import { isPortal } from "./portal";

// Client for the demo control bar. The API owns the simulation; this only asks and shows.

export const SPEEDS = [1, 10, 60, 300] as const;
export type Speed = (typeof SPEEDS)[number];
export type Arrivals = "off" | "normal" | "busy";
export type Staffing = "low" | "normal" | "high";

export type DemoPatient = {
  id: string;
  name: string;
  step: string;
  ctas: number | null;
  waitMinutes: number | null;
  /** What "Next step" would do, or null when the visit follows its own script. */
  next: string | null;
  scripted: boolean;
  mine: boolean;
};

export type DemoLive = {
  active: true;
  running: boolean;
  speed: Speed;
  arrivals: Arrivals;
  staffing: Staffing;
  clock: string;
  skipping: number | null;
  fault: string | null;
  /** The demo starts over by itself after this many idle minutes. */
  idleReset: { minutes: number; inMinutes: number | null; lastAutoReset: string | null };
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
  /** The judge's text thread, once they became the emergency contact. */
  phone?: JudgePhone | null;
};
export type JudgePhone = {
  active: boolean;
  patientId: string;
  phone: string;
  /** The newest text's delivery status, which says whether texts really leave the server. */
  delivery: string | null;
  /** Newest first. "in" is what the judge texted. */
  messages: { at: string; body: string; direction: "in" | "out" }[];
};
/** What this browser keeps about the contact it created. */
export type JudgeContact = { id: string; phone: string };
export type DemoState = { active: false } | DemoLive;

export type DemoAction =
  | { type: "play" }
  | { type: "pause" }
  | { type: "speed"; value: Speed }
  | { type: "skip"; minutes: number }
  | { type: "add"; count: number; ctas?: 1 | 2 | 3 | 4 | 5 }
  | { type: "surge" }
  | { type: "next"; patientId: string }
  | { type: "arrivals"; value: Arrivals }
  | { type: "staffing"; value: Staffing }
  | { type: "reset" }
  /** Counts as use, so the demo does not start over by itself yet. */
  | { type: "keep" }
  | { type: "contact"; name: string; phone: string }
  | { type: "ask"; contactId: string; text: string };

export class DemoError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(friendly[code] ?? "That didn't go through. Please try again.");
    this.name = "DemoError";
  }
}

const friendly: Record<string, string> = {
  demo_not_started: "Start the ER demo first.",
  department_full: "The ER is full. Skip ahead or restart the demo.",
  scripted_visit: "This visit follows its own script, so it can't be moved by hand.",
  nothing_next: "Nothing is left to do for this patient.",
  not_found: "That patient has already left.",
  invalid_input: "That control isn't available.",
  invalid_phone: "That doesn't look like a phone number. Try 902 555 0134 or +44 20 7946 0000.",
  featured_gone: "Maya's visit has ended. Restart the demo to try again.",
  contact_limit: "Maya has too many contacts already. Restart the demo to clear them.",
};

async function call<T>(path: string, init?: { body: unknown }): Promise<T> {
  const segment = window.location.pathname.split("/")[1];
  const response = await fetch(`/api/backend/journey/demo/${path}`, {
    method: init ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      // The bar lives in both apps; each one uses its own demo sign-in.
      "x-prc-portal": isPortal(segment) ? segment : "professional",
    },
    body: init ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new DemoError(body.error ?? "unavailable", response.status);
  return body as T;
}

export const demo = {
  state: (visit?: string, contact?: string) => {
    const query = new URLSearchParams();
    if (visit) query.set("visit", visit);
    if (contact) query.set("contact", contact);
    const text = query.toString();
    return call<DemoState>(`state${text ? `?${text}` : ""}`);
  },
  act: (action: DemoAction, focus?: string, contact?: string) =>
    call<{ note: string; state: DemoState; contact?: JudgeContact }>("act", {
      body: { ...action, ...(focus ? { focus } : {}), ...(contact ? { contact } : {}) },
    }),
};

/** What the speed means in plain words. */
export function speedHint(speed: Speed): string {
  if (speed === 1) return "real time";
  if (speed === 10) return "1 min every 6 s";
  if (speed === 60) return "1 min per second";
  return "5 min per second";
}

export const stepLabel: Record<string, string> = {
  arrived: "Checked in",
  waiting: "Waiting",
  being_seen: "Being seen",
  deciding: "Next steps",
  admitted_waiting_bed: "Waiting for a bed",
};

/** A line and a soft area under it, scaled to a small box. Null until there are two points. */
export function sparkline(
  values: readonly number[],
  width: number,
  height: number,
  pad = 3,
): { line: string; area: string; last: { x: number; y: number } } | null {
  if (values.length < 2) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const points = values.map((value, index) => ({
    x: pad + (index / (values.length - 1)) * (width - 2 * pad),
    y: pad + (1 - (value - low) / span) * (height - 2 * pad),
  }));
  const line = points
    .map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
  const first = points[0]!;
  const last = points.at(-1)!;
  return {
    line,
    area: `${line} L${last.x.toFixed(1)} ${height} L${first.x.toFixed(1)} ${height} Z`,
    last,
  };
}

/** "+39 min", "−12 min" or null when nothing changed. */
export function deltaText(before: number | null, after: number | null): string | null {
  if (before === null || after === null || before === after) return null;
  const change = after - before;
  return `${change > 0 ? "+" : "−"}${Math.abs(change)} min`;
}
