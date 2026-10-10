import WebSocket from "ws";
import { RealtimeMonitor, transcriptionModel } from "./realtime-monitor.js";

import {
  identifier,
  parseFrame,
  record,
  safeOutput,
  validAudio,
  type BridgeSocket,
  type RealtimeBridgeOptions,
} from "./realtime-protocol.js";
export type {
  BridgeSocket,
  RealtimeBridgeOptions,
  RealtimeFunctionTool,
} from "./realtime-protocol.js";

export function bridgeRealtime(twilioSocket: BridgeSocket, options: RealtimeBridgeOptions) {
  const maxMessageBytes = 256 * 1024;
  const maxBufferedBytes = 256 * 1024;
  let upstream: BridgeSocket | undefined;
  let started = false;
  let callId: string | undefined;
  const monitor = new RealtimeMonitor((entry) => {
    if (callId) options.onMonitor?.(callId, entry);
  });
  let streamSid: string | undefined;
  let closed = false;
  let closeReason = "bridge_closed";
  let closeReported = false;
  let verifying = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let configured = false;
  let ready = false;
  let bufferedBytes = 0;
  let activeResponse: string | undefined;
  let responseRequested = false;
  let responseNeeded = false;
  let cancelNextResponse = false;
  let speaking = false;
  let pendingActions = 0;
  let actionQueue = Promise.resolve();
  let markNumber = 0;
  let unacknowledgedBytes = 0;
  let setupTimer: ReturnType<typeof setTimeout> | undefined;
  let readback:
    { actionId: string; responseId?: string; hadAudio: boolean; completed: boolean } | undefined;
  const cancelledResponses = new Set<string>();
  const cancellationRequests = new Set<string>();
  const tools = new Map<string, string>();
  const digits = new Map<string, string>();
  const playback = new Map<
    string,
    { responseId: string; sentMs: number; heardMs: number; done: boolean }
  >();
  const marks = new Map<string, { itemId: string; endMs: number; bytes: number }>();
  const pendingAudio: string[] = [];
  const startTimer = setTimeout(() => close("start_timeout"), options.startTimeoutMs ?? 10_000);
  const sessionTimer = setTimeout(
    () => close("session_timeout"),
    options.sessionTimeoutMs ?? 600_000,
  );
  startTimer.unref();
  sessionTimer.unref();

  function reportClose() {
    if (!closed || verifying || closeReported) return;
    closeReported = true;
    if (!callId) {
      finish();
      return;
    }
    const id = callId;
    void Promise.resolve()
      .then(() => options.onClose(id, closeReason))
      .catch(() => {})
      .finally(finish);
  }

  function close(reason = "bridge_closed") {
    if (closed) return;
    monitor.close(reason);
    closed = true;
    closeReason = reason;
    clearTimeout(startTimer);
    clearTimeout(sessionTimer);
    clearTimeout(setupTimer);
    pendingAudio.length = 0;
    playback.clear();
    marks.clear();
    tools.clear();
    digits.clear();
    cancellationRequests.clear();
    readback = undefined;
    bufferedBytes = 0;
    for (const socket of [twilioSocket, upstream]) {
      if (socket && socket.readyState < WebSocket.CLOSING) {
        try {
          socket.close(1000, reason.slice(0, 100));
        } catch {
          /* Already disconnected. */
        }
      }
    }
    reportClose();
  }

  function send(socket: BridgeSocket | undefined, event: Record<string, unknown>) {
    if (closed) return false;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      socket.bufferedAmount > maxBufferedBytes
    ) {
      close("socket_unavailable");
      return false;
    }
    try {
      socket.send(JSON.stringify(event));
      return true;
    } catch {
      close("socket_send_failed");
      return false;
    }
  }

  function configure() {
    if (closed || configured) return;
    configured = true;
    send(upstream, {
      type: "session.update",
      session: {
        type: "realtime",
        output_modalities: ["audio"],
        instructions: options.instructions,
        audio: {
          input: {
            format: { type: "audio/pcmu" },
            transcription: { model: transcriptionModel },
            turn_detection: {
              type: "server_vad",
              create_response: false,
              interrupt_response: false,
            },
          },
          output: { format: { type: "audio/pcmu" }, voice: options.voice ?? "marin" },
        },
        tools: options.tools,
        tool_choice: "auto",
        tracing: null,
      },
    });
  }

  function flushResponse() {
    if (
      closed ||
      !ready ||
      !responseNeeded ||
      speaking ||
      pendingActions ||
      activeResponse ||
      responseRequested
    )
      return;
    responseNeeded = false;
    responseRequested = true;
    send(upstream, { type: "response.create" });
  }

  function interrupt(discardPendingResponse = true) {
    monitor.interrupt(activeResponse);
    if (discardPendingResponse) responseNeeded = false;
    if (readback && !readbackPlayed())
      readback = { actionId: readback.actionId, hadAudio: false, completed: false };
    if (activeResponse && !cancelledResponses.has(activeResponse)) {
      cancelledResponses.add(activeResponse);
      if (cancelledResponses.size > 128) {
        close("response_limit");
        return;
      }
      const eventId = `cancel-${cancelledResponses.size}`;
      cancellationRequests.add(eventId);
      send(upstream, { type: "response.cancel", response_id: activeResponse, event_id: eventId });
    } else if (responseRequested) cancelNextResponse = true;
    if (marks.size) {
      send(twilioSocket, { event: "clear", streamSid });
      for (const [itemId, item] of playback) {
        if (item.sentMs > item.heardMs)
          send(upstream, {
            type: "conversation.item.truncate",
            item_id: itemId,
            content_index: 0,
            audio_end_ms: Math.floor(item.heardMs),
          });
      }
    }
    // Twilio also acknowledges marks released by clear. They are not playback evidence.
    marks.clear();
    playback.clear();
    unacknowledgedBytes = 0;
  }

  function outputAudio(event: Record<string, unknown>) {
    if (typeof event.response_id === "string" && cancelledResponses.has(event.response_id)) return;
    if (
      !identifier(event.item_id) ||
      !identifier(event.response_id) ||
      event.response_id !== activeResponse ||
      event.content_index !== 0 ||
      !validAudio(event.delta)
    ) {
      close("invalid_output_audio");
      return;
    }
    const bytes = Buffer.from(event.delta, "base64").length;
    if (readback?.responseId === event.response_id) readback.hadAudio = true;
    unacknowledgedBytes += bytes;
    if (marks.size >= 2048 || playback.size >= 128 || unacknowledgedBytes > maxBufferedBytes) {
      close("playback_buffer_limit");
      return;
    }
    const item = playback.get(event.item_id) ?? {
      responseId: event.response_id,
      sentMs: 0,
      heardMs: 0,
      done: false,
    };
    item.sentMs += bytes / 8; // PCMU: one byte/sample, 8 samples/millisecond.
    playback.set(event.item_id, item);
    const name = `audio-${++markNumber}`;
    marks.set(name, { itemId: event.item_id, endMs: item.sentMs, bytes });
    send(twilioSocket, { event: "media", streamSid, media: { payload: event.delta } });
    send(twilioSocket, { event: "mark", streamSid, mark: { name } });
  }

  function acknowledge(name: unknown) {
    if (typeof name !== "string" || !marks.has(name)) return;
    for (const [mark, value] of marks) {
      const item = playback.get(value.itemId);
      if (item) {
        item.heardMs = Math.max(item.heardMs, value.endMs);
        if (item.done && item.heardMs >= item.sentMs) playback.delete(value.itemId);
      }
      unacknowledgedBytes -= value.bytes;
      marks.delete(mark);
      if (mark === name) break;
    }
  }

  function readbackPlayed() {
    return Boolean(
      readback?.completed &&
      readback.hadAudio &&
      !Array.from(playback.values()).some(
        (item) => item.responseId === readback!.responseId && item.heardMs < item.sentMs,
      ),
    );
  }

  function queueAction(action: () => Promise<void>) {
    if (++pendingActions > 16) {
      close("action_buffer_limit");
      return;
    }
    actionQueue = actionQueue
      .then(async () => {
        if (!closed) await action();
      })
      .catch(() => close("action_failed"))
      .finally(() => {
        pendingActions--;
        flushResponse();
      });
  }

  function toolOutput(toolCallId: string, result: unknown) {
    const output = safeOutput(result);
    const published: unknown = JSON.parse(output);
    if (
      record(published) &&
      record(published.pendingAction) &&
      identifier(published.pendingAction.id) &&
      typeof published.pendingAction.description === "string" &&
      published.pendingAction.description.length > 0
    ) {
      readback = { actionId: published.pendingAction.id, hadAudio: false, completed: false };
    }
    send(upstream, {
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: toolCallId,
        output,
      },
    });
    responseNeeded = true;
  }

  function invokeTool(event: Record<string, unknown>) {
    if (
      !identifier(event.call_id) ||
      !identifier(event.name) ||
      typeof event.arguments !== "string" ||
      event.arguments.length > 16 * 1024
    ) {
      close("invalid_tool_event");
      return;
    }
    if (typeof event.response_id === "string" && cancelledResponses.has(event.response_id)) return;
    const fingerprint = JSON.stringify([event.name, event.arguments]);
    const previous = tools.get(event.call_id);
    if (previous !== undefined) {
      if (previous !== fingerprint) close("tool_replay_mismatch");
      return;
    }
    if (tools.size >= 128) {
      close("tool_limit");
      return;
    }
    const toolCallId = event.call_id;
    const name = event.name;
    tools.set(toolCallId, fingerprint);
    let args: unknown;
    try {
      args = JSON.parse(event.arguments);
    } catch {
      /* Return a bounded error below. */
    }
    if (!record(args) || !options.tools.some((tool) => tool.name === name)) {
      monitor.toolStarted(toolCallId, name, {});
      monitor.toolFinished(toolCallId, { ok: false, error: "invalid_tool_request" });
      toolOutput(toolCallId, { ok: false, error: "invalid_tool_request" });
      flushResponse();
      return;
    }
    const toolArgs = args;
    monitor.toolStarted(toolCallId, name, toolArgs);
    queueAction(async () => {
      let result: unknown;
      try {
        result = await options.onTool(name, toolArgs, callId!, toolCallId);
      } catch {
        result = { ok: false, error: "tool_failed" };
      }
      monitor.toolFinished(toolCallId, result);
      if (!closed) toolOutput(toolCallId, result);
    });
  }

  function invokeDigit(event: Record<string, unknown>) {
    if (
      !ready ||
      !record(event.dtmf) ||
      event.dtmf.track !== "inbound_track" ||
      typeof event.dtmf.digit !== "string" ||
      !/^[0-9*#ABCD]$/.test(event.dtmf.digit) ||
      typeof event.sequenceNumber !== "string" ||
      !/^[1-9][0-9]{0,14}$/.test(event.sequenceNumber)
    ) {
      close("invalid_dtmf");
      return;
    }
    const digit = event.dtmf.digit;
    const previous = digits.get(event.sequenceNumber);
    if (previous !== undefined) {
      if (previous !== digit) close("dtmf_replay_mismatch");
      return;
    }
    if (digits.size >= 128) {
      close("dtmf_limit");
      return;
    }
    digits.set(event.sequenceNumber, digit);
    // A press is evidence only for an existing, fully played action. Never queue
    // keypad input behind a tool which may create or replace the pending action.
    if (pendingActions || (digit === "1" && !readbackPlayed())) {
      monitor.event("keypad", "Keypad action ignored", {
        reason: pendingActions ? "tool_in_progress" : "readback_not_fully_played",
      });
      return;
    }
    monitor.event("keypad", "Caller keypad action", {
      action: digit === "1" ? "Approve" : digit === "2" ? "Cancel" : "Other key",
    });
    const readbackActionId = readback?.actionId;
    if (digit === "1" || digit === "2") readback = undefined;
    interrupt();
    queueAction(async () => {
      let result: unknown;
      try {
        result = await options.onDigit(digit, callId!, readbackActionId);
      } catch {
        result = { ok: false, error: "keypad_action_failed" };
      }
      monitor.event("keypad", "Keypad result", { result });
      if (closed) return;
      send(upstream, {
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Phone keypad ${digit}; backend result: ${safeOutput(result)}`,
            },
          ],
        },
      });
      responseNeeded = true;
    });
  }

  function receiveUpstream(data: unknown) {
    if (closed) return;
    try {
      const event = parseFrame(data, maxMessageBytes);
      if (event.type === "session.updated" && configured && !ready) {
        ready = true;
        monitor.event("session", "Voice connected", {
          model: options.model ?? "gpt-realtime",
          voice: options.voice ?? "marin",
          transcriptionModel,
          instructions: options.instructions,
        });
        clearTimeout(setupTimer);
        for (const audio of pendingAudio)
          send(upstream, { type: "input_audio_buffer.append", audio });
        pendingAudio.length = 0;
        bufferedBytes = 0;
        responseNeeded = true;
        flushResponse();
      } else if (event.type === "error") {
        const error = event.error;
        if (
          record(error) &&
          error.code === "response_cancel_not_active" &&
          typeof error.event_id === "string" &&
          cancellationRequests.has(error.event_id)
        )
          return;
        monitor.receive(event);
        close("upstream_error");
      } else if (ready) {
        monitor.receive(event);
        switch (event.type) {
          case "response.created": {
            if (!record(event.response) || !identifier(event.response.id) || activeResponse) {
              close("response_overlap");
              return;
            }
            activeResponse = event.response.id;
            if (readback && !readback.responseId) readback.responseId = activeResponse;
            responseRequested = false;
            if (cancelNextResponse || speaking) {
              cancelNextResponse = false;
              interrupt(false);
            }
            break;
          }
          case "response.done": {
            if (!record(event.response) || !identifier(event.response.id)) {
              close("invalid_response");
              return;
            }
            if (readback?.responseId === event.response.id)
              readback.completed = event.response.status === "completed";
            for (const [itemId, item] of playback) {
              if (item.responseId !== event.response.id) continue;
              item.done = true;
              if (item.heardMs >= item.sentMs) playback.delete(itemId);
            }
            if (activeResponse === event.response.id) activeResponse = undefined;
            flushResponse();
            break;
          }
          case "input_audio_buffer.speech_started":
            speaking = true;
            interrupt();
            break;
          case "input_audio_buffer.speech_stopped":
            speaking = false;
            break;
          case "input_audio_buffer.committed":
            speaking = false;
            responseNeeded = true;
            flushResponse();
            break;
          case "response.output_audio.delta":
            outputAudio(event);
            break;
          case "response.function_call_arguments.done":
            invokeTool(event);
            break;
        }
      }
    } catch {
      close("upstream_protocol_error");
    }
  }

  async function authorize(event: Record<string, unknown>) {
    if (started) {
      close("duplicate_start");
      return;
    }
    started = true;
    const start = event.start;
    if (
      !record(start) ||
      !identifier(start.callSid) ||
      !identifier(start.streamSid) ||
      (event.streamSid !== undefined && event.streamSid !== start.streamSid) ||
      !record(start.mediaFormat) ||
      start.mediaFormat.encoding !== "audio/x-mulaw" ||
      start.mediaFormat.sampleRate !== 8000 ||
      start.mediaFormat.channels !== 1 ||
      !record(start.customParameters) ||
      Object.keys(start.customParameters).length > 32 ||
      Object.values(start.customParameters).some(
        (value) => typeof value !== "string" || value.length > 2048,
      )
    ) {
      close("invalid_start");
      return;
    }
    // Bind the transport shape now; caller authority still waits for verifyStart.
    streamSid = start.streamSid;
    verifying = true;
    try {
      const verified = await options.verifyStart({
        callSid: start.callSid,
        streamSid: start.streamSid,
        customParameters: start.customParameters as Record<string, string>,
      });
      if (!identifier(verified.callId)) {
        close("invalid_authorization");
        return;
      }
      callId = verified.callId;
      monitor.event("session", "Verified call stream opened");
      if (closed) return;
      clearTimeout(startTimer);
      setupTimer = setTimeout(
        () => close("upstream_setup_timeout"),
        options.startTimeoutMs ?? 10_000,
      );
      setupTimer.unref();
      if (!options.apiKey) {
        close("missing_api_key");
        return;
      }
      upstream = (options.socketFactory ?? ((url, config) => new WebSocket(url, config)))(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(options.model ?? "gpt-realtime")}`,
        { headers: { Authorization: `Bearer ${options.apiKey}` }, maxPayload: maxMessageBytes },
      );
      upstream.on("open", configure);
      upstream.on("message", receiveUpstream);
      upstream.on("close", () => close("upstream_closed"));
      upstream.on("error", () => close("upstream_error"));
      if (upstream.readyState === WebSocket.OPEN) configure();
    } catch {
      close("authorization_or_connection_failed");
    } finally {
      verifying = false;
      reportClose();
    }
  }

  twilioSocket.on("message", (data: unknown) => {
    if (closed) return;
    try {
      const event = parseFrame(data, maxMessageBytes);
      if (event.event === "connected") return;
      if (event.event === "start") {
        void authorize(event);
        return;
      }
      if (!streamSid) {
        close("unauthorized_media");
        return;
      }
      if (event.streamSid !== streamSid) {
        close("stream_mismatch");
        return;
      }
      if (event.event === "media") {
        if (
          !record(event.media) ||
          event.media.track !== "inbound" ||
          !validAudio(event.media.payload)
        ) {
          close("invalid_audio");
          return;
        }
        if (ready)
          send(upstream, { type: "input_audio_buffer.append", audio: event.media.payload });
        else {
          bufferedBytes += Buffer.byteLength(event.media.payload);
          if (bufferedBytes > 64 * 1024) {
            close("audio_buffer_limit");
            return;
          }
          pendingAudio.push(event.media.payload);
        }
      } else if (event.event === "stop") close("twilio_stop");
      else if (!callId) close("unauthorized_event");
      else if (event.event === "mark" && record(event.mark)) acknowledge(event.mark.name);
      else if (event.event === "dtmf") invokeDigit(event);
    } catch {
      close("twilio_protocol_error");
    }
  });
  twilioSocket.on("close", () => close("twilio_closed"));
  twilioSocket.on("error", () => close("twilio_error"));
  return { close, finished };
}
