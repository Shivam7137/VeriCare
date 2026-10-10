import twilio from "twilio";
import type { CallListInstanceCreateOptions } from "twilio/lib/rest/api/v2010/account/call.js";
import { E164_NUMBER, voiceReadiness, type VoiceConfig } from "./voice-config.js";

export type TwilioCallStatus =
  | "queued"
  | "initiated"
  | "ringing"
  | "in-progress"
  | "completed"
  | "busy"
  | "failed"
  | "no-answer"
  | "canceled";

export interface TwilioCallAcknowledgement {
  sid: string;
  status: TwilioCallStatus;
}
export interface TwilioClient {
  calls: {
    create(options: CallListInstanceCreateOptions): Promise<{ sid: string; status: string }>;
  };
}
export interface TwilioWebhookRequest {
  method: string;
  signature: string | undefined;
  url: string;
  body: unknown;
  contentType?: string;
}
export class TwilioDispatchError extends Error {
  constructor(readonly outcome: "blocked" | "rejected" | "uncertain") {
    super(`Twilio call dispatch ${outcome}`);
    this.name = "TwilioDispatchError";
  }
}
/** Rebuild from the configured public origin, never Host or forwarded request headers. */
function webhookUrl(config: VoiceConfig, path: string): string {
  if (!config.publicBaseUrl || !/^\/(?!\/)/.test(path) || /[\s\\#]/.test(path))
    throw new TwilioDispatchError("blocked");
  const raw = config.publicBaseUrl + path;
  const parsed = new URL(raw);
  if (parsed.origin !== config.publicBaseUrl || parsed.href !== raw)
    throw new TwilioDispatchError("blocked");
  return raw;
}

export function validateTwilioWebhook(config: VoiceConfig, request: TwilioWebhookRequest): boolean {
  if (
    !voiceReadiness(config).liveReady ||
    !request.signature ||
    !/^[a-zA-Z0-9+/]{27}=$/.test(request.signature)
  )
    return false;
  try {
    const url = webhookUrl(config, request.url);
    let params: Record<string, string> = {};
    if (request.method === "POST") {
      if (
        request.contentType?.split(";")[0]?.trim().toLowerCase() !==
          "application/x-www-form-urlencoded" ||
        !request.body ||
        typeof request.body !== "object" ||
        Array.isArray(request.body) ||
        Object.values(request.body).some((value) => typeof value !== "string")
      )
        return false;
      params = request.body as Record<string, string>;
      if (params.AccountSid !== config.accountSid) return false;
    } else if (request.method === "GET") {
      if (
        request.body !== undefined &&
        request.body !== null &&
        (typeof request.body !== "object" ||
          Array.isArray(request.body) ||
          Object.keys(request.body).length > 0)
      )
        return false;
    } else {
      return false;
    }
    return twilio.validateRequest(config.authToken!, request.signature, url, params);
  } catch {
    return false;
  }
}

function accessCodeTwiml(config: VoiceConfig, retry: boolean): string {
  const response = new twilio.twiml.VoiceResponse();
  const gather = response.gather({
    input: ["dtmf"],
    numDigits: 8,
    timeout: 15,
    finishOnKey: "",
    action: webhookUrl(config, "/voice/verify"),
    method: "POST",
  });
  gather.say(
    retry
      ? "That code could not be verified. Please enter the eight digit phone access code from your patient portal."
      : "You are speaking with an AI appointment coordination assistant. Please enter the eight digit phone access code from your patient portal.",
  );
  response.say(
    "We could not verify your access. Please use your patient portal or contact your care team. Goodbye.",
  );
  response.hangup();
  return response.toString();
}

export function incomingTwiml(config: VoiceConfig): string {
  return accessCodeTwiml(config, false);
}
export function retryTwiml(config: VoiceConfig): string {
  return accessCodeTwiml(config, true);
}
export function hangupTwiml(
  message = "Please use your patient portal or contact your care team for help. Goodbye.",
): string {
  const response = new twilio.twiml.VoiceResponse();
  response.say(message);
  response.hangup();
  return response.toString();
}

export function connectStreamTwiml(
  config: VoiceConfig,
  input: { callId: string; streamToken: string },
): string {
  const response = new twilio.twiml.VoiceResponse();
  const stream = response
    .connect()
    .stream({ url: webhookUrl(config, "/voice/stream").replace(/^https:/, "wss:") });
  // Twilio Media Streams disallow query parameters. Use SDK-escaped custom parameters.
  stream.parameter({ name: "callId", value: input.callId });
  stream.parameter({ name: "streamToken", value: input.streamToken });
  response.hangup();
  return response.toString();
}

const callStatuses = new Set<TwilioCallStatus>([
  "queued",
  "initiated",
  "ringing",
  "in-progress",
  "completed",
  "busy",
  "failed",
  "no-answer",
  "canceled",
]);

export function createTwilioProvider(
  config: VoiceConfig,
  client?: TwilioClient,
): {
  createCall(input: {
    callId: string;
    to: string;
    token?: string;
  }): Promise<TwilioCallAcknowledgement>;
} {
  return {
    async createCall(input) {
      if (
        !voiceReadiness(config).liveReady ||
        !E164_NUMBER.test(input.to) ||
        !config.allowedNumbers.includes(input.to) ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(input.callId)
      ) {
        throw new TwilioDispatchError("blocked");
      }
      const suffix = input.token ? `?${new URLSearchParams({ token: input.token })}` : "";
      const options: CallListInstanceCreateOptions = {
        from: config.phoneNumber!,
        to: input.to,
        method: "POST",
        url: webhookUrl(config, `/voice/outbound/${encodeURIComponent(input.callId)}${suffix}`),
        statusCallback: webhookUrl(
          config,
          `/voice/status?${new URLSearchParams({ callId: input.callId })}`,
        ),
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        record: false,
        timeout: 25,
        timeLimit: 600,
      };
      try {
        // Disable retry and debug logging even if the process has Twilio debug settings.
        const activeClient =
          client ??
          twilio(config.accountSid, config.authToken, {
            autoRetry: false,
            timeout: 10_000,
            logLevel: "error",
          });
        const ack = await activeClient.calls.create(options);
        if (
          !ack ||
          !/^CA[0-9a-f]{32}$/i.test(ack.sid) ||
          !callStatuses.has(ack.status as TwilioCallStatus)
        )
          throw new TwilioDispatchError("uncertain");
        return { sid: ack.sid, status: ack.status as TwilioCallStatus };
      } catch (error) {
        if (error instanceof TwilioDispatchError) throw error;
        const status =
          error && typeof error === "object" && "status" in error ? error.status : undefined;
        // Timeouts/server failures may follow call acceptance. Persist for reconciliation, never redial.
        const rejected =
          typeof status === "number" && status >= 400 && status < 500 && status !== 408;
        throw new TwilioDispatchError(rejected ? "rejected" : "uncertain");
      }
    },
  };
}
