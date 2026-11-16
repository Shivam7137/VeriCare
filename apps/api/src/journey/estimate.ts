import type { Ctas, EdStream } from "@prc/contracts";

// Wait-to-provider estimate: a queue-based point estimate scaled to a calibrated
// range. Pure functions only. A trained quantile model can replace `fluidWait`
// behind the same `estimateWait` result without touching callers.

const MIN = 60_000;

export type QueuePatient = { id: string; ctas: Ctas; triagedAt: number; stream: EdStream };
export type QueueSnapshot = {
  now: number;
  waiting: readonly QueuePatient[];
  /** First provider assessments that started recently. */
  starts: readonly { at: number; stream: EdStream }[];
  /** Recent triaged arrivals. */
  arrivals: readonly { at: number; ctas: Ctas; stream: EdStream }[];
};
export type Multipliers = { lo: number; hi: number };
export type EstimateBasis = {
  ahead: number;
  pacePerHour: number;
  moreUrgentPerHour: number;
  pointMinutes: number;
};
export type EstimateResult =
  | { kind: "range"; lowMinutes: number; highMinutes: number; basis: EstimateBasis }
  | { kind: "abstain"; why: "too_little_data" | "saturated" | "too_wide" | "not_waiting" };

/** Used until a replayed month supplies calibrated multipliers for a stratum. */
export const defaultMultipliers: Multipliers = { lo: 0.4, hi: 1.9 };

export function queueBasis(
  patient: QueuePatient,
  snapshot: QueueSnapshot,
  windowMinutes = 60,
): EstimateBasis | "too_little_data" | "saturated" {
  const since = snapshot.now - windowMinutes * MIN;
  const starts = snapshot.starts.filter(
    (start) => start.at >= since && start.stream === patient.stream,
  ).length;
  if (starts < 4) return "too_little_data";
  const pace = starts / windowMinutes;
  const moreUrgent =
    snapshot.arrivals.filter(
      (arrival) =>
        arrival.at >= since && arrival.stream === patient.stream && arrival.ctas < patient.ctas,
    ).length / windowMinutes;
  const ahead = snapshot.waiting.filter(
    (other) =>
      other.id !== patient.id &&
      other.stream === patient.stream &&
      (other.ctas < patient.ctas ||
        (other.ctas === patient.ctas && other.triagedAt < patient.triagedAt)),
  ).length;
  // Capacity left for this patient is the pace minus the more-urgent inflow that jumps ahead.
  const spare = pace - moreUrgent;
  if (spare < 0.2 * pace) return "saturated";
  return {
    ahead,
    pacePerHour: round1(pace * 60),
    moreUrgentPerHour: round1(moreUrgent * 60),
    pointMinutes: (ahead + 1) / spare,
  };
}

export function estimateWait(
  patient: QueuePatient,
  snapshot: QueueSnapshot,
  multipliers: Multipliers = defaultMultipliers,
): EstimateResult {
  if (!snapshot.waiting.some((other) => other.id === patient.id))
    return { kind: "abstain", why: "not_waiting" };
  const basis = queueBasis(patient, snapshot);
  if (typeof basis === "string") return { kind: "abstain", why: basis };
  const lowMinutes = Math.max(0, Math.floor((multipliers.lo * basis.pointMinutes) / 15) * 15);
  let highMinutes = Math.ceil((multipliers.hi * basis.pointMinutes) / 15) * 15;
  if (highMinutes - lowMinutes < 30) highMinutes = lowMinutes + 30;
  // A range wider than six hours is not information; say it is very busy instead.
  if (highMinutes > 360) return { kind: "abstain", why: "too_wide" };
  return {
    kind: "range",
    lowMinutes,
    highMinutes,
    basis: { ...basis, pointMinutes: round1(basis.pointMinutes) },
  };
}

/**
 * The same published shape from the trained model's calibrated 10th and 90th percentiles.
 * Rounding, minimum width and the six-hour ceiling are identical to the formula path, so
 * nothing downstream can tell which one produced the range.
 */
