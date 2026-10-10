import assert from "node:assert/strict";
import test from "node:test";
import { readVoiceConfig } from "../src/voice-config.js";
import { createTwilioTransferProvider } from "../src/twilio-transfer.js";
import { TwilioDispatchError } from "../src/twilio-provider.js";

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
const sid = `CA${"2".repeat(32)}`;
const input = {
  parentSid: sid,
  transferId: "8e854737-cd32-40bc-8424-4b805d5715ba",
  destination: "+15555550103",
  name: "Dr. Rao <test>",
};
test("transfer updates the existing parent call with escaped Dial Number and absolute action URL", async () => {
  let attempts = 0;
  const provider = createTwilioTransferProvider(config, {
    calls(parentSid) {
      assert.equal(parentSid, sid);
      return {
        async update(options) {
          attempts++;
          assert.match(
            options.twiml,
            /<Dial[^>]+action="https:\/\/voice.example.com\/voice\/transfers\/8e854737-cd32-40bc-8424-4b805d5715ba\/result"/,
          );
          assert.match(options.twiml, /<Number>\+15555550103<\/Number>/);
          assert.match(options.twiml, /Dr. Rao &lt;test&gt;/);
          assert.match(options.twiml, /record="do-not-record"/);
          assert.match(options.twiml, /timeout="25"/);
          return { sid, status: "in-progress" };
        },
      };
    },
  });
  await provider.transfer(input);
  assert.equal(attempts, 1);
  for (const destination of ["bad", "+15555550101"])
    await assert.rejects(provider.transfer({ ...input, destination }), TwilioDispatchError);
  assert.equal(attempts, 1);
});
test("network uncertainty and provider rejection are bounded and never retried", async () => {
  for (const status of [undefined, 503, 400]) {
    let attempts = 0;
    const provider = createTwilioTransferProvider(config, {
      calls() {
        return {
          async update() {
            attempts++;
            throw Object.assign(new Error("private provider secret"), { status });
          },
        };
      },
    });
    await assert.rejects(
      provider.transfer(input),
      (error: unknown) =>
        error instanceof TwilioDispatchError &&
        error.outcome === (status === 400 ? "rejected" : "uncertain") &&
        !error.message.includes("secret"),
    );
    assert.equal(attempts, 1);
  }
});
