import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { bridgeLive, type LiveBridgeOptions } from "../src/live-bridge.js";
import { start, media, audio, settle } from "./realtime-bridge-fixtures.js";

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
    return this.sent.filter((e) => e.type === type || e.event === type);
  }
}
function harness(extra: Partial<LiveBridgeOptions> = {}) {
  const phone = new Socket(),
    live = new Socket();
  const tools: unknown[] = [],
    digits: unknown[] = [],
    codes: string[] = [],
    captured: any[] = [];
  const urls: string[] = [];
  const controller = bridgeLive(phone, {
    apiKey: "test",
    instructions: "Backend rules",
    tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
    verifyStart: async () => ({ callId: "call-1" }),
    onTool: async (...args) => {
      tools.push(args);
      return { status: "authorization_required" };
    },
    onDigit: async (...args) => {
      digits.push(args);
      return { status: "saved" };
    },
    onVerify: async (code) => {
      codes.push(code);
      return { status: "verified", role: "staff" };
    },
    onClose: async () => {},
    onMonitor: (_, e) => captured.push(e),
    socketFactory: (url) => {
      urls.push(url);
      return live;
    },
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
    live.receive({
      type: "response.event",
      delegation_id: "d-1",
      event: { type: "response.created", response: { id: "r-1" } },
    });
    live.receive({
      type: "response.event",
      delegation_id: "d-1",
      event: {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: id, name: "lookup", arguments: "{}" },
      },
    });
    live.receive({
      type: "response.event",
      delegation_id: "d-1",
      event: { type: "response.completed", response: { id: "r-1", status: "completed" } },
    });
  }
  function digit(digit: string, sequence: string) {
    phone.receive({
      event: "dtmf",
      streamSid: "MZsynthetic",
      sequenceNumber: sequence,
      dtmf: { track: "inbound_track", digit },
    });
  }
  return { phone, live, tools, digits, codes, captured, urls, controller, connect, call, digit };
}

test("starts GPT-Live with native mulaw, brief greeting and separate backend rules", async (t) => {
  const h = harness();
  t.after(() => h.controller.close());
  await h.connect();
  assert.equal(h.urls[0], "wss://api.openai.com/v1/live/sessions");
  const s = h.live.events("session.start")[0]!.session;
  assert.equal(s.model, "gpt-live-1");
  assert.equal(s.audio.output.voice, "cedar");
  assert.deepEqual(s.audio.format, { type: "audio/pcmu", rate: 8000 });
  assert.equal(s.delegation.responses.instructions, "Backend rules");
  assert.equal(h.live.events("response.create").length, 0);
  assert.match(h.live.events("session.instructions.append")[0]!.content, /Hi.*AI.*help/i);
  h.phone.receive(media());
  assert.equal(h.live.events("session.input_audio.append")[0]!.audio, audio);
});
test("waits for all delegated tool output, continues once and deduplicates provider replay", async (t) => {
  const h = harness();
  t.after(() => h.controller.close());
  await h.connect();
  h.call();
  await settle();
  await settle();
  assert.equal(h.tools.length, 1);
  assert.equal(h.live.events("response.item.create").length, 1);
  assert.equal(h.live.events("response.create").length, 1);
  h.call();
  await settle();
  assert.equal(h.tools.length, 1);
  assert.equal(h.live.events("response.create").length, 1);
});
test("collects secret code only after an authorization challenge without forwarding digits", async (t) => {
  const h = harness();
  t.after(() => h.controller.close());
  await h.connect();
  h.digit("1", "1");
  await settle();
  assert.equal(h.digits.length, 0);
  h.call();
  await settle();
  await settle();
  for (const [i, d] of [..."12345678"].entries()) h.digit(d, String(i + 2));
  await settle();
  await settle();
  assert.deepEqual(h.codes, ["12345678"]);
  assert.equal(h.digits.length, 0);
  assert.ok(!JSON.stringify(h.live.sent).includes("12345678"));
  assert.ok(!JSON.stringify(h.captured).includes("12345678"));
});
test("requires the readback closing phrase and acknowledged playback before keypad approval", async (t) => {
  const h = harness({
    onTool: async () => ({
      pendingAction: { id: "action-1", description: "Send your portal link." },
    }),
  });
  t.after(() => h.controller.close());
  await h.connect();
  h.call();
  await settle();
  await settle();
  h.digit("1", "10");
  await settle();
  assert.equal(h.digits.length, 0);
  h.live.receive({
    type: "session.output_transcript.delta",
    delta: "Send your portal link. Press one to approve or two to cancel.",
    start_ms: 10,
    end_ms: 200,
  });
  h.live.receive({
    type: "session.output_audio.delta",
    delta: Buffer.alloc(160, 0x80).toString("base64"),
  });
  h.live.receive({
    type: "session.output_audio.delta",
    delta: Buffer.alloc(2560, 0xff).toString("base64"),
  });
  h.digit("1", "11");
  await settle();
  assert.equal(h.digits.length, 0);
  const mark = h.phone.events("mark").at(-1)!.mark;
  h.phone.receive({ event: "mark", streamSid: "MZsynthetic", mark });
  h.digit("1", "12");
  await settle();
  assert.deepEqual(h.digits, [["1", "call-1", "action-1"]]);
});
test("saves native caller and assistant transcript fragments, with backend events separate", async (t) => {
  const h = harness();
  t.after(() => h.controller.close());
  await h.connect();
  h.live.receive({
    type: "session.input_transcript.delta",
    delta: "Hello",
    start_ms: 0,
    end_ms: 200,
  });
  h.live.receive({
    type: "session.output_transcript.delta",
    delta: "Hi there",
    start_ms: 100,
    end_ms: 300,
  });
  h.live.receive({
    type: "session.input_transcript.delta",
    delta: " there",
    start_ms: 250,
    end_ms: 400,
  });
  assert.ok(h.captured.some((e) => e.speaker === "caller" && e.text === "Hello there"));
  assert.ok(h.captured.some((e) => e.speaker === "assistant" && e.text === "Hi there"));
  assert.ok(h.captured.some((e) => e.details?.model === "gpt-live-1"));
});
