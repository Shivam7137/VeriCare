"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "@prc/contracts";
import { api, date, labels, type Actor, type Progress, type Queue, type Slot } from "../lib/ui";
import RequestDetail from "./request-detail";
import RequestForm from "./request-form";

export default function Dashboard() {
  const [actor, setActor] = useState<Actor | null>(null);
  const [tasks, setTasks] = useState<Progress[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [booking, setBooking] = useState<{ startsAt: string } | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const refreshId = useRef(0);
  const refresh = useCallback(async () => {
    if (!actor) return;
    const version = ++refreshId.current,
      identity = generation.current;
    const [requests, availability, currentBooking, operatorQueue] = await Promise.all([
      api<{ tasks: Progress[] }>("/api/backend/tasks"),
      api<{ slots: Slot[] }>("/api/backend/slots?patientId=synthetic-patient-001"),
      api<{ startsAt: string }>("/api/backend/bookings/synthetic-appointment-001"),
      actor.role === "operator" ? api<Queue>("/api/backend/operator/queue") : Promise.resolve(null),
    ]);
    if (identity !== generation.current || version !== refreshId.current) return;
    setTasks(requests.tasks);
    setSlots(availability.slots);
    setBooking(currentBooking);
    setQueue(operatorQueue);
    setSelectedId((id) =>
      requests.tasks.some((item) => item.task.id === id) ? id : (requests.tasks[0]?.task.id ?? ""),
    );
  }, [actor]);
  useEffect(() => {
    let active = true;
    fetch("/api/session", { cache: "no-store" })
      .then(async (response) => {
        if (response.ok && active) setActor(await response.json());
      })
      .catch(() => {
        if (active) setError("The local server is unavailable. Refresh to try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!actor || busy) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function sync() {
      try {
        await refresh();
      } catch (cause) {
        if (active) setError((cause as Error).message);
      }
      // Slow responses must finish before scheduling the next poll.
      if (active) timer = setTimeout(sync, 3000);
    }
    void sync();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [actor, refresh, busy]);
  const selected = tasks.find((item) => item.task.id === selectedId);
  async function switchAccount(persona: Actor["role"]) {
    setBusy(true);
    setError("");
    setNotice("");
    generation.current++;
    refreshId.current++;
    setActor(null);
    setTasks([]);
    setSlots([]);
    setQueue(null);
    setBooking(null);
    setCreating(false);
    try {
      setActor(await api<Actor>("/api/session", { persona }));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    try {
      await api("/api/session", undefined, "DELETE");
      generation.current++;
      refreshId.current++;
      setActor(null);
      setTasks([]);
      setSlots([]);
      setQueue(null);
      setBooking(null);
      setError("");
      setNotice("");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function mutate(path: string, input: unknown, created = false) {
    setBusy(true);
    setError("");
    setNotice("");
    refreshId.current++;
    try {
      const result = await api<Task>(`/api/backend/${path}`, input);
      setSelectedId(result.id);
      if (created) setCreating(false);
      setNotice(
        created
          ? "Request saved. Verify it to send it to the staff queue."
          : "Your action was saved.",
      );
      await refresh();
    } catch (cause) {
      setError((cause as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <header>
        <a href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            +
          </span>
          Care coordination
        </a>
        <span className="badge">Synthetic demo · One department</span>
      </header>
      <section className="intro">
        <div>
          <p className="eyebrow">APPOINTMENT REQUESTS</p>
          <h1>
            A clear next step.
            <br />
            <span>Every step of the way.</span>
          </h1>
          <p className="lede">
            Request a new time, review the proposal, and follow your appointment through to
            confirmation.
          </p>
        </div>
        <div className="demo-note">
          <span className="dot" />
          Local demonstration
          <p>Fictional appointments and simulated callbacks. No real messages are sent.</p>
        </div>
      </section>
      <section className="account-bar" aria-label="Demo account">
        <div>
          <p className="eyebrow">DEMO ACCOUNT</p>
          <span>{actor ? `Signed in as ${actor.role}` : "Choose a view to get started"}</span>
        </div>
        <div className="account-options">
          {(["patient", "staff", "operator"] as const).map((role) => (
            <button
              key={role}
              aria-pressed={actor?.role === role}
              disabled={busy || loading}
              className={actor?.role === role ? "selected" : ""}
              onClick={() => switchAccount(role)}
            >
              {role.charAt(0).toUpperCase() + role.slice(1)}
            </button>
          ))}
        </div>
        {actor && (
          <button className="quiet" disabled={busy} onClick={signOut}>
            Sign out
          </button>
        )}
      </section>
      {error && (
        <div role="alert" className="alert">
          {error}
          <button className="quiet" onClick={() => setError("")}>
            Dismiss
          </button>
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <section className="panel empty">Connecting to your workspace…</section>
      ) : !actor ? (
        <section className="panel welcome">
          <p className="eyebrow">TRY THE COMPLETE JOURNEY</p>
          <h2>Start as a patient. Review as staff.</h2>
          <p>
            Create and verify a request in the patient view. Switch to staff to propose and approve
            a time, then return to the patient view to confirm after the simulated callback.
          </p>
          <p className="muted">
            The worker records the booking outcome automatically. The operator view follows progress
            across the queue.
          </p>
          <details>
            <summary>Local setup help</summary>
            <p>
              From the repository root, run <code>npm run demo:credentials</code>, then{" "}
              <code>npm run dev</code>. If credentials expired, follow the renewal steps in{" "}
              <code>docs/setup.md</code>.
            </p>
          </details>
        </section>
      ) : (
        <>
          <section className="stats" aria-label="Overview">
            <div>
              <span>Requests</span>
              <strong>{tasks.length}</strong>
            </div>
            <div>
              <span>Confirmed</span>
              <strong>{tasks.filter((item) => item.task.state === "completed").length}</strong>
            </div>
            {queue ? (
              <>
                <div>
                  <span>Overdue actions / jobs</span>
                  <strong>
                    {queue.counts.overduePendingActions} / {queue.counts.overdueJobs}
                  </strong>
                </div>
                <div>
                  <span>Failed / reconciling</span>
                  <strong>
                    {queue.counts.failedDeliveries} / {queue.counts.reconciliation}
                  </strong>
                </div>
              </>
            ) : (
              <div className="current-booking">
                <span>Current appointment · Demo patient</span>
                <strong>{booking ? date(booking.startsAt) : "Loading…"}</strong>
              </div>
            )}
          </section>
          <div className="workspace">
            <aside className="request-list">
              <div className="list-heading">
                <h2>{actor.role === "patient" ? "Your requests" : "Department queue"}</h2>
                <button
                  className="quiet"
                  disabled={busy}
                  onClick={() => {
                    setError("");
                    void refresh().catch((cause) => setError(cause.message));
                  }}
                >
                  Refresh
                </button>
              </div>
              {actor.role === "patient" && (
                <button
                  className="primary new-request"
                  disabled={busy}
                  onClick={() => {
                    setCreating(true);
                    setNotice("");
                  }}
                >
                  + New request
                </button>
              )}
              {!tasks.length && <p className="muted">No saved requests yet.</p>}
              {tasks.map((item) => (
                <button
                  key={item.task.id}
                  className={`request-item ${selectedId === item.task.id && !creating ? "active" : ""}`}
                  aria-pressed={selectedId === item.task.id && !creating}
                  disabled={busy}
                  onClick={() => {
                    setSelectedId(item.task.id);
                    setCreating(false);
                    setNotice("");
                  }}
                >
                  <span className={`status ${item.task.state === "completed" ? "success" : ""}`}>
                    {labels[item.task.state]}
                  </span>
                  <strong>{item.task.summary}</strong>
                  <small>
                    {item.task.id === "T001" ? "Starter request · T001" : date(item.task.createdAt)}
                  </small>
                </button>
              ))}
              <p className="hint">Updates automatically every 3 seconds.</p>
            </aside>
            <div className="content">
              {creating && actor.role === "patient" ? (
                <RequestForm
                  slots={slots}
                  busy={busy}
                  close={() => setCreating(false)}
                  create={(input) => mutate("tasks", input, true)}
                />
              ) : selected ? (
                <RequestDetail
                  key={selected.task.id}
                  progress={selected}
                  actor={actor}
                  slots={slots}
                  busy={busy}
                  command={(action, input = {}) =>
                    mutate(`tasks/${selected.task.id}/${action}`, {
                      expectedRevision: selected.task.revision,
                      ...input,
                    })
                  }
                />
              ) : (
                <section className="panel empty">
                  <h2>Select a request</h2>
                  <p>Your saved request and its next step will appear here.</p>
                </section>
              )}
            </div>
          </div>
        </>
      )}
      <footer>
        <span>Patient Request Coordination</span>
        <span>Synthetic records only · All times UTC</span>
      </footer>
    </main>
  );
}
