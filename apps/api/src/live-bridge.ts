import WebSocket from "ws";
import { LiveMonitor } from "./live-monitor.js";
import { liveGreeting, liveVoiceInstructions } from "./voice-persona.js";
import {
  identifier,
  parseFrame,
  record,
  safeOutput,
  validAudio,
  type BridgeSocket,
  type RealtimeBridgeOptions,
} from "./realtime-protocol.js";

export interface LiveBridgeOptions extends RealtimeBridgeOptions {
  backendModel?: string;
  onVerify(code: string, callId: string): Promise<unknown>;
}

/** Native GPT-Live audio remains continuous; response.create only continues delegated work. */
export function bridgeLive(phone: BridgeSocket, options: LiveBridgeOptions) {
  let upstream: BridgeSocket | undefined, callId: string | undefined, streamSid: string | undefined;
  let closed = false,
    verifying = false,
    ready = false,
    reported = false;
  let closeReason = "bridge_closed",
    buffered = 0,
    markSerial = 0,
    unplayed = 0;
  let awaitingCode = false,
    code = "",
    codeTouched = 0,
    codeEpoch = 0;
  let pending:
    | {
        id: string;
        caption: string;
        heard: boolean;
        barrier?: string;
        closingPhrase: boolean;
        hadSpeech: boolean;
        quietBytes: number;
        lastMark?: string;
      }
    | undefined;
  const audioQueue: string[] = [],
    marks = new Map<string, number>();
  const toolIds = new Set<string>(),
    digitIds = new Set<string>();
  const responses = new Map<
    string,
    { jobs: Promise<void>[]; complete: boolean; continued: boolean }
  >();
  let actionQueue = Promise.resolve();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const monitor = new LiveMonitor((entry) => {
    if (callId) options.onMonitor?.(callId, entry);
  });
  const startTimer = setTimeout(() => close("start_timeout"), options.startTimeoutMs ?? 10_000);
  const sessionTimer = setTimeout(
    () => close("session_timeout"),
    options.sessionTimeoutMs ?? 600_000,
  );
  startTimer.unref();
  sessionTimer.unref();
  let setupTimer: ReturnType<typeof setTimeout> | undefined;

  function reportClose() {
    if (!closed || verifying || reported) return;
    reported = true;
    if (!callId) {
      finish();
      return;
    }
    void Promise.resolve()
      .then(() => actionQueue)
      .then(() => options.onClose(callId!, closeReason))
      .catch(() => {})
      .finally(finish);
  }
  function close(reason = "bridge_closed") {
    if (closed) return;
    closeReason = reason;
    monitor.close(reason);
    closed = true;
    clearTimeout(startTimer);
    clearTimeout(sessionTimer);
    clearTimeout(setupTimer);
    code = "";
    audioQueue.length = 0;
    marks.clear();
    pending = undefined;
    for (const socket of [phone, upstream])
      if (socket && socket.readyState < 2)
        try {
          socket.close(1000, reason.slice(0, 100));
        } catch {}
    reportClose();
  }
  function send(socket: BridgeSocket | undefined, event: Record<string, unknown>) {
    if (closed) return false;
    if (!socket || socket.readyState !== 1 || socket.bufferedAmount > 256 * 1024) {
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
  function commentary(content: string) {
    send(upstream, {
      type: "session.commentary.append",
      delegation_id: null,
      content: content.slice(0, 800),
    });
  }
  function outcome(result: unknown) {
    if (!record(result)) return "The action outcome is unavailable. Do not claim it succeeded.";
    if (result.status === "verified")
      return record(result.pendingAction)
        ? `Access verified. There is still a pending action: ${String(result.pendingAction.description).slice(0, 400)} Read it back and say 'Press one to approve or two to cancel' before continuing the original request.`
        : `Access verified as ${result.role === "staff" ? "staff" : "patient"}. Acknowledge briefly and continue the original request.`;
    if (record(result.sms))
      return `SMS status: ${String(result.sms.status)}. Queued or accepted is not delivered; simulated means no real message was sent.`;
    if (record(result.task))
      return `Caller choice saved for request ${String(result.task.id)}. Current state: ${String(result.task.state)}. Check get_request_status before claiming a booking changed.`;
    return JSON.stringify({
      status: result.status,
      error: result.error,
      message: typeof result.message === "string" ? result.message.slice(0, 250) : undefined,
    });
  }
  function queue(operation: () => Promise<void>) {
    actionQueue = actionQueue
      .then(async () => {
        if (!closed) await operation();
      })
      .catch(() => close("action_failed"));
    return actionQueue;
  }
  function observeResult(result: unknown) {
    if (!record(result)) return;
    if (result.status === "authorization_required") {
      if (!awaitingCode) {
        awaitingCode = true;
        code = "";
        codeEpoch++;
      }
      pending = undefined;
    }
    if (record(result.pendingAction) && identifier(result.pendingAction.id)) {
      awaitingCode = false;
      code = "";
      codeEpoch++;
      pending = {
        id: result.pendingAction.id,
        caption: "",
        heard: false,
        closingPhrase: false,
        hadSpeech: false,
        quietBytes: 0,
      };
    }
  }
  async function continueResponse(id: string) {
    const response = responses.get(id);
    if (!response || !response.complete || response.continued || !response.jobs.length) return;
    response.continued = true;
    await Promise.all(response.jobs);
    if (!closed) send(upstream, { type: "response.create" });
  }
  function delegation(envelope: Record<string, unknown>) {
    if (!record(envelope.event) || !identifier(envelope.delegation_id)) return;
    const event = envelope.event,
      id = envelope.delegation_id;
    let response = responses.get(id);
    if (event.type === "response.created") {
      // A continuation reuses the delegation ID, but has a new response ID.
      const responseId = record(event.response) ? event.response.id : undefined;
      if (identifier(responseId) && !responses.has(responseId)) {
        response = { jobs: [], complete: false, continued: false };
        responses.set(id, response);
        responses.set(responseId, response);
      }
    }
    if (!response) {
      response = { jobs: [], complete: false, continued: false };
      responses.set(id, response);
    }
    if (responses.size > 256) {
      close("delegation_limit");
      return;
    }
    if (
      event.type === "response.output_item.done" &&
      record(event.item) &&
      event.item.type === "function_call"
    ) {
      const item = event.item;
      if (!identifier(item.call_id) || toolIds.has(item.call_id)) return;
      if (toolIds.size >= 128) {
        close("tool_limit");
        return;
      }
      const toolId = item.call_id;
      toolIds.add(toolId);
      response.jobs.push(
        queue(async () => {
          let result: unknown;
          const name = String(item.name);
          try {
            if (
              !options.tools.some((tool) => tool.name === name) ||
              typeof item.arguments !== "string" ||
              item.arguments.length > 16000
            )
              throw Error("tool_not_allowed");
            const args: unknown = JSON.parse(item.arguments);
            if (!record(args)) throw Error("invalid_arguments");
            monitor.toolStarted(toolId, name, args);
            result = await options.onTool(name, args, callId!, toolId);
          } catch (error) {
            result = {
              ok: false,
              error: record(error) && typeof error.code === "string" ? error.code : "tool_failed",
            };
          }
          monitor.toolFinished(toolId, result);
          observeResult(result);
          send(upstream, {
            type: "response.item.create",
            item: { type: "function_call_output", call_id: toolId, output: safeOutput(result) },
          });
        }),
      );
    }
    if (event.type === "response.completed") {
      response.complete = true;
      void continueResponse(id);
    }
  }
  function receiveLive(raw: unknown) {
    if (closed) return;
    try {
      const event = parseFrame(raw, 256 * 1024);
      monitor.receive(event);
      if (event.type === "session.started") {
        if (ready) return;
        ready = true;
        clearTimeout(setupTimer);
        monitor.event("session", "GPT-Live connected", {
          model: options.model ?? "gpt-live-1",
          voice: options.voice ?? "cedar",
          backendModel: options.backendModel ?? "gpt-6-luna",
          transcripts: "Native Live captions; grouping is approximate",
        });
        send(upstream, {
          type: "session.instructions.append",
          event_id: "greeting",
          delegation_id: null,
          content: liveGreeting,
        });
        for (const payload of audioQueue)
          send(upstream, { type: "session.input_audio.append", audio: payload });
        audioQueue.length = 0;
        buffered = 0;
      } else if (event.type === "session.output_audio.delta") {
        if (!ready || !validAudio(event.delta)) throw Error("invalid_audio");
        const samples = Buffer.from(event.delta, "base64"),
          bytes = samples.length;
        if (unplayed + bytes > 64_000) {
          close("playback_backpressure");
          return;
        }
        const mark = `live-${++markSerial}`;
        marks.set(mark, bytes);
        unplayed += bytes;
        send(phone, { event: "media", streamSid, media: { payload: event.delta } });
        send(phone, { event: "mark", streamSid, mark: { name: mark } });
        if (pending && !pending.heard) {
          // Mu-law zero/near-zero silence. A short quiet tail creates an application
          // playback boundary without waiting for Live's continuous silent stream to end.
          const audible = samples.some((sample) => {
            const value = ~sample & 255;
            const magnitude = (((value & 15) << 3) + 132) << ((value & 112) >> 4);
            return magnitude - 132 > 400;
          });
          if (audible) {
            pending.hadSpeech = true;
            pending.quietBytes = 0;
            pending.barrier = undefined;
          } else pending.quietBytes += bytes;
          pending.lastMark = mark;
          if (
            pending.closingPhrase &&
            pending.hadSpeech &&
            pending.quietBytes >= 2560 &&
            !pending.barrier
          )
            pending.barrier = mark;
        }
      } else if (
        event.type === "session.output_transcript.delta" &&
        pending &&
        !pending.heard &&
        typeof event.delta === "string"
      ) {
        pending.caption = (pending.caption + event.delta).slice(-8000);
        pending.closingPhrase =
          /press\s+(?:one|1)\s+to\s+approve\s*(?:,\s*)?or\s+(?:two|2)\s+to\s+cancel/i.test(
            pending.caption,
          );
        if (
          pending.closingPhrase &&
          pending.hadSpeech &&
          pending.quietBytes >= 2560 &&
          pending.lastMark
        ) {
          pending.barrier = pending.lastMark;
          if (!marks.has(pending.lastMark)) pending.heard = true;
        }
      } else if (event.type === "session.input_transcript.delta") {
        // Captions can arrive late. Keep native full-duplex audio in order instead of
        // cutting fresh speech/backchannels on a delayed transcript fragment.
        // Caller speech still invalidates a readback that has not finished playing.
        if (pending && !pending.heard) {
          pending.caption = "";
          pending.closingPhrase = false;
          pending.barrier = undefined;
          pending.hadSpeech = false;
          pending.quietBytes = 0;
        }
      } else if (event.type === "response.event") delegation(event);
      else if (event.type === "error") close("live_provider_error");
      else if (event.type === "session.closed") close("live_session_closed");
    } catch {
      close("invalid_live_frame");
    }
  }
  async function authorize(event: Record<string, unknown>) {
    const start = event.start;
    if (
      verifying ||
      streamSid ||
      !record(start) ||
      !identifier(start.streamSid) ||
      start.streamSid !== event.streamSid ||
      !identifier(start.callSid) ||
      !record(start.mediaFormat) ||
      start.mediaFormat.encoding !== "audio/x-mulaw" ||
      start.mediaFormat.sampleRate !== 8000 ||
      start.mediaFormat.channels !== 1 ||
      !record(start.customParameters) ||
      Object.values(start.customParameters).some((v) => typeof v !== "string")
    ) {
      close("invalid_start");
      return;
    }
    verifying = true;
    streamSid = start.streamSid;
    try {
      const verified = await options.verifyStart({
        callSid: start.callSid,
        streamSid,
        customParameters: start.customParameters as Record<string, string>,
      });
      callId = verified.callId;
      if (closed) return;
      clearTimeout(startTimer);
      const factory =
        options.socketFactory ??
        ((url, settings) => new WebSocket(url, settings) as unknown as BridgeSocket);
      upstream = factory("wss://api.openai.com/v1/live/sessions", {
        headers: { Authorization: `Bearer ${options.apiKey}` },
        maxPayload: 256 * 1024,
      });
      setupTimer = setTimeout(() => close("live_setup_timeout"), 15_000);
      setupTimer.unref();
      upstream.on("open", () =>
        send(upstream, {
          type: "session.start",
          session: {
            model: options.model ?? "gpt-live-1",
            store: false,
            instructions: liveVoiceInstructions,
            audio: {
              format: { type: "audio/pcmu", rate: 8000 },
              output: { voice: options.voice ?? "cedar" },
            },
            delegation: {
              type: "responses",
              responses: {
                model: options.backendModel ?? "gpt-6-luna",
                instructions: options.instructions,
                tools: options.tools,
                tool_choice: "auto",
                parallel_tool_calls: false,
              },
            },
          },
        }),
      );
      upstream.on("message", receiveLive);
      upstream.on("close", () => close("live_disconnected"));
      upstream.on("error", () => close("live_connection_failed"));
    } catch {
      close("stream_rejected");
    } finally {
      verifying = false;
      reportClose();
    }
  }
  function keypad(event: Record<string, unknown>) {
    if (
      !ready ||
      !callId ||
      !record(event.dtmf) ||
      event.dtmf.track !== "inbound_track" ||
      typeof event.dtmf.digit !== "string" ||
      !/^[0-9*#]$/.test(event.dtmf.digit) ||
      typeof event.sequenceNumber !== "string"
    )
      return;
    if (digitIds.has(event.sequenceNumber)) return;
    digitIds.add(event.sequenceNumber);
    if (digitIds.size > 500) {
      close("keypad_limit");
      return;
    }
    const digit = event.dtmf.digit;
    // Capture authority at key arrival; a queued key must not gain permission later.
    const arrivalCode = awaitingCode,
      arrivalEpoch = codeEpoch;
    const arrivalPending = pending?.id,
      arrivalHeard = pending?.heard;
    if (!arrivalCode && !arrivalPending) return;
    queue(async () => {
      if (arrivalCode) {
        if (!awaitingCode || arrivalEpoch !== codeEpoch) return;
        if (Date.now() - codeTouched > 30_000) code = "";
        codeTouched = Date.now();
        if (digit === "*") {
          code = "";
          return;
        }
        if (!/\d/.test(digit)) return;
        code += digit;
        if (code.length < 8) return;
        const entered = code;
        code = "";
        let result: unknown;
        try {
          result = await options.onVerify(entered, callId!);
        } catch {
          result = {
            status: "verification_failed",
            message: "That code did not work. Ask for a fresh code and let the caller try again.",
          };
        }
        if (record(result) && result.status === "verified") {
          awaitingCode = false;
          codeEpoch++;
          observeResult(result);
        }
        monitor.event(
          "keypad",
          "Access verification",
          record(result) ? result : {},
          record(result) && result.status === "verified" ? "complete" : "failed",
        );
        commentary(outcome(result));
        return;
      }
      if (!pending || pending.id !== arrivalPending || (digit !== "1" && digit !== "2")) return;
      if (digit === "1" && (!arrivalHeard || !pending.heard)) {
        commentary(
          "The action has not been approved. Ask the caller to wait until the readback finishes, then press one again. Do not restart a readback already in progress.",
        );
        return;
      }
      const actionId = pending.id;
      pending = undefined;
      let result: unknown;
      try {
        result = await options.onDigit(digit, callId!, actionId);
      } catch (error) {
        result = {
          ok: false,
          error: record(error) && typeof error.code === "string" ? error.code : "action_failed",
        };
      }
      monitor.event(
        "keypad",
        digit === "1" ? "Caller approved action" : "Caller cancelled action",
        { result },
      );
      commentary(outcome(result));
    });
  }
  phone.on("message", (raw) => {
    if (closed) return;
    try {
      const event = parseFrame(raw, 128 * 1024);
      if (event.event === "connected") return;
      if (event.event === "start") {
        void authorize(event);
        return;
      }
      if (!streamSid || event.streamSid !== streamSid) throw Error("stream_mismatch");
      if (event.event === "media") {
        if (
          !record(event.media) ||
          event.media.track !== "inbound" ||
          !validAudio(event.media.payload)
        )
          throw Error("invalid_audio");
        if (ready)
          send(upstream, { type: "session.input_audio.append", audio: event.media.payload });
        else {
          buffered += event.media.payload.length;
          if (buffered > 128 * 1024) throw Error("startup_backpressure");
          audioQueue.push(event.media.payload);
        }
      } else if (event.event === "dtmf") keypad(event);
      else if (
        event.event === "mark" &&
        record(event.mark) &&
        typeof event.mark.name === "string"
      ) {
        const name = event.mark.name,
          bytes = marks.get(name);
        if (bytes !== undefined) {
          marks.delete(name);
          unplayed -= bytes;
          if (pending?.barrier === name) {
            pending.heard = true;
            monitor.event("keypad", "Action readback played", { actionId: pending.id });
          }
        }
      } else if (event.event === "stop") close("provider_stopped");
    } catch {
      close("invalid_twilio_frame");
    }
  });
  phone.on("close", () => close("twilio_disconnected"));
  phone.on("error", () => close("twilio_socket_error"));
  return { close, finished };
}
