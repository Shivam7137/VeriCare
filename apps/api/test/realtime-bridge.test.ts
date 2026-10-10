import assert from "node:assert/strict";
import test from "node:test";
import {
  audio,
  harness,
  keypad,
  media,
  outputAudio,
  pendingActionResult,
  settle,
  start,
  toolCall,
} from "./realtime-bridge-fixtures.js";

test("authorizes Twilio start before opening the GA realtime connection", async (t) => {
  let verified: unknown;
  const h = harness({
    verifyStart: async (input) => {
      verified = input;
      return { callId: "phone-call-1" };
    },
  });
  t.after(() => h.controller.close());
  assert.equal(h.connections.length, 0);
  await h.connect();
  assert.deepEqual(verified, {
    callSid: "CAsynthetic",
    streamSid: "MZsynthetic",
    customParameters: { token: "synthetic-stream-token" },
  });
  assert.equal(h.connections[0]?.url, "wss://api.openai.com/v1/realtime?model=gpt-realtime");
  assert.deepEqual((h.connections[0]?.options as { headers: unknown }).headers, {
    Authorization: "Bearer synthetic-test-key",
  });
  const session = h.upstream.events("session.update")[0]?.session;
  assert.equal(session.type, "realtime");
  assert.deepEqual(session.audio.input.format, { type: "audio/pcmu" });
  assert.deepEqual(session.audio.output.format, { type: "audio/pcmu" });
  assert.equal(session.audio.output.voice, "cedar");
  assert.equal(session.audio.input.turn_detection.type, "server_vad");
  assert.equal(session.audio.input.turn_detection.create_response, false);
  assert.equal(session.audio.input.turn_detection.interrupt_response, false);
  assert.equal(session.instructions, "Only use the backend tools.");
  assert.equal(session.tools[0].name, "read_status");
  assert.equal(session.tracing, null);
});

test("rejects failed authorization, invalid codecs, and media without a valid start", async (t) => {
  const h = harness({
    verifyStart: async () => {
      throw new Error("private failure details");
    },
  });
  t.after(() => h.controller.close());
  h.twilio.receive(start);
  await settle();
  assert.equal(h.connections.length, 0);
  assert.equal(h.twilio.closeCalls, 1);
  assert.deepEqual(h.closed, []);
  for (const invalid of [
    media(),
    {
      ...start,
      start: {
        ...start.start,
        mediaFormat: { encoding: "audio/pcm", sampleRate: 16000, channels: 1 },
      },
    },
  ]) {
    const invalidHarness = harness();
    t.after(() => invalidHarness.controller.close());
    invalidHarness.twilio.receive(invalid);
    await settle();
    assert.equal(invalidHarness.connections.length, 0);
    assert.equal(invalidHarness.twilio.closeCalls, 1);
  }
});

test("buffers immediate startup audio until verification and session configuration both succeed", async (t) => {
  let authorize!: (value: { callId: string }) => void;
  const pending = harness({
    verifyStart: () =>
      new Promise((resolve) => {
        authorize = resolve;
      }),
  });
  t.after(() => pending.controller.close());
  pending.twilio.receive(start);
  pending.twilio.receive(media());
  const secondAudio = Buffer.alloc(160, 0xfe).toString("base64");
  pending.twilio.receive(media(secondAudio));
  await settle();
  assert.equal(pending.connections.length, 0);
  assert.equal(pending.twilio.closeCalls, 0);
  assert.deepEqual(pending.upstream.sent, []);
  assert.deepEqual(pending.calls, []);
  assert.deepEqual(pending.digits, []);
  authorize({ callId: "phone-call-1" });
  await settle();
  assert.equal(pending.connections.length, 1);
  assert.deepEqual(pending.upstream.sent, []);
  pending.upstream.readyState = 1;
  pending.upstream.emit("open");
  assert.equal(pending.upstream.events("input_audio_buffer.append").length, 0);
  pending.upstream.receive({ type: "session.updated", session: { type: "realtime" } });
  assert.deepEqual(pending.upstream.events("input_audio_buffer.append"), [
    { type: "input_audio_buffer.append", audio },
    { type: "input_audio_buffer.append", audio: secondAudio },
  ]);
  assert.equal(pending.twilio.closeCalls, 0);
});

