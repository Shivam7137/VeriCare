import { orderRequests } from "./workspace";
import { api, type Progress, type Queue, type Slot } from "./ui";

export type DesktopCall = {
  id: string;
  patientName?: string | null;
  taskId: string | null;
  direction: "inbound" | "outbound";
  mode: "simulated" | "twilio";
  status: string;
  createdAt: string;
  dueAt: string | null;
  maskedNumber: string | null;
  lastError: string | null;
  pendingAction: { description: string } | null;
};
export type VoiceReadiness = {
  mode: "simulated" | "twilio";
  ready: boolean;
  liveReady: boolean;
  missing: string[];
  invalid: string[];
  phoneNumber?: string | null;
  allNumbersAllowed?: boolean;
  agents: { id: string; name: string; description: string }[];
};
export type DesktopBooking = {
  id: string;
  patientId: string;
  startsAt: string;
  endsAt: string;
};
export type DesktopProgress = Progress & {
  workflow: (NonNullable<Progress["workflow"]> & { appointmentId: string }) | null;
};
export type DesktopSnapshot = {
  tasks: DesktopProgress[];
  calls: DesktopCall[];
  voice: VoiceReadiness;
  queue: Queue;
  bookings: DesktopBooking[];
  slots: Slot[];
  updatedAt: string;
};
export type RequestFilter = "all" | "open" | "review" | "patient" | "completed" | "stopped";

export const stoppedStates = new Set(["completed", "withdrawn", "staff_takeover"]);
export const activeCallStates = new Set([
  "awaiting_verification",
  "dialing",
  "ringing",
  "in_progress",
  "transferring",
]);

export function needsReview(progress: Progress, calls: DesktopCall[]) {
  return (
    ["awaiting_proposal", "awaiting_staff_approval", "staff_takeover", "reconciling"].includes(
      progress.task.state,
    ) ||
    (!["completed", "withdrawn"].includes(progress.task.state) &&
      calls.some((call) => call.taskId === progress.task.id && call.status === "handoff"))
  );
}

export function filterRequests(
  tasks: DesktopProgress[],
  calls: DesktopCall[],
  query: string,
  filter: RequestFilter,
) {
  const search = query.trim().toLocaleLowerCase();
  return orderRequests(
    tasks.filter((progress) => {
      const task = progress.task;
      const matchesSearch = [
        task.id,
        task.patientId,
        task.summary,
        progress.patient?.displayName ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(search));
      const matchesState =
        filter === "all" ||
        (filter === "open" && !stoppedStates.has(task.state)) ||
        (filter === "review" && needsReview(progress, calls)) ||
        (filter === "patient" && task.state === "awaiting_patient_confirmation") ||
        (filter === "completed" && task.state === "completed") ||
        (filter === "stopped" && ["withdrawn", "staff_takeover"].includes(task.state));
      return matchesSearch && matchesState;
    }),
  );
}

export function readable(value: string) {
  return value.replaceAll("_", " ");
}

export function taskLink(id: string) {
  return `/professional?request=${encodeURIComponent(id)}#requests`;
}

export async function loadDesktopSnapshot(): Promise<DesktopSnapshot> {
  const [queue, history, voice] = await Promise.all([
    api<Queue & { tasks: DesktopProgress[] }>(
      "/api/backend/operator/queue",
      undefined,
      undefined,
      "professional",
    ),
    api<{ calls: DesktopCall[] }>("/api/backend/voice/calls", undefined, undefined, "professional"),
    api<VoiceReadiness>("/api/backend/voice/config", undefined, undefined, "professional"),
  ]);
  const bookings = [
    ...new Map(
      queue.tasks.flatMap(({ booking }) => (booking ? [[booking.id, booking] as const] : [])),
    ).values(),
  ];
  const patientId = queue.tasks[0]?.task.patientId;
  const availability = patientId
    ? await api<{ slots: Slot[] }>(
        `/api/backend/slots?patientId=${encodeURIComponent(patientId)}`,
        undefined,
        undefined,
        "professional",
      )
    : { slots: [] };
  return {
    tasks: queue.tasks,
    calls: history.calls.map((call) => ({
      ...call,
      patientName: queue.tasks.find(({ task }) => task.id === call.taskId)?.patient?.displayName,
    })),
    queue,
    voice,
    bookings,
    slots: availability.slots,
    updatedAt: new Date().toISOString(),
  };
}
