"use client";
import { useEffect, useRef, useState } from "react";
import {
  clock,
  journey,
  minutesText,
  stageNames,
  stepNames,
  type PatientDetail,
} from "../lib/journey";
import { Icon } from "./journey-icons";

const REFRESH_MS = 3000;
const flagNames: Record<string, string> = {
  confidential: "Confidential",
  vip: "Protected",
  security: "Security alert",
  deceased: "Deceased",
  critical: "Critical",
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
const taskNames: Record<string, string> = {
  recheck: "Recheck",
  leaving: "Thinking of leaving",
  question: "Question",
  interpreter: "Interpreter",
  comfort: "Comfort",
};
const scopeText = (scopes: string[]) =>
  scopes.includes("estimates") ? "steps and wait estimates" : "steps only";

/**
 * One patient's visit, opened from the Desk. A native dialog, so focus is trapped,
 * Escape closes it and the page behind is inert without any extra code.
 */
export default function PatientDrawer({
  encounterId,
  onClose,
}: {
  encounterId: string | null;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<PatientDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (encounterId && !element.open) element.showModal();
    if (!encounterId && element.open) element.close();
  }, [encounterId]);

  useEffect(() => {
    if (!encounterId) return;
    let active = true;
    setDetail(null);
    setError("");
    const refresh = async () => {
      try {
        const next = await journey.patient(encounterId);
        if (active) {
          setDetail(next);
          setError("");
        }
      } catch {
        if (active) setError("This visit can't be loaded right now.");
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [encounterId]);

  return (
    <dialog
      ref={dialog}
      className="vc-drawer"
      aria-labelledby="vc-drawer-title"
      onClose={onClose}
      // A click on the backdrop lands on the dialog itself, not on its panel.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="vc-drawer-panel">
        <header className="vc-drawer-head">
          <div>
            <p className="vc-eyebrow">{detail ? `Visit ${detail.visitNumber}` : "Patient"}</p>
            <h2 id="vc-drawer-title">{detail?.name ?? "Loading"}</h2>
          </div>
          <button className="vc-btn" data-kind="quiet" data-size="sm" onClick={onClose}>
            Close
          </button>
        </header>
        {error && (
          <p className="vc-note" role="alert">
            <Icon name="alert" size={20} />
            {error}
          </p>
        )}
        {!detail && !error && <div className="vc-skeleton" aria-label="Loading the visit" />}
        {detail && <Detail detail={detail} />}
      </div>
    </dialog>
  );
}

function Detail({ detail }: { detail: PatientDetail }) {
  const silenced = detail.flags.length > 0 || detail.unmapped;
  return (
    <div className="vc-drawer-body">
      <dl className="vc-facts">
        <div>
          <dt>Step</dt>
          <dd>{stepNames[detail.step] ?? detail.step}</dd>
        </div>
        <div>
          <dt>Triage</dt>
          <dd>
            {detail.ctas ? (
              <span className="vc-level" data-level={detail.ctas}>
                {detail.ctas}
              </span>
            ) : (
              "Not yet"
            )}
          </dd>
        </div>
        <div>
          <dt>Age</dt>
          <dd>{detail.age ?? "–"}</dd>
        </div>
        <div>
          <dt>Stream</dt>
          <dd>{detail.stream === "rapid_assessment" ? "Rapid assessment" : "Main"}</dd>
        </div>
        <div>
          <dt>Area</dt>
          <dd>{detail.area ?? "–"}</dd>
        </div>
        <div>
          <dt>{detail.ended ? "Time in department" : "In department"}</dt>
          <dd>
            {detail.minutesInDepartment === null ? "–" : minutesText(detail.minutesInDepartment)}
          </dd>
        </div>
      </dl>

      {(silenced || detail.consultRequested || detail.bedRequested || detail.testsInProgress) && (
        <div className="vc-chips">
          {detail.flags.map((flag) => (
            <span key={flag} className="vc-chip" data-tone="danger">
              <Icon name="shield" size={16} />
              {flagNames[flag] ?? flag}
            </span>
          ))}
          {detail.unmapped && (
            <span className="vc-chip" data-tone="danger">
              <Icon name="alert" size={16} />
              Feed message needs review
            </span>
          )}
          {detail.testsInProgress && (
            <span className="vc-chip">
              <Icon name="flask" size={16} />
              Tests underway
            </span>
          )}
          {detail.consultRequested && <span className="vc-chip">Consult requested</span>}
          {detail.bedRequested && <span className="vc-chip">Bed requested</span>}
        </div>
      )}
      {silenced && (
        <p className="vc-muted">
          Silenced: the patient and their contacts get only the standard handoff, and the agent is
          not asked about this visit.
        </p>
      )}

      <section aria-labelledby="vc-steps-title">
        <h3 id="vc-steps-title">Steps</h3>
        <ol className="vc-steps vc-steps-compact">
          {detail.steps.map((step, index) => (
            <li
              key={step.label}
              data-state={step.state}
              aria-current={step.state === "now" ? "step" : undefined}
            >
              <span className="vc-dot">
                {step.state === "done" ? <Icon name="check" size={16} /> : index + 1}
              </span>
              {step.label}
              <em>{step.at ? clock(step.at) : step.state === "done" ? "Skipped" : ""}</em>
            </li>
          ))}
        </ol>
        {detail.testsStartedWaiting && (
          <p className="vc-muted">
            Tests started in the waiting room at {clock(detail.testsStartedWaiting)}, before the
            patient was seen.
          </p>
        )}
      </section>

      {(detail.estimates.length > 0 || detail.minutesWaiting !== null) && (
        <section aria-labelledby="vc-est-title">
          <h3 id="vc-est-title">What the model expects</h3>
          {detail.minutesWaiting !== null && (
            <p className="vc-muted">Waiting {minutesText(detail.minutesWaiting)} since triage.</p>
          )}
          <ul className="vc-est">
            {detail.estimates.map((item) => (
              <li key={item.stage}>
                <span>{stageNames[item.stage]}</span>
                <strong>about {minutesText(item.typicalMinutes)}</strong>
                <span className="vc-muted">
                  {minutesText(item.lowMinutes)} to {minutesText(item.highMinutes)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.published.length > 0 && (
        <section aria-labelledby="vc-told-title">
          <h3 id="vc-told-title">Ranges the patient was told</h3>
          <ul className="vc-told">
            {detail.published.map((item, index) => {
              const held =
                item.actual === null || item.high === null || item.low === null
                  ? null
                  : item.actual >= item.low && item.actual <= item.high;
              return (
                <li key={index}>
                  <time dateTime={item.at}>{clock(item.at)}</time>
                  <span>
                    {item.abstain
                      ? "Too busy to estimate"
                      : `Within ${minutesText(item.high ?? 0)}`}
                  </span>
                  <span className="vc-muted">
                    {item.actual === null
                      ? "still waiting"
                      : `seen after ${minutesText(item.actual)} · ${held ? "held" : "missed"}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-labelledby="vc-timeline-title">
        <h3 id="vc-timeline-title">From the hospital record</h3>
        <ol className="vc-timeline">
          {detail.timeline.map((event, index) => (
            <li key={index} data-kind={event.kind}>
              <time dateTime={event.at}>{clock(event.at)}</time>
              <span>{event.label}</span>
              {event.source === "staff" && <span className="vc-muted">by staff</span>}
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="vc-people-title">
        <h3 id="vc-people-title">Who gets updates</h3>
        {detail.contacts.length === 0 ? (
          <p className="vc-muted">Nobody added yet.</p>
        ) : (
          <ul className="vc-people">
            {detail.contacts.map((contact) => (
              <li key={contact.id}>
                <strong>{contact.name}</strong>
                <span className="vc-muted">
                  {contact.relationship} · {scopeText(contact.scopes)}
                  {contact.texts ? " · texts on" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail.tasks.length > 0 && (
        <section aria-labelledby="vc-tasks-title">
          <h3 id="vc-tasks-title">Desk tasks</h3>
          <ul className="vc-people">
            {detail.tasks.map((task) => (
              <li key={task.id}>
                <strong>
                  {taskNames[task.kind] ?? task.kind} ·{" "}
                  {task.state === "open" ? "open" : task.state === "done" ? "done" : "not needed"}
                </strong>
                <span className="vc-muted">{task.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.runs.length > 0 && (
        <section aria-labelledby="vc-agent-title">
          <h3 id="vc-agent-title">Visit Agent</h3>
          <ul className="vc-people">
            {detail.runs.map((run) => {
              const done = run.plan.filter((step) => step.verdict === "done");
              const refused = run.plan.length - done.length;
              return (
                <li key={run.id}>
                  <strong>
                    {wakeNames[run.wake] ?? run.wake} · {clock(run.at)}
                  </strong>
                  <span className="vc-muted">
                    {run.planner === "model" ? "Model" : "Rules"}:{" "}
                    {[...new Set(done.map((step) => toolNames[step.tool] ?? step.tool))].join(
                      ", ",
                    ) || "nothing sent"}
                    {refused ? `, ${refused} refused by the Guardian` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {detail.messages.length > 0 && (
        <section aria-labelledby="vc-msg-title">
          <h3 id="vc-msg-title">Messages</h3>
          <ul className="vc-wire">
            {detail.messages.map((message) => (
              <li key={message.id} data-from={message.direction}>
                <small>
                  {message.direction === "in" ? "From" : "To"}{" "}
                  {message.audience === "patient"
                    ? "the patient"
                    : (message.relationship ?? "contact").toLowerCase()}{" "}
                  · {message.channel === "sms" ? "text" : message.channel} · {clock(message.at)}
                </small>
                {message.body}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
