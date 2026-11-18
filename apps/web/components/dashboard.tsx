"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Task } from "@prc/contracts";
import { api, date, labels, type Actor, type Progress, type Slot } from "../lib/ui";
import { closedStates, enterWorkspace, orderRequests } from "../lib/workspace";
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
  const [selectedId, setSelectedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("all");
  const [retry, setRetry] = useState(0);
  const refreshId = useRef(0);
  const refresh = useCallback(async () => {
    if (!actor) return;
    const version = ++refreshId.current;
    const [requests, availability] = await Promise.all([
      api<{ tasks: Progress[] }>("/api/backend/tasks", undefined, undefined, portal),
      api<{ slots: Slot[] }>(
        "/api/backend/slots?patientId=synthetic-patient-001",
        undefined,
        undefined,
        portal,
      ),
    ]);
    if (version !== refreshId.current) return;
    const ordered = orderRequests(requests.tasks);
    setTasks(ordered);
    setSlots(availability.slots);
    setLoading(false);
    setSelectedId((id) =>
      ordered.some((item) => item.task.id === id) ? id : (ordered[0]?.task.id ?? ""),
    );
  }, [actor, portal]);
  useEffect(() => {
    let active = true;
    const requested = new URLSearchParams(window.location.search).get("request");
    if (requested && /^[A-Za-z0-9-]+$/.test(requested)) setSelectedId(requested);
    setLoading(true);
    setError("");
    enterWorkspace(portal, !patientPortal)
      .then((person) => {
        if (active) setActor(person);
      })
      .catch((cause) => {
        if (active) {
          setError(cause.message);
          setLoading(false);
        }
      });
    return () => {
      active = false;
      refreshId.current++;
    };
  }, [portal, patientPortal, retry]);
  useEffect(() => {
    if (!actor || busy) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function sync() {
      try {
        await refresh();
      } catch (cause) {
        if (active) {
          setError((cause as Error).message);
          setLoading(false);
        }
      }
      if (active) timer = setTimeout(sync, 3000);
    }
    void sync();
    return () => {
      active = false;
      refreshId.current++;
      clearTimeout(timer);
    };
  }, [actor, refresh, busy]);
  const selected = tasks.find((item) => item.task.id === selectedId);
  const bookings = [
    ...new Map(
      tasks.flatMap((item) => (item.booking ? [[item.booking.id, item.booking] as const] : [])),
    ).values(),
  ];
  const upcoming = [...bookings]
    .filter((booking) => Date.parse(booking.startsAt) > Date.now())
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))[0];
  const patientName = tasks.find((item) => item.patient?.displayName)?.patient?.displayName;
  const filtered = tasks.filter(
    (item) =>
      (stage === "all" ||
        (stage === "open" ? !closedStates.has(item.task.state) : item.task.state === stage)) &&
      [item.task.summary, item.patient?.displayName ?? "", labels[item.task.state]].some((value) =>
        value.toLowerCase().includes(query.toLowerCase().trim()),
      ),
  );
  async function mutate(path: string, input: unknown, created = false) {
    setBusy(true);
    setError("");
    setNotice("");
    refreshId.current++;
    try {
      const result = await api<Task>(`/api/backend/${path}`, input, "POST", portal);
      setSelectedId(result.id);
      if (created) {
        setCreating(false);
        setStage("all");
        setQuery("");
      }
      setNotice(
        created
          ? "Request saved. Check the details, then verify it for your care team."
          : "Your action is saved. The latest next step is below.",
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
      <PortalHeader
        portal={portal}
        requestId={selected?.task.id}
        patientId={selected?.task.patientId}
      />
      <section className="workspace-heading" id="workspace-main">
        <div>
          <p className="eyebrow">
            {patientPortal ? "Your appointment workspace" : "Fictional outpatient clinic"}
          </p>
          <h1>
            {patientPortal
              ? patientName
                ? `Hello, ${patientName.split(" ")[0]}.`
                : "Your appointments"
              : "Care team workspace"}
          </h1>
          <p>
            {patientPortal
              ? "Your appointment, your next step. Follow each change here."
              : "Review requests, agree a time, and keep every next step clear."}
          </p>
        </div>
        {actor && (
          <div className="workspace-heading-actions">
            {patientPortal ? (
              <button
                className="primary"
                onClick={() => {
                  setCreating(true);
                  setNotice("");
                }}
                disabled={busy}
              >
                New appointment request
              </button>
            ) : (
              <Link className="button-link" href="/professional/team">
                Care-team directory →
              </Link>
            )}
          </div>
        )}
      </section>
      {error && (
        <div role="alert" className="alert">
          <span>{error}</span>
          <button
            className="quiet"
            onClick={() => {
              setError("");
              actor
                ? void refresh().catch((cause) => setError(cause.message))
                : setRetry((value) => value + 1);
            }}
          >
            Retry connection
          </button>
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <section className="panel workspace-loading" role="status">
          <span className="loading-bar" />
          Opening your workspace…
        </section>
      ) : !actor ? (
        <section className="panel empty">
          <h2>Workspace unavailable</h2>
          <p>Please retry above. If access has expired, ask the demo host to refresh it.</p>
        </section>
      ) : (
        <>
          <section
            className="workspace-summary"
            aria-label={patientPortal ? "Your next appointment" : "Department summary"}
          >
            {patientPortal ? (
              <>
                <div>
                  <span>Next scheduled appointment</span>
                  <strong>
                    {upcoming
                      ? date(upcoming.startsAt)
                      : "No upcoming appointment in your requests"}
                  </strong>
                </div>
                <a href="#phone">Phone assistance ↗</a>
              </>
            ) : (
              <>
                <div>
                  <span>Open requests</span>
                  <strong>
                    {tasks.filter((item) => !closedStates.has(item.task.state)).length}
                  </strong>
                </div>
                <div>
                  <span>Need a proposal</span>
                  <strong>
                    {tasks.filter((item) => item.task.state === "awaiting_proposal").length}
                  </strong>
                </div>
                <div>
                  <span>Staff approval</span>
                  <strong>
                    {tasks.filter((item) => item.task.state === "awaiting_staff_approval").length}
                  </strong>
                </div>
                <div>
                  <span>Waiting on patient</span>
                  <strong>
                    {
                      tasks.filter((item) => item.task.state === "awaiting_patient_confirmation")
                        .length
                    }
                  </strong>
                </div>
              </>
            )}
          </section>
          <div className="workspace" id="requests">
            <aside className="request-list" aria-label="Request list">
              <div className="list-heading">
                <h2>{patientPortal ? "Your requests" : "Department queue"}</h2>
                <span className="count-label">{tasks.length}</span>
              </div>
              <label className="queue-search">
                <span className="visually-hidden">Search requests</span>
                <input
                  type="search"
                  placeholder={patientPortal ? "Search your requests" : "Search patient or request"}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <label className="queue-filter">
                <span className="visually-hidden">Filter request stage</span>
                <select value={stage} onChange={(event) => setStage(event.target.value)}>
                  <option value="all">All stages · {tasks.length}</option>
                  <option value="open">Open requests</option>
                  {Object.entries(labels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label} · {tasks.filter((item) => item.task.state === value).length}
                    </option>
                  ))}
                </select>
              </label>
              <div className="request-scroll">
                {!filtered.length && (
                  <div className="queue-empty">
                    <p>
                      {tasks.length
                        ? "No requests match this search."
                        : "Your new requests will appear here."}
                    </p>
                    {tasks.length > 0 && (
                      <button
                        className="quiet"
                        onClick={() => {
                          setQuery("");
                          setStage("all");
                        }}
                      >
                        Clear filters
                      </button>
                    )}
                  </div>
                )}
                {filtered.map((item) => (
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
                    {!patientPortal && (
                      <span className="request-patient">
                        {item.patient?.displayName ?? "Fictional patient"}
                      </span>
                    )}
                    <strong>{item.task.summary}</strong>
                    <small>
                      {item.task.id === "T001" ? "Starter template" : date(item.task.updatedAt)}
                    </small>
                  </button>
                ))}
              </div>
              <p className="hint">Saved changes update automatically.</p>
            </aside>
            <div className="content">
              {creating && patientPortal ? (
                <RequestForm
                  slots={slots}
                  bookings={bookings}
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
                  <h2>{tasks.length ? "Select a request" : "Start with an appointment request"}</h2>
                  <p>
                    {patientPortal
                      ? "Choose New appointment request above to share a preferred time."
                      : "Patient requests appear here when saved."}
                  </p>
                </section>
              )}
              <div id="phone">
                <PhonePanel
                  bookings={bookings}
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
        <span>VeriCare</span>
        <span>Fictional demo · Appointment times in Halifax time</span>
      </footer>
    </main>
  );
}
