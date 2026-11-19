import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { BackendError } from "../../domain.js";
import { authenticate, type Principal } from "../../identity.js";
import type { Agent } from "../intake.js";
import { judgePhone } from "./contact.js";
import { createDemoDirector, type DemoDirector } from "./director.js";
import { SPEEDS, type DemoAction } from "./types.js";

// Demo control bar API. Registered only when the synthetic demo is enabled (loopback only):
// it can add fictional patients, move the department clock and reset the fictional visits.

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const whole = (value: unknown, low: number, high: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;

/** Reads a request body into one of the actions the director knows. Anything else is refused. */
export function parseDemoAction(body: unknown): DemoAction {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const invalid = () => new BackendError("invalid_input", 400);
  switch (input.type) {
    case "play":
    case "pause":
    case "surge":
    case "reset":
    case "keep":
    case "reseat":
      return { type: input.type };
    case "speed":
      if (!SPEEDS.some((speed) => speed === input.value)) throw invalid();
      return { type: "speed", value: input.value as (typeof SPEEDS)[number] };
    case "skip":
      if (!whole(input.minutes, 1, 240)) throw invalid();
      return { type: "skip", minutes: input.minutes as number };
    case "add":
      if (!whole(input.count, 1, 10)) throw invalid();
      if (input.ctas !== undefined && !whole(input.ctas, 1, 5)) throw invalid();
      return {
        type: "add",
        count: input.count as number,
        ...(input.ctas === undefined ? {} : { ctas: input.ctas as 1 | 2 | 3 | 4 | 5 }),
      };
    case "next":
      if (typeof input.patientId !== "string" || !uuid.test(input.patientId)) throw invalid();
      return { type: "next", patientId: input.patientId };
    case "arrivals":
      if (input.value !== "off" && input.value !== "normal" && input.value !== "busy")
        throw invalid();
      return { type: "arrivals", value: input.value };
    case "staffing":
      if (input.value !== "low" && input.value !== "normal" && input.value !== "high")
        throw invalid();
      return { type: "staffing", value: input.value };
    case "contact":
      if (typeof input.phone !== "string" || input.phone.length > 32) throw invalid();
      if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 80))
        throw invalid();
      if (input.estimates !== undefined && typeof input.estimates !== "boolean") throw invalid();
      return {
        type: "contact",
        phone: input.phone,
        name: (input.name as string) ?? "",
        ...(input.estimates === false ? { estimates: false } : {}),
      };
    case "ask": {
      const text = typeof input.text === "string" ? input.text.trim() : "";
      if (typeof input.contactId !== "string" || !uuid.test(input.contactId)) throw invalid();
      if (!text || text.length > 500) throw invalid();
      return { type: "ask", contactId: input.contactId, text };
    }
    default:
      throw invalid();
  }
}

/** DEMO_IDLE_RESET_MINUTES, in minutes: 0 turns the automatic restart off. Default 30. */
function idleResetMinutes(): number {
  const value = Number(process.env.DEMO_IDLE_RESET_MINUTES);
  return process.env.DEMO_IDLE_RESET_MINUTES !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : 30;
}

export function registerDemoRoutes(
  app: FastifyInstance,
  pool: Pool,
  options: { agent?: Agent; now?: () => Date; director?: DemoDirector } = {},
): DemoDirector {
  const now = options.now ?? (() => new Date());
  const director =
    options.director ??
    createDemoDirector(pool, {
      now,
      agent: options.agent ?? null,
      idleResetMinutes: idleResetMinutes(),
      onError: (error) =>
        console.error(`Demo director: ${error instanceof Error ? error.message : "unknown error"}`),
    });
  // Only the real server runs the clock. Tests drive the director directly.
  if (!options.director && process.env.NODE_ENV !== "test") director.start();
  app.addHook("onClose", async () => director.stop());

  app.register(async (demo) => {
    const identities = new WeakMap<FastifyRequest, Principal>();
    demo.setErrorHandler((error, _request, reply) => {
      if (error instanceof BackendError)
        return reply.code(error.statusCode).send({ error: error.code });
      // Malformed JSON and other request errors are the caller's, not the database's.
      const status = (error as { statusCode?: number }).statusCode;
      if (status && status >= 400 && status < 500)
        return reply.code(400).send({ error: "invalid_input" });
      return reply.code(503).send({ error: "storage_unavailable" });
    });
    demo.addHook("onRequest", async (request) => {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? "");
      if (!match) throw new BackendError("unauthorized", 401);
      const identity = await authenticate(pool, match[1]!, now());
      // The staff app and the patient app both host the bar.
      if (identity.role !== "staff" && identity.role !== "patient")
        throw new BackendError("not_found", 404);
      identities.set(request, identity);
    });
    const who = (request: FastifyRequest) => identities.get(request)!;
    const focusOf = (request: FastifyRequest, asked?: string) => {
      const identity = who(request);
      return {
        patientId: identity.role === "patient" ? identity.patientId : null,
        // A patient's bar always follows their own visit; only staff choose another one.
        encounterId: identity.role === "staff" && asked && uuid.test(asked) ? asked : null,
      };
    };

    // The judge's own phone: the texts sent to the contact this browser created, if any.
    const withPhone = async <T extends { active: boolean }>(state: T, contact?: unknown) =>
      state.active && typeof contact === "string" && uuid.test(contact)
        ? { ...state, phone: await judgePhone(pool, contact) }
        : state;

    demo.get("/journey/demo/state", async (request) => {
      const { visit, contact } = request.query as { visit?: string; contact?: string };
      return withPhone(await director.state(focusOf(request, visit)), contact);
    });
    demo.post("/journey/demo/act", async (request) => {
      const body = request.body as Record<string, unknown> | null;
      const action = parseDemoAction(body);
      const asked = typeof body?.focus === "string" ? body.focus : undefined;
      const result = await director.act(action, focusOf(request, asked));
      const contact = result.contact?.id ?? body?.contact;
      return { ...result, state: await withPhone(result.state, contact) };
    });
  });
  return director;
}
