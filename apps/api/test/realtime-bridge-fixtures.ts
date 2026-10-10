import { EventEmitter } from "node:events";
import { bridgeRealtime, type RealtimeBridgeOptions } from "../src/realtime-bridge.js";

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  closeCalls = 0;
  send(message: string) {
    this.sent.push(JSON.parse(message));
  }
  close() {
    this.closeCalls++;
    this.readyState = 3;
    this.emit("close");
  }
  receive(message: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
  events(type: string) {
    return this.sent.filter((event) => event.type === type || event.event === type);
  }
}

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
export const audio = Buffer.alloc(160, 0xff).toString("base64");
export const start = {
  event: "start",
  sequenceNumber: "1",
  streamSid: "MZsynthetic",
  start: {
    streamSid: "MZsynthetic",
    callSid: "CAsynthetic",
    customParameters: { token: "synthetic-stream-token" },
    mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
  },
};
export const media = (payload = audio) => ({
  event: "media",
  streamSid: "MZsynthetic",
  media: { track: "inbound", timestamp: "20", payload },
});

export function harness(overrides: Partial<RealtimeBridgeOptions> = {}) {
  const twilio = new Socket();
  const upstream = new Socket();
  upstream.readyState = 0;
  const connections: { url: string; options: unknown }[] = [];
  const closed: { callId: string; reason: string }[] = [];
  const calls: unknown[][] = [];
  const digits: unknown[][] = [];
  const controller = bridgeRealtime(twilio, {
    apiKey: "synthetic-test-key",
    instructions: "Only use the backend tools.",
    voice: "cedar",
    tools: [
      {
        type: "function",
        name: "read_status",
        description: "Read progress",
        parameters: { type: "object", properties: {} },
      },
    ],
    verifyStart: async () => ({ callId: "phone-call-1" }),
    onTool: async (...args) => {
      calls.push(args);
      return { state: "awaiting_confirmation" };
    },
    onDigit: async (...args) => {
      digits.push(args);
      return { confirmed: true };
    },
    onClose: async (callId, reason) => {
      closed.push({ callId, reason });
    },
    socketFactory: (url, options) => {
      connections.push({ url, options });
      return upstream;
    },
    ...overrides,
  });
  async function connect() {
    twilio.receive(start);
    await settle();
    upstream.readyState = 1;
    upstream.emit("open");
    upstream.receive({ type: "session.updated", session: { type: "realtime" } });
    upstream.receive({ type: "response.created", response: { id: "response-greeting" } });
    upstream.receive({
      type: "response.done",
      response: { id: "response-greeting", status: "completed" },
    });
    return settle();
  }
  return { twilio, upstream, connections, closed, calls, digits, controller, connect };
}

export function outputAudio(
  h: ReturnType<typeof harness>,
  itemId = "item-audio",
  responseId = "response-1",
) {
  h.upstream.receive({
    type: "response.output_audio.delta",
    response_id: responseId,
    item_id: itemId,
    content_index: 0,
    output_index: 0,
    delta: audio,
  });
}

export const toolCall = (args = "{}", callId = "tool-call-1", name = "read_status") => ({
  type: "response.function_call_arguments.done",
  event_id: "event-1",
  response_id: "response-tool",
  item_id: "item-tool",
  output_index: 0,
  call_id: callId,
  name,
  arguments: args,
});

export const pendingActionResult = {
  status: "awaiting_explicit_confirmation",
  pendingAction: { id: "pending-action-1", description: "Change the callback to the agreed time." },
};
export const keypad = (sequenceNumber: string) => ({
  event: "dtmf",
  sequenceNumber,
  streamSid: "MZsynthetic",
  dtmf: { track: "inbound", digit: "1" },
});
