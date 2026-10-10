import twilio from "twilio";
import type { MessageListInstanceCreateOptions } from "twilio/lib/rest/api/v2010/account/message.js";
import { readVoiceConfig, voiceNumberAllowed, type VoiceConfig } from "./voice-config.js";
import { webhookUrl } from "./twilio-provider.js";

export interface SmsProvider {
  send(input: {
    smsId: string;
    to: string;
    body: string;
  }): Promise<{ sid: string; status: string }>;
}
export interface TwilioSmsClient {
  messages: {
    create(input: MessageListInstanceCreateOptions): Promise<{ sid: string; status: string }>;
  };
}
export class SmsDispatchError extends Error {
  constructor(
    readonly outcome: "blocked" | "rejected" | "uncertain",
    readonly providerCode?: string,
  ) {
    super(`SMS dispatch ${outcome}`);
    this.name = "SmsDispatchError";
  }
}
export const SMS_SID = /^SM[0-9a-f]{32}$/i;
export const smsProviderStatus: Record<string, "accepted" | "sent" | "delivered" | "failed"> = {
  accepted: "accepted",
  queued: "accepted",
  sending: "accepted",
  sent: "sent",
  delivered: "delivered",
  undelivered: "failed",
  failed: "failed",
  canceled: "failed",
};

/** Reuse the existing public-origin validator: HTTPS, no local hosts, credentials or query data. */
export function readSmsAppUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.SMS_APP_URL?.trim() || env.PUBLIC_DEMO_ORIGIN?.trim();
  return value ? readVoiceConfig({ VOICE_PUBLIC_BASE_URL: value }).publicBaseUrl : undefined;
}

export function createTwilioSmsProvider(
  config: VoiceConfig,
  client?: TwilioSmsClient,
): SmsProvider {
  return {
    async send(input) {
      if (
        config.mode !== "twilio" ||
        !config.liveEnabled ||
        !config.accountSid ||
        !config.authToken ||
        !config.phoneNumber ||
        !config.publicBaseUrl ||
        config.invalid.length ||
        !voiceNumberAllowed(config, input.to) ||
        input.to === config.phoneNumber ||
        !/^[0-9a-f-]{36}$/i.test(input.smsId) ||
        !input.body ||
        input.body.length > 1000
      )
        throw new SmsDispatchError("blocked");
      try {
        const active =
          client ??
          twilio(config.accountSid, config.authToken, {
            autoRetry: false,
            timeout: 10_000,
            logLevel: "error",
          });
        const ack = await active.messages.create({
          to: input.to,
          from: config.phoneNumber,
          body: input.body,
          statusCallback: webhookUrl(config, `/voice/sms/${input.smsId}/status`),
        });
        if (!ack || !SMS_SID.test(ack.sid) || !Object.hasOwn(smsProviderStatus, ack.status))
          throw new SmsDispatchError("uncertain");
        return { sid: ack.sid, status: ack.status };
      } catch (error) {
        if (error instanceof SmsDispatchError) throw error;
        const fields =
          error && typeof error === "object" ? (error as { status?: unknown; code?: unknown }) : {};
        const rejected =
          typeof fields.status === "number" &&
          fields.status >= 400 &&
          fields.status < 500 &&
          fields.status !== 408;
        const code =
          typeof fields.code === "number" && /^\d{4,6}$/.test(String(fields.code))
            ? String(fields.code)
            : undefined;
        throw new SmsDispatchError(rejected ? "rejected" : "uncertain", code);
      }
    },
  };
}
