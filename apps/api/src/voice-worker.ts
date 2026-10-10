import type { Pool } from "pg";
import { VoiceStore } from "./voice-store.js";
import { readVoiceConfig, voiceReadiness, type VoiceConfig } from "./voice-config.js";
import { createTwilioProvider, TwilioDispatchError } from "./twilio-provider.js";

export async function runVoiceWorker(
  pool: Pool,
  options: {
    config?: VoiceConfig;
    now?: () => Date;
    provider?: ReturnType<typeof createTwilioProvider>;
  } = {},
) {
  const config = options.config ?? readVoiceConfig();
  const store = new VoiceStore(pool, { now: options.now });
  const results: { id: string; status: string }[] = [];
  for (let dispatched = 0; dispatched < 20; dispatched++) {
    // Recheck authority, task state and the agreed window immediately before each dial.
    const [call] = await store.claimDue(1);
    if (!call) {
      // A claim can cancel an obsolete candidate. Keep scanning the bounded queue
      // so that cancelled callbacks do not delay an eligible call behind them.
      const remaining = await pool.query(
        "SELECT 1 FROM voice_calls WHERE status='queued' AND due_at <= $1 LIMIT 1",
        [store.now()],
      );
      if (!remaining.rowCount) break;
      continue;
    }
    if (call.mode === "simulated") {
      await store.markDialed(call.id, `SIM-${call.id}`);
      await store.recordEvent(call.id, "simulated_callback_ringing", {}, "simulated-ring");
      results.push({ id: call.id, status: "ringing" });
      continue;
    }
    if (!voiceReadiness(config).liveReady) {
      await store.markDispatchFailed(call.id, "voice_not_configured", false);
      results.push({ id: call.id, status: "failed" });
      continue;
    }
    try {
      const provider = options.provider ?? createTwilioProvider(config);
      const result = await provider.createCall({ callId: call.id, to: call.to });
      await store.markDialed(call.id, result.sid);
      results.push({ id: call.id, status: "ringing" });
    } catch (error) {
      const uncertain = !(error instanceof TwilioDispatchError) || error.outcome === "uncertain";
      await store.markDispatchFailed(
        call.id,
        uncertain ? "call_dispatch_uncertain" : "call_dispatch_rejected",
        uncertain,
      );
      results.push({ id: call.id, status: uncertain ? "reconciling" : "failed" });
    }
  }
  return results;
}
