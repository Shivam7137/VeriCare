import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import websocket from "@fastify/websocket";
import formbody from "@fastify/formbody";
import {
  voiceAccessCodeInputSchema,
  voiceVerifyInputSchema,
  voiceCallbackInputSchema,
  voiceToolInputSchema,
  voiceConfirmInputSchema,
  voiceEmptyInputSchema,
} from "@prc/contracts";
import { BackendError } from "./domain.js";
import { authenticate, type Principal } from "./identity.js";
import { VoiceStore } from "./voice-store.js";
import { VoiceAgent, voiceAgentInstructions, voiceAgentTools } from "./voice-agent.js";
import {
  readVoiceConfig,
  voiceNumberAllowed,
  voiceReadiness,
  type VoiceConfig,
} from "./voice-config.js";
import {
  connectStreamTwiml,
  retryTwiml,
  hangupTwiml,
  validateTwilioWebhook,
} from "./twilio-provider.js";
import { bridgeLive } from "./live-bridge.js";
import { terminalCalls } from "./voice-store-support.js";
import { createTwilioTransferProvider, transferOutcomeTwiml } from "./twilio-transfer.js";
import { registerVoiceDirectoryRoutes } from "./voice-directory-routes.js";
import type { TransferProvider } from "./voice-transfers.js";
import { VoiceMonitorStore } from "./voice-monitor-store.js";
import { RealtimeMonitor } from "./realtime-monitor.js";
import { createTwilioSmsProvider } from "./twilio-sms.js";
import { registerVoiceSmsRoutes } from "./voice-sms-routes.js";