test("rejects malformed pending-start frames and never executes an unverified keypad action", async (t) => {
  for (const invalid of [
    { ...media(), streamSid: "MZother" },
    media("not valid audio"),
    { ...media(), media: { ...media().media, track: "outbound" } },
    {
      event: "dtmf",
      sequenceNumber: "3",
      streamSid: "MZsynthetic",
      dtmf: { track: "inbound", digit: "1" },
    },
  ]) {
    let authorize!: (value: { callId: string }) => void;
    const pending = harness({
      verifyStart: () =>
        new Promise((resolve) => {
          authorize = resolve;
        }),
    });
    t.after(() => pending.controller.close());
    pending.twilio.receive(start);
    pending.twilio.receive(invalid);
    assert.equal(pending.twilio.closeCalls, 1);
    authorize({ callId: "phone-call-1" });
    await settle();
    assert.equal(pending.connections.length, 0);
    assert.deepEqual(pending.digits, []);
    assert.equal(pending.closed.length, 1);
  }
});

test("discards startup audio after rejected verification or a full startup buffer", async (t) => {
  let reject!: (reason: Error) => void;
  const denied = harness({
    verifyStart: () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  });
  t.after(() => denied.controller.close());
  denied.twilio.receive(start);
  denied.twilio.receive(media());
  reject(new Error("not authorized"));
  await settle();
  assert.equal(denied.twilio.closeCalls, 1);
  assert.equal(denied.connections.length, 0);
  assert.deepEqual(denied.upstream.sent, []);

  let authorize!: (value: { callId: string }) => void;
  const full = harness({
    verifyStart: () =>
      new Promise((resolve) => {
        authorize = resolve;
      }),
  });
  t.after(() => full.controller.close());
  full.twilio.receive(start);
  for (let index = 0; index < 500; index++) full.twilio.receive(media());
  assert.equal(full.twilio.closeCalls, 1);
  authorize({ callId: "phone-call-1" });
  await settle();
  assert.equal(full.connections.length, 0);
  assert.deepEqual(full.closed, [{ callId: "phone-call-1", reason: "audio_buffer_limit" }]);
});

test("buffers only authorized media until session configuration is acknowledged", async (t) => {
  const h = harness();
  t.after(() => h.controller.close());
  h.twilio.receive(start);
  await settle();
  h.twilio.receive(media());
  assert.equal(h.upstream.sent.length, 0);
  h.upstream.readyState = 1;
  h.upstream.emit("open");
  assert.equal(h.upstream.events("input_audio_buffer.append").length, 0);
  h.upstream.receive({ type: "session.updated", session: { type: "realtime" } });
  assert.deepEqual(h.upstream.events("input_audio_buffer.append"), [
    { type: "input_audio_buffer.append", audio },
  ]);
  h.twilio.receive(media());
  assert.equal(h.upstream.events("input_audio_buffer.append").length, 2);
});

test("sends PCMU audio and playback marks back to the bound Twilio stream", async (t) => {
  const h = harness();
  t.after(() => h.controller.close());
  await h.connect();
  h.upstream.receive({ type: "response.created", response: { id: "response-1" } });
  outputAudio(h);
  assert.deepEqual(h.twilio.events("media"), [
    { event: "media", streamSid: "MZsynthetic", media: { payload: audio } },
  ]);
  assert.equal(h.twilio.events("mark").length, 1);
  assert.equal(h.twilio.events("mark")[0]?.streamSid, "MZsynthetic");
});

test("barge-in cancels generation and truncates only to acknowledged playback", async (t) => {
  const h = harness();
  t.after(() => h.controller.close());
  await h.connect();
  h.upstream.receive({ type: "response.created", response: { id: "response-1" } });
  outputAudio(h);
  const firstMark = h.twilio.events("mark")[0]?.mark.name;
  h.twilio.receive({ event: "mark", streamSid: "MZsynthetic", mark: { name: firstMark } });
  outputAudio(h);
  const clearedMark = h.twilio.events("mark")[1]?.mark.name;
  h.upstream.receive({
    type: "input_audio_buffer.speech_started",
    audio_start_ms: 20,
    item_id: "user-1",
  });
  assert.deepEqual(h.upstream.events("response.cancel"), [
    { type: "response.cancel", response_id: "response-1", event_id: "cancel-1" },
  ]);
  assert.deepEqual(h.upstream.events("conversation.item.truncate"), [
    {
      type: "conversation.item.truncate",
      item_id: "item-audio",
      content_index: 0,
      audio_end_ms: 20,
    },
  ]);
  assert.deepEqual(h.twilio.events("clear"), [{ event: "clear", streamSid: "MZsynthetic" }]);
  h.twilio.receive({ event: "mark", streamSid: "MZsynthetic", mark: { name: clearedMark } });
  outputAudio(h);
  assert.equal(h.twilio.events("media").length, 2, "late cancelled audio must not play");
  h.upstream.receive({
    type: "response.done",
    response: { id: "response-1", status: "cancelled" },
  });
  h.upstream.receive({ type: "input_audio_buffer.speech_stopped" });
  h.upstream.receive({ type: "input_audio_buffer.committed", item_id: "user-1" });
  h.upstream.receive({ type: "response.created", response: { id: "response-2" } });
  outputAudio(h, "item-second", "response-2");
  h.upstream.receive({ type: "input_audio_buffer.speech_started" });
  assert.equal(
    h.upstream.events("conversation.item.truncate")[1]?.audio_end_ms,
    0,
    "clear acknowledgements must not count as heard audio",
  );
});

