import type { ProposalDraft, Task } from "@prc/contracts";
import { isPortal, type Portal } from "./portal";

export type Actor = { id: string; role: "patient" | "staff" | "operator" };
export type Slot = { id: string; startsAt: string; endsAt: string; available: boolean };
export type Booking = { id: string; patientId: string; startsAt: string; endsAt: string };
export type Window = { startsAt: string; endsAt: string; timeZone: string };
export type Progress = {
  task: Task;
  patient?: { id: string; displayName: string | null } | null;
  booking?: Booking | null;
  workflow: {
    availability: Window;
    callbackWindow: Window;
    callbackDelivered?: { version: number; at: string };
  } | null;
  activeProposal: ProposalDraft | null;
  actions: { id: string; kind: string; proposalVersion: number; status: string }[];
  events: {
    id: string;
    action: string;
    occurredAt: string;
    evidenceRef: string;
    actorDisplayName?: string | null;
  }[];
  jobs: { id: string; kind: string; status: string; dueAt: string; lastError: string | null }[];
  operation: {
    status: string;
    result: { confirmationRef?: string } | null;
    lastError: string | null;
  } | null;
};
export type Queue = {
  counts: {
    overduePendingActions: number;
    overdueJobs: number;
    failedDeliveries: number;
    reconciliation: number;
  };
};

export const labels: Record<Task["state"], string> = {
  awaiting_verification: "Verify request",
  awaiting_proposal: "Waiting for a proposal",
  awaiting_staff_approval: "Staff review",
  awaiting_patient_confirmation: "Patient confirmation",
  ready_to_execute: "Ready to book",
  executing: "Booking in progress",
  reconciling: "Checking booking result",
  completed: "Appointment changed",
  withdrawn: "Withdrawn",
  staff_takeover: "With staff",
};
export function date(value: string) {
  return (
    new Intl.DateTimeFormat("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    }).format(new Date(value)) + " UTC"
  );
}
export function inputDate(value = Date.now()) {
  return new Date(value).toISOString().slice(0, 16);
}
export function windowInput(start: string, end: string): Window {
  return {
    startsAt: new Date(start + ":00Z").toISOString(),
    endsAt: new Date(end + ":00Z").toISOString(),
    timeZone: "UTC",
  };
}
const errors: Record<string, string> = {
  invalid_portal: "Open the patient or healthcare professional portal to continue.",
  portal_role_not_allowed:
    "This account cannot use this portal. Sign in with the portal's demo account.",
  unauthorized: "Your demo session ended. Choose a demo account to sign in again.",
  demo_session_expired:
    "The local demo session expired. Renew it with the setup instructions below.",
  demo_setup_required:
    "Local demo accounts are unavailable. Run npm run demo:credentials from the repository root and check the API.",
  demo_unavailable:
    "Demo sign-in is available only on the local development server with ENABLE_SYNTHETIC_DEMO=true.",
  revision_conflict:
    "This request changed while you were working. Review the refreshed details and try again.",
  callback_required: "Wait for the agreed callback before confirming this appointment.",
  slot_unavailable: "That appointment time is no longer available. Choose another time.",
  invalid_windows:
    "Choose future availability and a callback window that ends before the appointment.",
  callback_window_unavailable:
    "The callback window is unavailable. Update it before proposing a time.",
  invalid_input: "Check the dates and required fields, then try again.",
  storage_unavailable: "The backend is temporarily unavailable. Your saved requests are preserved.",
  service_unavailable: "Cannot reach the backend. Check that the API and database are running.",
};
export async function api<T>(
  path: string,
  body?: unknown,
  method?: string,
  portal?: Portal,
): Promise<T> {
  const segment =
    typeof window === "undefined" ? undefined : window.location.pathname.split("/")[1];
  const scope = portal ?? (isPortal(segment) ? segment : undefined);
  const response = await fetch(path, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(scope ? { "x-prc-portal": scope } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      errors[result.error] ??
        `The action could not be completed (${result.error ?? response.status}). Refresh and review this request.`,
    );
  return result as T;
}
