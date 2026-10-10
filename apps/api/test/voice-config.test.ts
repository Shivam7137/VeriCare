import assert from "node:assert/strict";
import test from "node:test";
import { readVoiceConfig, voiceReadiness } from "../src/voice-config.js";

const liveEnv = {
  VOICE_MODE: "twilio",
  VOICE_LIVE_ENABLED: "true",
  TWILIO_ACCOUNT_SID: `AC${"1".repeat(32)}`,
  TWILIO_AUTH_TOKEN: "synthetic-auth-token",
  TWILIO_PHONE_NUMBER: "+15555550101",
  OPENAI_API_KEY: "synthetic-openai-key",
  VOICE_PUBLIC_BASE_URL: "https://voice.example.com",
  VOICE_ALLOWED_NUMBERS: "+15555550102,+15555550103",
};

test("voice defaults to a ready simulator without activating supplied credentials", () => {
  const empty = readVoiceConfig({});
  assert.equal(empty.mode, "simulated");
  assert.equal(empty.liveEnabled, false);
  assert.equal(empty.realtimeModel, "gpt-realtime");
  assert.equal(empty.voice, "marin");
  assert.equal(voiceReadiness(empty).ready, true);
  assert.equal(voiceReadiness(empty).liveReady, false);
  const keysOnly = readVoiceConfig({
    ...liveEnv,
    VOICE_MODE: undefined,
    VOICE_LIVE_ENABLED: undefined,
  });
  assert.equal(keysOnly.mode, "simulated");
  assert.equal(voiceReadiness(keysOnly).liveReady, false);
  assert.deepEqual(voiceReadiness(keysOnly).missing, ["VOICE_MODE", "VOICE_LIVE_ENABLED"]);
  assert.equal(
    readVoiceConfig({ VOICE_OPENAI_API_KEY: "synthetic-alias" }).openaiApiKey,
    "synthetic-alias",
  );
});

test("live readiness requires every credential, allowlist and explicit enable flag", () => {
  const configured = readVoiceConfig(liveEnv);
  assert.equal(voiceReadiness(configured).ready, true);
  assert.equal(voiceReadiness(configured).liveReady, true);
  assert.deepEqual(voiceReadiness(configured).missing, []);
  for (const key of Object.keys(liveEnv)) {
    const config = readVoiceConfig({ ...liveEnv, [key]: undefined });
    assert.equal(voiceReadiness(config).liveReady, false, key);
    assert.ok(voiceReadiness(config).missing.includes(key), key);
  }
  for (const value of ["TRUE", "1", "yes"]) {
    assert.equal(
      voiceReadiness(readVoiceConfig({ ...liveEnv, VOICE_LIVE_ENABLED: value })).liveReady,
      false,
    );
  }
});

test("bad provider configuration fails closed and reports variable names without values", () => {
  const invalidValues = {
    VOICE_MODE: "secret-invalid-mode",
    TWILIO_ACCOUNT_SID: "secret-invalid-sid",
    TWILIO_PHONE_NUMBER: "not-a-number",
    VOICE_ALLOWED_NUMBERS: "+15555550102,not-a-number",
    OPENAI_REALTIME_MODEL: "<bad-model>",
    OPENAI_VOICE: "<bad-voice>",
  };
  for (const [key, value] of Object.entries(invalidValues)) {
    const readiness = voiceReadiness(readVoiceConfig({ ...liveEnv, [key]: value }));
    assert.equal(readiness.ready, false, key);
    assert.equal(readiness.liveReady, false, key);
    assert.ok(readiness.invalid.includes(key), key);
    assert.equal(JSON.stringify(readiness).includes(value), false, key);
  }
});

test("webhook origin must be public HTTPS without credentials, path, query or fragment", () => {
  for (const url of [
    "http://voice.example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://10.0.0.1",
    "https://172.16.0.1",
    "https://192.168.0.1",
    "https://169.254.169.254",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://server.internal",
    "https://localhost.",
    "https://not_a_host.example.com",
    "https://192.0.2.1",
    "https://198.51.100.1",
    "https://203.0.113.1",
    "https://user:secret@voice.example.com",
    "https://voice.example.com/base",
    "https://voice.example.com?token=secret",
    "https://voice.example.com/#fragment",
    "not-a-url",
  ]) {
    const readiness = voiceReadiness(readVoiceConfig({ ...liveEnv, VOICE_PUBLIC_BASE_URL: url }));
    assert.equal(readiness.liveReady, false, url);
    assert.ok(readiness.invalid.includes("VOICE_PUBLIC_BASE_URL"), url);
  }
  assert.equal(
    readVoiceConfig({ ...liveEnv, VOICE_PUBLIC_BASE_URL: "https://voice.example.com/" })
      .publicBaseUrl,
    "https://voice.example.com",
  );
});

test("safe readiness omits keys, account identifiers, URL and allowlisted numbers", () => {
  const config = readVoiceConfig({
    ...liveEnv,
    VOICE_ALLOWED_NUMBERS: " +15555550102, +15555550102 ",
  });
  assert.deepEqual(config.allowedNumbers, ["+15555550102"]);
  const readiness = voiceReadiness(config);
  assert.equal(readiness.allowlistedNumberCount, 1);
  const serialized = JSON.stringify(readiness);
  for (const key of [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_AUTH_TOKEN",
    "TWILIO_PHONE_NUMBER",
    "OPENAI_API_KEY",
    "VOICE_PUBLIC_BASE_URL",
  ]) {
    assert.equal(serialized.includes(liveEnv[key as keyof typeof liveEnv]), false, key);
  }
  assert.equal(serialized.includes("+15555550102"), false);
});

test("an explicit wildcard permits all phone numbers without making an empty list open", () => {
  const wildcard = readVoiceConfig({ ...liveEnv, VOICE_ALLOWED_NUMBERS: " * " });
  assert.equal(voiceReadiness(wildcard).liveReady, true);
  assert.deepEqual(wildcard.allowedNumbers, ["*"]);
  assert.equal(voiceReadiness(wildcard).allowlistedNumberCount, 0);
  assert.equal(
    voiceReadiness(readVoiceConfig({ ...liveEnv, VOICE_ALLOWED_NUMBERS: "" })).liveReady,
    false,
  );
});
