"use client";

import { useState, type FormEvent } from "react";
import {
  date,
  inputDate,
  labels,
  windowInput,
  type Actor,
  type Progress,
  type Slot,
} from "../lib/ui";

type Props = {
  progress: Progress;
  actor: Actor;
  slots: Slot[];
  busy: boolean;
  command: (action: string, input?: Record<string, unknown>) => Promise<void>;
};
const mutable = new Set([
  "awaiting_proposal",
  "awaiting_staff_approval",
  "awaiting_patient_confirmation",
  "ready_to_execute",
]);
const closed = new Set(["completed", "withdrawn", "staff_takeover"]);

export default function RequestDetail({ progress, actor, slots, busy, command }: Props) {
  const { task, workflow, activeProposal: proposal } = progress;
  const requester = actor.id === task.requesterId;
  const staff = actor.role === "staff";
  const [slotId, setSlotId] = useState("");
  const [callbackStart, setCallbackStart] = useState(() => inputDate());
  const [callbackEnd, setCallbackEnd] = useState(() => inputDate(Date.now() + 3_600_000));
  const available = slots.filter(
    (slot) =>
      slot.available &&
      workflow &&
      Date.parse(slot.startsAt) >= Date.parse(workflow.availability.startsAt) &&
      Date.parse(slot.endsAt) <= Date.parse(workflow.availability.endsAt),
  );
  const slot = available.find((item) => item.id === slotId);
  const hasCallback = proposal && workflow?.callbackDelivered?.version === proposal.version;
  const windowOpen =
    workflow &&
    Date.parse(workflow.callbackWindow.startsAt) <= Date.now() &&
    Date.parse(workflow.callbackWindow.endsAt) > Date.now();
  const phase =
    task.state === "completed"
      ? 5
      : ["ready_to_execute", "executing", "reconciling"].includes(task.state)
        ? 4
        : task.state === "awaiting_patient_confirmation"
          ? 3
          : task.state === "awaiting_staff_approval"
            ? 2
            : task.state === "awaiting_proposal"
              ? 1
              : 0;
  async function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (slot && workflow)
      await command("proposals", { slotId: slot.id, expiresAt: workflow.callbackWindow.endsAt });
  }
  const decide = (kind: string, response: string) =>
    command(kind, {
      proposalVersion: proposal?.version,
      response,
      evidenceRef: `web:${crypto.randomUUID()}`,
    });
  return (
    <section className="panel detail" aria-labelledby="request-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">REQUEST DETAILS</p>
          <h2 id="request-heading">{task.summary}</h2>
          {progress.patient?.displayName && (
            <p className="muted">{progress.patient.displayName} · Fictional patient</p>
          )}
        </div>
        <span className={`status ${task.state === "completed" ? "success" : ""}`}>
          {labels[task.state]}
        </span>
      </div>
      <ol className="steps" aria-label="Request progress">
        {["Verify", "Propose", "Staff review", "Confirm", "Book"].map((label, index) => (
          <li
            key={label}
            className={index < phase ? "done" : index === phase ? "current" : ""}
            aria-current={index === phase ? "step" : undefined}
          >
            <span>{index < phase ? "✓" : index + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <div className={`next-action ${task.state === "completed" ? "complete" : ""}`} role="status">
        <p className="eyebrow">{task.state === "completed" ? "CONFIRMED OUTCOME" : "NEXT STEP"}</p>
        <p>{task.nextAction}</p>
        {progress.operation?.result?.confirmationRef && (
          <p className="reference">Confirmation: {progress.operation.result.confirmationRef}</p>
        )}
      </div>
      {workflow && (
        <dl className="facts">
          <div>
            <dt>Requested availability</dt>
            <dd>
              {date(workflow.availability.startsAt)}
              <br />
              <span className="muted">until {date(workflow.availability.endsAt)}</span>
            </dd>
          </div>
          <div>
            <dt>Agreed callback window</dt>
            <dd>
              {date(workflow.callbackWindow.startsAt)}
              <br />
              <span className="muted">until {date(workflow.callbackWindow.endsAt)}</span>
            </dd>
          </div>
        </dl>
      )}
      {proposal && (
        <div className="proposal">
          <div>
            <p className="eyebrow">PROPOSED APPOINTMENT · VERSION {proposal.version}</p>
            <h3>{date(proposal.startsAt)}</h3>
            <p className="muted">Decision due {date(proposal.expiresAt)}</p>
          </div>
          <div className="decision-list">
            {progress.actions
              .filter((action) => action.proposalVersion === proposal.version)
              .map((action) => (
                <span key={action.id}>
                  {action.kind === "staff_approval" ? "Staff" : "Patient"}:{" "}
                  <strong>{action.status}</strong>
                </span>
              ))}
          </div>
        </div>
      )}
      <div className="actions">
        {requester && task.state === "awaiting_verification" && (
          <button className="primary" disabled={busy} onClick={() => command("verify")}>
            Verify my request
          </button>
        )}
        {staff && workflow && mutable.has(task.state) && (
          <form onSubmit={propose} className="proposal-form">
            <label>
              Available time within this request
              <select
                aria-label="Proposed appointment"
                value={slotId}
                onChange={(event) => setSlotId(event.target.value)}
                disabled={busy}
              >
                <option value="">Choose a proposal time</option>
                {slotId && !slot && (
                  <option value={slotId}>Selected time is unavailable — choose again</option>
                )}
                {!available.length && <option value="">No matching slots available</option>}
                {available.map((item) => (
                  <option key={item.id} value={item.id}>
                    {date(item.startsAt)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primary"
              disabled={busy || !slot || Date.parse(workflow.callbackWindow.endsAt) <= Date.now()}
            >
              {proposal ? "Replace proposal" : "Propose appointment"}
            </button>
          </form>
        )}
        {staff && proposal && task.state === "awaiting_staff_approval" && (
          <>
            <button
              className="primary"
              disabled={busy}
              onClick={() => decide("staff-approval", "approve")}
            >
              Approve proposal
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => decide("staff-approval", "reject")}
            >
              Reject proposal
            </button>
          </>
        )}
        {requester && proposal && task.state === "awaiting_patient_confirmation" && (
          <div className="confirmation">
            <p>
              {hasCallback
                ? "Your agreed callback has been delivered. Review the proposed appointment before confirming."
                : "Waiting for your agreed callback. This page updates automatically."}
            </p>
            <button
              className="primary"
              disabled={busy || !hasCallback || !windowOpen}
              onClick={() => decide("confirmation", "approve")}
            >
              Confirm appointment
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => decide("confirmation", "reject")}
            >
              Decline proposal
            </button>
          </div>
        )}
        {requester &&
          workflow &&
          (mutable.has(task.state) || task.state === "awaiting_verification") && (
            <details className="callback-settings">
              <summary>Change callback window</summary>
              <p className="hint">
                Changing the window requires a new proposal and fresh approvals.
              </p>
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  await command("callback", {
                    callbackWindow: windowInput(callbackStart, callbackEnd),
                  });
                }}
              >
                <div className="field-pair">
                  <label>
                    New callback starts (UTC)
                    <input
                      aria-label="New callback starts (UTC)"
                      type="datetime-local"
                      required
                      value={callbackStart}
                      onChange={(event) => setCallbackStart(event.target.value)}
                    />
                  </label>
                  <label>
                    New callback ends (UTC)
                    <input
                      aria-label="New callback ends (UTC)"
                      type="datetime-local"
                      required
                      min={callbackStart}
                      value={callbackEnd}
                      onChange={(event) => setCallbackEnd(event.target.value)}
                    />
                  </label>
                </div>
                <button className="secondary" disabled={busy}>
                  Save callback window
                </button>
              </form>
            </details>
          )}
        {!closed.has(task.state) && (requester || staff) && (
          <button
            className="quiet danger"
            disabled={busy}
            onClick={() =>
              command(staff ? "takeover" : "withdraw", {
                evidenceRef: `web:${crypto.randomUUID()}`,
              })
            }
          >
            {staff ? "Take over request" : "Withdraw request"}
          </button>
        )}
      </div>
      <div className="history">
        <h3>Activity</h3>
        <ol>
          {[...progress.events].reverse().map((event) => (
            <li key={event.id}>
              <span className="timeline-dot" />
              <div>
                <strong>{event.action.replaceAll("_", " ")}</strong>
                {event.actorDisplayName && <span>{event.actorDisplayName}</span>}
                <time dateTime={event.occurredAt}>{date(event.occurredAt)}</time>
              </div>
            </li>
          ))}
        </ol>
      </div>
      {!!progress.jobs.length && (
        <details>
          <summary>Callbacks & reminders ({progress.jobs.length})</summary>
          <ul className="job-list">
            {progress.jobs.map((job) => (
              <li key={job.id}>
                <strong>{job.kind}</strong> · {job.status} · {date(job.dueAt)}
                {job.lastError && <span> · {job.lastError.replaceAll("_", " ")}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="reference">
        {task.id} · Revision {task.revision}
      </p>
    </section>
  );
}
