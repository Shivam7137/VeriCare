"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { VoiceMonitorSnapshot } from "@prc/contracts";
import { api, date } from "../lib/ui";
import { enterWorkspace } from "../lib/workspace";
import PortalHeader from "./portal-header";
import { MonitorEntry, monitorTime } from "./call-monitor-feed";
import "../app/phone.css";
import "../app/monitor.css";

type MonitorCall = {
  id: string;
  mode: string;
  direction: string;
  status: string;
  maskedNumber: string | null;
  createdAt: string;
  taskId: string | null;
};
type Filter = "all" | "transcript" | "tool" | "events";
const empty: VoiceMonitorSnapshot = {
  entries: [],
  captureWarning: null,
  persisted: true,
  streamConnected: false,
};
const request = <T,>(path: string) =>
  api<T>(`/api/backend/voice/${path}`, undefined, undefined, "professional");

export default function CallMonitor() {
  const [calls, setCalls] = useState<MonitorCall[]>([]);
  const [selected, setSelected] = useState("");
  const [callFilter, setCallFilter] = useState("all");
  const [watchNewest, setWatchNewest] = useState(true);
  const [ready, setReady] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [captureError, setCaptureError] = useState("");
  const [snapshot, setSnapshot] = useState(empty);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const [updated, setUpdated] = useState("");
  const [retry, setRetry] = useState(0);
  const feed = useRef<HTMLDivElement>(null);
  const call = calls.find((item) => item.id === selected);
  const entries = snapshot.entries;
  const visible = entries.filter(
    (entry) =>
      (filter === "all" ||
        filter === entry.kind ||
        (filter === "events" && !["tool", "transcript"].includes(entry.kind))) &&
      `${entry.label} ${entry.text ?? ""} ${JSON.stringify(entry.details ?? {})}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("call")) setWatchNewest(false);
  }, []);
  useEffect(() => {
    const live = calls.find((item) => item.mode === "twilio" && item.status === "in_progress");
    if (watchNewest && live) setSelected(live.id);
  }, [calls, watchNewest]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        await enterWorkspace("professional");
        const data = await request<{ calls: MonitorCall[] }>("calls");
        if (disposed) return;
        setCalls(data.calls);
        setReady(true);
        setHistoryError("");
        setSelected(
          (current) =>
            current ||
            (new URLSearchParams(window.location.search).get("call") ??
              data.calls.find((item) => item.mode === "twilio" && item.status === "in_progress")
                ?.id ??
              data.calls[0]?.id ??
              ""),
        );
      } catch (cause) {
        if (!disposed) setHistoryError((cause as Error).message);
      }
      if (!disposed) timer = setTimeout(poll, 3000);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [retry]);

  useEffect(() => {
    if (!selected || !ready) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setSnapshot(empty);
    setUpdated("");
    setCaptureError("");
    async function poll() {
      try {
        const data = await request<VoiceMonitorSnapshot>(
          `calls/${encodeURIComponent(selected)}/monitor`,
        );
        if (disposed) return;
        setSnapshot(data);
        setUpdated(new Date().toISOString());
        setCaptureError("");
      } catch (cause) {
        if (!disposed) setCaptureError((cause as Error).message);
      }
      if (!disposed) timer = setTimeout(poll, 1000);
    }
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [selected, ready, retry]);

  const contentVersion = JSON.stringify(visible);
  useEffect(() => {
    if (follow && feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  }, [contentVersion, follow]);

  function download() {
    if (!call) return;
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              exportedAt: new Date().toISOString(),
              call,
              ...snapshot,
              note: "Synthetic demo. Caller ASR is approximate; assistant text may include words not played before interruption. No audio recording.",
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `health-coordinator-call-${call.id}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <main className="portal-workspace monitor-workspace">
      <PortalHeader portal="professional" monitor />
      <section className="workspace-heading" id="workspace-main">
        <div>
          <p className="eyebrow">Voice lab · Fictional demo calls</p>
          <h1>Call monitor</h1>
          <p>See the conversation, inspect each tool, and review what happened.</p>
        </div>
        <Link className="button-link" href="/professional/team#phone">
          Get a phone access code →
        </Link>
      </section>
      {(historyError || captureError) && (
        <div role="alert" className="alert">
          <span>
            Updates interrupted. {historyError || captureError} Showing the last received data.
          </span>
          <button className="quiet" onClick={() => setRetry((value) => value + 1)}>
            Reconnect
          </button>
        </div>
      )}
      <div className="monitor-layout">
        <aside className="panel monitor-calls" aria-label="Call selection">
          <div className="monitor-sidebar-heading">
            <h2>Calls</h2>
            <span className="monitor-count">{calls.length}</span>
          </div>
          <label className="monitor-call-filter">
            Show calls
            <select value={callFilter} onChange={(event) => setCallFilter(event.target.value)}>
              <option value="all">All calls</option>
              <option value="twilio">Real phone</option>
              <option value="simulated">Simulations</option>
              <option value="active">In progress</option>
            </select>
          </label>
          <label className="monitor-watch">
            <input
              type="checkbox"
              checked={watchNewest}
              onChange={(event) => setWatchNewest(event.target.checked)}
            />
            Watch newest live call
          </label>
          <div className="monitor-call-list">
            {calls
              .filter(
                (item) =>
                  callFilter === "all" ||
                  callFilter === item.mode ||
                  (callFilter === "active" &&
                    ["in_progress", "transferring"].includes(item.status)),
              )
              .map((item) => (
                <button
                  key={item.id}
                  className={`monitor-call-choice ${selected === item.id ? "selected" : ""}`}
                  aria-pressed={selected === item.id}
                  onClick={() => {
                    setSelected(item.id);
                    setWatchNewest(false);
                    setFollow(true);
                  }}
                >
                  <span className="monitor-choice-title">
                    {item.mode === "twilio" ? "Real phone" : "Simulation"}
                    <span
                      className={`monitor-call-dot ${item.status === "in_progress" ? "active" : ""}`}
                    />
                  </span>
                  <span>
                    {item.direction === "inbound" ? "Incoming" : "Callback"} ·{" "}
                    {item.status.replaceAll("_", " ")}
                  </span>
                  <time dateTime={item.createdAt}>{date(item.createdAt)}</time>
                  <small>{item.maskedNumber ?? item.id.slice(0, 8)}</small>
                </button>
              ))}
          </div>
          {!ready && (
            <p role="status" className="hint">
              Loading calls…
            </p>
          )}
          {ready && !calls.length && (
            <p className="hint">
              Verified calls will appear here. Get an access code, then call the demo line.
            </p>
          )}
        </aside>
        <section className="panel monitor-panel" aria-label="Selected call monitor">
          <div className="monitor-topline">
            <div>
              <p className="eyebrow">
                {call?.mode === "simulated" ? "Simulation record" : "Conversation & activity"}
              </p>
              <h2>
                {call
                  ? call.mode === "twilio"
                    ? "Phone conversation"
                    : "Simulated call"
                  : "Select a call"}
              </h2>
            </div>
            <span
              role="status"
              className={`monitor-connection ${!captureError && snapshot.streamConnected ? "connected" : ""}`}
            >
              {captureError
                ? "Reconnecting"
                : !updated
                  ? "Waiting for data"
                  : snapshot.streamConnected
                    ? "Live · updates every second"
                    : "Saved record · stream offline"}
            </span>
          </div>
          {call && (
            <p className="hint monitor-call-reference">
              {date(call.createdAt)} · {call.status.replaceAll("_", " ")} · {call.id}
              {call.taskId && (
                <>
                  {" "}
                  ·{" "}
                  <Link href={`/professional?request=${encodeURIComponent(call.taskId)}`}>
                    Open request
                  </Link>
                </>
              )}
            </p>
          )}
          <div className="monitor-metrics">
            <div>
              <strong>{entries.filter((entry) => entry.kind === "transcript").length}</strong>
              <span>Speech turns</span>
            </div>
            <div>
              <strong>{entries.filter((entry) => entry.kind === "tool").length}</strong>
              <span>Tool calls</span>
            </div>
            <div>
              <strong>{entries.filter((entry) => entry.status === "failed").length}</strong>
              <span>Errors</span>
            </div>
            <div>
              <strong>
                {
                  entries.filter(
                    (entry) => entry.kind === "speech" && entry.label === "Assistant interrupted",
                  ).length
                }
              </strong>
              <span>Interruptions</span>
            </div>
          </div>
          {snapshot.captureWarning && (
            <p role="alert" className="phone-error">
              {snapshot.captureWarning}
            </p>
          )}
          {entries.some((entry) => entry.label === "Synthetic event playback") && (
            <p className="phone-note">
              Synthetic playback sample: the transcript is invented to demonstrate the monitor. No
              phone call was placed.
            </p>
          )}
          <div className="monitor-toolbar">
            <div className="monitor-tabs" role="group" aria-label="Monitor view">
              {(
                [
                  ["all", "All activity"],
                  ["transcript", "Transcript"],
                  ["tool", "Tools"],
                  ["events", "Events"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button className="quiet" disabled={!call || !entries.length} onClick={download}>
              Export JSON ↓
            </button>
          </div>
          <div className="monitor-feed-controls">
            <input
              type="search"
              aria-label="Search this call"
              placeholder="Search transcript, tools or results…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <label>
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
              />
              Follow latest
            </label>
          </div>
          <div
            ref={feed}
            className="monitor-feed"
            tabIndex={0}
            aria-label="Call activity, scroll to review"
            onScroll={() => {
              const el = feed.current;
              if (el && el.scrollHeight - el.clientHeight - el.scrollTop > 80) setFollow(false);
            }}
          >
            {visible.length ? (
              <ol className="monitor-entries">
                {visible.map((entry) => (
                  <MonitorEntry key={entry.id} entry={entry} />
                ))}
              </ol>
            ) : (
              <div className="monitor-empty">
                <span aria-hidden="true">∿</span>
                <h3>
                  {entries.length
                    ? "No matching activity"
                    : !updated
                      ? "Waiting for call activity"
                      : "No captured activity for this call"}
                </h3>
                <p>
                  {entries.length
                    ? "Try another view or search term."
                    : call?.mode === "simulated"
                      ? "Simulations capture tool actions, without spoken audio. Older demo calls have no transcript to replay."
                      : "Transcripts appear once a verified caller speaks with the assistant. Calls made before monitoring was enabled have no saved transcript."}
                </p>
              </div>
            )}
          </div>
          <footer className="monitor-footer">
            <span>
              {updated
                ? `Last synced ${monitorTime(updated)} · Halifax time`
                : "Connecting to call history…"}
            </span>
            <span>Saved with the call · No audio recording</span>
          </footer>
          <p className="monitor-disclaimer">
            Caller transcription is approximate. Assistant text is generated speech and may include
            words not played before an interruption. Use fictional information only; this demo saves
            transcripts and tool results for review.
          </p>
        </section>
      </div>
    </main>
  );
}
