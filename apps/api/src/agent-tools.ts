import { agentToolInputSchema, timeWindowSchema } from "@prc/contracts";
import type { TimeWindow } from "./domain.js";
import type { Principal } from "./identity.js";
import type { WorkflowService } from "./workflow.js";

// Explicit syntax: availability: START/END [IANA_ZONE]; callback: START/END [IANA_ZONE]
// START and END must be UTC ISO instants ending in Z. Never resolve relative dates.
function explicitWindow(text: string, label: string): TimeWindow | null {
  const segments = [...text.matchAll(new RegExp(`\\b${label}\\s*:\\s*([^;\\n]*)`, "gi"))];
  if (segments.length !== 1) return null;
  const value = segments[0]![1]!.trim();
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s*\/\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+\[([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)\]$/.exec(
      value,
    );
  if (!match) return null;
  const parsed = timeWindowSchema.safeParse({
    startsAt: match[1],
    endsAt: match[2],
    timeZone: match[3],
  });
  return parsed.success ? parsed.data : null;
}

export function interpretRequest(text: string) {
  const intent =
    /\breschedul(?:e|ing)\b/i.test(text) || /\b(?:move|change)\b[^.;\n]*\bappointment\b/i.test(text)
      ? ("reschedule" as const)
      : ("unknown" as const);
  const availability = explicitWindow(text, "availability");
  const callbackWindow = explicitWindow(text, "callback");
  const clarifications: string[] = [];
  if (intent === "unknown")
    clarifications.push("Describe the appointment change you want to request.");
  if (!availability)
    clarifications.push(
      "Provide availability: START/END [IANA_ZONE], using explicit UTC ISO instants ending in Z.",
    );
  if (!callbackWindow)
    clarifications.push(
      "Provide callback: START/END [IANA_ZONE], using explicit UTC ISO instants ending in Z.",
    );
  if (
    availability &&
    callbackWindow &&
    Date.parse(callbackWindow.endsAt) > Date.parse(availability.startsAt)
  ) {
    clarifications.push(
      "Provide a callback window that ends no later than the availability window starts.",
    );
  }
  return {
    intent,
    availability,
    callbackWindow,
    clarifications,
    ready: clarifications.length === 0,
  };
}

export async function runAgentTool(service: WorkflowService, actor: Principal, raw: unknown) {
  const input = agentToolInputSchema.parse(raw);
  let result;
  switch (input.tool) {
    case "progress":
      result = await service.progress(actor, input.taskId);
      break;
    case "request_callback":
      result = await service.callback(actor, input.taskId, input.input);
      break;
    case "confirm":
      result = await service.decide(actor, input.taskId, "patient_confirmation", input.input);
      break;
    case "withdraw":
      result = await service.withdraw(actor, input.taskId, input.input);
      break;
    case "call_ended":
      result = await service.callEnded(actor, input.taskId, input.evidenceRef);
      break;
  }
  return { tool: input.tool, result };
}