type CallParams = { Params: { id: string } };
export function registerVoiceRoutes(
  app: FastifyInstance,
  pool: Pool,
  options: { config?: VoiceConfig; now?: () => Date; transferProvider?: TransferProvider } = {},
) {
  const config = options.config ?? readVoiceConfig();
  const now = options.now ?? (() => new Date());
  const store = new VoiceStore(pool, { now });
  const monitor = new VoiceMonitorStore(pool);
  const agent = new VoiceAgent(pool, {
    now,
    ownNumber: config.phoneNumber,
    transferProvider: options.transferProvider ?? createTwilioTransferProvider(config),
    smsProvider: createTwilioSmsProvider(config),
  });
  const connections = new Map<string, { close(reason?: string): void }>();
  const activeConnections = new Set<ReturnType<typeof bridgeLive>>();
  let closing = false;
  app.register(async (voice) => {
    await voice.register(formbody);
    await voice.register(websocket, { options: { maxPayload: 128 * 1024 } });
    registerVoiceSmsRoutes(voice, agent.sms, config);
    voice.addHook("onClose", async () => {
      closing = true;
      // Include streams still authenticating, and finish their call records before pool.end().
      while (activeConnections.size) {
        const active = [...activeConnections];
        for (const connection of active) connection.close("server_stopping");
        await Promise.allSettled(active.map((connection) => connection.finished));
      }
      connections.clear();
      await monitor.flush();
    });
    voice.setErrorHandler((error, _request, reply) => {
      if (error instanceof BackendError)
        return reply.code(error.statusCode).send({ error: error.code });
      if (
        error instanceof Error &&
        (error.name === "ZodError" ||
          ("code" in error && String(error.code).startsWith("FST_ERR_CTP")))
      )
        return reply.code(400).send({ error: "invalid_input" });
      return reply.code(503).send({ error: "voice_unavailable" });
    });
    voice.register(async (api) => {
      const actors = new WeakMap<object, Principal>();
      api.addHook("onRequest", async (request) => {
        const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? "");
        if (!token) throw new BackendError("unauthorized", 401);
        actors.set(request, await authenticate(pool, token[1]!, now()));
      });
      const actor = (request: object) => actors.get(request)!;
      registerVoiceDirectoryRoutes(api, agent.directory, agent.transfers, store, actor);
      api.get("/voice/config", async () => ({
        ...voiceReadiness(config),
        model: config.liveModel,
        voice: config.voice,
        backendModel: config.backendModel,
        authorization: "when_needed",
        smsEnabled: Boolean(agent.sms.appUrl),
        agents: [
          {
            id: "appointment-coordinator",
            name: "Appointment assistant",
            description: "Explains progress and prepares patient-approved appointment actions.",
          },
          {
            id: "professional-handoff",
            name: "Professional handover",
            description: "Stops call automation and records a request for the care team.",
          },
        ],
        storesAudio: false,
        storesTranscripts: true,
        transcriptStorage: "database",
      }));
      api.post("/voice/access-codes", async (request) => {
        const input = voiceAccessCodeInputSchema.parse(request.body);
        return store.issueCode(actor(request), input.taskId);
      });
      api.post("/voice/simulate", async (request, reply) => {
        return reply
          .code(201)
          .send(
            await store.simulate(actor(request), voiceVerifyInputSchema.parse(request.body).code),
          );
      });
      api.get("/voice/calls", async (request) => ({ calls: await store.list(actor(request)) }));
      api.get<CallParams>("/voice/calls/:id", (request) =>
        store.get(actor(request), request.params.id),
      );
      api.get<CallParams>("/voice/calls/:id/monitor", async (request, reply) => {
        if (!["staff", "operator"].includes(actor(request).role))
          throw new BackendError("forbidden", 403);
        const call = await store.get(actor(request), request.params.id);
        reply.header("Cache-Control", "no-store");
        const snapshot = await monitor.read(call.id);
        const messages = await agent.sms.list(actor(request), call.id);
        return {
          ...snapshot,
          entries: [
            ...snapshot.entries,
            ...messages.map((message) => ({
              id: `sms-${message.id}`,
              kind: "tool",
              label: `SMS · ${message.status}`,
              at: message.createdAt,
              status: ["failed", "unknown"].includes(message.status)
                ? "failed"
                : ["prepared", "dispatching", "accepted", "sent"].includes(message.status)
                  ? "running"
                  : "complete",
              text: message.body,
              details: { ...message, updatedAt: message.updatedAt },
            })),
          ],
          streamConnected: connections.has(call.id),
        };
      });
      api.post<CallParams>("/voice/calls/:id/verify", async (request) => {
        const call = await store.get(actor(request), request.params.id);
        if (call.mode !== "simulated" || call.actorId !== actor(request).id)
          throw new BackendError("forbidden", 403);
        return store.verifyCode(call.id, voiceVerifyInputSchema.parse(request.body).code);
      });
      api.post<CallParams>("/voice/calls/:id/tool", async (request) => {
        const call = await store.get(actor(request), request.params.id);
        if (call.mode !== "simulated" || call.actorId !== actor(request).id)
          throw new BackendError("forbidden", 403);
        const input = voiceToolInputSchema.parse(request.body);
        const capture = new RealtimeMonitor((entry) => monitor.capture(call.id, entry));
        capture.toolStarted(input.toolCallId, input.name, input.arguments);
        try {
          const result = await agent.run(call.id, input.toolCallId, input.name, input.arguments);
          capture.toolFinished(input.toolCallId, result);
          return result;
        } catch (error) {
          capture.toolFinished(input.toolCallId, {
            ok: false,
            error: error instanceof BackendError ? error.code : "tool_failed",
          });
          throw error;
        }
      });
      api.post<CallParams>("/voice/calls/:id/confirm", async (request) => {
        const call = await store.get(actor(request), request.params.id);
        if (call.actorId !== actor(request).id) throw new BackendError("forbidden", 403);
        if (call.mode !== "simulated") throw new BackendError("live_keypad_required", 403);
        return agent.confirm(call.id, voiceConfirmInputSchema.parse(request.body).actionId);
      });
      api.post<CallParams>("/voice/calls/:id/cancel", async (request) => {
        const call = await store.get(actor(request), request.params.id);
        voiceEmptyInputSchema.parse(request.body);
        if (call.actorId !== actor(request).id) throw new BackendError("forbidden", 403);
        await store.cancelPending(call.id);
        return { status: "cancelled" };
      });
      api.post<CallParams>("/voice/calls/:id/end", async (request) => {
        const call = await store.get(actor(request), request.params.id);
        voiceEmptyInputSchema.parse(request.body);
        if (call.actorId !== actor(request).id && actor(request).role !== "staff")
          throw new BackendError("forbidden", 403);
        if (call.status === "transferring") throw new BackendError("transfer_in_progress", 409);
        const ended = await store.end(call.id, "portal_ended");
        connections.get(call.id)?.close("portal_ended");
        return ended;
      });
      api.post("/voice/callbacks", async (request, reply) => {
        const input = voiceCallbackInputSchema.parse(request.body);
        if (config.mode === "twilio") {
          if (!voiceReadiness(config).liveReady)
            throw new BackendError("voice_not_configured", 409);
          if (!voiceNumberAllowed(config, input.to))
            throw new BackendError("number_not_allowed", 400);
        }
        return reply
          .code(201)
          .send(await store.scheduleCallback(actor(request), { ...input, mode: config.mode }));
      });
    });
    voice.register(async (provider) => {
      provider.addHook("onRequest", async (request, reply) => {
        if (!voiceReadiness(config).liveReady)
          return reply.code(503).send({ error: "voice_not_configured" });
      });
      provider.addHook("preValidation", async (request) => {
        if (
          !validateTwilioWebhook(config, {
            signature:
              typeof request.headers["x-twilio-signature"] === "string"
                ? request.headers["x-twilio-signature"]
                : undefined,
            url: request.raw.url ?? request.url,
            body: request.body ?? {},
            method: request.method as "GET" | "POST",
            contentType: request.headers["content-type"],
          })
        )
          throw new BackendError("invalid_twilio_signature", 403);
      });
      provider.post("/voice/incoming", async (request, reply) => {
        const form = request.body as Record<string, string>;
        if (!voiceNumberAllowed(config, form.From ?? ""))
          return reply
            .type("text/xml")
            .send(hangupTwiml("This test line is not available for this number."));
        const call = await store.beginInbound({
          sid: form.CallSid!,
          from: form.From!,
          departmentId: config.departmentId,
        });
        const { token } = await store.issueStream(call.id);
        return reply
          .type("text/xml")
          .send(connectStreamTwiml(config, { callId: call.id, streamToken: token }));
      });
      provider.post<CallParams>("/voice/outbound/:id", async (request, reply) => {
        const form = request.body as Record<string, string>;
        const call = await store.getInternal(request.params.id);
        if (
          call.direction !== "outbound" ||
          call.mode !== "twilio" ||
          !["dialing", "ringing", "awaiting_verification", "reconciling"].includes(call.status)
        )
          return reply.type("text/xml").send(hangupTwiml());
        await store.markDialed(call.id, form.CallSid!);
        const { token } = await store.issueStream(call.id);
        return reply
          .type("text/xml")
          .send(connectStreamTwiml(config, { callId: call.id, streamToken: token }));
      });
      provider.post("/voice/verify", async (request, reply) => {
        const form = request.body as Record<string, string>;
        const call = await store.bySid(form.CallSid ?? "");
        if (!call) return reply.type("text/xml").send(hangupTwiml());
        try {
          await store.verifyCode(call.id, form.Digits ?? "");
          const { token } = await store.issueStream(call.id);
          return reply
            .type("text/xml")
            .send(connectStreamTwiml(config, { callId: call.id, streamToken: token }));
        } catch (error) {
          if (!(error instanceof BackendError)) throw error;
          const current = await store.getInternal(call.id);
          return reply
            .type("text/xml")
            .send(
              terminalCalls.has(current.status)
                ? hangupTwiml(
                    "Verification was not completed. Please obtain a new code in your Health Coordinator workspace.",
                  )
                : retryTwiml(config),
            );
        }
      });
      provider.post("/voice/status", async (request, reply) => {
        const form = request.body as Record<string, string>;
        const query = request.query as Record<string, string>;
        const call = query.callId
          ? await store.getInternal(query.callId)
          : await store.bySid(form.CallSid ?? "");
        if (call) await store.statusCallback(call.id, form.CallSid!, form.CallStatus!);
        return reply.code(204).send();
      });
      provider.post<CallParams>("/voice/transfers/:id/result", async (request, reply) => {
        const form = request.body as Record<string, string>;
        const transfer = await agent.transfers.result(request.params.id, {
          parentSid: form.CallSid ?? "",
          childSid: form.DialCallSid,
          status: form.DialCallStatus ?? "",
        });
        return reply.type("text/xml").send(transferOutcomeTwiml(transfer.status));
      });
      provider.get("/voice/stream", { websocket: true }, (socket) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let handoffDeadline: number | undefined;
        let closed = false;
        const connection = bridgeLive(socket, {
          apiKey: config.openaiApiKey!,
          model: config.liveModel,
          backendModel: config.backendModel,
          voice: config.voice,
          instructions: `${voiceAgentInstructions}\nCurrent server time is ${now().toISOString()} UTC. The fictional clinic uses America/Halifax. Ask the caller to confirm exact dates and time zone for relative expressions such as next week.`,
          tools: voiceAgentTools,
          onMonitor: (callId, entry) => monitor.capture(callId, entry),
          verifyStart: async ({ callSid, customParameters }) => {
            const verified = await store.claimStream(
              customParameters.callId ?? "",
              customParameters.streamToken ?? "",
              callSid,
            );
            if (!closed && !closing) {
              connections.set(verified.callId, connection);
              const check = async () => {
                try {
                  const { call } = await store.sessionState(verified.callId);
                  if (call.status === "handoff") {
                    // Tools already reject handoff. Allow a bounded final spoken acknowledgment;
                    // portal end, authority loss and server shutdown still close immediately.
                    handoffDeadline ??= Date.now() + 10_000;
                    if (Date.now() >= handoffDeadline) return connection.close("call_stopped");
                  } else if (call.status === "transferring") {
                    // The provider update, not this timer, ends Connect/Stream. Closing early
                    // would execute the original trailing Hangup before Dial replaces it.
                  } else if (terminalCalls.has(call.status)) {
                    return connection.close("call_stopped");
                  }
                } catch {
                  return connection.close("call_authority_unavailable");
                }
                if (!closed) {
                  timer = setTimeout(check, 1000);
                  timer.unref();
                }
              };
              timer = setTimeout(check, 1000);
              timer.unref();
            }
            return verified;
          },
          onTool: (name, args, callId, toolCallId) => agent.run(callId, toolCallId, name, args),
          onDigit: (digit, callId, actionId) => agent.digit(callId, digit, actionId),
          onVerify: async (code, callId) => {
            await store.verifyCode(callId, code);
            const { actor, call } = await store.bound(callId);
            return {
              status: "verified",
              role: actor.role,
              pendingAction: call.pendingAction,
              message:
                "Access verified. Briefly acknowledge and continue the caller's original request; do not ask them to repeat it.",
            };
          },
          onClose: async (callId, reason) => {
            closed = true;
            clearTimeout(timer);
            connections.delete(callId);
            await store.streamClosed(callId, reason);
            await monitor.flush();
          },
        });
        activeConnections.add(connection);
        void connection.finished.then(() => activeConnections.delete(connection));
        if (closing) connection.close("server_stopping");
      });
    });
  });
}
