import twilio from "twilio";
import { voiceNumberAllowed, voiceReadiness, type VoiceConfig } from "./voice-config.js";
import { TwilioDispatchError, webhookUrl } from "./twilio-provider.js";
import type { TransferProvider } from "./voice-transfers.js";

export interface TwilioTransferClient {
  calls(sid: string): {
    update(options: { twiml: string }): Promise<{ sid: string; status: string }>;
  };
}
export function createTwilioTransferProvider(
  config: VoiceConfig,
  client?: TwilioTransferClient,
): TransferProvider {
  return {
    async transfer(input) {
      if (
        !voiceReadiness(config).liveReady ||
        !/^CA[0-9a-f]{32}$/i.test(input.parentSid) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.transferId) ||
        !voiceNumberAllowed(config, input.destination) ||
        input.destination === config.phoneNumber
      )
        throw new TwilioDispatchError("blocked");
      const response = new twilio.twiml.VoiceResponse();
      response.say(`Connecting you to ${input.name}.`);
      response
        .dial({
          action: webhookUrl(config, `/voice/transfers/${input.transferId}/result`),
          method: "POST",
          callerId: config.phoneNumber!,
          record: "do-not-record",
          timeout: 25,
          timeLimit: 600,
        })
        .number(input.destination);
      try {
        const activeClient =
          client ??
          twilio(config.accountSid, config.authToken, {
            autoRetry: false,
            timeout: 10_000,
            logLevel: "error",
          });
        const ack = await activeClient
          .calls(input.parentSid)
          .update({ twiml: response.toString() });
        if (!ack || ack.sid !== input.parentSid || ack.status !== "in-progress")
          throw new TwilioDispatchError("uncertain");
      } catch (error) {
        if (error instanceof TwilioDispatchError) throw error;
        const status =
          error && typeof error === "object" && "status" in error ? error.status : undefined;
        const rejected =
          typeof status === "number" && status >= 400 && status < 500 && status !== 408;
        throw new TwilioDispatchError(rejected ? "rejected" : "uncertain");
      }
    },
  };
}
export function transferOutcomeTwiml(status: string) {
  const response = new twilio.twiml.VoiceResponse();
  response.say(
    status === "connected"
      ? "Your call to the care team has ended. No appointment change was made by this transfer. Goodbye."
      : status === "busy"
        ? "That care team destination was busy. Please try through your care team later. No appointment change was made. Goodbye."
        : status === "no-answer"
          ? "The care team did not answer. Please try through your care team later. No appointment change was made. Goodbye."
          : "We could not connect your call. Please use your portal or contact your care team. No appointment change was made. Goodbye.",
  );
  response.hangup();
  return response.toString();
}
