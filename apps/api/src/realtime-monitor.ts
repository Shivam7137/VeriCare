import type { VoiceMonitorEntry } from "@prc/contracts";
import { identifier, record } from "./realtime-protocol.js";

export const transcriptionModel = "gpt-4o-mini-transcribe";
const maxEntries = 1000;
const maxText = 8000;

function cleanText(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[credential redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "[credential redacted]")
    .replace(/\b\d{8}\b/g, "[code redacted]")
    .replace(/\+[1-9]\d{7,14}\b/g, (phone) => `***${phone.slice(-4)}`)
    .slice(0, maxText);
}

export function monitorDetail(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested value omitted]";
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => monitorDetail(item, depth + 1));
  if (record(value))
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 60)
        .map(([key, item]) => [
          key,
          /(?:authorization|cookie|password|secret|(?:^|[_-])token$|Token$|access.?code|api.?key|^audio$|audio_data|audio_base64)/i.test(
            key,
          )
            ? "[redacted]"
            : monitorDetail(item, depth + 1),
        ]),
    );
  return value;
}

/** Observes protocol events only. It has no authority to invoke tools or mutate calls. */
export class RealtimeMonitor {
  private entries = new Map<string, VoiceMonitorEntry>();
  private texts = new Map<string, string>();
  private serial = 0;
  private closed = false;
  private interrupted = new Set<string>();
  private failed = new Set<string>();
  private lastSpeechEnd: number | undefined;
  private limited = false;
  constructor(
    private emit: (entry: VoiceMonitorEntry) => void,
    private clock = () => Date.now(),
  ) {}

  private publish(entry: VoiceMonitorEntry) {
    if (!this.entries.has(entry.id) && this.entries.size >= maxEntries) {
      if (!this.limited) {
        this.limited = true;
        this.event(
          "error",
          "Capture limit reached",
          { reason: "Further new events are omitted for this call." },
          "failed",
        );
      }
      return;
    }
    this.entries.set(entry.id, entry);
    try {
      this.emit(entry);
    } catch {
      /* Observability must never stop a call. */
    }
  }

  event(
    kind: VoiceMonitorEntry["kind"],
    label: string,
    details?: Record<string, unknown>,
    status: VoiceMonitorEntry["status"] = "info",
  ) {
    const entry: VoiceMonitorEntry = {
      id: `event-${++this.serial}`,
      kind,
      label,
      status,
      at: new Date(this.clock()).toISOString(),
      ...(details ? { details: monitorDetail(details) as Record<string, unknown> } : {}),
    };
    // Reserve a final warning even if the session has reached its entry budget.
    if (this.limited && label === "Capture limit reached") {
      try {
        this.emit(entry);
      } catch {
        /* Best effort. */
      }
    } else this.publish(entry);
  }

  toolStarted(id: string, name: string, args: Record<string, unknown>) {
    if (this.entries.has(`tool-${id}`)) return;
    this.publish({
      id: `tool-${id}`,
      kind: "tool",
      label: name,
      status: "running",
      at: new Date(this.clock()).toISOString(),
      details: { arguments: monitorDetail(args) },
    });
  }

  toolFinished(id: string, result: unknown) {
    const entry = this.entries.get(`tool-${id}`);
    if (!entry) return;
    const cleaned = monitorDetail(result);
    const bounded =
      JSON.stringify(cleaned ?? null).length > 16000
        ? { omitted: "Result exceeds monitor preview limit." }
        : cleaned;
    this.publish({
      ...entry,
      status: record(result) && (result.ok === false || result.error) ? "failed" : "complete",
      elapsedMs: Math.max(0, this.clock() - Date.parse(entry.at)),
      details: { ...entry.details, result: bounded },
    });
  }

  interrupt(responseId?: string) {
    if (!responseId || this.interrupted.has(responseId)) return;
    this.interrupted.add(responseId);
    for (const entry of this.entries.values()) {
      if (
        entry.responseId === responseId &&
        (entry.kind === "transcript" || entry.kind === "response")
      )
        this.publish({ ...entry, status: "interrupted" });
    }
    this.event("speech", "Assistant interrupted", { responseId });
  }

