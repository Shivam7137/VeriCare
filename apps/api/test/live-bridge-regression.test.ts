import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { bridgeLive, type LiveBridgeOptions } from "../src/live-bridge.js";
import { settle, start } from "./realtime-bridge-fixtures.js";

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.emit("close");
  }
  receive(value: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
  events(type: string) {
    return this.sent.filter((event) => event.type === type || event.event === type);
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness(extra: Partial<LiveBridgeOptions> = {}) {
  const phone = new Socket(),
    live = new Socket();
  const digits: unknown[][] = [],
    codes: string[] = [];
  const controller = bridgeLive(phone, {
    apiKey: "test",
    instructions: "Only perform authorized actions.",
    tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
    verifyStart: async () => ({ callId: "call-1" }),
    onTool: async () => ({ status: "authorization_required" }),
    onDigit: async (...args) => {
      digits.push(args);
      return { status: "saved" };
    },
    onVerify: async (code) => {
      codes.push(code);
      return { status: "verified" };
    },
    onClose: async () => {},
    socketFactory: () => live,
    ...extra,
  });
  async function connect() {
    phone.receive(start);
    await settle();
    live.emit("open");
    live.receive({ type: "session.started", session: { model: "gpt-live-1" } });
    await settle();
  }
  function call(id = "tool-1") {
    const response = { id: `response-${id}` };
    live.receive({
      type: "response.event",
      delegation_id: "delegation-1",
      event: { type: "response.created", response },
    });
    live.receive({
      type: "response.event",
      delegation_id: "delegation-1",
      event: {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: id, name: "lookup", arguments: "{}" },
      },
    });
    live.receive({
      type: "response.event",
      delegation_id: "delegation-1",
      event: { type: "response.completed", response: { ...response, status: "completed" } },
    });
  }
  function digit(value: string, sequence: string) {
    phone.receive({
      event: "dtmf",
      streamSid: "MZsynthetic",
      sequenceNumber: sequence,
      dtmf: { track: "inbound_track", digit: value },
    });
  }
  function caption() {
    live.receive({
      type: "session.output_transcript.delta",
      delta: "Send your portal link. Press one to approve or two to cancel.",
      start_ms: 10,
      end_ms: 200,
    });
  }
  function output(sample = 0x80, bytes = 160) {
    live.receive({
      type: "session.output_audio.delta",
      delta: Buffer.alloc(bytes, sample).toString("base64"),
    });
  }
  function quiet() {
    output(0xff, 2560);
  }
  function played(index: number) {
    phone.receive({
      event: "mark",
      streamSid: "MZsynthetic",
      mark: phone.events("mark")[index]!.mark,
    });
  }
  return {
    phone,
    live,
    digits,
    codes,
    controller,
    connect,
    call,
    digit,
    caption,
    output,
    quiet,
    played,
  };
}
const prepared = { pendingAction: { id: "action-1", description: "Send your portal link." } };

test("Live shutdown waits for a started tool before durable close and finished", async (t) => {
  const tool = deferred<unknown>();
  let started = false,
    finalized = false,
    finished = false;
  const h = harness({
    onTool: async () => {
      started = true;
      return tool.promise;
    },
    onClose: async () => {
      finalized = true;
    },
  });
  t.after(() => {
    tool.resolve({ status: "read" });
    h.controller.close();
  });
  await h.connect();
  h.call();
  await settle();
  assert.equal(started, true);
  void h.controller.finished.then(() => {
    finished = true;
  });
  h.controller.close("server_stopping");
  await settle();
  assert.equal(finalized, false, "onClose must not flush/close storage while a tool is running");
  assert.equal(finished, false);
  tool.resolve({ status: "read" });
  await h.controller.finished;
  assert.equal(finalized, true);
  assert.equal(h.live.events("response.item.create").length, 0);
});

test("digits received before an authorization challenge cannot become a code behind a slow tool", async (t) => {
  const tool = deferred<unknown>();
  const h = harness({ onTool: async () => tool.promise });
  t.after(() => {
    tool.resolve({});
    h.controller.close();
  });
  await h.connect();
  h.call();
  await settle();
  for (const [index, value] of [..."12345678"].entries()) h.digit(value, String(index + 1));
  tool.resolve({ status: "authorization_required" });
  await settle();
  await settle();
  assert.deepEqual(h.codes, [], "only digits arriving after the challenge count as code entry");
});

test("a queued keypad approval retains its arrival-time readback gate", async (t) => {
  const slow = deferred<unknown>();
  let calls = 0;
  const h = harness({ onTool: async () => (++calls === 1 ? prepared : slow.promise) });
  t.after(() => {
    slow.resolve({});
    h.controller.close();
  });
  await h.connect();
  h.call();
  await settle();
  h.call("tool-2");
  await settle();
  h.caption();
  h.output();
  h.quiet();
  h.digit("1", "1");
  h.played(0);
  h.played(1);
  slow.resolve({ status: "read" });
  await settle();
  await settle();
  assert.deepEqual(h.digits, [], "a key pressed before playback completed must not approve later");
});

test("readback approval waits for all already queued audio after the closing caption", async (t) => {
  const h = harness({ onTool: async () => prepared });
  t.after(() => h.controller.close());
  await h.connect();
  h.call();
  await settle();
  h.caption();
  h.output();
  h.output();
  h.quiet();
  h.played(0);
  h.digit("1", "1");
  await settle();
  assert.deepEqual(
    h.digits,
    [],
    "the first 20 ms audio mark cannot prove the rest of readback played",
  );
  h.played(1);
  h.digit("1", "2");
  await settle();
  assert.deepEqual(h.digits, [], "the quiet-tail playback mark is still outstanding");
  h.played(2);
  h.digit("1", "3");
  await settle();
  assert.deepEqual(h.digits, [["1", "call-1", "action-1"]]);
});

test("late readback captions can bind audio already queued for playback", async (t) => {
  const h = harness({ onTool: async () => prepared });
  t.after(() => h.controller.close());
  await h.connect();
  h.call();
  await settle();
  h.output();
  h.quiet();
  h.caption();
  h.played(0);
  h.played(1);
  h.digit("1", "1");
  await settle();
  assert.deepEqual(h.digits, [["1", "call-1", "action-1"]]);
});

test("continuous silence does not extend a qualified readback playback boundary", async (t) => {
  const h = harness({ onTool: async () => prepared });
  t.after(() => h.controller.close());
  await h.connect();
  h.call();
  await settle();
  h.caption();
  h.output();
  h.quiet();
  h.output(0x7f, 2560);
  h.quiet();
  h.played(0);
  h.played(1);
  h.digit("1", "1");
  await settle();
  assert.deepEqual(h.digits, [["1", "call-1", "action-1"]]);
});

test("caller captions invalidate an unfinished readback without cutting native full-duplex audio", async (t) => {
  const h = harness({ onTool: async () => prepared });
  t.after(() => h.controller.close());
  await h.connect();
  h.call();
  await settle();
  h.caption();
  h.output();
  h.quiet();
  h.live.receive({
    type: "session.input_transcript.delta",
    delta: "Wait",
    start_ms: 100,
    end_ms: 300,
  });
  assert.equal(h.phone.events("clear").length, 0, "delayed captions are not playback controls");
  h.caption();
  h.played(0);
  h.played(1);
  h.digit("1", "1");
  await settle();
  assert.deepEqual(h.digits, [], "old playback marks cannot restore the interrupted readback");
  h.output();
  h.quiet();
  h.played(2);
  h.played(3);
  h.digit("1", "2");
  await settle();
  assert.deepEqual(h.digits, [["1", "call-1", "action-1"]]);
});

test("silence without readback speech cannot authorize an action", async (t) => {
  const h = harness({ onTool: async () => prepared });
  t.after(() => h.controller.close());
  await h.connect();
  h.call();
  await settle();
  h.caption();
  h.quiet();
  h.output(0x7f, 2560);
  h.played(0);
  h.played(1);
  h.digit("1", "1");
  await settle();
  assert.deepEqual(h.digits, []);
});

test("shutdown waits for keypad verification already in flight", async (t) => {
  const verification = deferred<unknown>();
  let verifying = false,
    finalized = false;
  const h = harness({
    onVerify: async () => {
      verifying = true;
      return verification.promise;
    },
    onClose: async () => {
      finalized = true;
    },
  });
  t.after(() => {
    verification.resolve({ status: "verified" });
    h.controller.close();
  });
  await h.connect();
  h.call();
  await settle();
  for (const [index, value] of [..."12345678"].entries()) h.digit(value, String(index + 1));
  await settle();
  assert.equal(verifying, true);
  h.controller.close("server_stopping");
  await settle();
  assert.equal(finalized, false);
  verification.resolve({ status: "verified" });
  await h.controller.finished;
  assert.equal(finalized, true);
  assert.equal(h.live.events("session.commentary.append").length, 0);
});

test("verification restores an existing SMS preview and requires a fresh readback before approval", async (t) => {
  let calls = 0;
  const h = harness({
    onTool: async () => (++calls === 1 ? prepared : { status: "authorization_required" }),
    onVerify: async () => ({ status: "verified", pendingAction: prepared.pendingAction }),
  });
  t.after(() => h.controller.close());
  await h.connect();
  h.call();
  await settle();
  h.caption();
  h.output();
  h.quiet();
  h.played(0);
  h.played(1);
  h.call("tool-2");
  await settle();
  for (const [index, value] of [..."12345678"].entries()) h.digit(value, String(index + 1));
  // This key arrives in code-entry mode, before verification has restored the preview.
  h.digit("1", "9");
  await settle();
  assert.deepEqual(h.digits, []);
  h.digit("1", "10");
  await settle();
  assert.deepEqual(h.digits, [], "the old playback evidence cannot approve the restored preview");
  h.caption();
  h.output();
  h.quiet();
  h.played(2);
  h.played(3);
  h.digit("1", "11");
  await settle();
  assert.deepEqual(h.digits, [["1", "call-1", "action-1"]]);
});
