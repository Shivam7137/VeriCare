import type { Ctas, VisitState } from "@prc/contracts";
import type { VisitFacts } from "../../opor/hl7v2-mapper.js";
import type { Arrivals, Staffing } from "./flow.js";

export const SPEEDS = [1, 10, 60, 300] as const;
export type Speed = (typeof SPEEDS)[number];

/** One open visit, as the director reads it. */
export type Row = {
  id: string;
  visit: string;
  mrn: string;
  name: string;
  dob: string | null;
  patientId: string | null;
  state: VisitState;
  facts: VisitFacts;
  published: { lowMinutes: number; highMinutes: number } | null;
  createdAt: Date;
};

export type DemoAction =
  | { type: "play" }
  | { type: "pause" }
  | { type: "speed"; value: Speed }
  | { type: "skip"; minutes: number }
  | { type: "add"; count: number; ctas?: Ctas }
  | { type: "surge" }
  | { type: "next"; patientId: string }
  | { type: "arrivals"; value: Arrivals }
  | { type: "staffing"; value: Staffing }
  | { type: "reset" }
  /** Maya leaves (if she is still in) and arrives again, waiting; nobody else changes. */
  | { type: "reseat" }
  /** Counts as use, so the demo does not start over by itself yet. */
  | { type: "keep" }
  /** A judge becomes the featured patient's emergency contact, with their own phone. */
  | { type: "contact"; name: string; phone: string; estimates?: boolean }
  /** The judge texts a question as that contact. */
  | { type: "ask"; contactId: string; text: string };

export type DemoPatient = {
  id: string;
  name: string;
  step: string;
  ctas: number | null;
  waitMinutes: number | null;
  /** What "Next step" would do. Null when the visit follows its own script or has ended. */
  next: string | null;
  scripted: boolean;
  /** The visit that belongs to the signed-in patient, when there is one. */
  mine: boolean;
  /** Confidential or otherwise silenced: no estimate for it appears anywhere, the bar included. */
  silenced: boolean;
};

export type DemoLive = {
  active: true;
  running: boolean;
  /** The clock has run since the last reset (so the play button says "Resume"). */
  started: boolean;
  speed: Speed;
  arrivals: Arrivals;
  staffing: Staffing;
  clock: string;
  /** Simulated minutes still to skip, or null. */
  skipping: number | null;
  fault: string | null;
  /** The demo starts over by itself after this many idle minutes. */
  idleReset: {
    minutes: number;
    /** Whole minutes left before it does, or null while nobody has used it. */
    inMinutes: number | null;
    lastAutoReset: string | null;
  };
  counts: {
    inDepartment: number;
    arrived: number;
    waiting: number;
    beingSeen: number;
    boarding: number;
    finished: number;
  };
  model: {
    version: string | null;
    source: "model" | "formula";
    waiting: number;
    medianMinutes: number | null;
    longestMinutes: number | null;
    trend: { at: string; median: number; waiting: number }[];
  };
  focus:
    | (DemoPatient & {
        estimate: { label: string; low: number; typical: number; high: number } | null;
      })
    | null;
  patients: DemoPatient[];
  recent: { at: string; text: string }[];
};

export type DemoState = { active: false } | DemoLive;
