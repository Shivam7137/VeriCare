import type { VisitState } from "@prc/contracts";
import type { Audience } from "./guardian.js";
import type { RangeReason } from "./estimate.js";

// The approved wording. Every fact a person hears or reads comes from here,
// filled in by code. No language model writes status or numbers.

export const NEUTRAL_REPLY =
  "I'm not able to share information about that person right now. I can connect you with our staff if you'd like.";
/** Identical for every transfer so the wording never hints at the reason. */
export const HANDOFF_REPLY = "For an update, please speak with the ER team.";
export const STALE_REPLY =
  "We can't see live updates right now. Please ask your nurse for your status.";
export const WORSE_LINE = "Feeling worse? Tell the triage nurse right away or call 911.";

// Fixed replies to what people tell us. The Visit Agent chooses which applies; code owns the words.
export const WORSE_REPLY =
  "Thank you for telling us. We've asked the triage nurse to check on you now. If this is an emergency, tell staff right away or call 911.";
export const LEAVING_REPLY =
  "Thanks for telling us. We've let the triage nurse know. Please speak with them before you go.";
export const QUESTION_REPLY =
  "I can't answer that myself, so I've passed your question to the care team. I'll let you know when someone picks it up.";
export const INTERPRETER_REPLY = "We've asked the team to arrange a free interpreter for you.";
export const COMFORT_REPLY = "We've let the team know, and someone will come by when they can.";
export const CHECK_IN_ASK =
  "You've been waiting a while. Are you feeling the same, better or worse? Reply SAME, BETTER or WORSE.";
export const CONTACT_WORSE_REPLY =
  "Thank you for telling us. We've asked the triage nurse to check on them now. If this is an emergency, call 911.";
export const PICKED_UP = "The care team has picked up your question.";
export const SMS_INVITE =
  "VeriCare: you can get text updates about your emergency visit. Reply YES to start. Reply STOP at any time.";
export const SMS_WELCOME =
  "You're set. We'll text you when your step or estimate changes. Text STATUS any time. Feeling worse? Tell the triage nurse or call 911.";
export const SMS_STOPPED = "You won't get more texts about this visit.";

export const stepLabels = [
  "Checked in",
  "Waiting to be seen",
  "Being seen",
  "Tests and results",
  "Next steps",
] as const;

/** One sentence for the current step. Contacts hear the third person and no severity words. */
export function statusSentence(state: VisitState, audience: Audience, firstName: string): string {
  const you = audience === "patient";
  const who = you ? "You" : firstName;
  const are = you ? "are" : "is";
  const have = you ? "have" : "has";
  switch (state.step) {
    case "arrived":
      return `${who} ${are} checked in at the emergency department.`;
    case "waiting":
      return state.testsInProgress
        ? `${who} ${are} waiting to be seen, and some tests have been started.`
        : `${who} ${are} waiting to be seen by the care team.`;
    case "being_seen":
      return state.testsInProgress
        ? `The care team is with ${you ? "you" : firstName}, and tests are underway.`
        : `The care team is with ${you ? "you" : firstName} now.`;
    case "deciding":
      return `Test results are back and the team is planning ${you ? "your" : `${firstName}'s`} next steps.`;
    case "admitted_waiting_bed":
      return `${who} ${are} being admitted and ${are} waiting for a hospital bed.`;
    case "moved_to_unit":
      return `${who} ${have} moved to an inpatient unit.`;
    case "discharged":
      return `${you ? "Your" : `${firstName}'s`} emergency visit has ended.`;
    case "left":
      return `${you ? "Your" : `${firstName}'s`} emergency visit has ended.`;
    case "cancelled":
      return HANDOFF_REPLY;
  }
}

/** Upper bound first, because a wait that runs over is the harmful error. */
export function rangeSentence(lowMinutes: number, highMinutes: number, audience: Audience): string {
  const subject = audience === "patient" ? "You'll" : "They'll";
  const sooner = lowMinutes < highMinutes - 30 ? ", possibly sooner" : "";
  return `${subject} likely be seen within about ${duration(highMinutes)}${sooner}. Sicker patients are seen first, so this can change.`;
}

export type OutlookStage = "triage" | "results" | "decision";

export const outlookLabel = (stage: OutlookStage, waiting: boolean): string =>
  stage === "triage"
    ? "Triage"
    : stage === "results"
      ? "Test results"
      : waiting
        ? "Whole visit"
        : "Next steps decided";

/** Typical time to a later step. Same shape as the wait range: upper bound first, never a promise. */
export function outlookSentence(
  stage: OutlookStage,
  lowMinutes: number,
  highMinutes: number,
  audience: Audience,
  waiting: boolean,
): string {
  const sooner = lowMinutes < highMinutes - 30 ? ", often sooner" : "";
  const within = `within about ${duration(highMinutes)}`;
  switch (stage) {
    case "triage":
      return `A triage nurse usually sees people ${within}.`;
    case "results":
      return `Results for the tests under way are usually back ${within}${sooner}. Scans can take longer than blood tests.`;
    case "decision":
      return waiting
        ? `Counting the wait to be seen, visits like ${audience === "patient" ? "yours" : "this one"} usually finish ${within} from now${sooner}.`
        : `The team usually decides on next steps ${within} from now${sooner}.`;
  }
}

export const BUSY_SENTENCE =
  "It's very busy right now and we can't give a reliable estimate. A nurse can tell you more.";

export function reasonSentence(reason: RangeReason): string | null {
  switch (reason) {
    case "more_urgent_arrivals":
      return "Several very sick patients arrived, so the wait is longer.";
    case "pace_slower":
      return "The team is seeing patients more slowly right now.";
    case "pace_faster":
      return "The team is moving through patients faster.";
    default:
      return null;
  }
}

export function duration(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourText = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest === 0 ? hourText : `${hourText} ${rest} minutes`;
}
