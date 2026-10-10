"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "@prc/contracts";
import { api, date, labels, type Actor, type Progress, type Queue, type Slot } from "../lib/ui";
import RequestDetail from "./request-detail";
import RequestForm from "./request-form";
import PhonePanel from "./phone-panel";
import PortalHeader from "./portal-header";
import type { Portal } from "../lib/portal";

export default function Dashboard({ portal }: { portal: Portal }) {
  const patientPortal = portal === "patient";
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
      api<{ tasks: Progress[] }>("/api/backend/tasks", undefined, undefined, portal),
      api<{ slots: Slot[] }>(
        "/api/backend/slots?patientId=synthetic-patient-001",
        undefined,
        undefined,
        portal,
      ),
      api<{ startsAt: string }>(
        "/api/backend/bookings/synthetic-appointment-001",
        undefined,
        undefined,
        portal,
      ),
      actor.role === "operator"
        ? api<Queue>("/api/backend/operator/queue", undefined, undefined, portal)
        : Promise.resolve(null),
    ]);
    if (identity !== generation.current || version !== refreshId.current) return;
    setTasks(requests.tasks);
    setSlots(availability.slots);
    setBooking(currentBooking);
    setQueue(operatorQueue);
    setSelectedId((id) =>
      requests.tasks.some((item) => item.task.id === id) ? id : (requests.tasks[0]?.task.id ?? ""),
    );
  }, [actor, portal]);
  useEffect(() => {
    let active = true;
    fetch("/api/session", { cache: "no-store", headers: { "x-prc-portal": portal } })
      .then(async (response) => {
        if (response.ok && active) setActor(await response.json());
        else if (response.status !== 401 && active)
          setError("Your portal session could not be restored. Sign in to try again.");
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
  }, [portal]);
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
  const accountChoices: Actor["role"][] = patientPortal
    ? actor
      ? []
      : ["patient"]
    : ["staff", "operator"];
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
      setActor(await api<Actor>("/api/session", { persona }, "POST", portal));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    try {
      await api("/api/session", undefined, "DELETE", portal);
      generation.current++;
      refreshId.current++;
      setActor(null);
      setTasks([]);
      setSlots([]);
      setQueue(null);
      setBooking(null);
      setCreating(false);
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
      const result = await api<Task>(`/api/backend/${path}`, input, "POST", portal);
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
    <main className={`portal-workspace ${portal}-portal`}>
      <PortalHeader portal={portal} />
      <section className="intro">
        <div>
          <p className="eyebrow">
            {patientPortal ? "PATIENT PORTAL" : "HEALTHCARE PROFESSIONAL PORTAL"}
          </p>
          <h1>
            {patientPortal ? "Your care. Your next step." : "Keep care moving."}
            <br />
            <span>{patientPortal ? "We’ll help you get there." : "One request at a time."}</span>
          </h1>
          <p className="lede">
            {patientPortal
              ? "Request a new time, review your proposal, and follow your appointment through to confirmation."
              : "Review department requests, approve appointment proposals, and coordinate patient follow-up."}
          </p>
        </div>
        <div className="demo-note">
          <span className="dot" />
          Local demonstration
          <p>
            Fictional appointments and phone assistance. Simulation is available without provider
            credentials.
          </p>
        </div>
      </section>
      <section className="account-bar" aria-label="Demo account">
        <div>
          <p className="eyebrow">DEMO ACCOUNT</p>
          <span>
            {actor
              ? actor.role === "patient"
                ? "Your patient workspace"
                : actor.role === "staff"
                  ? "Staff review · Proposals and approvals"
                  : "Operator monitoring · Read only"
              : patientPortal
                ? "Sign in to manage your appointments"
                : "Choose your professional workspace"}
          </span>
        </div>
        <div className="account-options">
          {accountChoices.map((role) => (
            <button
              key={role}
              aria-pressed={actor?.role === role}
              disabled={busy || loading}
              className={actor?.role === role ? "selected" : ""}
              onClick={() => switchAccount(role)}
            >
              {role === "patient"
                ? "Sign in as demo patient"
                : role === "staff"
                  ? "Staff review"
                  : "Operator monitoring"}
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
        <section className="panel welcome" id="requests">
          <p className="eyebrow">
            {patientPortal ? "YOUR APPOINTMENT WORKSPACE" : "YOUR DEPARTMENT WORKSPACE"}
          </p>
          <h2>
            {patientPortal
              ? "A new time starts with a request."
              : "Turn patient requests into clear next steps."}
          </h2>
          <p>
            {patientPortal
              ? "Sign in with the fictional patient account to share your availability, review a proposed time, and confirm after your agreed callback."
              : "Use Staff review to propose and approve appointment times. Operator monitoring provides a read-only overview of callbacks, outstanding actions, and booking outcomes."}
          </p>
          <p className="muted" id="phone">
            {patientPortal
              ? "Phone assistance is available after sign-in to help you follow progress or request a callback."
              : "Phone activity and handovers appear after sign-in. Patients make their own confirmations in the separate patient portal."}
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
          <section className="stats" id="requests" aria-label="Overview">
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
                <span>
                  {patientPortal
                    ? "Your current appointment"
                    : "Current appointment · Demo patient"}
                </span>
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
              <div id="phone">
                <PhonePanel
                  key={`${actor.id}:${creating ? "new" : selectedId}`}
                  actor={actor}
                  taskId={creating ? undefined : selected?.task.id}
                  portal={portal}
                />
              </div>
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
