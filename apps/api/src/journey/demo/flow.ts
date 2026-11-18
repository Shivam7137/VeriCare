import type { Ctas, VisitState } from "@prc/contracts";

// The rules the demo department follows when nobody is scripting it. Pure functions only:
// the same visit number always gets the same plan, so a restart never changes a story.
// Everything here is fictional and exists to drive the demo control bar.

const MIN = 60_000;

export type Rng = () => number;

/** Small, fast, seedable generator (mulberry32). Good enough for a simulated waiting room. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, so a visit number turns into a stable seed. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const between = (rng: Rng, low: number, high: number) => low + (high - low) * rng();
const chance = (rng: Rng, probability: number) => rng() < probability;

export type Stream = "main" | "rapid_assessment";
export type Arrivals = "off" | "normal" | "busy";
export type Staffing = "low" | "normal" | "high";

/** Patients per simulated hour who walk in on their own. */
export const ARRIVALS_PER_HOUR: Record<Arrivals, number> = { off: 0, normal: 7, busy: 15 };
/** Minutes between one patient starting with a provider and the next, per stream. */
export const START_GAP_MINUTES: Record<Stream, number> = { main: 7, rapid_assessment: 10 };
/** More staff means a shorter gap. */
export const STAFFING_FACTOR: Record<Staffing, number> = { low: 1.7, normal: 1, high: 0.6 };

/** Share of arrivals at each triage level (CTAS 1 is the sickest). */
const CTAS_WEIGHTS: readonly [Ctas, number][] = [
  [1, 0.02],
  [2, 0.14],
  [3, 0.38],
  [4, 0.33],
  [5, 0.13],
];
export function pickCtas(rng: Rng): Ctas {
  let roll = rng();
  for (const [level, weight] of CTAS_WEIGHTS) {
    if (roll < weight) return level;
    roll -= weight;
  }
  return 3;
}

export type Plan = {
  ctas: Ctas;
  /** Low-acuity patients can be handled in the rapid assessment stream. */
  raz: boolean;
  /** Minutes from arrival to the triage assessment. */
  triageMin: number;
  /** Minutes from being seen to the tests being ordered. */
  orderMin: number;
  labs: boolean;
  imaging: "XR" | "CT" | "US" | null;
  consult: boolean;
  /** Minutes from the tests being ordered to every result being back. */
  resultMin: number;
  /** Minutes from the last result to the decision. */
  decideMin: number;
  /** Minutes from being seen to the decision when no tests are needed. */
  noTestMin: number;
  admit: boolean;
  /** Minutes from the decision to admit to the bed being requested. */
  bedMin: number;
  /** Minutes from the bed request to the move to a ward. */
  boardMin: number;
};

const LAB_RATE: Record<Ctas, number> = { 1: 1, 2: 0.9, 3: 0.65, 4: 0.3, 5: 0.1 };
const IMAGING_RATE: Record<Ctas, number> = { 1: 0.8, 2: 0.6, 3: 0.4, 4: 0.3, 5: 0.1 };
const CONSULT_RATE: Record<Ctas, number> = { 1: 0.4, 2: 0.25, 3: 0.12, 4: 0.03, 5: 0 };
const ADMIT_RATE: Record<Ctas, number> = { 1: 0.85, 2: 0.5, 3: 0.2, 4: 0.04, 5: 0.01 };