  private transcript(
    event: Record<string, unknown>,
    speaker: "caller" | "assistant",
    final: boolean,
    failed = false,
  ) {
    if (!identifier(event.item_id)) return;
    const id = `transcript-${event.item_id}`;
    const previous = this.entries.get(id);
    if (!previous && this.entries.size >= maxEntries) return;
    const raw = final
      ? typeof event.transcript === "string"
        ? event.transcript
        : (this.texts.get(id) ?? "")
      : (this.texts.get(id) ?? "") + (typeof event.delta === "string" ? event.delta : "");
    const text = raw.slice(0, maxText);
    this.texts.set(id, text);
    const responseId = identifier(event.response_id) ? event.response_id : previous?.responseId;
    this.publish({
      ...previous,
      id,
      kind: "transcript",
      label: speaker === "caller" ? "Caller" : "Assistant",
      at: previous?.at ?? new Date(this.clock()).toISOString(),
      speaker,
      itemId: event.item_id,
      ...(responseId ? { responseId } : {}),
      text: cleanText(text),
      status:
        failed || (responseId && this.failed.has(responseId))
          ? "failed"
          : responseId && this.interrupted.has(responseId)
            ? "interrupted"
            : final
              ? "complete"
              : "streaming",
      ...(failed
        ? {
            details: {
              reason:
                record(event.error) && typeof event.error.code === "string"
                  ? cleanText(event.error.code)
                  : "transcription_failed",
            },
          }
        : text.length === maxText
          ? { details: { truncated: true } }
          : {}),
    });
  }

  receive(event: Record<string, unknown>) {
    if (this.closed) return;
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        this.transcript(event, "caller", false);
        break;
      case "input_audio_buffer.speech_stopped":
        this.lastSpeechEnd = this.clock();
        break;
      case "conversation.item.input_audio_transcription.delta":
        this.transcript(event, "caller", false);
        break;
      case "conversation.item.input_audio_transcription.completed":
        this.transcript(event, "caller", true);
        break;
      case "conversation.item.input_audio_transcription.failed":
        this.transcript(event, "caller", true, true);
        break;
      case "response.output_audio_transcript.delta":
        this.transcript(event, "assistant", false);
        break;
      case "response.output_audio_transcript.done":
        this.transcript(event, "assistant", true);
        break;
      case "response.created": {
        const response = event.response;
        if (!record(response) || !identifier(response.id)) break;
        this.publish({
          id: `response-${response.id}`,
          responseId: response.id,
          kind: "response",
          label: "Model response",
          status: "running",
          at: new Date(this.clock()).toISOString(),
        });
        break;
      }
      case "response.output_audio.delta": {
        // Only timing; audio bytes are never retained or emitted.
        const entry = this.entries.get(`response-${event.response_id}`);
        if (entry && entry.details === undefined)
          this.publish({
            ...entry,
            details: {
              firstAudioMs: Math.max(0, this.clock() - Date.parse(entry.at)),
              ...(this.lastSpeechEnd !== undefined
                ? { sinceCallerStoppedMs: Math.max(0, this.clock() - this.lastSpeechEnd) }
                : {}),
            },
          });
        break;
      }
      case "response.done": {
        const response = event.response;
        if (!record(response) || !identifier(response.id)) break;
        const entry = this.entries.get(`response-${response.id}`);
        const status =
          this.interrupted.has(response.id) || response.status === "cancelled"
            ? "interrupted"
            : response.status === "completed"
              ? "complete"
              : "failed";
        if (status === "interrupted") this.interrupted.add(response.id);
        if (status === "failed") this.failed.add(response.id);
        if (entry)
          this.publish({
            ...entry,
            status,
            elapsedMs: Math.max(0, this.clock() - Date.parse(entry.at)),
            details: {
              ...entry.details,
              ...(record(response.usage) ? { usage: monitorDetail(response.usage) } : {}),
              providerStatus: response.status,
            },
          });
        if (status !== "complete")
          for (const transcript of this.entries.values()) {
            if (transcript.kind === "transcript" && transcript.responseId === response.id)
              this.publish({ ...transcript, status });
          }
        break;
      }
      case "error":
        this.event(
          "error",
          "Voice provider error",
          {
            code:
              record(event.error) && typeof event.error.code === "string"
                ? cleanText(event.error.code)
                : "upstream_error",
          },
          "failed",
        );
        break;
    }
  }

  close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.entries.values()) {
      if (entry.status === "streaming" || entry.status === "running")
        this.publish({ ...entry, status: "incomplete" });
    }
    this.event("session", "Call stream ended", { reason });
    this.texts.clear();
  }
}