export function rangeFromModel(
  lowMinutes: number,
  highMinutes: number,
  basis: EstimateBasis,
): EstimateResult {
  const low = Math.max(0, Math.floor(lowMinutes / 15) * 15);
  let high = Math.ceil(highMinutes / 15) * 15;
  if (high - low < 30) high = low + 30;
  if (high > 360) return { kind: "abstain", why: "too_wide" };
  return {
    kind: "range",
    lowMinutes: low,
    highMinutes: high,
    basis: { ...basis, pointMinutes: round1(basis.pointMinutes) },
  };
}

/** Empirical multipliers from resolved snapshots: realised remaining wait over the point estimate. */
export function calibrate(
  resolved: readonly { pointMinutes: number; actualMinutes: number }[],
  alpha = 0.2,
): Multipliers | null {
  if (resolved.length < 30) return null;
  const scores = resolved
    .map((item) => item.actualMinutes / Math.max(item.pointMinutes, 5))
    .sort((a, b) => a - b);
  const pick = (p: number) => {
    const index = Math.min(scores.length, Math.max(1, Math.ceil((scores.length + 1) * p)));
    return scores[index - 1]!;
  };
  return { lo: pick(alpha / 2), hi: pick(1 - alpha / 2) };
}

export type RangeReason =
  "first" | "more_urgent_arrivals" | "pace_slower" | "pace_faster" | "steady";

/** Why the range moved, in terms a person can be told. */
export function explainChange(previous: EstimateBasis | null, next: EstimateBasis): RangeReason {
  if (!previous) return "first";
  if (next.moreUrgentPerHour - previous.moreUrgentPerHour >= 1) return "more_urgent_arrivals";
  if (next.pacePerHour <= previous.pacePerHour * 0.8) return "pace_slower";
  if (next.pacePerHour >= previous.pacePerHour * 1.25) return "pace_faster";
  return "steady";
}

export type Published = {
  highAt: number;
  sentAt: number;
  worseStreak: number;
  betterStreak: number;
};
export type PublishDecision = {
  publish: boolean;
  kind: "first" | "worse" | "better" | "overrun" | "hold";
  next: Published;
};

/**
 * Anti-jitter: computing is free, telling people is gated. Bad news goes out
 * fast, good news is confirmed first, and passing the promised time is always said.
 */
export function publishDecision(
  published: Published | null,
  highMinutes: number,
  now: number,
): PublishDecision {
  const highAt = now + highMinutes * MIN;
  if (!published)
    return {
      publish: true,
      kind: "first",
      next: { highAt, sentAt: now, worseStreak: 0, betterStreak: 0 },
    };
  const sent = (kind: PublishDecision["kind"]): PublishDecision => ({
    publish: true,
    kind,
    next: { highAt, sentAt: now, worseStreak: 0, betterStreak: 0 },
  });
  const sinceSent = (now - published.sentAt) / MIN;
  if (now >= published.highAt && sinceSent >= 30) return sent("overrun");
  const remaining = Math.max(15, (published.highAt - now) / MIN);
  const shift = (highAt - published.highAt) / MIN;
  if (shift >= 60) return sent("worse");
  if (shift >= Math.max(30, 0.25 * remaining)) {
    if (published.worseStreak + 1 >= 2) return sent("worse");
    return hold({ ...published, worseStreak: published.worseStreak + 1, betterStreak: 0 });
  }
  if (-shift >= Math.max(45, 0.4 * remaining)) {
    if (published.betterStreak + 1 >= 3 && sinceSent >= 30) return sent("better");
    return hold({ ...published, betterStreak: published.betterStreak + 1, worseStreak: 0 });
  }
  return hold({ ...published, worseStreak: 0, betterStreak: 0 });
}

const hold = (next: Published): PublishDecision => ({ publish: false, kind: "hold", next });
const round1 = (value: number) => Math.round(value * 10) / 10;
