import type { Pool } from "pg";
import {
  voiceMonitorEntrySchema,
  type VoiceMonitorEntry,
  type VoiceMonitorSnapshot,
} from "@prc/contracts";

/** Coalesce partial transcripts into saved utterances without awaiting the database on the audio path. */
export class VoiceMonitorStore {
  private pending = new Map<
    string,
    { call_id: string; entry_id: string; payload: VoiceMonitorEntry }
  >();
  private warnings = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> | undefined;
  constructor(private pool: Pool) {}

  capture(callId: string, entry: VoiceMonitorEntry) {
    const key = `${callId}:${entry.id}`;
    if (this.pending.size >= 2048 && !this.pending.has(key)) {
      this.warn(callId, "Capture buffer filled; some events could not be saved.");
      return;
    }
    this.pending.set(key, {
      call_id: callId,
      entry_id: entry.id,
      payload: voiceMonitorEntrySchema.parse(entry),
    });
    if (!this.timer && !this.writing) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 250);
      this.timer.unref();
    }
  }

  private warn(callId: string, message: string) {
    if (this.warnings.size >= 200 && !this.warnings.has(callId))
      this.warnings.delete(this.warnings.keys().next().value!);
    this.warnings.set(callId, message);
  }

  async flush(): Promise<void> {
    if (this.writing) return this.writing;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.writing = Promise.resolve().then(async () => {
      while (this.pending.size) {
        const batch = [...this.pending.values()];
        this.pending.clear();
        try {
          await this.pool.query(
            `INSERT INTO voice_monitor_entries (call_id,entry_id,payload)
          SELECT value->>'call_id',value->>'entry_id',value->'payload'
          FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS entries(value,ordinal)
          ORDER BY ordinal
          ON CONFLICT (call_id,entry_id) DO UPDATE SET payload=EXCLUDED.payload`,
            [JSON.stringify(batch)],
          );
          for (const callId of new Set(batch.map((entry) => entry.call_id))) {
            if (!this.warnings.has(callId)) continue;
            await this.pool.query(
              `INSERT INTO voice_monitor_entries (call_id,entry_id,payload) VALUES ($1,'capture-warning',$2)
            ON CONFLICT (call_id,entry_id) DO NOTHING`,
              [
                callId,
                {
                  id: "capture-warning",
                  kind: "error",
                  label: "Capture incomplete",
                  status: "failed",
                  at: new Date().toISOString(),
                  details: { reason: this.warnings.get(callId) },
                },
              ],
            );
          }
        } catch {
          for (const entry of batch)
            this.warn(
              entry.call_id,
              "Some monitor events could not be saved. This call's record may be incomplete.",
            );
        }
      }
    });
    await this.writing;
    this.writing = undefined;
    if (this.pending.size) await this.flush();
  }

  async read(callId: string): Promise<VoiceMonitorSnapshot> {
    const result = await this.pool.query<{ payload: VoiceMonitorEntry }>(
      "SELECT payload FROM voice_monitor_entries WHERE call_id=$1 ORDER BY position LIMIT 1002",
      [callId],
    );
    return {
      entries: result.rows.map((row) => row.payload),
      captureWarning: this.warnings.get(callId) ?? null,
      persisted: true,
      streamConnected: false,
    };
  }
}