/** What this visit will do, decided once from its visit number. Overrides pin parts of the story. */
export function planFor(visit: string, overrides: Partial<Plan> = {}): Plan {
  const rng = mulberry32(hashSeed(visit));
  // The draw order is fixed. Adding a draw anywhere but the end would change every story.
  const rolledCtas = pickCtas(rng);
  const ctas = overrides.ctas ?? rolledCtas;
  const raz = ctas >= 4 && chance(rng, 0.35);
  const triageMin = ctas === 1 ? 1 : ctas === 2 ? between(rng, 2, 4) : between(rng, 4, 12);
  const orderMin = between(rng, 3, 9);
  const labs = chance(rng, LAB_RATE[ctas]);
  const imagingRoll = chance(rng, IMAGING_RATE[ctas]);
  const kind = rng();
  const imaging = !imagingRoll ? null : ctas <= 3 && kind < 0.5 ? "CT" : kind < 0.75 ? "XR" : "US";
  const consult = chance(rng, CONSULT_RATE[ctas]);
  const labMin = between(rng, 30, 55);
  const imagingMin = between(rng, 35, 80);
  const resultMin = Math.max(labs ? labMin : 0, imaging ? imagingMin : 0);
  const decideMin = between(rng, 12, 35);
  const noTestMin = between(rng, 20, 55);
  const admit = !raz && chance(rng, ADMIT_RATE[ctas]);
  const bedMin = between(rng, 5, 15);
  const boardMin = between(rng, 60, 170);
  return {
    ctas,
    raz,
    triageMin,
    orderMin,
    labs,
    imaging,
    consult,
    resultMin,
    decideMin,
    noTestMin,
    admit,
    bedMin,
    boardMin,
    ...overrides,
  };
}

export type Act = "triage" | "see" | "order" | "result" | "discharge" | "admit" | "bed" | "move";
/** `at` is null for a start with a provider: the queue, not a timer, decides when. */
export type Move = { act: Act; at: number | null };

type Progress = Pick<
  VisitState,
  | "step"
  | "testsInProgress"
  | "resultsReady"
  | "consultRequested"
  | "bedRequested"
  | "arrivedAt"
  | "triagedAt"
  | "providerAt"
  | "lastEventAt"
>;

const time = (iso: string | null, fallback: number) => (iso ? Date.parse(iso) : fallback);

/**
 * The next thing that should happen to a visit, and when, judging only by its state and plan.
 * Because it reads the state, a restarted demo picks every visit up where it was.
 */
export function nextMove(state: Progress, plan: Plan, fallbackAt: number): Move | null {
  const last = time(state.lastEventAt, fallbackAt);
  const decision: Act = plan.admit ? "admit" : "discharge";
  switch (state.step) {
    case "arrived":
      return { act: "triage", at: time(state.arrivedAt, last) + plan.triageMin * MIN };
    case "waiting":
      return { act: "see", at: null };
    case "being_seen": {
      const seenAt = time(state.providerAt, last);
      const needsOrders = plan.labs || plan.imaging !== null || plan.consult;
      const placed = state.testsInProgress || state.resultsReady || state.consultRequested;
      if (!placed && needsOrders) return { act: "order", at: seenAt + plan.orderMin * MIN };
      if (state.testsInProgress) return { act: "result", at: last + plan.resultMin * MIN };
      // A consult adds a wait of its own before anyone decides.
      const after = placed ? last + (plan.decideMin + (plan.consult ? 30 : 0)) * MIN : null;
      return { act: decision, at: after ?? seenAt + plan.noTestMin * MIN };
    }
    case "deciding":
      return { act: decision, at: last + plan.decideMin * MIN };
    case "admitted_waiting_bed":
      return state.bedRequested
        ? { act: "move", at: last + plan.boardMin * MIN }
        : { act: "bed", at: last + plan.bedMin * MIN };
    default:
      return null;
  }
}

/** What the bar tells the presenter will happen on "Next step". */
export const MOVE_LABEL: Record<Act, string> = {
  triage: "Triage assessment",
  see: "Seen by a provider",
  order: "Tests ordered",
  result: "Results back",
  discharge: "Sent home",
  admit: "Admitted to hospital",
  bed: "Bed requested",
  move: "Moves to a ward",
};

/** Time of the next provider start in a stream, after one just began at `at`. */
export function nextStartAfter(at: number, stream: Stream, staffing: Staffing, rng: Rng): number {
  const gap = START_GAP_MINUTES[stream] * STAFFING_FACTOR[staffing] * between(rng, 0.75, 1.25);
  return at + gap * MIN;
}

