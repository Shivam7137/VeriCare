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
    result: { confirmationRef?: string; booking?: Booking; status?: string } | null;
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
export const displayTimeZone = "America/Halifax";
export const timeZoneLabel = "Halifax time";
export function date(value: string) {
  return new Intl.DateTimeFormat("en-CA", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: displayTimeZone,
    timeZoneName: "short",
  }).format(new Date(value));
}
// Date inputs follow the browser's local zone; ISO payloads preserve exact instants.
export function inputDate(value = Date.now()) {
  const instant = new Date(value);
  return new Date(value - instant.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function inputTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
export function windowInput(start: string, end: string): Window {
  return {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(end).toISOString(),
    timeZone: inputTimeZone(),
  };
}
const errors: Record<string, string> = {
  invalid_voice_code:
    "This access code has expired or was already used. Generate a fresh code and try again.",
  voice_verification_locked:
    "This call cannot accept more codes. Start a new call with a fresh code.",
  pending_action_exists: "Review or cancel the existing action before preparing another one.",
  pending_action_missing: "That action is no longer pending. Review the latest call details.",
  call_ended: "This call has ended. Start a new simulated call to continue.",
  code_unavailable: "A phone access code could not be created. Please retry.",
  live_keypad_required:
    "Approve this action on the phone after the readback. Press 1 to approve or 2 to cancel.",
  transfer_loop: "Choose a destination other than the VeriCare phone line.",
  transfer_destination_unavailable:
    "This teammate needs a valid phone destination for a live transfer.",
  transfer_in_progress: "The transfer is in progress. Wait for the call result.",
  pending_action_expired: "This action has expired. Prepare it again and review the new details.",

  invalid_portal: "Open the patient or healthcare professional portal to continue.",
  portal_role_not_allowed: "This workspace is unavailable. Reload to reconnect.",
  unauthorized:
    "The demo connection has expired. Reload to reconnect or ask the demo host to refresh access.",
  demo_session_expired: "Demo access has expired. Ask the demo host to refresh access, then retry.",
  demo_setup_required:
    "The demo workspace is unavailable. Ask the demo host to refresh access, then retry.",
  demo_unavailable: "The demo workspace is not available on this host.",
  revision_conflict:
    "This record changed while you were working. Review the refreshed details and try again.",
  callback_required: "Wait for the simulated follow-up update before confirming this appointment.",
  slot_unavailable: "That appointment time is no longer available. Choose another time.",
  invalid_windows:
    "Choose future availability and a callback window that ends before the appointment.",
  callback_window_unavailable:
    "The callback window is unavailable. Update it before proposing a time.",
  invalid_input: "Check the dates and required fields, then try again.",
  no_active_visit: "This visit has ended, so this can no longer be done.",
  duplicate_contact: "This number is already getting your updates.",
  storage_unavailable: "The backend is temporarily unavailable. Your saved requests are preserved.",
  service_unavailable:
    "The service is temporarily unavailable. Your saved work is preserved. Please retry.",
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
