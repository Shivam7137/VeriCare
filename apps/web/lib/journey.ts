import { api } from "./ui";

// View models for VeriCare Journey. The API decides what may be shown;
// these pages only render what it returns.

export type VisitMessage = {
  id: string;
  direction: "in" | "out";
  kind: string;
  body: string;
  at: string;
};
export type VisitContact = {
  id: string;
  name: string;
  relationship: string;
  phoneEnding: string;
  scopes: ("status" | "alerts" | "estimates")[];
};
export type LiveVisit = {
  mode: "live";
  firstName: string;
  steps: string[];
  friendlyStep: number;
  step: string;
  sentence: string;
  badges: {
    testsInProgress: boolean;
    resultsReady: boolean;
    consultRequested: boolean;
    bedRequested: boolean;
  };
  range: {
    lowMinutes: number;
    highMinutes: number;
    headline: string;
    sentence: string;
    reason: string | null;
    updatedAt: string;
  } | null;
  outlook: {
    stage: "triage" | "results" | "decision";
    label: string;
    lowMinutes: number;
    highMinutes: number;
    headline: string;
    sentence: string;
  }[];
  ended: boolean;
  canLeave: boolean;
  checkInDue: boolean;
  worseLine: string;
  lastUpdatedAt: string;
  messages: VisitMessage[];
  contacts: VisitContact[];
};
export type Visit =
  LiveVisit | { mode: "none" } | { mode: "handoff"; message: string; worseLine: string };

export type DeskTask = {
  id: string;
  encounterId: string;
  kind: "recheck" | "leaving" | "question" | "interpreter" | "comfort";
  priority: 1 | 2 | 3;
  summary: string;
  patientName: string;
  ctas: number | null;
  createdAt: string;
};
export type DeskPatient = {
  id: string;
  name: string;
  step: string;
  ctas: number | null;
  stream: string;
  area: string | null;
  flags: string[];
  unmapped: boolean;
  testsInProgress: boolean;
  waitingMinutes: number | null;
  range: { lowMinutes: number; highMinutes: number } | null;
  stages: DeskStage[];
};
export type StageName = "triage" | "provider" | "results" | "decision" | "bed";
export type DeskStage = {
  stage: StageName;
  lowMinutes: number;
  typicalMinutes: number;
  highMinutes: number;
};
export type Desk = {
  feed: { lastMessageAt: string; feedTime: string; stale: boolean } | null;
  patients: DeskPatient[];
  tasks: DeskTask[];
  accuracy: { total: number; inside: number; over: number };
  stageAccuracy: { stage: StageName; total: number; inside: number; over: number }[];
  model: { version: string; trainedAt: string } | null;
  agent: { runs: AgentRun[] };
  ledger: {
    seq: string;
    at: string;
    actor: string;
    action: string;
    patientName: string | null;
    detail: Record<string, unknown>;
  }[];
};

export type FamilyVisit =
  | { mode: "handoff"; message: string }
  | {
      mode: "live";
      patientFirstName: string;
      contactFirstName: string;
      steps: string[];
      friendlyStep: number;
      step: string;
      sentence: string;
      ended: boolean;
      range: { headline: string; sentence: string; updatedAt: string } | null;
      sharesEstimates: boolean;
      lastUpdatedAt: string;
      messages: VisitMessage[];
    };

export type AccuracyStage = {
  stage: StageName;
  total: number;
  inside: number;
  over: number;
  under: number;
  visits: number;
  medianErrorMinutes: number | null;
  meanWidthMinutes: number | null;
  awaitingOutcome: number;
  widening: number;
};
export type AccuracyPoint = {
  stage: StageName;
  patientName: string;
  computedAt: string;
  low: number;
  typical: number;
  high: number;
  actual: number;
  censored: boolean;
};
export type Accuracy = {
  model: string | null;
  target: number;
  stages: AccuracyStage[];
  points: AccuracyPoint[];
  published: { total: number; inside: number; over: number; abstained: number; told: number };
};

export type AgentStep = {
  tool: string;
  args: Record<string, unknown>;
  verdict: "done" | "denied";
  why: string;
};
export type AgentRun = {
  id: string;
  wake: string;
  planner: "model" | "rules";
  model: string | null;
  fallbackReason: string | null;
  plan: AgentStep[];
  latencyMs: number | null;
  at: string;
  patientName: string;
};
export type Mission = {
  feed: Desk["feed"];
  hl7: {
    id: string;
    at: string;
    /** When the event happened in the department, from the message header. */
    sentAt: string | null;
    outcome: string;
    type: string;
    name: string;
    raw: string;
  }[];
  runs: AgentRun[];
  thread: {
    id: string;
    audience: "patient" | "contact";
    direction: "in" | "out";
    channel: "web" | "sms" | "voice";
    kind: string;
    body: string;
    at: string;
    patientName: string;
    relationship: string | null;
  }[];
  texts: { id: string; to: string; body: string; status: string; at: string }[];
  totals: {
    runs: number;
    modelRuns: number;
    denied: number;
    held: number;
    messages: number;
    tasks: number;
    open: number;
  };
};

