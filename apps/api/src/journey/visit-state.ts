import type { EdEvent, SensitivityFlag, VisitState, VisitStep } from "@prc/contracts";

const ended: ReadonlySet<VisitStep> = new Set(["moved_to_unit", "discharged", "left", "cancelled"]);

/**
 * The visit's current state, derived only from its events. Replaying the same
 * events always gives the same state, so the event log is the source of truth.
 */
export function deriveVisitState(events: readonly EdEvent[]): VisitState {
  const ordered = [...events].sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.sourceEventId.localeCompare(b.sourceEventId),
  );
  let step: VisitStep = "arrived";
  let ctas: VisitState["ctas"] = null;
  let stream: VisitState["stream"] = "main";
  let area: string | null = null;
  let consultRequested = false;
  let bedRequested = false;
  let unmapped = false;
  let arrivedAt: string | null = null;
  let triagedAt: string | null = null;
  let providerAt: string | null = null;
  let endedAt: string | null = null;
  let lastEventAt: string | null = null;
  let results = 0;
  const openOrders = new Set<string>();
  const flags = new Set<SensitivityFlag>();

  for (const event of ordered) {
    lastEventAt = event.occurredAt;
    const { detail } = event;
    // Flags and unmapped messages apply even after the visit has ended.
    if (event.kind === "flag_set" && detail.flag) flags.add(detail.flag);
    else if (event.kind === "flag_cleared" && detail.flag) flags.delete(detail.flag);
    else if (event.kind === "unmapped") unmapped = true;
    if (ended.has(step)) continue;

    if (detail.stream) stream = detail.stream;
    if (detail.area) area = detail.area;
    switch (event.kind) {
      case "arrived":
        arrivedAt ??= event.occurredAt;
        break;
      case "triaged":
        if (detail.ctas) ctas = detail.ctas;
        triagedAt ??= event.occurredAt;
        if (step === "arrived") step = "waiting";
        break;
      case "provider_assigned":
        providerAt ??= event.occurredAt;
        if (step === "arrived" || step === "waiting") step = "being_seen";
        break;
      case "order_placed":
        if (detail.orderId) openOrders.add(detail.orderId);
        if (step === "deciding") step = "being_seen";
        break;
      case "result_available":
        if (detail.orderId && openOrders.delete(detail.orderId)) results += 1;
        // Results that land while the team is with the patient, with nothing else pending.
        if (step === "being_seen" && openOrders.size === 0) step = "deciding";
        break;
      case "order_cancelled":
        if (detail.orderId) openOrders.delete(detail.orderId);
        break;
      case "consult_requested":
        consultRequested = true;
        break;
      case "admit_decision":
        step = "admitted_waiting_bed";
        break;
      case "bed_requested":
        bedRequested = true;
        break;
      case "moved_to_unit":
        step = "moved_to_unit";
        endedAt = event.occurredAt;
        break;
      case "discharged":
        step = "discharged";
        endedAt = event.occurredAt;
        break;
      case "left_without_being_seen":
        step = "left";
        endedAt = event.occurredAt;
        break;
      case "cancelled":
        step = "cancelled";
        endedAt = event.occurredAt;
        break;
      default:
        break;
    }
  }

  const testsInProgress = openOrders.size > 0;
  return {
    step,
    friendlyStep: friendlyStep(step, testsInProgress),
    ctas,
    stream,
    area,
    testsInProgress,
    resultsReady: results > 0 && !testsInProgress,
    consultRequested,
    bedRequested,
    sensitivity: [...flags].sort(),
    unmapped,
    ended: ended.has(step),
    arrivedAt,
    triagedAt,
    providerAt,
    endedAt,
    lastEventAt,
  };
}

function friendlyStep(step: VisitStep, testsInProgress: boolean): number {
  if (step === "arrived") return 1;
  if (step === "waiting") return 2;
  if (step === "being_seen") return testsInProgress ? 4 : 3;
  if (step === "deciding") return 4;
  return 5;
}
