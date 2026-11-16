"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clock,
  journey,
  minutesText,
  stageNames,
  stepNames,
  type Desk,
  type DeskPatient,
  type DeskTask,
} from "../lib/journey";
import { enterWorkspace } from "../lib/workspace";
import { Icon, type IconName } from "./journey-icons";

const REFRESH_MS = 2000;
const taskLook: Record<DeskTask["kind"], { icon: IconName; label: string }> = {
  recheck: { icon: "alert", label: "Recheck patient" },
  leaving: { icon: "door", label: "Thinking of leaving" },
  question: { icon: "chat", label: "Question" },
  interpreter: { icon: "globe", label: "Interpreter" },
  comfort: { icon: "heart", label: "Comfort" },
};
const priorityWord = { 1: "Now", 2: "Soon", 3: "When free" } as const;
const actions: Record<string, string> = {
  feed_message: "Feed message applied",
  visit_silenced: "Visit silenced",
  step_update_allow: "Step update sent",
  step_update_handoff: "Step update withheld",
  step_update_neutral: "Step update withheld",
  status_request_allow: "Status shared",
  status_request_handoff: "Status withheld",
  consent_given: "Consent given",
  consent_withdrawn: "Consent withdrawn",
  flag_set: "Flag set",
  flag_cleared: "Flag cleared",
  task_recheck: "Recheck raised",
  task_leaving: "Leaving alert raised",
  task_question: "Question relayed",
  task_interpreter: "Interpreter requested",
  task_closed_done: "Task done",
  task_closed_not_needed: "Task not needed",
  task_comfort: "Comfort request raised",
  agent_run: "Visit Agent decided",
  voice_status_allow: "Status shared by phone",
  voice_status_handoff: "Phone status withheld",
  voice_status_neutral: "Phone status withheld",
};
const wakeNames: Record<string, string> = {
  step_change: "Step changed",
  estimate_shift: "Estimate moved",
  check_in_due: "Check-in due",
  inbound_message: "Patient wrote in",
  contact_question: "Family wrote in",
};
const toolNames: Record<string, string> = {
  notify: "sent an update",
  ask_check_in: "asked how they feel",
  open_staff_task: "put it on the Desk",
  answer_from_kb: "answered from the knowledge base",
  handoff: "handed off to staff",
  schedule_wake: "will check in later",
  do_nothing: "held back",
};