/** Who is seen next in a stream: the sickest first, then whoever has waited longest. */
export function pickNextToSee<T extends { ctas: number; triagedAt: number }>(
  waiting: readonly T[],
): T | null {
  let best: T | null = null;
  for (const patient of waiting)
    if (
      !best ||
      patient.ctas < best.ctas ||
      (patient.ctas === best.ctas && patient.triagedAt < best.triagedAt)
    )
      best = patient;
  return best;
}

/** How many people walk in during a stretch of simulated time (Poisson, by inversion). */
export function arrivalsIn(rng: Rng, perHour: number, milliseconds: number): number {
  const mean = (perHour * milliseconds) / (60 * MIN);
  if (mean <= 0) return 0;
  const limit = Math.exp(-mean);
  let count = 0;
  let product = rng();
  while (product > limit && count < 12) {
    count += 1;
    product *= rng();
  }
  return count;
}

const GIVEN = [
  "Aiden",
  "Beatrice",
  "Callum",
  "Dahlia",
  "Elijah",
  "Fiona",
  "Gabriel",
  "Hana",
  "Isaac",
  "Jasmine",
  "Kofi",
  "Layla",
  "Mateo",
  "Nadia",
  "Owen",
  "Priyanka",
  "Quinn",
  "Rosalind",
  "Sebastian",
  "Tamara",
  "Umar",
  "Vivian",
  "Wesley",
  "Ximena",
  "Yusuf",
  "Zara",
  "Andre",
  "Bridget",
  "Cormac",
  "Delphine",
  "Emeka",
  "Freya",
  "Gavin",
  "Helena",
  "Idris",
  "Joelle",
] as const;
const FAMILY = [
  "Abbott",
  "Baptiste",
  "Carriere",
  "Dhillon",
  "Eastwood",
  "Fougere",
  "Gillis",
  "Hartigan",
  "Ibrahim",
  "Jessome",
  "Kennedy",
  "Landry",
  "Mosher",
  "Nickerson",
  "Ouellette",
  "Pettipas",
  "Quigley",
  "Robichaud",
  "Sampson",
  "Tanner",
  "Underhill",
  "Vaughan",
  "Whynot",
  "Xavier",
  "Young",
  "Zwicker",
  "Amirault",
  "Bourque",
  "Chisholm",
  "Dauphinee",
  "Embree",
  "Fancy",
  "Goreham",
  "Harnish",
  "Isnor",
  "Jollimore",
  "Kinsman",
] as const;

/** Two lists with coprime lengths, so the first 1,300 names never repeat. */
export function nameFor(index: number): { given: string; family: string } {
  return { given: GIVEN[index % GIVEN.length]!, family: FAMILY[index % FAMILY.length]! };
}

/** A birth date in a plausible age mix: a few children, mostly adults, many older people. */
export function birthDateFor(rng: Rng, now: number): string {
  const roll = rng();
  const years =
    roll < 0.08 ? between(rng, 1, 17) : roll < 0.6 ? between(rng, 18, 64) : between(rng, 65, 92);
  const born = new Date(now - years * 365.25 * 24 * 60 * MIN);
  return born.toISOString().slice(0, 10);
}

/** Phrases for the live ticker, keyed by the kind of event that happened. */
export function eventPhrase(kind: string, detail: Record<string, unknown>): string | null {
  switch (kind) {
    case "arrived":
      return "arrived";
    case "triaged":
      return typeof detail.ctas === "number" ? `triaged, level ${detail.ctas}` : "triaged";
    case "provider_assigned":
      return "is being seen";
    case "order_placed":
      return detail.orderType === "lab"
        ? "bloodwork ordered"
        : detail.modality === "ct"
          ? "CT ordered"
          : detail.modality === "ultrasound"
            ? "ultrasound ordered"
            : "X-ray ordered";
    case "consult_requested":
      return "specialist consult requested";
    case "result_available":
      return "result back";
    case "admit_decision":
      return "admitted, waiting for a bed";
    case "bed_requested":
      return "bed requested";
    case "moved_to_unit":
      return "moved to a ward";
    case "discharged":
      return "went home";
    case "left_without_being_seen":
      return "left without being seen";
    default:
      return null;
  }
}
