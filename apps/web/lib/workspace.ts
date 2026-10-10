import type { Booking, Progress } from "./ui";
import { api, type Actor } from "./ui";
import type { Portal } from "./portal";

export async function enterWorkspace(portal: Portal, staffActions = false): Promise<Actor> {
  const actor = await api<Actor>("/api/session", undefined, "GET", portal);
  // Older overview cookies may be read-only. Upgrade once on entering an action workspace.
  return staffActions && actor.role === "operator"
    ? api<Actor>("/api/session", { persona: "staff" }, "POST", "professional")
    : actor;
}
export const closedStates = new Set(["completed", "withdrawn", "staff_takeover"]);
export function orderRequests<T extends Progress>(items: T[], now = Date.now()): T[] {
  const rank = (item: T) => {
    if (item.task.id === "T001") return 4;
    if (closedStates.has(item.task.state)) return 3;
    if (item.workflow && Date.parse(item.workflow.callbackWindow.endsAt) <= now) return 2;
    return 1;
  };
  return [...items].sort(
    (a, b) => rank(a) - rank(b) || Date.parse(b.task.updatedAt) - Date.parse(a.task.updatedAt),
  );
}
export function nextStep(progress: Progress, patient = false, now = Date.now()): string {
  const { task, workflow } = progress;
  if (
    !closedStates.has(task.state) &&
    workflow &&
    Date.parse(workflow.callbackWindow.endsAt) <= now &&
    !["ready_to_execute", "executing", "reconciling"].includes(task.state)
  )
    return patient
      ? "Your callback window has ended. Set a new window below so your care team can prepare a fresh proposal."
      : "The callback window has ended. The patient needs to set a new window before a fresh proposal can be approved.";
  const steps: Record<string, string> = {
    awaiting_verification: patient
      ? "Check your appointment and availability, then verify this request to send it to your care team."
      : "The patient needs to verify this request before the care team can propose a time.",
    awaiting_proposal: patient
      ? "Your request is with the care team. They will propose a time within your availability."
      : "Choose an available time within the patient's availability, then save the exact proposal.",
    awaiting_staff_approval: patient
      ? "Your proposed time is being reviewed by the care team."
      : "Review the exact appointment below and approve or reject this proposal.",
    awaiting_patient_confirmation: patient
      ? "Review your proposed appointment. Once the simulated follow-up is ready, confirm this exact time."
      : "Staff approval is saved. The patient must confirm this exact appointment during the agreed window.",
    ready_to_execute:
      "Both approvals are saved. The booking service is processing the appointment change.",
    executing:
      "The booking service is saving the appointment change. This page updates automatically.",
    reconciling:
      "The booking result is being checked. Wait for a saved receipt before treating the change as complete.",
    completed:
      "The appointment change is saved in the demo scheduler. The receipt below records the completed booking.",
    withdrawn: "This request was withdrawn. No further automated actions are planned for it.",
    staff_takeover:
      "The care team is handling this request. Automated booking actions are stopped.",
  };
  return steps[task.state] ?? task.nextAction;
}

/** A receipt describes this operation, never the appointment's mutable current booking. */
export function savedBookingReceipt(
  progress: Progress,
): { confirmationRef: string; booking: Booking | null } | null {
  const result = progress.operation?.result;
  return result?.confirmationRef
    ? { confirmationRef: result.confirmationRef, booking: result.booking ?? null }
    : null;
}
