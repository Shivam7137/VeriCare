"use client";
import { clock, type PatientDetail } from "../../lib/journey";
import { describeRun } from "./agent-words";

const scopeText = (scopes: string[]) =>
  scopes.includes("estimates") ? "Steps and wait estimates" : "Steps only";

export function RecordTab({ detail }: { detail: PatientDetail }) {
  return (
    <div className="vca-panel">
      <h2>From the hospital record</h2>
      <p className="vca-hint">Every OPOR feed event for this visit in plain words, newest last.</p>
      <ol className="vc-timeline">
        {detail.timeline.map((event, index) => (
          <li key={index} data-kind={event.kind}>
            <time dateTime={event.at}>{clock(event.at)}</time>
            <span>{event.label}</span>
            {event.source === "staff" && <span className="vc-muted">by staff</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function MessagesTab({ detail }: { detail: PatientDetail }) {
  return (
    <div className="vca-panel">
      <h2>Messages</h2>
      <p className="vca-hint">What the patient and their contacts sent and received.</p>
      {detail.messages.length === 0 ? (
        <p className="vca-quiet">No messages yet.</p>
      ) : (
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
      )}
    </div>
  );
}

export function AgentTab({ detail }: { detail: PatientDetail }) {
  return (
    <div className="vca-panel">
      <h2>Visit Agent decisions</h2>
      <p className="vca-hint">
        Why the agent woke, what it chose, and what the Guardian refused. The agent picks approved
        messages; it never writes facts or numbers.
      </p>
      {detail.runs.length === 0 ? (
        <p className="vca-quiet">The agent has not woken for this visit yet.</p>
      ) : (
        <ul className="vca-runs">
          {detail.runs.map((run) => {
            const text = describeRun(run);
            return (
              <li key={run.id}>
                <time dateTime={run.at}>{clock(run.at)}</time>
                <code data-planner={run.planner}>
                  {run.planner === "model" ? "model" : "rules"}
                </code>
                <span>
                  <strong>{text.wake}</strong> · {text.did}
                  {text.refused ? ` · ${text.refused} refused by the Guardian` : ""}
                  {text.why && <q>{text.why}</q>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function PeopleTab({ detail }: { detail: PatientDetail }) {
  return (
    <div className="vca-panel">
      <h2>Family and consent</h2>
      <p className="vca-hint">
        People the patient approved. Each confirmed by text; scopes limit what they hear.
      </p>
      {detail.contacts.length === 0 ? (
        <p className="vca-quiet">Nobody added yet. Patients add people from their own app.</p>
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
    </div>
  );
}