test("clears queued speech after generation has completed without cancelling a finished response", async (t) => {
  const h = harness();
  t.after(() => h.controller.close());
  await h.connect();
  h.upstream.receive({ type: "response.created", response: { id: "response-1" } });
  outputAudio(h);
  h.upstream.receive({
    type: "response.done",
    response: { id: "response-1", status: "completed" },
  });
  h.upstream.receive({ type: "input_audio_buffer.speech_started" });
  assert.equal(h.twilio.events("clear").length, 1);
  assert.equal(h.upstream.events("response.cancel").length, 0);
  assert.equal(h.upstream.events("conversation.item.truncate")[0]?.audio_end_ms, 0);
});

test("tool results preserve call IDs and duplicate tool events execute only once", async (t) => {
  const h = harness();
  t.after(() => h.controller.close());
  await h.connect();
  h.upstream.receive({ type: "response.created", response: { id: "response-tool" } });
  h.upstream.receive(toolCall('{"taskId":"synthetic-task"}'));
  h.upstream.receive(toolCall('{"taskId":"synthetic-task"}'));
  await settle();
  assert.deepEqual(h.calls, [
    ["read_status", { taskId: "synthetic-task" }, "phone-call-1", "tool-call-1"],
  ]);
  const results = h.upstream.events("conversation.item.create");
  assert.equal(results.length, 1);
  assert.deepEqual(results[0]?.item, {
    type: "function_call_output",
    call_id: "tool-call-1",
    output: '{"state":"awaiting_confirmation"}',
  });
  const beforeDone = h.upstream.events("response.create").length;
  h.upstream.receive({
    type: "response.done",
    response: { id: "response-tool", status: "completed" },
  });
  assert.equal(
    h.upstream.events("response.create").length,
    beforeDone + 1,
    "wait for response.done before follow-up",
  );
  h.upstream.receive(toolCall('{"taskId":"synthetic-task"}'));
  await settle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.upstream.events("conversation.item.create").length, 1);
});

test("malformed and unregistered tools produce bounded safe errors without backend invocation", async (t) => {
  const h = harness();
  t.after(() => h.controller.close());
  await h.connect();
  for (const [index, args] of ["{", "[]", "null"].entries())
    h.upstream.receive(toolCall(args, `bad-${index}`));
  h.upstream.receive(toolCall("{}", "unknown-tool", "complete_booking"));
  await settle();
  assert.equal(h.calls.length, 0);
  const outputs = h.upstream.events("conversation.item.create");
  assert.equal(outputs.length, 4);
  for (const output of outputs) assert.equal(JSON.parse(output.item.output).ok, false);
  h.upstream.receive(toolCall("{}", "reused-id"));
  await settle();
  h.upstream.receive(toolCall('{"changed":true}', "reused-id"));
  assert.equal(h.twilio.closeCalls, 1);
  assert.equal(h.calls.length, 1);
});

test("DTMF cancellation reaches the backend callback and exact transport replays are ignored", async (t) => {
  const h = harness();
  t.after(() => h.controller.close());
  await h.connect();
  const digit = {
    event: "dtmf",
    sequenceNumber: "4",
    streamSid: "MZsynthetic",
    dtmf: { track: "inbound", digit: "2" },
  };
  h.twilio.receive(digit);
  h.twilio.receive(digit);
  await settle();
  assert.deepEqual(h.digits, [["2", "phone-call-1", undefined]]);
  assert.deepEqual(h.calls, []);
  const event = h.upstream.events("conversation.item.create")[0];
  assert.equal(event?.item.role, "user");
  assert.match(event?.item.content[0].text, /confirmed/);
});

