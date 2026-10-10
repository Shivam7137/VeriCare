"use client";

import { useState } from "react";
import Link from "next/link";
import { date } from "../lib/ui";
import DesktopIcon from "./desktop-icon";
import TransferHistory from "./transfer-history";
import { activeCallStates, readable, taskLink, type DesktopCall } from "../lib/desktop";

export default function DesktopCalls({ calls }: { calls: DesktopCall[] }) {
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState("");
  const [expanded, setExpanded] = useState(false);
  const filtered = calls
    .filter(
      (call) =>
        filter === "all" ||
        (filter === "active" && activeCallStates.has(call.status)) ||
        (filter === "callback" && call.direction === "outbound") ||
        (filter === "handoff" && call.status === "handoff"),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const visible = expanded ? filtered : filtered.slice(0, 5);
  const call = filtered.find((item) => item.id === selected);
  return (
    <section className="desk-card desk-calls" id="calls" aria-labelledby="desk-call-title">
      <div className="desk-section-heading">
        <div>
          <p className="eyebrow">CONVERSATIONS</p>
          <h2 id="desk-call-title">
            Calls & callbacks <span className="desk-count">{calls.length}</span>
          </h2>
        </div>
        <select
          aria-label="Filter calls"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setExpanded(false);
            setSelected("");
          }}
        >
          <option value="all">All calls</option>
          <option value="active">Active calls</option>
          <option value="callback">Callbacks</option>
          <option value="handoff">Professional handovers</option>
        </select>
      </div>
      <p className="desk-muted">
        The latest {calls.length === 200 ? "200 " : ""}department calls. Ending a call does not
        complete an appointment request.
      </p>
      {visible.length ? (
        <ul className="desk-call-list">
          {visible.map((item) => (
            <li key={item.id}>
              <span
                className={`desk-call-icon ${item.status === "handoff" ? "desk-call-handoff" : ""}`}
                aria-hidden="true"
              >
                <DesktopIcon name={item.direction === "inbound" ? "inbound" : "external"} />
              </span>
              <div>
                <strong>
                  {item.direction === "inbound" ? "Incoming call" : "Scheduled callback"}
                  {item.patientName && ` · ${item.patientName}`}
                </strong>
                <p>
                  {item.maskedNumber ?? "Portal-verified session"} ·{" "}
                  {item.mode === "simulated" ? "Simulated" : "Real phone"}
                </p>
                <time dateTime={item.dueAt ?? item.createdAt}>
                  {date(item.dueAt ?? item.createdAt)}
                </time>
              </div>
              <span
                className={`desk-pill ${item.status === "handoff" || item.status === "reconciling" ? "desk-pill-amber" : activeCallStates.has(item.status) ? "desk-pill-green" : ""}`}
              >
                {readable(item.status)}
              </span>
              <button
                className="desk-link-button"
                aria-expanded={selected === item.id}
                aria-label={`View ${item.direction} call ${item.id}`}
                onClick={() => setSelected(selected === item.id ? "" : item.id)}
              >
                Details
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="desk-empty">
          {calls.length
            ? "No calls match this filter."
            : "Calls will appear here when a patient starts a session or schedules a callback."}
        </p>
      )}
      {filtered.length > 5 && (
        <button className="desk-link-button desk-show-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer calls" : `Show all ${filtered.length} calls`}
        </button>
      )}
      {call && (
        <div className="desk-call-detail">
          <strong>
            {call.status === "handoff" ? "Professional review requested" : "Call details"}
          </strong>
          {call.status === "handoff" && (
            <p>
              Call automation has stopped. Review the request in the professional workspace; no live
              transfer has occurred.
            </p>
          )}
          {call.pendingAction && (
            <p>
              <strong>Awaiting caller approval:</strong> {call.pendingAction.description}
            </p>
          )}
          {call.lastError && <p className="desk-warning">{readable(call.lastError)}</p>}
          <TransferHistory callId={call.id} />
          {call.taskId ? (
            <Link className="desk-text-link" href={taskLink(call.taskId)}>
              Open linked request <DesktopIcon name="external" />
            </Link>
          ) : (
            <p className="desk-muted">
              No appointment request attached. This may be intake or a staff care-team call.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
