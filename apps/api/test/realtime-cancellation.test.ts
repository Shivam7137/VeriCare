import assert from "node:assert/strict";
import test from "node:test";
import {
  harness,
  keypad,
  outputAudio,
  pendingActionResult,
  settle,
  toolCall,
} from "./realtime-bridge-fixtures.js";

test("a completed-response cancellation race does not end the authenticated conversation", async (t) => {
  const h = harness();
  t.after(() => h.controller.close());
  await h.connect();
  h.upstream.receive({ type: "response.created", response: { id: "response-race" } });
  h.upstream.receive({ type: "input_audio_buffer.speech_started" });
  const request = h.upstream.events("response.cancel")[0];
  assert.equal(typeof request?.event_id, "string");
  h.upstream.receive({
    type: "response.done",
    response: { id: "response-race", status: "completed" },
  });
  h.upstream.receive({
    type: "error",
    event_id: "server-error-1",
    error: {
      type: "invalid_request_error",
      code: "response_cancel_not_active",
      event_id: request?.event_id,
    },
  });
  assert.equal(h.twilio.closeCalls, 0);
  assert.equal(h.upstream.closeCalls, 0);
  h.upstream.receive({ type: "input_audio_buffer.speech_stopped" });
  h.upstream.receive({ type: "input_audio_buffer.committed", item_id: "caller-turn" });
  h.upstream.receive({ type: "response.created", response: { id: "response-next" } });
  outputAudio(h, "audio-next", "response-next");
  assert.equal(h.twilio.events("media").length, 1);
});

test("uncorrelated cancellation errors and other errors on a tracked request remain fatal", async (t) => {
  for (const error of [
    { code: "response_cancel_not_active", event_id: "never-sent" },
    { code: "response_cancel_not_active" },
    { code: "invalid_api_key", event_id: "cancel-1" },
  ]) {
    const h = harness();
    t.after(() => h.controller.close());
    await h.connect();
    h.upstream.receive({ type: "response.created", response: { id: "response-race" } });
    h.upstream.receive({ type: "input_audio_buffer.speech_started" });
    h.upstream.receive({ type: "error", event_id: "server-error-2", error });
    assert.equal(h.twilio.closeCalls, 1);
    assert.equal(h.upstream.closeCalls, 1);
  }
});

test("an interrupted confirmation can be repeated without accepting stale playback evidence", async (t) => {
  const h = harness({ onTool: async () => pendingActionResult });
  t.after(() => h.controller.close());
  await h.connect();
  h.upstream.receive({ type: "response.created", response: { id: "response-tool" } });
  h.upstream.receive(toolCall());
  await settle();
  h.upstream.receive({
    type: "response.done",
    response: { id: "response-tool", status: "completed" },
  });
  h.upstream.receive({ type: "response.created", response: { id: "readback-first" } });
  outputAudio(h, "audio-first", "readback-first");
  const clearedMark = h.twilio.events("mark")[0]?.mark.name;
  h.upstream.receive({ type: "input_audio_buffer.speech_started" });
  h.upstream.receive({
    type: "response.done",
    response: { id: "readback-first", status: "cancelled" },
  });
  h.upstream.receive({ type: "input_audio_buffer.speech_stopped" });
  h.upstream.receive({ type: "input_audio_buffer.committed", item_id: "repeat-request" });
  h.upstream.receive({ type: "response.created", response: { id: "readback-repeat" } });
  outputAudio(h, "audio-first", "readback-first");
  assert.equal(
    h.twilio.events("media").length,
    1,
    "cancelled audio must not enter the repeated prompt",
  );
  outputAudio(h, "audio-repeat", "readback-repeat");
  const repeatMark = h.twilio.events("mark")[1]?.mark.name;
  h.twilio.receive({ event: "mark", streamSid: "MZsynthetic", mark: { name: clearedMark } });
  h.twilio.receive(keypad("4"));
  await settle();
  assert.deepEqual(h.digits, [], "the previous clear acknowledgement is not repeat playback");
  h.twilio.receive({ event: "mark", streamSid: "MZsynthetic", mark: { name: repeatMark } });
  h.upstream.receive({
    type: "response.done",
    response: { id: "readback-first", status: "completed" },
  });
  h.twilio.receive(keypad("5"));
  await settle();
  assert.deepEqual(h.digits, [], "a late prior response.done must not finish the repeated prompt");
  h.upstream.receive({
    type: "response.done",
    response: { id: "readback-repeat", status: "completed" },
  });
  h.twilio.receive(keypad("6"));
  h.twilio.receive(keypad("6"));
  await settle();
  assert.deepEqual(h.digits, [["1", "phone-call-1"]]);
  assert.equal(h.twilio.closeCalls, 0);
});
