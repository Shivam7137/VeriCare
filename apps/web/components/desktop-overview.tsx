"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { date, labels, type Actor } from "../lib/ui";
import {
  filterRequests,
  loadDesktopSnapshot,
  needsReview,
  stoppedStates,
  type DesktopSnapshot,
  type RequestFilter,
} from "../lib/desktop";
import { AgentPanel, AppointmentPanel, RequestInspector } from "./desktop-panels";
import DesktopCalls from "./desktop-calls";
import DesktopIcon from "./desktop-icon";
import { enterWorkspace, orderRequests } from "../lib/workspace";

export default function DesktopOverview() {
  const [actor, setActor] = useState<Actor | null>(null);
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RequestFilter>("all");
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState(0);
  const generation = useRef(0);
  const identity = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const current = generation.current;
    const valid = () => !disposed && current === generation.current;
    async function refresh() {
      setSyncing(true);
      try {
        const person = await enterWorkspace("professional");
        if (!valid()) return;
        if (identity.current !== person.id) {
          identity.current = person.id;
          setSnapshot(null);
          setSelected("");
        }
        setActor(person);
        const data = await loadDesktopSnapshot();
        if (!valid()) return;
        setSnapshot(data);
        setError("");
        setSelected((id) =>
          data.tasks.some((item) => item.task.id === id)
            ? id
            : (orderRequests(data.tasks)[0]?.task.id ?? ""),
        );
      } catch (cause) {
        if (valid()) setError((cause as Error).message);
      } finally {
        if (valid()) {
          setLoading(false);
          setSyncing(false);
          // Never overlap periodic requests, including when a response is slow.
          timer = setTimeout(refresh, 5000);
        }
      }
    }
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [version]);

  function refreshNow() {
    generation.current++;
    setVersion((value) => value + 1);
  }
  const filtered = snapshot ? filterRequests(snapshot.tasks, snapshot.calls, query, filter) : [];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 6) - 1));
  const visible = filtered.slice(currentPage * 6, currentPage * 6 + 6);
  const progress = filtered.find((item) => item.task.id === selected) ?? filtered[0];
  const handovers = snapshot?.calls.filter((call) => call.status === "handoff").length ?? 0;
  function changeFilter(value: RequestFilter) {
    setFilter(value);
    setPage(0);
  }

  return (
    <div className="desktop-screen">
      <a href="#desktop-main" className="desk-skip">
        Skip to overview
      </a>
      <aside className="desk-sidebar">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            +
          </span>
          <span>
            Health <br />
            Coordinator
          </span>
        </Link>
        <p className="desk-nav-label">WORKSPACE</p>
        <nav aria-label="Desktop navigation">
          <a href="#overview" className="desk-nav-current">
            <span aria-hidden="true">
              <DesktopIcon name="overview" />
            </span>
            Overview
          </a>
          {actor && (
            <>
              <a href="#requests">
                <span aria-hidden="true">≡</span>Requests <b>{snapshot?.tasks.length ?? "–"}</b>
              </a>
              <a href="#calls">
                <span aria-hidden="true">
                  <DesktopIcon name="external" />
                </span>
                Calls & callbacks {handovers > 0 && <b>{handovers}</b>}
              </a>
              <a href="#appointments">
                <span aria-hidden="true">
                  <DesktopIcon name="calendar" />
                </span>
                Appointments
              </a>
              <a href="#agents">
                <span aria-hidden="true">◇</span>AI agents
              </a>
            </>
          )}
        </nav>
        <p className="desk-nav-label">OPEN A PORTAL</p>
        <nav aria-label="Related workspaces">
          <Link href="/patient">
            <span aria-hidden="true">○</span>Patient portal <DesktopIcon name="external" />
          </Link>
          <Link href="/professional/team">
            <span aria-hidden="true">✚</span>Care team & phone <DesktopIcon name="external" />
          </Link>
          <Link href="/professional">
            <span aria-hidden="true">✚</span>Professional portal <DesktopIcon name="external" />
          </Link>
        </nav>
        <div className="desk-sidebar-note">
          <span className="desk-pill">Synthetic demo</span>
          <p>
            One department.
            <br />
            Every next step in view.
          </p>
          <small>Appointment times in Halifax time.</small>
        </div>
      </aside>
      <main className="desk-main" id="desktop-main">
        <header className="desk-topbar">
          <span>
            Care operations <span aria-hidden="true">/</span> Desktop overview
          </span>
          <div>
            <span className="desk-tag">
              {actor
                ? actor.role === "operator"
                  ? "Operator · View only"
                  : "Professional view"
                : "Professional workspace"}
            </span>
          </div>
        </header>
        <section className="desk-heading" id="overview">
          <div>
            <p className="eyebrow">Fictional outpatient clinic</p>
            <h1>Department overview</h1>
            <p>Requests, saved appointment outcomes, and phone activity.</p>
          </div>
          {actor && (
            <button className="desk-refresh" disabled={syncing} onClick={refreshNow}>
              <span aria-hidden="true">↻</span> {syncing ? "Refreshing…" : "Refresh overview"}
            </button>
          )}
        </section>
        {error && (
          <div className="desk-error" role="alert">
            <strong>{"Overview could not refresh."}</strong>
            <p>
              {error} {error && snapshot ? "Showing the last successful update below." : ""}
            </p>
          </div>
        )}
        {loading ? (
          <div className="desk-card desk-welcome" role="status">
            Connecting to your professional workspace…
          </div>
        ) : !actor ? (
          <section className="desk-card desk-welcome">
            <h2>Overview unavailable</h2>
            <p>Please retry. If demo access has expired, ask the demo host to refresh it.</p>
            <button className="secondary" onClick={refreshNow}>
              Retry connection
            </button>
          </section>
        ) : !snapshot ? (
          <div className="desk-card desk-welcome" role="status">
            {error
              ? "The overview will retry automatically. You can also use Refresh overview."
              : "Loading requests, appointments and calls…"}
          </div>
        ) : (
          <>
            <div className="desk-live-line">
              <span className={error ? "desk-warning" : ""}>
                <i aria-hidden="true" />
                {error ? "Update delayed" : "Connected to your department"}
              </span>
              <span>
                Updated{" "}
                {new Date(snapshot.updatedAt).toLocaleTimeString("en-CA", {
                  timeZone: "America/Halifax",
                  timeZoneName: "short",
                  hour: "numeric",
                  minute: "2-digit",
                })}
                · Refreshes every 5s
              </span>
            </div>
            <section className="desk-stats" aria-label="Department overview">
              {[
                {
                  label: "Open requests",
                  value: snapshot.tasks.filter((item) => !stoppedStates.has(item.task.state))
                    .length,
                  note: "Awaiting the next step",
                  target: "open" as const,
                  icon: "≡",
                },
                {
                  label: "Needs professional review",
                  value: snapshot.tasks.filter((item) => needsReview(item, snapshot.calls)).length,
                  note: `${handovers} phone handover${handovers === 1 ? "" : "s"} recorded`,
                  target: "review" as const,
                  icon: "✚",
                },
                {
                  label: "Waiting on the patient",
                  value: snapshot.tasks.filter(
                    (item) => item.task.state === "awaiting_patient_confirmation",
                  ).length,
                  note: "Exact proposal confirmation",
                  target: "patient" as const,
                  icon: "○",
                },
                {
                  label: "Appointment changes",
                  value: snapshot.tasks.filter((item) => item.task.state === "completed").length,
                  note: "Confirmed by the backend",
                  target: "completed" as const,
                  icon: "✓",
                },
              ].map((stat) => (
                <button
                  className={`desk-stat ${filter === stat.target ? "desk-stat-selected" : ""}`}
                  key={stat.label}
                  onClick={() => {
                    changeFilter(stat.target);
                    setQuery("");
                    document
                      .getElementById("requests")
                      ?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  aria-label={`Show ${stat.label.toLowerCase()}`}
                  aria-pressed={filter === stat.target && !query}
                >
                  <span>
                    {stat.label}
                    <i aria-hidden="true">{stat.icon}</i>
                  </span>
                  <strong>{stat.value}</strong>
                  <small>{stat.note}</small>
                </button>
              ))}
            </section>
            <div className="desk-work-grid">
              <div className="desk-primary-column">
                <section
                  className="desk-card desk-request-card"
                  id="requests"
                  aria-labelledby="desk-requests-title"
                >
                  <div className="desk-section-heading">
                    <div>
                      <p className="eyebrow">THE WORK IN PROGRESS</p>
                      <h2 id="desk-requests-title">
                        Request overview <span className="desk-count">{snapshot.tasks.length}</span>
                      </h2>
                    </div>
                    <Link className="desk-text-link" href="/professional">
                      Open workspace <DesktopIcon name="external" />
                    </Link>
                  </div>
                  <div className="desk-filters">
                    <label>
                      <span className="desk-visually-hidden">Search requests</span>
                      <DesktopIcon name="search" />
                      <input
                        type="search"
                        value={query}
                        onChange={(event) => {
                          setQuery(event.target.value);
                          setPage(0);
                        }}
                        placeholder="Search note, request or patient…"
                      />
                    </label>
                    <select
                      aria-label="Filter requests"
                      value={filter}
                      onChange={(event) => changeFilter(event.target.value as RequestFilter)}
                    >
                      <option value="all">All requests</option>
                      <option value="open">Open requests</option>
                      <option value="review">Professional review</option>
                      <option value="patient">Patient confirmation</option>
                      <option value="completed">Appointment changed</option>
                      <option value="stopped">Withdrawn / with staff</option>
                    </select>
                  </div>
                  {visible.length ? (
                    <div
                      className="desk-table-scroll"
                      tabIndex={0}
                      role="region"
                      aria-label="Request overview table"
                    >
                      <table>
                        <thead>
                          <tr>
                            <th scope="col">Request / patient</th>
                            <th scope="col">Stage</th>
                            <th scope="col">Updated · Halifax time</th>
                            <th scope="col">
                              <span className="desk-visually-hidden">View details</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {visible.map(({ task, patient }) => (
                            <tr
                              key={task.id}
                              className={progress?.task.id === task.id ? "desk-row-selected" : ""}
                            >
                              <td>
                                <strong>{task.summary}</strong>
                                <small>{patient?.displayName ?? task.patientId}</small>
                              </td>
                              <td>
                                <span
                                  className={`desk-pill ${task.state === "completed" ? "desk-pill-green" : task.state === "awaiting_staff_approval" || task.state === "reconciling" ? "desk-pill-amber" : ""}`}
                                >
                                  {labels[task.state]}
                                </span>
                              </td>
                              <td>
                                <time dateTime={task.updatedAt}>{date(task.updatedAt)}</time>
                              </td>
                              <td>
                                <button
                                  className="desk-link-button"
                                  aria-label={`View request ${task.id}`}
                                  aria-pressed={progress?.task.id === task.id}
                                  onClick={() => setSelected(task.id)}
                                >
                                  View <span aria-hidden="true">→</span>
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="desk-empty">
                      <h3>
                        {snapshot.tasks.length
                          ? "No matching requests"
                          : "Your request queue is clear"}
                      </h3>
                      <p>
                        {snapshot.tasks.length
                          ? "Try another search or choose All requests."
                          : "Requests created in the patient portal will appear here."}
                      </p>
                      {snapshot.tasks.length > 0 && (
                        <button
                          className="desk-link-button"
                          onClick={() => {
                            setQuery("");
                            changeFilter("all");
                          }}
                        >
                          Clear filters
                        </button>
                      )}
                    </div>
                  )}
                  <div className="desk-pagination">
                    <span>
                      {filtered.length
                        ? `${currentPage * 6 + 1}–${Math.min(currentPage * 6 + 6, filtered.length)} of ${filtered.length} requests`
                        : "0 requests"}
                    </span>
                    <div>
                      <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                        Previous
                      </button>
                      <button
                        disabled={(currentPage + 1) * 6 >= filtered.length}
                        onClick={() => setPage(currentPage + 1)}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                </section>
                <DesktopCalls calls={snapshot.calls} />
                <AppointmentPanel snapshot={snapshot} />
              </div>
              <div className="desk-secondary-column">
                <RequestInspector progress={progress} />
                <AgentPanel snapshot={snapshot} />
              </div>
            </div>
          </>
        )}
        <footer className="desk-footer">
          <span>Health Coordinator · Department overview</span>
          <span>Fictional records · Backend-verified outcomes</span>
        </footer>
      </main>
    </div>
  );
}
