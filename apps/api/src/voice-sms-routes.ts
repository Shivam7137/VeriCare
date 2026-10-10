import type { FastifyInstance } from "fastify";
import type { VoiceConfig } from "./voice-config.js";
import { BackendError } from "./domain.js";
import { validateTwilioWebhook } from "./twilio-provider.js";
import type { VoiceSms } from "./voice-sms.js";

/** Register inside the formbody-enabled voice scope, outside bearer-authenticated APIs. */
export function registerVoiceSmsRoutes(app: FastifyInstance, sms: VoiceSms, config: VoiceConfig) {
  app.post<{ Params: { id: string } }>("/voice/sms/:id/status", async (request, reply) => {
    if (
      !validateTwilioWebhook(config, {
        method: request.method,
        signature:
          typeof request.headers["x-twilio-signature"] === "string"
            ? request.headers["x-twilio-signature"]
            : undefined,
        url: request.raw.url ?? request.url,
        body: request.body,
        contentType: request.headers["content-type"],
      })
    )
      return reply.code(403).send({ error: "invalid_twilio_signature" });
    const form = request.body as Record<string, string>;
    try {
      await sms.result(request.params.id, {
        messageSid: form.MessageSid ?? "",
        status: form.MessageStatus ?? "",
        errorCode: form.ErrorCode,
      });
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof BackendError)
        return reply.code(error.statusCode).send({ error: error.code });
      return reply.code(503).send({ error: "sms_status_unavailable" });
    }
  });
}
