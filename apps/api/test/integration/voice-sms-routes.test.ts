import assert from "node:assert/strict";
import test from "node:test";
import fastify from "fastify";
import formbody from "@fastify/formbody";
import twilio from "twilio";
import { workflowFixture } from "./workflow-fixture.js";
import { VoiceStore } from "../../src/voice-store.js";
import { VoiceSms } from "../../src/voice-sms.js";
import { registerVoiceSmsRoutes } from "../../src/voice-sms-routes.js";
import { readVoiceConfig } from "../../src/voice-config.js";

test("SMS status route requires Twilio's signature and binds callbacks to the accepted SID", async (t) => {
  const f = await workflowFixture(t);
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
  const sid = `SM${"2".repeat(32)}`;
  const sms = new VoiceSms(f.pool, {
    now: f.now,
    appUrl: "https://health.example.com",
    provider: {
      async send() {
        return { sid, status: "queued" };
      },
    },
  });
  const store = new VoiceStore(f.pool, { now: f.now });
  const call = await store.beginInbound({ sid: `CA${"2".repeat(32)}`, from: "+15555550102" });
  await f.pool.query("UPDATE voice_calls SET caller_number='+15555550102' WHERE id=$1", [call.id]);
  const prepared = await sms.prepare(call.id, { template: "portal_link", toolCallId: "portal" });
  await sms.confirm(call.id, prepared.sms.id);
  const app = fastify({ logger: false });
  t.after(() => app.close());
  await app.register(formbody);
  registerVoiceSmsRoutes(app, sms, config);
  await app.ready();
  const url = `/voice/sms/${prepared.sms.id}/status`;
  const send = (body: Record<string, string>, signed: boolean) =>
    app.inject({
      method: "POST",
      url,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(signed
          ? {
              "x-twilio-signature": twilio.getExpectedTwilioSignature(
                config.authToken!,
                config.publicBaseUrl! + url,
                body,
              ),
            }
          : {}),
      },
      payload: new URLSearchParams(body).toString(),
    });
  const body = { AccountSid: config.accountSid!, MessageSid: sid, MessageStatus: "delivered" };
  assert.equal((await send(body, false)).statusCode, 403);
  assert.equal((await send({ ...body, MessageSid: `SM${"3".repeat(32)}` }, true)).statusCode, 403);
  assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "accepted");
  assert.equal((await send({ ...body, AccountSid: `AC${"9".repeat(32)}` }, true)).statusCode, 403);
  assert.equal((await send(body, true)).statusCode, 204);
  assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "delivered");
  assert.equal((await send({ ...body, MessageStatus: "sent" }, true)).statusCode, 204);
  assert.equal((await sms.confirm(call.id, prepared.sms.id)).sms.status, "delivered");
});
