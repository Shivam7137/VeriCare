import { createHash } from "node:crypto";
import type { VoiceMonitorEntry } from "@prc/contracts";
import { monitorDetail, RealtimeMonitor } from "./realtime-monitor.js";
import { record } from "./realtime-protocol.js";

const windowMs = 12_000;
const maxText = 8000;
const maxFragments = 512;
const normalClosures = new Set([
  "provider_stopped",
  "live_session_closed",
  "portal_ended",
  "call_stopped",
]);
type Fragment = { startMs: number; endMs: number; text: string };
type Caption = {
  id: string;
  speaker: "caller" | "assistant";
  window: number;
  at: string;
  status: VoiceMonitorEntry["status"];
  fragments: Fragment[];
  seen: Set<string>;
  characters: number;
  truncated: boolean;
};

function boundedSink(emit: (entry: VoiceMonitorEntry) => void) {
  const ids = new Set<string>();
  let warned = false;
  const safeEmit = (entry: VoiceMonitorEntry) => {
    try {
      emit(entry);
    } catch {
      /* Capture failures must never stop conversation. */
    }
  };
  const warn = () => {
    if (warned) return;
    warned = true;
    ids.add("live-capture-limit");
    safeEmit({
      id: "live-capture-limit",
      kind: "error",
      label: "Capture limit reached",
      status: "failed",
      at: new Date().toISOString(),
      details: { reason: "Further caption text, fragments, or new events may be omitted." },
    });
  };
  return {
    warn,
    publish(entry: VoiceMonitorEntry) {
      if (entry.label === "Capture limit reached") {
        warn();
        return false;
      }
      // Reserve one of the shared 1,000 records for the omission warning.
      if (!ids.has(entry.id) && ids.size >= 999) {
        warn();
        return false;
      }
      ids.add(entry.id);
      safeEmit(entry);
      return true;
    },
  };
}

/** Native captions are approximate timeline windows, never inferred provider turn IDs. */
export class LiveMonitor extends RealtimeMonitor {
  private captions = new Map<string, Caption>();
  private latestWindow = new Map<string, number>();
  private captionsClosed = false;
  private readonly captionSink: ReturnType<typeof boundedSink>;

  constructor(emit: (entry: VoiceMonitorEntry) => void) {
    const sink = boundedSink(emit);
    super(sink.publish);
    this.captionSink = sink;
  }

  private publishCaption(caption: Caption) {
    return this.captionSink.publish({
      id: caption.id,
      kind: "transcript",
      label: caption.speaker === "caller" ? "Caller" : "Assistant",
      at: caption.at,
      speaker: caption.speaker,
      status: caption.status,
      // Redact after joining, so a secret split between adjacent deltas is still removed.
      text: monitorDetail(caption.fragments.map((fragment) => fragment.text).join("")) as string,
      details: {
        grouping:
          "Approximate 12-second timeline window; not a conversational turn or playback confirmation.",
        windowStartMs: caption.window * windowMs,
        windowEndMs: (caption.window + 1) * windowMs,
        fragments: caption.fragments.map(({ startMs, endMs }) => ({ startMs, endMs })),
        ...(caption.truncated ? { truncated: true } : {}),
      },
    });
  }

  override receive(event: Record<string, unknown>) {
    if (this.captionsClosed) return;
    if (
      event.type === "session.input_transcript.delta" ||
      event.type === "session.output_transcript.delta"
    ) {
      const speaker = event.type === "session.input_transcript.delta" ? "caller" : "assistant";
      const start = event.start_ms,
        end = event.end_ms;
      if (
        typeof event.delta !== "string" ||
        !event.delta ||
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end < start ||
        !Number.isSafeInteger(Math.floor(end))
      )
        return;
      const window = Math.floor(start / windowMs);
      const id = `live-caption-${speaker}-${window}`;
      const latest = Math.max(window, this.latestWindow.get(speaker) ?? window);
      this.latestWindow.set(speaker, latest);
      for (const prior of this.captions.values()) {
        if (prior.speaker === speaker && prior.window < latest && prior.status === "streaming") {
          prior.status = "complete";
          this.publishCaption(prior);
        }
      }
      let caption = this.captions.get(id);
      if (!caption) {
        caption = {
          id,
          speaker,
          window,
          at: new Date().toISOString(),
          status: window < latest ? "complete" : "streaming",
          fragments: [],
          seen: new Set(),
          characters: 0,
          truncated: false,
        };
      }
      const key = createHash("sha256")
        .update(
          typeof event.event_id === "string" && event.event_id
            ? `event:${event.event_id}`
            : JSON.stringify([start, end, event.delta]),
        )
        .digest("hex");
      if (caption.seen.has(key)) return;
      if (caption.fragments.length >= maxFragments || caption.characters >= maxText) {
        caption.truncated = true;
        this.publishCaption(caption);
        this.captionSink.warn();
        return;
      }
      const text = event.delta.slice(0, maxText - caption.characters);
      caption.seen.add(key);
      caption.fragments.push({ startMs: start, endMs: end, text });
      caption.fragments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
      caption.characters += text.length;
      caption.truncated ||= text.length < event.delta.length;
      if (this.publishCaption(caption)) this.captions.set(id, caption);
      if (caption.truncated) this.captionSink.warn();
    } else if (event.type === "response.event" && record(event.event)) {
      const nested = event.event;
      super.receive({
        ...nested,
        type: ["response.completed", "response.failed", "response.cancelled"].includes(
          String(nested.type),
        )
          ? "response.done"
          : nested.type,
      });
    } else super.receive(event);
  }

  override close(reason: string) {
    if (this.captionsClosed) return;
    this.captionsClosed = true;
    for (const caption of this.captions.values()) {
      if (caption.status !== "streaming") continue;
      caption.status = normalClosures.has(reason) ? "complete" : "incomplete";
      this.publishCaption(caption);
    }
    this.captions.clear();
    this.latestWindow.clear();
    super.close(reason);
  }
}
