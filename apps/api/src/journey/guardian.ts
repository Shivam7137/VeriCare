import type { ConsentScope, VisitState } from "@prc/contracts";

export const FEED_STALE_AFTER_MS = 15 * 60_000;

export type Audience = "patient" | "contact";
export type DisclosureRequest = "status" | "estimate";

export type GuardianInput = {
  audience: Audience;
  /** The patient's own session, or a contact who passed the one-time code on this call. */
  verified: boolean;
  /** Contacts only: active consent scopes the patient gave this person. Null when none. */
  consentScopes: readonly ConsentScope[] | null;
  state: VisitState | null;
  /** When the department's OPOR feed last delivered any message. */
  feedLastMessageAt: Date | null;
  now: Date;
  request: DisclosureRequest;
};

/** Internal reasons are for the audit log only. They are never spoken or sent. */
export type GuardianReason =
  | "unverified"
  | "no_visit"
  | "no_consent"
  | "sensitive_record"
  | "unmapped_state"
  | "critical_acuity"
  | "feed_stale"
  | "visit_cancelled";

export type GuardianDecision =
  | { outcome: "allow"; tier: 2 | 3; status: true; estimate: boolean }
  | { outcome: "neutral"; tier: 0; reason: GuardianReason }
  | { outcome: "handoff"; tier: 0; reason: GuardianReason };

const neutral = (reason: GuardianReason): GuardianDecision => ({
  outcome: "neutral",
  tier: 0,
  reason,
});
const handoff = (reason: GuardianReason): GuardianDecision => ({
  outcome: "handoff",
  tier: 0,
  reason,
});

/**
 * Decides what may be disclosed. It is plain code so no prompt can change it,
 * and it fails closed: any doubt becomes a neutral reply or a handoff.
 *
 * `neutral` is what an unknown caller hears whether or not the patient exists.
 * `handoff` connects a known, permitted person to staff with fixed wording.
 */
export function decideDisclosure(input: GuardianInput): GuardianDecision {
  const { audience, state } = input;
  if (!input.verified) return neutral("unverified");
  if (!state) return neutral("no_visit");
  if (audience === "contact") {
    const scopes = input.consentScopes;
    if (!scopes || !scopes.includes("status")) return neutral("no_consent");
  }
  if (state.step === "cancelled") return neutral("visit_cancelled");
  if (state.sensitivity.length > 0) return handoff("sensitive_record");
  if (state.unmapped) return handoff("unmapped_state");
  const critical = state.ctas === 1 || state.ctas === 2;
  // A contact never hears automated updates about a resuscitation or emergent case.
  if (critical && audience === "contact") return handoff("critical_acuity");
  const fresh =
    input.feedLastMessageAt !== null &&
    input.now.getTime() - input.feedLastMessageAt.getTime() <= FEED_STALE_AFTER_MS;
  if (!fresh && !state.ended) return handoff("feed_stale");

  const estimateScope =
    audience === "patient" || (input.consentScopes?.includes("estimates") ?? false);
  // Estimates cover only the wait to be seen, and never the most urgent patients.
  const estimate =
    input.request === "estimate" && estimateScope && !critical && state.step === "waiting";
  return { outcome: "allow", tier: audience === "patient" ? 3 : 2, status: true, estimate };
}

/**
 * Whether estimates for the steps after the wait (triage, results, the decision) may be
 * shared. The rule is the wait range's rule, applied to any step before the visit ends.
 * The wait for an inpatient bed is never shared through this path: it is staff-only.
 */
export function mayShareOutlook(input: GuardianInput): boolean {
  const { state } = input;
  if (!state || state.ended || state.step === "admitted_waiting_bed") return false;
  if (decideDisclosure(input).outcome !== "allow") return false;
  const scope =
    input.audience === "patient" || (input.consentScopes?.includes("estimates") ?? false);
  return scope && state.ctas !== 1 && state.ctas !== 2;
}