export type PatientDetail = {
  id: string;
  name: string;
  visitNumber: string;
  age: number | null;
  step: string;
  friendlyStep: number;
  ctas: number | null;
  stream: string;
  area: string | null;
  flags: string[];
  unmapped: boolean;
  ended: boolean;
  testsInProgress: boolean;
  consultRequested: boolean;
  bedRequested: boolean;
  minutesInDepartment: number | null;
  minutesWaiting: number | null;
  steps: { label: string; at: string | null; state: "done" | "now" | "next" }[];
  testsStartedWaiting: string | null;
  timeline: { at: string; kind: string; source: string; label: string }[];
  estimates: DeskStage[];
  published: {
    at: string;
    low: number | null;
    high: number | null;
    abstain: string | null;
    reason: string | null;
    actual: number | null;
  }[];
  contacts: {
    id: string;
    name: string;
    relationship: string;
    scopes: VisitContact["scopes"];
    texts: boolean;
  }[];
  tasks: {
    id: string;
    kind: DeskTask["kind"];
    priority: 1 | 2 | 3;
    summary: string;
    state: "open" | "done" | "not_needed";
    createdAt: string;
    closedAt: string | null;
  }[];
  messages: Omit<Mission["thread"][number], "patientName">[];
  runs: Omit<AgentRun, "patientName">[];
};

const base = "/api/backend/journey";
async function family<T>(token: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/family/${token}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!response.ok) throw new Error("unavailable");
  return (await response.json()) as T;
}
export const journey = {
  visit: () => api<Visit>(`${base}/visit`, undefined, "GET", "patient"),
  say: (text: string) =>
    api<{ kind: string; reply: string }>(`${base}/visit/messages`, { text }, "POST", "patient"),
  checkIn: (answer: "same" | "better" | "worse") =>
    api<{ reply: string }>(`${base}/visit/check-in`, { answer }, "POST", "patient"),
  addContact: (input: {
    name: string;
    relationship: string;
    phone: string;
    scopes: VisitContact["scopes"];
  }) => api<{ id: string; link: string }>(`${base}/visit/contacts`, input, "POST", "patient"),
  withdrawContact: (id: string) =>
    api(`${base}/visit/contacts/${id}/withdraw`, {}, "POST", "patient"),
  desk: () => api<Desk>(`${base}/desk`, undefined, "GET", "professional"),
  accuracy: () => api<Accuracy>(`${base}/desk/accuracy`, undefined, "GET", "professional"),
  mission: () => api<Mission>(`${base}/desk/mission`, undefined, "GET", "professional"),
  patient: (id: string) =>
    api<PatientDetail>(`${base}/desk/encounters/${id}`, undefined, "GET", "professional"),
  family: (token: string) => family<FamilyVisit>(token),
  familyAsk: (token: string, text: string) =>
    family<{ kind: string; reply: string }>(token, { text }),
  setFlag: (encounterId: string, flag: string, active: boolean) =>
    api(`${base}/desk/encounters/${encounterId}/flags`, { flag, active }, "POST", "professional"),
  closeTask: (id: string, outcome: "done" | "not_needed") =>
    api(`${base}/desk/tasks/${id}/close`, { outcome }, "POST", "professional"),
};

export const stageNames: Record<StageName, string> = {
  triage: "Triage",
  provider: "Seen",
  results: "Results",
  decision: "Decision",
  bed: "Bed",
};
export const stepNames: Record<string, string> = {
  arrived: "Checked in",
  waiting: "Waiting to be seen",
  being_seen: "Being seen",
  deciding: "Results back",
  admitted_waiting_bed: "Admitted, waiting for a bed",
  moved_to_unit: "Moved to a unit",
  discharged: "Visit ended",
  left: "Left before being seen",
  cancelled: "Cancelled",
};

export function clock(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Halifax",
  })
    .format(new Date(value))
    .toLowerCase();
}

export function minutesText(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest ? `${Math.floor(minutes / 60)} h ${rest} min` : `${Math.floor(minutes / 60)} h`;
}
