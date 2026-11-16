import type { Ctas, EdEvent, EdStream } from "@prc/contracts";

// Inputs for the stage-time models, rebuilt from feed events alone.
//
// Every definition here mirrors ml/vericare_ml/features.py. The two are held
// together by a fixture test (stage-model.test.ts): the Python side exports
// events with the features it expects from them, and this file must reproduce
// them. Change one side and the other must change too.
//
// Times are milliseconds here and minutes in the features. Windows are (now - w, now].

const MIN = 60_000;

/** 0 lab, 1 X-ray, 2 CT, 3 other imaging. */
export type OrderKind = 0 | 1 | 2 | 3;
export type TimelineOrder = {
  id: string;
  kind: OrderKind;
  placedAt: number;
  resultAt: number | null;
};

/** One visit reduced to the timestamps the models use. Nothing clinical beyond triage level. */
export type Timeline = {
  id: string;
  age: number | null;
  arrivedAt: number;
  triagedAt: number | null;
  ctas: Ctas | null;
  stream: EdStream;
  providerAt: number | null;
  admitAt: number | null;
  /** First of discharge or admit decision. */
  decisionAt: number | null;
  endedAt: number | null;
  movedToUnit: boolean;
  consultAt: number | null;
  orders: TimelineOrder[];
};

export type StageVisit = { id: string; age: number | null; events: readonly EdEvent[] };

/** Reads a visit's events up to `now`. Later events are ignored so a replay sees the past as it was. */
export function timelineOf(visit: StageVisit, now: number): Timeline | null {
  const events = visit.events
    .map((event) => ({ event, at: Date.parse(event.occurredAt) }))
    .filter((item) => item.at <= now)
    .sort((a, b) => a.at - b.at || a.event.sourceEventId.localeCompare(b.event.sourceEventId));
  const first = events[0];
  if (!first) return null;
  const line: Timeline = {
    id: visit.id,
    age: visit.age,
    arrivedAt: first.at,
    triagedAt: null,
    ctas: null,
    stream: "main",
    providerAt: null,
    admitAt: null,
    decisionAt: null,
    endedAt: null,
    movedToUnit: false,
    consultAt: null,
    orders: [],
  };
  for (const { event, at } of events) {
    const { detail } = event;
    // A result can land after the patient has gone; it still tells us how fast the lab is.
    if (line.endedAt !== null && event.kind !== "result_available") continue;
    if (detail.stream) line.stream = detail.stream;
    switch (event.kind) {
      case "triaged":
        if (detail.ctas) line.ctas = detail.ctas;
        line.triagedAt ??= at;
        break;
      case "provider_assigned":
        line.providerAt ??= at;
        break;
      case "order_placed": {
        const kind = orderKind(detail);
        if (detail.orderId && kind !== null)
          line.orders.push({ id: detail.orderId, kind, placedAt: at, resultAt: null });
        break;
      }
      case "result_available": {
        const order = line.orders.find((item) => item.id === detail.orderId && !item.resultAt);
        if (order) order.resultAt = at;
        break;
      }
      case "order_cancelled":
        line.orders = line.orders.filter((item) => item.id !== detail.orderId || item.resultAt);
        break;
      case "consult_requested":
        line.consultAt ??= at;
        break;
      case "admit_decision":
        line.admitAt ??= at;
        line.decisionAt ??= at;
        break;
      case "moved_to_unit":
        line.endedAt = at;
        line.movedToUnit = true;
        break;
      case "discharged":
        line.decisionAt ??= at;
        line.endedAt = at;
        break;
      case "left_without_being_seen":
      case "cancelled":
        line.endedAt = at;
        break;
      default:
        break;
    }
  }
  return line;
}

function orderKind(detail: EdEvent["detail"]): OrderKind | null {
  if (detail.orderType === "lab") return 0;
  if (detail.orderType !== "imaging") return null;
  if (detail.modality === "ct") return 2;
  if (detail.modality === "ultrasound" || detail.modality === "mri" || detail.modality === "other")
    return 3;
  return 1;
}

