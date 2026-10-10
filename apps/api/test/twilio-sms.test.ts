import assert from "node:assert/strict";
import test from "node:test";
import { readVoiceConfig } from "../src/voice-config.js";
import { createTwilioSmsProvider, readSmsAppUrl, SmsDispatchError } from "../src/twilio-sms.js";

const config = readVoiceConfig({
  VOICE_MODE: "twilio",
  VOICE_LIVE_ENABLED: "true",
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "synthetic-token",
  TWILIO_PHONE_NUMBER: "+15555550101",
  OPENAI_API_KEY: "synthetic-key",
  VOICE_PUBLIC_BASE_URL: "https://voice.example.com",
  VOICE_ALLOWED_NUMBERS: "*",
});
const input = {
  smsId: "8e854737-cd32-40bc-8424-4b805d5715ba",
  to: "+15555550102",
  body: "Fictional demo. Reply STOP to opt out.",
};
const sid = `SM${"2".repeat(32)}`;

test("SMS provider sends one bounded text with a fixed signed-callback URL", async () => {
  let attempts = 0;
  const provider = createTwilioSmsProvider(config, {
    messages: {
      async create(options) {
        attempts++;
        assert.equal(options.to, input.to);
        assert.equal(options.from, "+15555550101");
        assert.equal(options.body, input.body);
        assert.equal(
          options.statusCallback,
          "https://voice.example.com/voice/sms/8e854737-cd32-40bc-8424-4b805d5715ba/status",
        );
        return { sid, status: "queued" };
      },
    },
  });
  assert.deepEqual(await provider.send(input), { sid, status: "queued" });
  for (const to of ["bad", "+15555550101"])
    await assert.rejects(provider.send({ ...input, to }), SmsDispatchError);
  assert.equal(attempts, 1);
});

test("SMS provider surfaces opt-out without private error text and never retries ambiguous outcomes", async () => {
  for (const scenario of [
    { status: 400, code: 21610, outcome: "rejected" },
    { status: 503, code: undefined, outcome: "uncertain" },
    { status: undefined, code: undefined, outcome: "uncertain" },
  ]) {
    let attempts = 0;
    const provider = createTwilioSmsProvider(config, {
      messages: {
        async create() {
          attempts++;
          throw Object.assign(new Error("secret destination +15555550102"), scenario);
        },
      },
    });
    await assert.rejects(
      provider.send(input),
      (error: unknown) =>
        error instanceof SmsDispatchError &&
        error.outcome === scenario.outcome &&
        !error.message.includes("secret") &&
        (scenario.code !== 21610 || error.providerCode === "21610"),
    );
    assert.equal(attempts, 1);
  }
});

test("SMS provider does not accept malformed or unrelated acknowledgements", async () => {
  for (const acknowledgement of [
    { sid: "bad", status: "queued" },
    { sid, status: "incoming" },
  ]) {
    const provider = createTwilioSmsProvider(config, {
      messages: {
        async create() {
          return acknowledgement;
        },
      },
    });
    await assert.rejects(
      provider.send(input),
      (error: unknown) => error instanceof SmsDispatchError && error.outcome === "uncertain",
    );
  }
});

test("SMS portal destination is an explicit safe HTTPS origin and rejects credentials or query data", () => {
  assert.equal(
    readSmsAppUrl({ PUBLIC_DEMO_ORIGIN: "https://health.example.com" }),
    "https://health.example.com",
  );
  assert.equal(
    readSmsAppUrl({
      SMS_APP_URL: "https://sms.example.com",
      PUBLIC_DEMO_ORIGIN: "https://health.example.com",
    }),
    "https://sms.example.com",
  );
  for (const value of [
    "http://health.example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://user:secret@health.example.com",
    "https://health.example.com/?token=secret",
    "https://health.example.com/patient",
  ]) {
    assert.equal(readSmsAppUrl({ SMS_APP_URL: value }), undefined);
  }
});