export default function EdDesk() {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const ready = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setDesk(await journey.desk());
      setError("");
    } catch {
      setError("The Desk can't reach the server. Showing the last update.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    enterWorkspace("professional", true)
      .then(() => {
        ready.current = true;
        if (active) void refresh();
      })
      .catch(() => {
        if (active) setError("The staff demo account isn't available right now.");
      });
    const timer = window.setInterval(() => {
      if (ready.current && document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const run = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await work();
      await refresh();
    } catch {
      setError("That action didn't go through. Please try again.");
    } finally {
      setBusy("");
    }
  };

  const waiting = desk?.patients.filter((patient) => patient.step === "waiting") ?? [];
  const accuracy = desk?.accuracy ?? { total: 0, inside: 0, over: 0 };
  const coverage = accuracy.total ? Math.round((accuracy.inside / accuracy.total) * 100) : null;

  return (
    <div className="vc">
      <header className="vc-bar">
        <Link href="/" className="vc-brand">
          <span className="vc-brand-mark">
            <Icon name="heart" size={20} />
          </span>
          <span>
            VeriCare Desk
            <small>Halifax Infirmary Emergency</small>
          </span>
        </Link>
        {desk?.feed ? (
          <span className="vc-live" data-state={desk.feed.stale ? "stale" : "live"}>
            <i aria-hidden="true" />
            {desk.feed.stale ? "OPOR feed stale" : "OPOR feed live"} · department clock{" "}
            {clock(desk.feed.feedTime)}
          </span>
        ) : (
          <span className="vc-live" data-state="stale">
            <i aria-hidden="true" />
            Waiting for the OPOR feed
          </span>
        )}
      </header>

      <main className="vc-desk" id="workspace-main">
        <div className="vc-desk-head">
          <div>
            <p className="vc-eyebrow">Emergency department</p>
            <h1>Who needs a person now</h1>
          </div>
          <nav className="vc-desk-links" aria-label="Related screens">
            <Link
              href="/professional/ed/accuracy"
              className="vc-btn"
              data-kind="quiet"
              data-size="sm"
            >
              Estimate accuracy
            </Link>
            <Link
              href="/professional/ed/mission"
              className="vc-btn"
              data-kind="quiet"
              data-size="sm"
            >
              Mission control
            </Link>
            <Link href="/patient/visit" className="vc-btn" data-kind="quiet" data-size="sm">
              Patient view
              <Icon name="arrow" size={18} />
            </Link>
          </nav>
        </div>
        {error && (
          <p className="vc-note" role="alert">
            <Icon name="alert" size={20} />
            {error}
          </p>
        )}

        <section className="vc-stats" aria-label="Department summary">
          <div className="vc-card vc-stat">
            <span>Needs a person</span>
            <strong>{desk?.tasks.length ?? "–"}</strong>
            <small>
              {desk?.tasks.filter((task) => task.priority === 1).length ?? 0} marked now
            </small>
          </div>
          <div className="vc-card vc-stat">
            <span>Waiting to be seen</span>
            <strong>{desk ? waiting.length : "–"}</strong>
            <small>
              Longest{" "}
              {waiting.length
                ? minutesText(Math.max(...waiting.map((patient) => patient.waitingMinutes ?? 0)))
                : "–"}
            </small>
          </div>
          <div className="vc-card vc-stat">
            <span>In the department</span>
            <strong>{desk?.patients.length ?? "–"}</strong>
            <small>
              {desk?.patients.filter((patient) => patient.flags.length || patient.unmapped)
                .length ?? 0}{" "}
              silenced
            </small>
          </div>
          <div className="vc-card vc-stat">
            <span>Estimates that held</span>
            <strong>{coverage === null ? "–" : `${coverage}%`}</strong>
            <div className="vc-meter" aria-hidden="true">
              <i style={{ width: `${coverage ?? 0}%` }} />
            </div>
            <small>
              {accuracy.inside} of {accuracy.total} inside the range, {accuracy.over} ran over
            </small>
            {(desk?.stageAccuracy.length ?? 0) > 0 && (
              <small>
                By step:{" "}
                {desk!.stageAccuracy
                  .map((row) => `${stageNames[row.stage].toLowerCase()} ${row.inside}/${row.total}`)
                  .join(", ")}
              </small>
            )}
          </div>
        </section>

        <div className="vc-desk-grid">
          <section className="vc-queue" aria-label="Tasks from patients and families">
            {desk && desk.tasks.length === 0 && (
              <div className="vc-card vc-empty">
                <Icon name="check" size={28} />
                <p>Nobody is waiting on you. New requests appear here on their own.</p>
              </div>
            )}
            {desk?.tasks.map((task) => (
              <article className="vc-card vc-task" key={task.id} data-priority={task.priority}>
                <div className="vc-task-top">
                  <span
                    className="vc-chip"
                    data-tone={
                      task.priority === 1 ? "danger" : task.priority === 2 ? "warn" : "plain"
                    }
                  >
                    <Icon name={taskLook[task.kind].icon} size={16} />
                    {taskLook[task.kind].label} · {priorityWord[task.priority]}
                  </span>
                  <time className="vc-muted" dateTime={task.createdAt}>
                    {clock(task.createdAt)}
                  </time>
                </div>
                <strong>{task.patientName}</strong>
                <p>{task.summary}</p>
                <div className="vc-task-actions">
                  <button
                    className="vc-btn"
                    data-size="sm"
                    disabled={busy === task.id}
                    onClick={() => run(task.id, () => journey.closeTask(task.id, "done"))}
                  >
                    <Icon name="check" size={18} />
                    Done
                  </button>
                  <button
                    className="vc-btn"
                    data-kind="quiet"
                    data-size="sm"
                    disabled={busy === task.id}
                    onClick={() => run(task.id, () => journey.closeTask(task.id, "not_needed"))}
                  >
                    Not needed
                  </button>
                </div>
              </article>
            ))}
          </section>

          <section className="vc-card vc-section" aria-label="Patients in the department">
            <div className="vc-section-head">
              <Icon name="list" />
              <h2>In the department</h2>
            </div>
            <div className="vc-table-wrap">
              <table className="vc-table">
                <thead>
                  <tr>
                    <th scope="col">Patient</th>
                    <th scope="col">Triage</th>
                    <th scope="col">Step</th>
                    <th scope="col">Waiting</th>
                    <th scope="col">Told</th>
                    <th scope="col">Model estimate</th>
                    <th scope="col">Privacy</th>
                  </tr>
                </thead>
                <tbody>
                  {desk?.patients.map((patient) => (
                    <PatientRow
                      key={patient.id}
                      patient={patient}
                      busy={busy === patient.id}
                      toggle={(active) =>
                        run(patient.id, () => journey.setFlag(patient.id, "confidential", active))
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <section className="vc-card vc-section" aria-label="Visit Agent log">
          <div className="vc-section-head">
            <Icon name="pulse" />
            <h2>What the Visit Agent decided</h2>
          </div>
          <p className="vc-muted">
            Each visit has an agent that chooses which approved message to send, or to send none. It
            cannot write facts or numbers, and code checks every choice.
          </p>
          <ul className="vc-ledger">
            {desk?.agent.runs.map((item) => {
              const done = item.plan.filter((step) => step.verdict === "done");
              const refused = item.plan.length - done.length;
              const said = done.find((step) => step.why && !step.why.startsWith("Floor"))?.why;
              return (
                <li key={item.id}>
                  <time dateTime={item.at}>{clock(item.at)}</time>
                  <code>{item.planner === "model" ? "model" : "rules"}</code>
                  <span>
                    <strong>{wakeNames[item.wake] ?? item.wake}</strong> · {item.patientName}:{" "}
                    {[...new Set(done.map((step) => toolNames[step.tool] ?? step.tool))].join(
                      ", ",
                    ) || "nothing sent"}
                    {refused ? ` (${refused} refused by the Guardian)` : ""}
                    {item.planner === "model" && said ? ` — “${said}”` : ""}
                  </span>
                </li>
              );
            })}
            {desk && desk.agent.runs.length === 0 && (
              <li>
                <span />
                <span />
                <span className="vc-muted">No decisions yet.</span>
              </li>
            )}
          </ul>
        </section>

        <section className="vc-card vc-section" aria-label="Audit ledger">
          <div className="vc-section-head">
            <Icon name="shield" />
            <h2>Ledger</h2>
          </div>
          <p className="vc-muted">
            Every feed message, disclosure decision and staff action, newest first. Each entry is
            chained to the one before it, so changes would show.
          </p>
          <ul className="vc-ledger">
            {desk?.ledger.map((entry) => (
              <li key={entry.seq}>
                <time dateTime={entry.at}>{clock(entry.at)}</time>
                <code>{entry.actor.length > 14 ? "staff" : entry.actor}</code>
                <span>
                  {actions[entry.action] ?? entry.action}
                  {entry.patientName ? ` · ${entry.patientName}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}

function PatientRow({
  patient,
  busy,
  toggle,
}: {
  patient: DeskPatient;
  busy: boolean;
  toggle: (active: boolean) => void;
}) {
  const silenced = patient.flags.length > 0 || patient.unmapped;
  const confidential = patient.flags.includes("confidential");
  return (
    <tr data-silenced={silenced}>
      <td>
        <strong>{patient.name}</strong>
        {patient.stream === "rapid_assessment" && <div className="vc-muted">Rapid assessment</div>}
      </td>
      <td>
        {patient.ctas ? (
          <span className="vc-level" data-level={patient.ctas}>
            <span className="vc-sr">Triage level </span>
            {patient.ctas}
          </span>
        ) : (
          "–"
        )}
      </td>
      <td>
        {stepNames[patient.step] ?? patient.step}
        {patient.testsInProgress && <div className="vc-muted">Tests underway</div>}
      </td>
      <td>{patient.waitingMinutes === null ? "–" : minutesText(patient.waitingMinutes)}</td>
      <td>
        {silenced ? (
          <span className="vc-chip" data-tone="danger">
            <Icon name="shield" size={16} />
            Silenced
          </span>
        ) : patient.range ? (
          `Within ${minutesText(patient.range.highMinutes)}`
        ) : (
          "–"
        )}
      </td>
      <td>
        {patient.stages.length === 0
          ? "–"
          : patient.stages.map((item) => (
              <div key={item.stage} className="vc-stage-line">
                <span>{stageNames[item.stage]}</span> {minutesText(item.lowMinutes)} to{" "}
                {minutesText(item.highMinutes)}
              </div>
            ))}
      </td>
      <td>
        <button
          className="vc-btn"
          data-kind={confidential ? "danger-quiet" : "quiet"}
          data-size="sm"
          disabled={busy}
          aria-pressed={confidential}
          onClick={() => toggle(!confidential)}
        >
          {confidential ? "Clear confidential" : "Mark confidential"}
        </button>
      </td>
    </tr>
  );
}
