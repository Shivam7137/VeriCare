// The language model behind the Visit Agent. It only ever returns tool calls;
// code decides what each call is allowed to do. Server-only: the key never leaves this process.

export type ToolSpec = {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Every property is required and no extras are allowed. */
  parameters: Record<string, unknown>;
};
export type ToolCall = { name: string; args: Record<string, unknown> };
export type PlanRequest = { instructions: string; context: unknown; tools: readonly ToolSpec[] };

export interface Planner {
  readonly model: string;
  plan(request: PlanRequest): Promise<ToolCall[]>;
}

export class PlannerError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "PlannerError";
  }
}

type Fetch = typeof fetch;

/** Reads the tool calls out of a Responses API reply. Anything else in the reply is ignored. */
export function toolCallsFrom(reply: unknown): ToolCall[] {
  const output = (reply as { output?: unknown } | null)?.output;
  if (!Array.isArray(output)) throw new PlannerError("malformed_reply");
  const calls: ToolCall[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "function_call")
      continue;
    const { name, arguments: raw } = item as { name?: unknown; arguments?: unknown };
    if (typeof name !== "string" || typeof raw !== "string")
      throw new PlannerError("malformed_reply");
    let args: unknown;
    try {
      args = JSON.parse(raw);
    } catch {
      throw new PlannerError("malformed_arguments");
    }
    if (!args || typeof args !== "object" || Array.isArray(args))
      throw new PlannerError("malformed_arguments");
    calls.push({ name, args: args as Record<string, unknown> });
  }
  return calls;
}

export function createOpenAiPlanner(options: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: Fetch;
}): Planner {
  const send = options.fetch ?? fetch;
  return {
    model: options.model,
    async plan(request) {
      let response: Response;
      try {
        response = await send("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: options.model,
            instructions: request.instructions,
            input: JSON.stringify(request.context),
            tools: request.tools.map((tool) => ({ type: "function", strict: true, ...tool })),
            tool_choice: "required",
            parallel_tool_calls: true,
            store: false,
          }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
        });
      } catch (error) {
        throw new PlannerError(
          error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network",
        );
      }
      // The status is enough for the log. The body may echo the request, so it is not kept.
      if (!response.ok) throw new PlannerError(`http_${response.status}`);
      let reply: unknown;
      try {
        reply = await response.json();
      } catch {
        throw new PlannerError("malformed_reply");
      }
      return toolCallsFrom(reply);
    },
  };
}

/**
 * The planner the server runs with, or null for the rules path. A key alone never enables
 * the model: VISIT_AGENT_ENABLED must be "true" as well.
 */
export function readPlanner(env: NodeJS.ProcessEnv = process.env): Planner | null {
  const apiKey = env.VISIT_AGENT_OPENAI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  const model =
    env.VISIT_AGENT_MODEL?.trim() || env.OPENAI_VOICE_BACKEND_MODEL?.trim() || "gpt-6-luna";
  if (env.VISIT_AGENT_ENABLED !== "true" || !apiKey) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(model)) return null;
  return createOpenAiPlanner({ apiKey, model });
}