/** Step codes shared with the training code. */
export const STEP = { arrived: 0, waiting: 1, beingSeen: 2, boarding: 3 } as const;

export type StageFeatures = Record<string, number>;
export type DepartmentSnapshot = {
  now: number;
  /** Features for every visit still open at `now`, by visit id. */
  byVisit: Map<string, StageFeatures>;
  /** Order ids still open for each visit, for scoring the results estimate later. */
  openOrders: Map<string, string[]>;
  /** Every visit that was read, open or recently ended. */
  timelines: Map<string, Timeline>;
};

/**
 * Features for every open visit at `now`. `visits` must include visits that ended in the
 * last 24 hours: recent starts, results and bed moves come from them.
 */
export function departmentSnapshot(
  visits: readonly StageVisit[],
  now: number,
  timeZone = "America/Halifax",
): DepartmentSnapshot {
  const lines = visits
    .map((visit) => timelineOf(visit, now))
    .filter((line): line is Timeline => line !== null);
  const active = lines.filter((line) => line.endedAt === null);
  const triaged = (line: Timeline) => line.triagedAt !== null;
  const seen = (line: Timeline) => line.providerAt !== null;
  const waiting = active.filter((line) => triaged(line) && !seen(line));
  const boarding = active.filter((line) => line.admitAt !== null);
  const raz = (line: Timeline) => line.stream === "rapid_assessment";
  const within = (at: number | null, minutes: number) =>
    at !== null && at > now - minutes * MIN && at <= now;
  const count = <T>(items: readonly T[], test: (item: T) => boolean) =>
    items.reduce((total, item) => total + (test(item) ? 1 : 0), 0);
  const waits = (stream: boolean) =>
    lines
      .filter((line) => within(line.providerAt, 180) && raz(line) === stream && triaged(line))
      .map((line) => (line.providerAt! - line.triagedAt!) / MIN);
  const results = lines.flatMap((line) => line.orders.filter((order) => order.resultAt !== null));
  const turnaround = (imaging: boolean) =>
    results
      .filter((order) => within(order.resultAt, 180) && order.kind > 0 === imaging)
      .map((order) => (order.resultAt! - order.placedAt) / MIN);
  const openOf = (line: Timeline) => line.orders.filter((order) => order.resultAt === null);
  const allOpen = active.flatMap(openOf);
  const clock = localClock(now, timeZone);

  const department = {
    waiting_main: count(waiting, (line) => !raz(line)),
    waiting_raz: count(waiting, raz),
    wait_triage: count(active, (line) => !triaged(line)),
    waiting_median_elapsed: median(
      waiting.map((line) => (now - line.triagedAt!) / MIN),
      1,
    ),
    starts_30_main: count(lines, (line) => within(line.providerAt, 30) && !raz(line)),
    starts_60_main: count(lines, (line) => within(line.providerAt, 60) && !raz(line)),
    starts_180_main: count(lines, (line) => within(line.providerAt, 180) && !raz(line)),
    starts_60_raz: count(lines, (line) => within(line.providerAt, 60) && raz(line)),
    triaged_60: count(lines, (line) => within(line.triagedAt, 60)),
    urgent_60: count(lines, (line) => within(line.triagedAt, 60) && (line.ctas ?? 9) <= 2),
    recent_wait_main: median(waits(false), 3),
    recent_wait_raz: median(waits(true), 3),
    dispo_60: count(lines, (line) => within(line.decisionAt, 60)),
    in_treatment: count(active, (line) => seen(line) && line.decisionAt === null),
    boarding: boarding.length,
    moves_240: count(lines, (line) => line.movedToUnit && within(line.endedAt, 240)),
    moves_1440: count(lines, (line) => line.movedToUnit && within(line.endedAt, 1440)),
    open_lab_dept: count(allOpen, (order) => order.kind === 0),
    open_img_dept: count(allOpen, (order) => order.kind > 0),
    recent_tat_lab: median(turnaround(false), 3),
    recent_tat_img: median(turnaround(true), 3),
    hour_sin: Math.sin((2 * Math.PI * clock.minuteOfDay) / 1440),
    hour_cos: Math.cos((2 * Math.PI * clock.minuteOfDay) / 1440),
    weekday: clock.weekday,
  };

  const byVisit = new Map<string, StageFeatures>();
  const openOrders = new Map<string, string[]>();
  for (const line of active) {
    const open = openOf(line);
    const done = line.orders.filter((order) => order.resultAt !== null);
    const isWaiting = triaged(line) && !seen(line);
    const isBoarding = line.admitAt !== null;
    const since = (at: number | null) => (at === null ? NaN : (now - at) / MIN);
    const features: StageFeatures = {
      ...department,
      ctas: line.ctas ?? NaN,
      age: line.age ?? NaN,
      raz: triaged(line) && raz(line) ? 1 : 0,
      step: !triaged(line)
        ? STEP.arrived
        : isWaiting
          ? STEP.waiting
          : isBoarding
            ? STEP.boarding
            : STEP.beingSeen,
      since_arrival: since(line.arrivedAt),
      since_triage: since(line.triagedAt),
      since_provider: since(line.providerAt),
      since_admit: since(line.admitAt),
      open_lab: count(open, (order) => order.kind === 0),
      open_xray: count(open, (order) => order.kind === 1),
      open_ct: count(open, (order) => order.kind === 2),
      open_other: count(open, (order) => order.kind === 3),
      oldest_open: open.length ? since(Math.min(...open.map((order) => order.placedAt))) : NaN,
      newest_open: open.length ? since(Math.max(...open.map((order) => order.placedAt))) : NaN,
      resulted: done.length,
      since_last_result: done.length
        ? since(Math.max(...done.map((order) => order.resultAt!)))
        : NaN,
      consult: line.consultAt !== null ? 1 : 0,
      ahead_urgent: NaN,
      ahead_same: NaN,
      lower_waited_longer: NaN,
      fluid: NaN,
      urgent_arrivals_stream_60: NaN,
      boarders_ahead: isBoarding ? count(boarding, (other) => other.admitAt! < line.admitAt!) : NaN,
    };
    if (isWaiting && line.ctas !== null) {
      const level = line.ctas;
      const queue = waiting.filter((other) => raz(other) === raz(line) && other.ctas !== null);
      const earlier = (other: Timeline) => other.triagedAt! < line.triagedAt!;
      features.ahead_urgent = count(queue, (other) => other.ctas! < level);
      features.ahead_same = count(queue, (other) => other.ctas === level && earlier(other));
      features.lower_waited_longer = count(queue, (other) => other.ctas! > level && earlier(other));
      const arrivals = count(
        lines,
        (other) =>
          within(other.triagedAt, 60) && raz(other) === raz(line) && (other.ctas ?? 9) < level,
      );
      features.urgent_arrivals_stream_60 = arrivals;
      const starts = raz(line) ? department.starts_60_raz : department.starts_60_main;
      if (starts > 0) {
        const pace = starts / 60;
        const spare = Math.max(pace - arrivals / 60, 0.2 * pace);
        features.fluid = (features.ahead_urgent + features.ahead_same + 1) / spare;
      }
    }
    byVisit.set(line.id, features);
    openOrders.set(
      line.id,
      open.map((order) => order.id),
    );
  }
  return { now, byVisit, openOrders, timelines: new Map(lines.map((line) => [line.id, line])) };
}

/** Median with the average of the middle pair; NaN below `least` values. */
export function median(values: number[], least: number): number {
  if (values.length < least || values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock minute of the day and weekday (0 = Sunday) where the department is. */
export function localClock(
  now: number,
  timeZone: string,
): { minuteOfDay: number; weekday: number } {
  let format = clocks.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    clocks.set(timeZone, format);
  }
  const parts = Object.fromEntries(
    format.formatToParts(new Date(now)).map((part) => [part.type, part.value]),
  );
  const minuteOfDay =
    Number(parts.hour) * 60 +
    Number(parts.minute) +
    (Number(parts.second) + (now % 1000) / 1000) / 60;
  return {
    minuteOfDay,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!),
  };
}
