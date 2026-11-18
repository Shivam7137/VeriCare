"use client";

import { useEffect, useRef, useState } from "react";
import type { VoiceMonitorEntry, VoiceMonitorSnapshot } from "@prc/contracts";
import { api } from "../lib/ui";
import { enterWorkspace } from "../lib/workspace";
import { monitorTime } from "./call-monitor-feed";

type LiveCall = {
  id: string;
  mode: string;
  status: string;
  maskedNumber: string | null;
  createdAt: string;
  updatedAt?: string;
};
type Config = { model: string; voice: string; phoneNumber?: string | null; liveReady?: boolean };

const activeStates = ["in_progress", "awaiting_verification", "transferring"];
const empty: VoiceMonitorSnapshot = {
  entries: [],
  captureWarning: null,
  persisted: true,
  streamConnected: false,
};
const request = <T,>(path: string) =>
  api<T>(`/api/backend/voice/${path}`, undefined, undefined, "professional");

// Stale rows can keep an active status after a dropped call, so recency is required too.
export function currentCall(calls: LiveCall[], now = Date.now()) {
  return calls.find(
    (call) =>
      call.mode === "twilio" &&
      activeStates.includes(call.status) &&
      now - Date.parse(call.updatedAt ?? call.createdAt) < 20 * 60_000,
  );
}

// Readable from the back of a room: +12025550142 becomes +1 202-555-0142.
export function dialable(number: string) {
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(number);
  return nanp ? `+1 ${nanp[1]}-${nanp[2]}-${nanp[3]}` : number;
}

const toolNames: Record<string, string> = {
  identify_emergency_patient: "Match the patient",
  send_emergency_contact_code: "Text a verification code",
  verify_emergency_contact_code: "Check the code",
  get_emergency_patient_location: "Look up the location",
};
const words = (value: string) => value.replaceAll("_", " ");
const title = (value: string) =>
  toolNames[value] ?? words(value).replace(/^./, (c) => c.toUpperCase());

function field(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return Object.values(value).map(field).filter(Boolean).join(" · ");
  return String(value);
}

