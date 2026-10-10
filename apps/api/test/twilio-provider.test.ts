import assert from "node:assert/strict";
import test from "node:test";
import twilio from "twilio";
import { readVoiceConfig } from "../src/voice-config.js";
import {
  connectStreamTwiml,
  createTwilioProvider,
  hangupTwiml,
  incomingTwiml,
  retryTwiml,
  TwilioDispatchError,
  validateTwilioWebhook,
  type TwilioClient,
  type TwilioWebhookRequest,
} from "../src/twilio-provider.js";

const config = readVoiceConfig({
  VOICE_MODE: "twilio",
  VOICE_LIVE_ENABLED: "true",
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "synthetic-auth-token",
  TWILIO_PHONE_NUMBER: "+15555550101",
  OPENAI_API_KEY: "synthetic-openai-key",
  VOICE_PUBLIC_BASE_URL: "https://voice.example.com",
  VOICE_ALLOWED_NUMBERS: "+15555550102",
});
const sid = `CA${"2".repeat(32)}`;

function signedRequest(
  url = "/voice/incoming",
  body: unknown = {
    AccountSid: config.accountSid,
    CallSid: sid,
    From: "+15555550102",
    To: config.phoneNumber,
  },
): TwilioWebhookRequest {
  return {
    method: "POST",
    url,
    body,
    contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    signature: twilio.getExpectedTwilioSignature(
      config.authToken!,
      config.publicBaseUrl! + url,
      body as Record<string, string>,
    ),
  };
}

test("signed form webhooks bind both the request body and exact configured public URL", () => {
  const request = signedRequest("/voice/verify?attempt=1&name=a%20b");
  assert.equal(validateTwilioWebhook(config, request), true);
  for (const mutation of [
    { signature: undefined },
    { signature: "invalid-signature" },
    { url: "/voice/verify?attempt=2&name=a%20b" },
    { body: { ...(request.body as object), From: "+15555550999" } },
    { body: { ...(request.body as object), Digits: "12345678" } },
    { url: "https://untrusted.example.com/voice/verify?attempt=1&name=a%20b" },
    { url: "//untrusted.example.com/voice/verify?attempt=1&name=a%20b" },
    { url: "/voice/verify?attempt=1&name=a%20b#ignored" },
    { method: "PUT" },
    { contentType: "application/json" },
    { contentType: undefined },
  ])
    assert.equal(
      validateTwilioWebhook(config, { ...request, ...mutation }),
      false,
      JSON.stringify(mutation),
    );
  const attacker = {
    ...request,
    signature: twilio.getExpectedTwilioSignature(
      config.authToken!,
      "https://attacker.example.com" + request.url,
      request.body as Record<string, string>,
    ),
  };
  assert.equal(validateTwilioWebhook(config, attacker), false);
  assert.equal(validateTwilioWebhook({ ...config, liveEnabled: false }, request), false);
});

test("webhooks reject foreign accounts and malformed form values even with a signature", () => {
  assert.equal(
    validateTwilioWebhook(
      config,
      signedRequest("/voice/status", { AccountSid: `AC${"3".repeat(32)}`, CallSid: sid }),
    ),
    false,
  );
  for (const body of [
    null,
    [],
    "unparsed",
    { AccountSid: config.accountSid, CallStatus: ["completed", "ringing"] },
    { AccountSid: config.accountSid, CallStatus: { value: "completed" } },
  ]) {
    assert.equal(validateTwilioWebhook(config, { ...signedRequest(), body }), false);
  }
});

test("signed status callbacks include immutable call binding and provider state", () => {
  const request = signedRequest("/voice/status?callId=synthetic-call", {
    AccountSid: config.accountSid,
    CallSid: sid,
    CallStatus: "completed",
    SequenceNumber: "4",
  });
  assert.equal(validateTwilioWebhook(config, request), true);
  assert.equal(
    validateTwilioWebhook(config, { ...request, url: "/voice/status?callId=another-call" }),
    false,
  );
  assert.equal(
    validateTwilioWebhook(config, {
      ...request,
      body: { ...(request.body as object), CallSid: `CA${"4".repeat(32)}` },
    }),
    false,
  );
});

test("Media Stream upgrade validates the HTTPS signature and disallows unsigned body parameters", () => {
  const request: TwilioWebhookRequest = {
    method: "GET",
    url: "/voice/stream",
    body: undefined,
    signature: twilio.getExpectedTwilioSignature(
      config.authToken!,
      config.publicBaseUrl! + "/voice/stream",
      {},
    ),
  };
  assert.equal(validateTwilioWebhook(config, request), true);
  assert.equal(
    validateTwilioWebhook(config, { ...request, body: { arbitrary: "payload" } }),
    false,
  );
  assert.equal(validateTwilioWebhook(config, { ...request, signature: undefined }), false);
});

