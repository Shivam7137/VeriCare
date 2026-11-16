import {
  checkInAnswerSchema,
  contactInputSchema,
  patientMessageInputSchema,
  staffFlagInputSchema,
  staffTaskCloseSchema,
} from "@prc/contracts";
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { BackendError } from "../domain.js";
import { authenticate, type Principal } from "../identity.js";
import { validateTwilioWebhook } from "../twilio-provider.js";
import { readVoiceConfig, type VoiceConfig } from "../voice-config.js";
import { accuracyView, contactByLink, familyView, missionView } from "./insight.js";
import {
  addContact,
  checkIn,
  patientMessage,
  staffCloseTask,
  staffSetFlag,
  visitMessage,
  withdrawContact,
  type Agent,
} from "./intake.js";
import { HANDOFF_REPLY } from "./messages.js";
import { inboundSms, smsStatus, twiml } from "./sms.js";
import { deskView, patientVisitView } from "./views.js";

type IdRoute = { Params: { id: string } };

export function registerJourneyRoutes(
  app: FastifyInstance,
  pool: Pool,
  options: {
    now?: () => Date;
    siteId?: string;
    /** The Visit Agent's runner. Without it the rules path answers everything. */
    agent?: Agent;
    config?: VoiceConfig;
  } = {},
): void {
  const now = options.now ?? (() => new Date());
  const siteId = options.siteId ?? "qeii-hi";
  const agent = options.agent ?? null;
  const safeErrors = (scope: FastifyInstance) =>
    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof BackendError)
        return reply.code(error.statusCode).send({ error: error.code });
      if (
        error instanceof Error &&
        (error.name === "ZodError" ||
          ("code" in error &&
            typeof error.code === "string" &&
            (error.code.startsWith("FST_ERR_CTP_") || error.code === "FST_ERR_VALIDATION")))
      )
        return reply.code(400).send({ error: "invalid_input" });
      return reply.code(503).send({ error: "storage_unavailable" });
    });

  // The family page. The link in the contact's text message is the only key, so these
  // routes take no session. They are rate-limited per link and reveal nothing on a bad one.
  app.register(async (family) => {
    safeErrors(family);
    const recent = new Map<string, number[]>();
    const limited = (token: string, most: number) => {
      const cutoff = Date.now() - 60_000;
      const hits = (recent.get(token) ?? []).filter((at) => at > cutoff);
      hits.push(Date.now());
      recent.set(token, hits);
      if (recent.size > 5000) recent.clear();
      return hits.length > most;
    };
    type LinkRoute = { Params: { token: string } };
    family.get<LinkRoute>("/journey/family/:token", async (request, reply) => {
      if (limited(request.params.token, 90)) return reply.code(429).send({ error: "slow_down" });
      return familyView(pool, request.params.token, now());
    });
    family.post<LinkRoute>("/journey/family/:token/messages", async (request, reply) => {
      if (limited(`ask:${request.params.token}`, 6))
        return reply.code(429).send({ error: "slow_down" });
      const { text } = patientMessageInputSchema.parse(request.body);
      const found = await contactByLink(pool, request.params.token);
      // Same answer as a visit that has gone quiet, so a bad link learns nothing.
      if (!found || found.encounter.state.ended) return { kind: "handoff", reply: HANDOFF_REPLY };
      return visitMessage(
        pool,
        { encounterId: found.encounter.id, contactId: found.contact.id },
        text,
        "web",
        now(),
        agent,
      );
    });
  });

  // Text-message webhooks from the phone provider. Each request must carry a valid signature.
  app.register(async (sms) => {
    await sms.register(formbody);
    const config = options.config ?? readVoiceConfig();
    const signed = (request: FastifyRequest) =>
      validateTwilioWebhook(config, {
        method: request.method,
        signature:
          typeof request.headers["x-twilio-signature"] === "string"
            ? request.headers["x-twilio-signature"]
            : undefined,
        url: request.raw.url ?? request.url,
        body: request.body,
        contentType: request.headers["content-type"],
      });
    sms.post("/journey/sms/inbound", async (request, reply) => {
      if (!signed(request)) return reply.code(403).send({ error: "invalid_twilio_signature" });
      const form = request.body as Record<string, string>;
      let answer: string | null = null;
      try {
        answer = await inboundSms(
          pool,
          { from: form.From ?? "", body: form.Body ?? "", sid: form.MessageSid ?? "" },
          now(),
          agent,
        );
      } catch {
        // Never let the provider retry into a storm; the text is simply not answered.
      }
      return reply.type("text/xml").send(twiml(answer));
    });
    sms.post<IdRoute>("/journey/sms/:id/status", async (request, reply) => {
      if (!signed(request)) return reply.code(403).send({ error: "invalid_twilio_signature" });
      const form = request.body as Record<string, string>;
      try {
        await smsStatus(
          pool,
          request.params.id,
          { sid: form.MessageSid ?? "", status: form.MessageStatus ?? "" },
          now(),
        );
      } catch {
        return reply.code(400).send({ error: "invalid_input" });
      }
      return reply.code(204).send();
    });
  });

  app.register(async (journey) => {
    const identities = new WeakMap<FastifyRequest, Principal>();
    const actor = (request: FastifyRequest) => {
      const identity = identities.get(request);
      if (!identity) throw new BackendError("unauthorized", 401);
      return identity;
    };
    // A patient session sees only its own visit. The id comes from the session, never the request.
    const patient = (request: FastifyRequest) => {
      const identity = actor(request);
      if (identity.role !== "patient" || !identity.patientId)
        throw new BackendError("not_found", 404);
      return identity.patientId;
    };
    const staff = (request: FastifyRequest) => {
      const identity = actor(request);
      if (identity.role !== "staff" || !identity.departmentId)
        throw new BackendError("not_found", 404);
      return { id: identity.id, departmentId: identity.departmentId };
    };
    safeErrors(journey);
    journey.addHook("onRequest", async (request) => {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? "");
      if (!match) throw new BackendError("unauthorized", 401);
      identities.set(request, await authenticate(pool, match[1]!, now()));
    });

    journey.get("/journey/visit", async (request) =>
      patientVisitView(pool, patient(request), now()),
    );
    journey.post("/journey/visit/messages", async (request) =>
      patientMessage(
        pool,
        patient(request),
        patientMessageInputSchema.parse(request.body).text,
        now(),
        agent,
      ),
    );
    journey.post("/journey/visit/check-in", async (request) =>
      checkIn(pool, patient(request), checkInAnswerSchema.parse(request.body).answer, now()),
    );
    journey.post("/journey/visit/contacts", async (request, reply) =>
      reply
        .code(201)
        .send(
          await addContact(pool, patient(request), contactInputSchema.parse(request.body), now()),
        ),
    );
    journey.post<IdRoute>("/journey/visit/contacts/:id/withdraw", async (request) =>
      withdrawContact(pool, patient(request), request.params.id, now()),
    );

    journey.get("/journey/desk", async (request) =>
      deskView(pool, staff(request).departmentId, siteId, now()),
    );
    journey.get("/journey/desk/accuracy", async (request) =>
      accuracyView(pool, staff(request).departmentId, siteId),
    );
    journey.get("/journey/desk/mission", async (request) =>
      missionView(pool, staff(request).departmentId, siteId, now()),
    );
    journey.post<IdRoute>("/journey/desk/encounters/:id/flags", async (request) => {
      const input = staffFlagInputSchema.parse(request.body);
      return staffSetFlag(
        pool,
        staff(request),
        request.params.id,
        input.flag,
        input.active,
        now(),
        agent,
      );
    });
    journey.post<IdRoute>("/journey/desk/tasks/:id/close", async (request) =>
      staffCloseTask(
        pool,
        staff(request),
        request.params.id,
        staffTaskCloseSchema.parse(request.body).outcome,
        now(),
      ),
    );
  });
}