function Activity({ entry }: { entry: VoiceMonitorEntry }) {
  const sms = entry.id.startsWith("sms-");
  const details = entry.details ?? {};
  const args = (details.arguments ?? {}) as Record<string, unknown>;
  const result = (details.result ?? {}) as Record<string, unknown>;
  if (entry.kind !== "tool")
    return (
      <li className={`live-event live-${entry.kind}`}>
        <i />
        <span>{entry.label}</span>
        <time>{monitorTime(entry.at)}</time>
      </li>
    );
  const outcome = sms
    ? String(details.status ?? "")
    : entry.status === "running"
      ? "running"
      : entry.status === "failed"
        ? "failed"
        : String(result.status ?? "done");
  const extra = Object.entries(result).filter(([key]) => !["status", "message"].includes(key));
  return (
    <li className={`live-tool${sms ? " live-sms" : ""} live-is-${entry.status}`}>
      <div className="live-tool-head">
        <b>{sms ? "✉" : entry.status === "running" ? "" : "✓"}</b>
        <strong>{sms ? "Text message" : title(entry.label)}</strong>
        <span className="live-chip">{words(outcome)}</span>
      </div>
      {!sms && <code>{entry.label}</code>}
      {sms ? (
        <p className="live-sms-body">
          {entry.text}
          <small>to {String(details.maskedRecipient ?? "registered contact")}</small>
        </p>
      ) : (
        <dl>
          {Object.entries(args).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{field(value)}</dd>
            </div>
          ))}
          {extra.map(([key, value]) => (
            <div key={key} className="live-out">
              <dt>{key}</dt>
              <dd>{field(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {typeof result.message === "string" && <p className="live-rule">{result.message}</p>}
      <div className="live-tool-foot">
        <time>{monitorTime(entry.at)}</time>
        {entry.elapsedMs !== undefined && <span>{Math.round(entry.elapsedMs)} ms</span>}
      </div>
    </li>
  );
}

export default function PitchLive(props: {
  open: boolean;
  polling: boolean;
  onClose: () => void;
  onLive: () => void;
}) {
  // The poll loop outlives renders, so it reads the latest props through a ref.
  const latest = useRef(props);
  latest.current = props;
  const announced = useRef("");
  const [calls, setCalls] = useState<LiveCall[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [selected, setSelected] = useState("");
  const [snapshot, setSnapshot] = useState(empty);
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const talk = useRef<HTMLDivElement>(null);
  const work = useRef<HTMLOListElement>(null);
  const call = calls.find((item) => item.id === selected);

  useEffect(() => {
    if (!props.polling) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await enterWorkspace("professional");
        const data = await request<{ calls: LiveCall[] }>("calls");
        if (disposed) return;
        setCalls(data.calls);
        setError("");
        const live = currentCall(data.calls);
        if (live) setSelected(live.id);
        // A new call opens the panel by itself, once, so the presenter can keep talking.
        if (live && announced.current !== live.id) {
          announced.current = live.id;
          if (!latest.current.open) latest.current.onLive();
        }
        setNow(Date.now());
      } catch (cause) {
        if (!disposed) setError((cause as Error).message);
      }
      if (!disposed) timer = setTimeout(poll, 1000);
    }
    void poll();
    void request<Config>("config")
      .then((data) => !disposed && setConfig(data))
      .catch(() => {});
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [props.polling]);

  useEffect(() => {
    setSnapshot(empty);
    if (!selected || !props.polling) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const data = await request<VoiceMonitorSnapshot>(
          `calls/${encodeURIComponent(selected)}/monitor`,
        );
        if (disposed) return;
        setSnapshot(data);
        setError("");
      } catch (cause) {
        if (!disposed) setError((cause as Error).message);
      }
      if (!disposed) timer = setTimeout(poll, 700);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [selected, props.polling]);

  const entries = [...snapshot.entries].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const transcript = entries.filter((entry) => entry.kind === "transcript");
  const activity = entries.filter((entry) => !["transcript", "response"].includes(entry.kind));
  const tools = activity.filter((entry) => entry.kind === "tool" && !entry.id.startsWith("sms-"));
  const version = JSON.stringify(entries.map((entry) => [entry.id, entry.status, entry.text]));
  useEffect(() => {
    for (const element of [talk.current, work.current])
      element?.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [version]);

  const live = snapshot.streamConnected;
  const state = error
    ? "offline"
    : !call
      ? "waiting"
      : live
        ? "live"
        : activeStates.includes(call.status)
          ? "connecting"
          : "saved";
  const label = {
    offline: "Reconnecting",
    waiting: "Waiting for a call",
    live: "Live",
    connecting: "Connecting",
    saved: "Call ended · saved record",
  }[state];
  const seconds = call
    ? Math.max(
        0,
        Math.floor(
          ((live ? now : Date.parse(call.updatedAt ?? call.createdAt)) -
            Date.parse(call.createdAt)) /
            1000,
        ),
      )
    : 0;
  const last = calls.find((item) => item.mode === "twilio" && item.id !== selected);

  return (
    <div className={`live${props.open ? " open" : ""}`} data-hold data-state={state}>
      <div className="live-top">
        <div className="live-brand">
          <strong>VeriCare</strong>
          <span>Live call</span>
        </div>
        <div className="live-status">
          <i />
          {label}
          {state === "live" && (
            <span className="live-wave" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
          )}
        </div>
        <div className="live-meta">
          {call && (
            <>
              <span>Caller {call.maskedNumber ?? "unknown"}</span>
              <span>
                {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
              </span>
            </>
          )}
          {config && (
            <span>
              {config.model} · {config.voice}
            </span>
          )}
          <button className="live-close" onClick={props.onClose} aria-label="Close live panel">
            ✕
          </button>
        </div>
      </div>
      {!call ? (
        <div className="live-wait">
          <div className="live-rings">
            <i />
            <i />
            <i />
            <b>☎</b>
          </div>
          <h3>{error ? "Can't reach the call service" : "Waiting for a call"}</h3>
          <p>
            {error ||
              "Dial the demo line. The conversation and every step VeriCare takes will appear here as it happens."}
          </p>
          {!error && config?.phoneNumber && config.liveReady && (
            <a className="live-dial" href={`tel:${config.phoneNumber}`}>
              {dialable(config.phoneNumber)}
            </a>
          )}
          {last && (
            <button className="live-last" onClick={() => setSelected(last.id)}>
              Show the last recorded call
            </button>
          )}
        </div>
      ) : (
        <div className="live-body">
          <section className="live-col">
            <h3>
              Conversation <span>{transcript.length} segments · transcribed live</span>
            </h3>
            <div className="live-scroll live-talk" ref={talk}>
              {transcript.map((entry) => (
                <div className={`live-line live-${entry.speaker ?? "assistant"}`} key={entry.id}>
                  <span>
                    {entry.speaker === "caller" ? "Caller" : "Alex · AI"}
                    <time>{monitorTime(entry.at)}</time>
                  </span>
                  <p>
                    {entry.text?.trim() || "…"}
                    {entry.status === "streaming" && <i className="live-caret" />}
                  </p>
                  {entry.status === "interrupted" && <small>Interrupted by the caller</small>}
                </div>
              ))}
              {!transcript.length && <p className="live-hint">Listening for the first words…</p>}
            </div>
          </section>
          <section className="live-col">
            <h3>
              What VeriCare is doing <span>{tools.length} tool calls</span>
            </h3>
            <ol className="live-scroll live-work" ref={work}>
              {activity.map((entry) => (
                <Activity entry={entry} key={entry.id} />
              ))}
              {!activity.length && <p className="live-hint">Tool calls and texts appear here.</p>}
            </ol>
          </section>
        </div>
      )}
      <div className="live-foot">
        <span>
          {snapshot.captureWarning ??
            "Fictional patient data. Captions are approximate. No audio is recorded."}
        </span>
        {call && state !== "live" && last && (
          <button className="live-last small" onClick={() => setSelected(last.id)}>
            Previous recorded call
          </button>
        )}
      </div>
    </div>
  );
}
