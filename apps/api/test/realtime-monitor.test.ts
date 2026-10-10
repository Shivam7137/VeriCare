import assert from "node:assert/strict";
import test from "node:test";
import { harness, settle, toolCall } from "./realtime-bridge-fixtures.js";
import { RealtimeMonitor } from "../src/realtime-monitor.js";
import type { VoiceMonitorEntry } from "@prc/contracts";

test("bridge streams caller and assistant transcripts, resolves tools once, and records interruption", async () => {
  const entries: any[] = [];
  const h = harness({
    onMonitor: (_callId: string, entry: unknown) => entries.push(structuredClone(entry)),
  } as any);
  await h.connect();
  assert.deepEqual(h.upstream.events("session.update")[0]?.session.audio.input.transcription, {
    model: "gpt-4o-mini-transcribe",
  });
  h.upstream.receive({ type: "input_audio_buffer.speech_started", item_id: "caller-1" });
  h.upstream.receive({ type: "input_audio_buffer.speech_stopped", item_id: "caller-1" });
  h.upstream.receive({
    type: "conversation.item.input_audio_transcription.delta",
    item_id: "caller-1",
    delta: "Move my ",
  });
  h.upstream.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "caller-1",
    transcript: "Move my appointment.",
  });
  h.upstream.receive(toolCall());
  h.upstream.receive(toolCall());
  await settle();
  h.upstream.receive({ type: "response.created", response: { id: "reply-1" } });
  h.upstream.receive({
    type: "response.output_audio_transcript.delta",
    response_id: "reply-1",
    item_id: "assistant-1",
    delta: "Let me check.",
  });
  h.upstream.receive({ type: "input_audio_buffer.speech_started", item_id: "caller-2" });
  h.upstream.receive({
    type: "response.output_audio_transcript.done",
    response_id: "reply-1",
    item_id: "assistant-1",
    transcript: "Let me check that appointment.",
  });
  h.controller.close("test_done");
  await h.controller.finished;
  const latest = [...new Map(entries.map((entry) => [entry.id, entry])).values()];
  assert.equal(latest.find((e) => e.itemId === "caller-1")?.text, "Move my appointment.");
  assert.equal(latest.find((e) => e.itemId === "assistant-1")?.status, "interrupted");
  const tool = latest.find((e) => e.kind === "tool");
  assert.equal(tool?.status, "complete");
  assert.deepEqual(tool?.details.result, { state: "awaiting_confirmation" });
  assert.equal(h.calls.length, 1);
  assert.ok(latest.some((e) => e.label === "Call stream ended"));
});

test("out-of-order transcription finalizes its original turn; late output does not hide a failed response", () => {
  const entries = new Map<string, VoiceMonitorEntry>();
  const monitor = new RealtimeMonitor((entry) => entries.set(entry.id, entry));
  for (const id of ["caller-a", "caller-b"])
    monitor.receive({ type: "input_audio_buffer.speech_started", item_id: id });
  monitor.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "caller-b",
    transcript: "Second turn",
  });
  monitor.receive({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "caller-a",
    transcript: "First turn",
  });
  assert.deepEqual(
    [...entries.values()].map((entry) => entry.text),
    ["First turn", "Second turn"],
  );
  monitor.receive({ type: "response.created", response: { id: "failed-response" } });
  monitor.receive({ type: "response.done", response: { id: "failed-response", status: "failed" } });
  monitor.receive({
    type: "response.output_audio_transcript.done",
    item_id: "assistant-a",
    response_id: "failed-response",
    transcript: "Partial response",
  });
  assert.equal(entries.get("transcript-assistant-a")?.status, "failed");
});

test("monitor excludes audio, credentials and full destination numbers, and bounds stored text", () => {
  const entries = new Map<string, VoiceMonitorEntry>();
  const monitor = new RealtimeMonitor((entry) => entries.set(entry.id, entry));
  monitor.toolStarted("tool-a", "list_care_team", {
    authorization: "private",
    nested: { accessCode: "12345678" },
    phoneNumber: "+12025550123",
  });
  monitor.toolFinished("tool-a", {
    token: "private-token",
    audio: "raw-audio",
    result: "sk-test-secretvalue",
    data: "x".repeat(20000),
  });
  monitor.receive({ type: "response.output_audio.delta", delta: "raw-audio" });
  const saved = JSON.stringify([...entries.values()]);
  assert.doesNotMatch(saved, /private|12345678|\+12025550123|raw-audio|sk-test/);
  assert.match(saved, /\*\*\*0123/);
  assert.ok(saved.length < 17000);
});

test("transcription failure and premature stream end stay visible without inventing text", () => {
  const entries = new Map<string, VoiceMonitorEntry>();
  const monitor = new RealtimeMonitor((entry) => entries.set(entry.id, entry));
  monitor.receive({ type: "input_audio_buffer.speech_started", item_id: "caller-a" });
  monitor.receive({
    type: "conversation.item.input_audio_transcription.failed",
    item_id: "caller-a",
    error: { code: "transcription_error", message: "private-provider-debug" },
  });
  monitor.toolStarted("tool-b", "read_status", {});
  monitor.close("twilio_closed");
  assert.equal(entries.get("transcript-caller-a")?.status, "failed");
  assert.equal(entries.get("tool-tool-b")?.status, "incomplete");
  assert.doesNotMatch(JSON.stringify([...entries.values()]), /private-provider-debug/);
});

test("capture exceptions never break the voice bridge", async () => {
  const h = harness({
    onMonitor: () => {
      throw new Error("capture offline");
    },
  } as any);
  await h.connect();
  h.upstream.receive(toolCall());
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.closed.length, 0);
  h.controller.close();
  await h.controller.finished;
});
