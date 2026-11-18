import type { AgentRun } from "../../lib/journey";

// Plain-language names for agent wakes, tools and audit actions, shared by the
// Agent & audit view and each patient's Visit Agent tab.

export const wakeNames: Record<string, string> = {
  step_change: "Step changed",
  estimate_shift: "Estimate moved",
  check_in_due: "Check-in due",
  inbound_message: "Patient wrote in",
  contact_question: "Family wrote in",
};
export const toolNames: Record<string, string> = {
  notify: "sent an update",
  ask_check_in: "asked how they feel",
  open_staff_task: "put it on the Desk",
  answer_from_kb: "answered from the knowledge base",
  handoff: "handed off to staff",
  schedule_wake: "will check in later",
  do_nothing: "held back",
};
export const actionNames: Record<string, string> = {
  feed_message: "Feed message applied",
  visit_silenced: "Visit silenced",
  step_update_allow: "Step update sent",
  step_update_handoff: "Step update withheld",
  step_update_neutral: "Step update withheld",
  status_request_allow: "Status shared",
  status_request_handoff: "Status withheld",
  consent_given: "Consent given",
  consent_withdrawn: "Consent withdrawn",
  flag_set: "Flag set",
  flag_cleared: "Flag cleared",
  task_recheck: "Recheck raised",
  task_leaving: "Leaving alert raised",
  task_question: "Question relayed",
  task_interpreter: "Interpreter requested",
  task_closed_done: "Task done",
  task_closed_not_needed: "Task not needed",
  task_comfort: "Comfort request raised",
  agent_run: "Visit Agent decided",
  voice_status_allow: "Status shared by phone",
  voice_status_handoff: "Phone status withheld",
  voice_status_neutral: "Phone status withheld",
};

export function describeRun(run: Pick<AgentRun, "wake" | "plan" | "planner">) {
  const done = run.plan.filter((step) => step.verdict === "done");
  const said = done.find((step) => step.why && !step.why.startsWith("Floor"))?.why;
  return {
    wake: wakeNames[run.wake] ?? run.wake,
    did:
      [...new Set(done.map((step) => toolNames[step.tool] ?? step.tool))].join(", ") ||
      "nothing sent",
    refused: run.plan.length - done.length,
    why: run.planner === "model" ? said : undefined,
  };
}
