"use client";

import { useState } from "react";
import Link from "next/link";
import DesktopIcon from "./desktop-icon";
import { nextStep } from "../lib/workspace";
import { date, displayTimeZone, labels } from "../lib/ui";
import { readable, taskLink, type DesktopProgress, type DesktopSnapshot } from "../lib/desktop";

export function RequestInspector({ progress }: { progress?: DesktopProgress }) {
  if (!progress)
    return (
      <aside className="desk-card desk-inspector">
        <p className="eyebrow">REQUEST DETAILS</p>
        <h2>A closer look</h2>
        <p className="desk-muted">Select a request to see its next step, proposal and history.</p>
      </aside>
    );
  const { task, workflow, activeProposal, operation } = progress;
  const events = [...progress.events].sort(
    (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt),
  );
  return (
    <aside className="desk-card desk-inspector" aria-label="Selected request details">
      <div className="desk-section-heading">
        <p className="eyebrow">SELECTED REQUEST</p>
        <span className="desk-mini">{progress.patient?.displayName ?? "Fictional patient"}</span>
      </div>
      <h2>{task.summary}</h2>

      <div className="desk-next">
        <strong>Next step</strong>
        <p>{nextStep(progress)}</p>
      </div>
      {task.state === "completed" && operation?.result?.confirmationRef && (
        <div className="desk-evidence">
          <strong>Appointment change saved</strong>
          {progress.booking && <p>{date(progress.booking.startsAt)}</p>}
          <p>Demo scheduler receipt: {operation.result.confirmationRef}</p>
        </div>
      )}
      <dl className="desk-details">
        <div>
          <dt>Status</dt>
          <dd>{labels[task.state]}</dd>
        </div>
        <div>
          <dt>Patient</dt>
          <dd>{progress.patient?.displayName ?? task.patientId}</dd>
        </div>
        {activeProposal && (
          <div>
            <dt>Proposed appointment · v{activeProposal.version}</dt>
            <dd>{date(activeProposal.startsAt)}</dd>
          </div>
        )}
        {workflow && (
          <div>
            <dt>Callback window</dt>
            <dd>
              {date(workflow.callbackWindow.startsAt)}
              <br />
              to {date(workflow.callbackWindow.endsAt)}
            </dd>
          </div>
        )}
      </dl>
      <details className="desk-history" open>
        <summary>
          Request history <span>{events.length}</span>
        </summary>
        {events.length ? (
          <ol>
            {events.map((event) => (
              <li key={event.id}>
                <strong>{readable(event.action)}</strong>
                {event.actorDisplayName && (
                  <span className="desk-event-actor">{event.actorDisplayName}</span>
                )}
                <time dateTime={event.occurredAt}>{date(event.occurredAt)}</time>
              </li>
            ))}
          </ol>
        ) : (
          <p className="desk-muted">No recorded events.</p>
        )}
      </details>
      <Link className="desk-text-link" href={taskLink(task.id)}>
        Open in professional workspace <DesktopIcon name="external" />
      </Link>
    </aside>
  );
}

export function AppointmentPanel({ snapshot }: { snapshot: DesktopSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const bookings = [...snapshot.bookings].sort(
    (a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt),
  );
  return (
    <section className="desk-card" id="appointments" aria-labelledby="desk-appointments">
      <div className="desk-section-heading">
        <div>
          <p className="eyebrow">SCHEDULER</p>
          <h2 id="desk-appointments">Appointments & availability</h2>
        </div>
        <span className="desk-tag">Mock scheduler</span>
      </div>
      <p className="desk-muted">Current bookings associated with department requests.</p>
      {snapshot.bookings.length ? (
        (expanded ? bookings : bookings.slice(0, 5)).map((booking) => (
          <div className="desk-booking" key={booking.id}>
            <span className="desk-calendar" aria-hidden="true">
              {new Intl.DateTimeFormat("en-CA", {
                day: "numeric",
                timeZone: displayTimeZone,
              }).format(new Date(booking.startsAt))}
            </span>
            <div>
              <strong>{date(booking.startsAt)}</strong>
              <p>
                {snapshot.tasks.find(({ task }) => task.patientId === booking.patientId)?.patient
                  ?.displayName ?? booking.patientId}
              </p>
            </div>
            <span className="desk-pill desk-pill-green">Booked</span>
          </div>
        ))
      ) : (
        <p className="desk-empty">No associated bookings yet.</p>
      )}
      {bookings.length > 5 && (
        <button className="desk-link-button desk-show-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show fewer appointments" : `Show all ${bookings.length} appointments`}
        </button>
      )}
      <details className="desk-slots">
        <summary>
          View appointment slots{" "}
          <span>{snapshot.slots.filter((slot) => slot.available).length} available</span>
        </summary>
        {snapshot.slots.length ? (
          <ul>
            {snapshot.slots.map((slot) => (
              <li key={slot.id}>
                <time dateTime={slot.startsAt}>{date(slot.startsAt)}</time>
                <span className={`desk-pill ${slot.available ? "desk-pill-green" : ""}`}>
                  {slot.available ? "Available" : "Unavailable"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="desk-muted">Slots appear when the department has a patient request.</p>
        )}
      </details>
    </section>
  );
}

export function AgentPanel({ snapshot }: { snapshot: DesktopSnapshot }) {
  const { voice, queue } = snapshot;
  return (
    <section className="desk-card" id="agents" aria-labelledby="desk-agents">
      <div className="desk-section-heading">
        <div>
          <p className="eyebrow">PHONE & AI</p>
          <h2 id="desk-agents">Agent readiness</h2>
        </div>
        <span className={`desk-pill ${voice.liveReady ? "desk-pill-green" : "desk-pill-amber"}`}>
          {voice.liveReady ? "Live enabled" : "Live disabled"}
        </span>
      </div>
      <p className="desk-muted">
        {voice.mode === "simulated"
          ? "Phone simulation is selected. No real numbers are dialled."
          : voice.liveReady
            ? "The real phone line is configured. Callers need a one-time portal access code."
            : "The real phone line is not ready. The separate simulator remains available."}
      </p>
      <div className="desk-agent-list">
        {voice.agents.map((agent, index) => (
          <div key={agent.id}>
            <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <div>
              <h3>{agent.name}</h3>
              <p>{agent.description}</p>
            </div>
          </div>
        ))}
      </div>
      {voice.phoneNumber && (
        <p className="desk-phone-number">
          <a href={`tel:${voice.phoneNumber}`}>{voice.phoneNumber}</a>
        </p>
      )}
      <Link className="desk-text-link" href="/professional/team">
        Care-team directory & staff phone access →
      </Link>
      <p className="desk-muted">
        Appointment follow-up jobs are simulated. Real phone activity is labelled separately.
      </p>
      <div className="desk-health" aria-label="Delivery and booking monitoring">
        <div>
          <strong>{queue.counts.overduePendingActions + queue.counts.overdueJobs}</strong>
          <span>Overdue actions / jobs</span>
        </div>
        <div>
          <strong>{queue.counts.failedDeliveries}</strong>
          <span>Failed deliveries</span>
        </div>
        <div>
          <strong>{queue.counts.reconciliation}</strong>
          <span>Bookings to reconcile</span>
        </div>
      </div>
    </section>
  );
}
