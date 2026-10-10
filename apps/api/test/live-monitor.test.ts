import assert from "node:assert/strict";
import test from "node:test";
import type { VoiceMonitorEntry } from "@prc/contracts";
import { LiveMonitor } from "../src/live-monitor.js";

function fixture() {
  const entries = new Map<string, VoiceMonitorEntry>();
  const monitor = new LiveMonitor((entry) => entries.set(entry.id, structuredClone(entry)));
  const caption = (
    speaker: "caller" | "assistant",
    delta: string,
    start: number,
    end: number,
    eventId?: string,
  ) =>
    monitor.receive({
      type:
        speaker === "caller" ? "session.input_transcript.delta" : "session.output_transcript.delta",
      delta,
      start_ms: start,
      end_ms: end,
      ...(eventId ? { event_id: eventId } : {}),
    });
  const transcripts = () => [...entries.values()].filter((entry) => entry.kind === "transcript");
  return { entries, monitor, caption, transcripts };
}

test("delayed native fragments update their original timeline window in timestamp order", () => {
  const f = fixture();
  f.caption("caller", "Friday", 1000, 1300, "first");
  f.caption("caller", "Monday", 13000, 13400, "second");
  f.caption("caller", " afternoon.", 1400, 1800, "late");
  const entries = f.transcripts();
  assert.deepEqual(
    entries.map((entry) => entry.text),
    ["Friday afternoon.", "Monday"],
  );
  assert.equal(entries[0]!.status, "complete");
  assert.equal(entries[1]!.status, "streaming");
  assert.match(String(entries[0]!.details?.grouping), /approximate/i);
  assert.deepEqual(entries[0]!.details?.fragments, [
    { startMs: 1000, endMs: 1300 },
    { startMs: 1400, endMs: 1800 },
  ]);
  assert.equal(entries[0]!.itemId, undefined, "native captions do not have provider turn IDs");
});

test("caption replay is deduplicated while distinct repeated words and overlapping speakers remain", () => {
  const f = fixture();
  f.caption("caller", "go", 100, 200, "event-a");
  f.caption("caller", "go", 100, 200, "event-a");
  f.caption("assistant", "Okay", 100, 300, "event-b");
  f.caption("caller", " now", 400, 500);
  f.caption("caller", " now", 400, 500);
  f.caption("caller", " go", 250, 350, "event-c");
  assert.deepEqual(
    f.transcripts().map((entry) => entry.text),
    ["go go now", "Okay"],
  );
  assert.deepEqual(f.transcripts()[0]!.details?.fragments, [
    { startMs: 100, endMs: 200 },
    { startMs: 250, endMs: 350 },
    { startMs: 400, endMs: 500 },
  ]);
});

test("native caption records redact joined secrets and never save raw fragment text or audio", () => {
  const f = fixture();
  f.caption("caller", "Code 1234", 0, 100);
  f.caption(
    "caller",
    "5678, phone +15005550006, sk-private-secret and Bearer private-auth",
    100,
    200,
  );
  f.monitor.receive({ type: "session.output_audio.delta", delta: "private-audio-bytes" });
  f.monitor.toolStarted("tool-1", "lookup", { accessCode: "12345678", audio: "raw-audio" });
  f.monitor.toolFinished("tool-1", { password: "private-password" });
  const saved = JSON.stringify([...f.entries.values()]);
  assert.doesNotMatch(
    saved,
    /1234|5678|\+15005550006|sk-private|private-auth|private-audio|raw-audio|private-password/,
  );
  assert.match(saved, /\[code redacted\]/);
  assert.match(saved, /\*\*\*0006/);
  assert.deepEqual(f.transcripts()[0]!.details?.fragments, [
    { startMs: 0, endMs: 100 },
    { startMs: 100, endMs: 200 },
  ]);
});

test("normal closure completes caption windows while errors preserve incomplete evidence", () => {
  for (const [reason, expected] of [
    ["provider_stopped", "complete"],
    ["live_session_closed", "complete"],
    ["live_provider_error", "incomplete"],
    ["twilio_socket_error", "incomplete"],
    ["server_stopping", "incomplete"],
  ]) {
    const f = fixture();
    f.caption("caller", "First window", 0, 100);
    f.caption("caller", "Latest window", 13000, 13200);
    f.monitor.close(reason!);
    assert.equal(f.transcripts()[0]!.status, "complete");
    assert.equal(f.transcripts()[1]!.status, expected, reason);
    const size = f.entries.size;
    f.caption("caller", "must be ignored after close", 14000, 15000);
    f.monitor.close(reason!);
    assert.equal(f.entries.size, size);
    assert.equal(f.transcripts()[1]!.text, "Latest window");
  }
});

test("native transcripts and delegated lifecycle events share one bounded record budget", () => {
  const f = fixture();
  for (let index = 0; index < 1200; index++) {
    f.caption("caller", "A", index * 12000, index * 12000 + 100);
    f.monitor.event("session", "Backend update", { index });
  }
  assert.ok(f.entries.size <= 1000);
  assert.equal(
    [...f.entries.values()].filter((entry) => entry.label === "Capture limit reached").length,
    1,
  );
});

test("long caption windows expose truncation and keep both text and fragment metadata bounded", () => {
  const f = fixture();
  for (let index = 0; index < 1000; index++)
    f.caption("assistant", "x".repeat(40), index, index + 1, `event-${index}`);
  const transcript = f.transcripts()[0]!;
  assert.ok(transcript.text!.length <= 8000);
  assert.equal(transcript.details?.truncated, true);
  assert.ok((transcript.details?.fragments as unknown[]).length <= 512);
  assert.ok([...f.entries.values()].some((entry) => entry.label === "Capture limit reached"));
});

test("invalid caption timing is ignored and monitor capture failures cannot escape", () => {
  const f = fixture();
  for (const [start, end] of [
    [-1, 3],
    [3, 2],
    [NaN, 3],
    [0, Infinity],
  ])
    f.caption("caller", "invalid", start!, end!);
  assert.deepEqual(f.transcripts(), []);
  const monitor = new LiveMonitor(() => {
    throw new Error("storage offline");
  });
  assert.doesNotThrow(() => {
    monitor.receive({
      type: "session.input_transcript.delta",
      delta: "Hello",
      start_ms: 0,
      end_ms: 200,
    });
    monitor.close("provider_stopped");
  });
});