test("inbound TwiML collects eight DTMF digits and safely ends a silent call", () => {
  for (const xml of [incomingTwiml(config), retryTwiml(config)]) {
    assert.match(xml, /<Gather[^>]*input="dtmf"/);
    assert.match(xml, /numDigits="8"/);
    assert.match(xml, /timeout="15"/);
    assert.match(xml, /action="https:\/\/voice\.example\.com\/voice\/verify"/);
    assert.match(xml, /method="POST"/);
    assert.match(xml, /portal/i);
    assert.match(xml, /<Hangup\s*\/>/);
    assert.doesNotMatch(xml, /<Record|input="speech"/);
  }
  assert.match(incomingTwiml(config), /AI/);
  assert.match(hangupTwiml(), /<Hangup\s*\/>/);
});

test("TwiML uses escaped SDK nodes and stream authentication in custom parameters", () => {
  const xml = connectStreamTwiml(config, { callId: 'call"<&', streamToken: 'token"<&' });
  assert.match(xml, /<Connect><Stream url="wss:\/\/voice.example.com\/voice\/stream">/);
  assert.match(xml, /name="callId" value="call&quot;&lt;&amp;"/);
  assert.match(xml, /name="streamToken" value="token&quot;&lt;&amp;"/);
  assert.doesNotMatch(xml, /wss:[^"]*\?/);
  assert.doesNotMatch(hangupTwiml('hello <Redirect> & "'), /<Redirect>/);
  assert.match(hangupTwiml('hello <Redirect> & "'), /&lt;Redirect&gt; &amp;/);
});

test("outbound dispatch gates consent target, credentials and explicit activation before client use", async () => {
  let attempts = 0;
  const client: TwilioClient = {
    calls: {
      async create() {
        attempts += 1;
        return { sid, status: "queued" };
      },
    },
  };
  for (const scenario of [
    { config: { ...config, mode: "simulated" as const }, to: "+15555550102" },
    { config: { ...config, liveEnabled: false }, to: "+15555550102" },
    { config: { ...config, openaiApiKey: undefined }, to: "+15555550102" },
    { config, to: "+15555550999" },
    { config, to: "15555550102" },
  ]) {
    await assert.rejects(
      createTwilioProvider(scenario.config, client).createCall({
        callId: "synthetic-call",
        to: scenario.to,
      }),
      (error: unknown) => error instanceof TwilioDispatchError && error.outcome === "blocked",
    );
  }
  assert.equal(attempts, 0);
});

test("outbound calls use configured caller ID, POST callbacks, no recording and bounded duration", async () => {
  let options: Parameters<TwilioClient["calls"]["create"]>[0] | undefined;
  const client: TwilioClient = {
    calls: {
      async create(input) {
        options = input;
        return { sid, status: "queued" };
      },
    },
  };
  const ack = await createTwilioProvider(config, client).createCall({
    callId: "synthetic-call",
    to: "+15555550102",
    token: "call-bound-token",
  });
  assert.deepEqual(ack, { sid, status: "queued" });
  assert.ok(options);
  assert.equal(options.to, "+15555550102");
  assert.equal(options.from, config.phoneNumber);
  assert.equal(options.method, "POST");
  assert.equal(
    options.url,
    "https://voice.example.com/voice/outbound/synthetic-call?token=call-bound-token",
  );
  assert.equal(
    options.statusCallback,
    "https://voice.example.com/voice/status?callId=synthetic-call",
  );
  assert.equal(options.statusCallbackMethod, "POST");
  assert.deepEqual(options.statusCallbackEvent, ["initiated", "ringing", "answered", "completed"]);
  assert.equal(options.record, false);
  assert.equal(options.timeout, 25);
  assert.equal(options.timeLimit, 600);
});

test("uncertain network outcomes and malformed acknowledgements never retry or expose provider errors", async () => {
  for (const providerResult of [
    new Error(`network timeout with ${config.authToken} and ${config.openaiApiKey}`),
    Object.assign(new Error("provider error with private data"), { status: 503 }),
    Object.assign(new Error("request timeout"), { status: 408 }),
    { sid: "", status: "queued" },
    { sid, status: "unknown-provider-value" },
  ]) {
    let attempts = 0;
    const client: TwilioClient = {
      calls: {
        async create() {
          attempts += 1;
          if (providerResult instanceof Error) throw providerResult;
          return providerResult;
        },
      },
    };
    await assert.rejects(
      createTwilioProvider(config, client).createCall({
        callId: "synthetic-call",
        to: "+15555550102",
      }),
      (error: unknown) => {
        assert.ok(error instanceof TwilioDispatchError);
        assert.equal(error.outcome, "uncertain");
        assert.equal(error.cause, undefined);
        assert.doesNotMatch(
          error.message,
          /synthetic-auth-token|synthetic-openai-key|private data/,
        );
        return true;
      },
    );
    assert.equal(attempts, 1);
  }
});

test("explicit provider rejection is distinguishable from an uncertain dispatch", async () => {
  const client: TwilioClient = {
    calls: {
      async create() {
        throw Object.assign(new Error("private provider detail"), { status: 400 });
      },
    },
  };
  await assert.rejects(
    createTwilioProvider(config, client).createCall({
      callId: "synthetic-call",
      to: "+15555550102",
    }),
    (error: unknown) =>
      error instanceof TwilioDispatchError &&
      error.outcome === "rejected" &&
      error.message === "Twilio call dispatch rejected",
  );
});
