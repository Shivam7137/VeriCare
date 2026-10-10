import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import fastify from "fastify";
import type { Pool } from "pg";
import twilio from "twilio";
import WebSocket from "ws";
import { readVoiceConfig } from "../src/voice-config.js";
import { registerVoiceRoutes } from "../src/voice-routes.js";
import { VoiceStore } from "../src/voice-store.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

test(
  "server shutdown waits for pending stream authorization and its durable close finalizer",
  { timeout: 5000 },
  async (t) => {
    const claim = deferred<{ callId: string }>();
    const claimStarted = deferred();
    const finalize = deferred();
    const finalizerStarted = deferred();
    const endings: { callId: string; reason: string }[] = [];
    t.mock.method(VoiceStore.prototype, "claimStream", async () => {
      claimStarted.resolve();
      return claim.promise;
    });
    t.mock.method(VoiceStore.prototype, "streamClosed", async (callId: string, reason: string) => {
      endings.push({ callId, reason });
      finalizerStarted.resolve();
      await finalize.promise;
    });
    const app = fastify({ logger: false });
    // Store calls are stubbed; only the loopback WebSocket is real. Authorization stays
    // pending until that socket closes, so the bridge never opens a provider connection.
    registerVoiceRoutes(app, {} as Pool, { config });
    let socket: WebSocket | undefined;
    t.after(async () => {
      socket?.terminate();
      claim.resolve({ callId: "synthetic-phone-call" });
      finalize.resolve();
      await app.close();
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    socket = new WebSocket(`ws://127.0.0.1:${address.port}/voice/stream`, {
      headers: {
        "x-twilio-signature": twilio.getExpectedTwilioSignature(
          config.authToken!,
          `${config.publicBaseUrl}/voice/stream`,
          {},
        ),
      },
    });
    await once(socket, "open");
    socket.send(
      JSON.stringify({
        event: "start",
        streamSid: "MZsynthetic",
        start: {
          streamSid: "MZsynthetic",
          callSid: "CAsynthetic",
          customParameters: {},
          mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
        },
      }),
    );
    await claimStarted.promise;

    let shutdownFinished = false;
    const socketClosed = once(socket, "close");
    const shutdown = app.close().then(() => {
      shutdownFinished = true;
    });
    await socketClosed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      shutdownFinished,
      false,
      "pending authentication must outlive neither shutdown nor the pool",
    );

    claim.resolve({ callId: "synthetic-phone-call" });
    await finalizerStarted.promise;
    assert.equal(shutdownFinished, false, "the database finalizer must complete before pool.end()");
    finalize.resolve();
    await shutdown;
    assert.equal(endings.length, 1);
    assert.equal(endings[0]!.callId, "synthetic-phone-call");
    assert.ok(["server_stopping", "twilio_closed"].includes(endings[0]!.reason));
  },
);