test("an early keypad press cannot approve a future action or an unplayed readback", async (t) => {
  let finish!: (value: unknown) => void;
  const h = harness({
    onTool: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  t.after(() => h.controller.close());
  await h.connect();
  h.upstream.receive({ type: "response.created", response: { id: "response-tool" } });
  h.upstream.receive(toolCall());
  await settle();
  h.twilio.receive(keypad("4"));
  finish(pendingActionResult);
  await settle();
  assert.deepEqual(h.digits, [], "keypad input must not wait behind a prepare tool");
  h.upstream.receive({
    type: "response.done",
    response: { id: "response-tool", status: "completed" },
  });
  h.upstream.receive({ type: "response.created", response: { id: "response-readback" } });
  outputAudio(h, "item-readback", "response-readback");
  h.upstream.receive({
    type: "response.done",
    response: { id: "response-readback", status: "completed" },
  });
  h.twilio.receive(keypad("5"));
  await settle();
  assert.deepEqual(h.digits, [], "generation completion is not playback completion");
  const mark = h.twilio.events("mark")[0]?.mark.name;
  h.twilio.receive({ event: "mark", streamSid: "MZsynthetic", mark: { name: mark } });
  h.twilio.receive(keypad("4"));
  h.twilio.receive(keypad("5"));
  await settle();
  assert.deepEqual(h.digits, [], "previously discarded presses must remain discarded");
  h.twilio.receive(keypad("6"));
  h.twilio.receive(keypad("6"));
  await settle();
  assert.deepEqual(h.digits, [["1", "phone-call-1", pendingActionResult.pendingAction.id]]);
});

test("keypad approval requires a pending action and cannot use marks released by a cleared readback", async (t) => {
  const h = harness({ onTool: async () => pendingActionResult });
  t.after(() => h.controller.close());
  await h.connect();
  h.twilio.receive(keypad("3"));
  await settle();
  assert.deepEqual(h.digits, []);
  h.upstream.receive({ type: "response.created", response: { id: "response-tool" } });
  h.upstream.receive(toolCall());
  await settle();
  h.upstream.receive({
    type: "response.done",
    response: { id: "response-tool", status: "completed" },
  });
  h.upstream.receive({ type: "response.created", response: { id: "response-readback" } });
  outputAudio(h, "item-readback", "response-readback");
  const mark = h.twilio.events("mark")[0]?.mark.name;
  h.upstream.receive({
    type: "response.done",
    response: { id: "response-readback", status: "completed" },
  });
  h.upstream.receive({ type: "input_audio_buffer.speech_started" });
  h.twilio.receive({ event: "mark", streamSid: "MZsynthetic", mark: { name: mark } });
  h.twilio.receive(keypad("4"));
  await settle();
  assert.deepEqual(h.digits, []);
});

test("disconnect, stop, provider errors, and session timeout close both sockets and record outcome once", async (t) => {
  for (const cause of ["twilio-close", "upstream-error", "provider-error", "stop"] as const) {
    const h = harness();
    t.after(() => h.controller.close());
    await h.connect();
    if (cause === "twilio-close") h.twilio.close();
    if (cause === "upstream-error") h.upstream.emit("error", new Error("private provider details"));
    if (cause === "provider-error")
      h.upstream.receive({ type: "error", error: { message: "private provider details" } });
    if (cause === "stop")
      h.twilio.receive({
        event: "stop",
        streamSid: "MZsynthetic",
        stop: { callSid: "CAsynthetic" },
      });
    assert.equal(h.twilio.closeCalls, 1, cause);
    h.controller.close();
    await settle();
    assert.equal(h.twilio.closeCalls, 1, cause);
    assert.equal(h.upstream.closeCalls, 1, cause);
    assert.equal(h.closed.length, 1, cause);
    assert.equal(h.closed[0]?.callId, "phone-call-1");
    assert.doesNotMatch(h.closed[0]?.reason ?? "", /private/);
  }
  const timeout = harness({ sessionTimeoutMs: 15 });
  t.after(() => timeout.controller.close());
  await timeout.connect();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(timeout.closed, [{ callId: "phone-call-1", reason: "session_timeout" }]);
  assert.equal(timeout.upstream.closeCalls, 1);
});

test("rejects duplicate starts, wrong stream IDs, malformed frames, excessive audio, and backpressure", async (t) => {
  for (const invalid of [
    start,
    { ...media(), streamSid: "MZother" },
    media("not base64!"),
    media(Buffer.alloc(32 * 1024).toString("base64")),
  ]) {
    const h = harness();
    t.after(() => h.controller.close());
    await h.connect();
    h.twilio.receive(invalid);
    assert.equal(h.twilio.closeCalls, 1);
    assert.equal(h.upstream.closeCalls, 1);
  }
  const malformed = harness();
  t.after(() => malformed.controller.close());
  malformed.twilio.emit("message", Buffer.from("{"));
  assert.equal(malformed.twilio.closeCalls, 1);
  const blocked = harness();
  t.after(() => blocked.controller.close());
  await blocked.connect();
  blocked.upstream.bufferedAmount = 1024 * 1024;
  blocked.twilio.receive(media());
  assert.equal(blocked.twilio.closeCalls, 1);
  const queued = harness();
  t.after(() => queued.controller.close());
  queued.twilio.receive(start);
  await settle();
  for (let index = 0; index < 500; index++) queued.twilio.receive(media());
  assert.equal(queued.twilio.closeCalls, 1);
});

test("a delayed response.created is cancelled without losing the caller's newly committed turn", async (t) => {
  const h = harness();
  t.after(() => h.controller.close());
  h.twilio.receive(start);
  await settle();
  h.upstream.readyState = 1;
  h.upstream.emit("open");
  h.upstream.receive({ type: "session.updated" });
  assert.equal(h.upstream.events("response.create").length, 1);
  h.upstream.receive({ type: "input_audio_buffer.speech_started" });
  h.upstream.receive({ type: "input_audio_buffer.speech_stopped" });
  h.upstream.receive({ type: "input_audio_buffer.committed", item_id: "caller-turn" });
  h.upstream.receive({ type: "response.created", response: { id: "late-greeting" } });
  assert.deepEqual(h.upstream.events("response.cancel"), [
    { type: "response.cancel", response_id: "late-greeting", event_id: "cancel-1" },
  ]);
  h.upstream.receive({
    type: "response.done",
    response: { id: "late-greeting", status: "cancelled" },
  });
  assert.equal(h.upstream.events("response.create").length, 2);
});

test("waits for backend tools after response.done and never emits an overlapping follow-up", async (t) => {
  let finish!: (value: unknown) => void;
  const h = harness({
    onTool: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  t.after(() => h.controller.close());
  await h.connect();
  h.upstream.receive({ type: "response.created", response: { id: "response-tool" } });
  h.upstream.receive(toolCall());
  await settle();
  h.upstream.receive({
    type: "response.done",
    response: { id: "response-tool", status: "completed" },
  });
  const before = h.upstream.events("response.create").length;
  h.upstream.receive({ type: "input_audio_buffer.committed", item_id: "user-2" });
  assert.equal(h.upstream.events("response.create").length, before);
  finish({ ok: true });
  await settle();
  assert.equal(h.upstream.events("response.create").length, before + 1);
  assert.equal(h.upstream.events("conversation.item.create").length, 1);
});

test("late authorization and backend results cannot reopen a disconnected conversation", async (t) => {
  let authorize!: (value: { callId: string }) => void;
  const auth = harness({
    verifyStart: () =>
      new Promise((resolve) => {
        authorize = resolve;
      }),
  });
  t.after(() => auth.controller.close());
  auth.twilio.receive(start);
  auth.twilio.close();
  authorize({ callId: "phone-call-1" });
  await settle();
  assert.equal(auth.connections.length, 0);
  assert.deepEqual(auth.closed, [{ callId: "phone-call-1", reason: "twilio_closed" }]);

  let finish!: (value: unknown) => void;
  const tool = harness({
    onTool: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  t.after(() => tool.controller.close());
  await tool.connect();
  tool.upstream.receive(toolCall());
  await settle();
  tool.twilio.close();
  finish({ secretInternalDetails: "must not be sent after disconnect" });
  await settle();
  assert.equal(tool.upstream.events("conversation.item.create").length, 0);
  assert.equal(tool.closed.length, 1);
});

test("fails closed when session negotiation stalls and when start never arrives", async (t) => {
  const noStart = harness({ startTimeoutMs: 10 });
  const noSession = harness({ startTimeoutMs: 10 });
  t.after(() => noStart.controller.close());
  t.after(() => noSession.controller.close());
  noSession.twilio.receive(start);
  await settle();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(noStart.twilio.closeCalls, 1);
  assert.equal(noStart.connections.length, 0);
  assert.equal(noSession.upstream.closeCalls, 1);
  assert.equal(noSession.closed[0]?.reason, "upstream_setup_timeout");
});

test("backend exceptions and oversized results disclose neither stack traces nor private messages", async (t) => {
  for (const onTool of [
    async () => {
      throw new Error("private stack information");
    },
    async () => ({ value: "x".repeat(64 * 1024) }),
  ]) {
    const h = harness({ onTool });
    t.after(() => h.controller.close());
    await h.connect();
    h.upstream.receive(toolCall());
    await settle();
    const output = h.upstream.events("conversation.item.create")[0]?.item.output;
    assert.equal(JSON.parse(output).ok, false);
    assert.ok(output.length < 100);
    assert.doesNotMatch(output, /private|stack/);
  }
});
