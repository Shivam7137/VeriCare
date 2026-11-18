"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { clock, journey, type AgentRun, type AgentStep, type Mission } from "../lib/journey";
import { enterWorkspace } from "../lib/workspace";
import { Icon, type IconName } from "./journey-icons";

const REFRESH_MS = 1500;
const wakes: Record<string, string> = {
  step_change: "Step changed",
  estimate_shift: "Estimate moved",
  check_in_due: "Check-in due",
  inbound_message: "Patient wrote in",
  contact_question: "Family wrote in",
};
const tools: Record<string, { label: string; icon: IconName }> = {
  notify: { label: "Send update", icon: "send" },
  ask_check_in: { label: "Ask how they feel", icon: "pulse" },
  open_staff_task: { label: "Put on the Desk", icon: "list" },
  answer_from_kb: { label: "Answer from knowledge base", icon: "chat" },
  handoff: { label: "Hand off to staff", icon: "people" },
  schedule_wake: { label: "Check in later", icon: "clock" },
  do_nothing: { label: "Hold back", icon: "shield" },
};
const refusals: Record<string, string> = {
  superseded: "the visit had already moved on",
  consent_withdrawn: "consent was withdrawn",
  no_alerts_scope: "this contact did not ask for alerts",
  rate_limit: "too soon after the last estimate text",
  guardian_no_estimate: "an estimate may not be shared right now",
  guardian_sensitive_record: "the visit is silenced",
  guardian_feed_stale: "the hospital feed is stale",
  guardian_critical_acuity: "automated updates are off for this visit",
  unknown_action: "that message was never offered",
  tool_not_offered: "that tool is not available here",
  summary_rejected: "the summary held contact details",
  unknown_article: "no such article",
  "already sent": "already sent",
};
const hl7Names: Record<string, string> = {
  "ADT A04": "Arrival",
  "ADT A08": "Update",
  "ADT A02": "Moved",
  "ADT A03": "Discharge",
  "ADT A06": "Admitted",
  "ORM O01": "Order placed",
  "ORU R01": "Result back",
};

function target(step: AgentStep) {
  const id = typeof step.args.action_id === "string" ? step.args.action_id : "";
  if (step.tool === "notify") return id.startsWith("contact") ? "family" : "patient";
  if (step.tool === "open_staff_task") return String(step.args.kind ?? "task");
  if (step.tool === "answer_from_kb")
    return String(step.args.article_id ?? "").replaceAll("_", " ");
  if (step.tool === "schedule_wake") return `${step.args.minutes} min`;
  return "";
}

/** Mission control: the hospital feed, the agent's decisions and what people received, live. */
export default function EdMission({ embedded = false }: { embedded?: boolean }) {
  const [data, setData] = useState<Mission | null>(null);
  const [error, setError] = useState("");
  const [raw, setRaw] = useState<string | null>(null);
  const ready = useRef(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await journey.mission();
        if (active) {
          setData(next);
          setError("");
        }
      } catch {
        if (active) setError("Mission control can't reach the server. Showing the last update.");
      }
    };
    enterWorkspace("professional", true)
      .then(() => {
        ready.current = true;
        void refresh();
      })
      .catch(() => active && setError("The staff demo account isn't available right now."));
    const timer = window.setInterval(() => {
      if (ready.current && document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const totals = data?.totals;
  const shown = raw ? data?.hl7.find((message) => message.id === raw) : null;
  const Main = embedded ? "div" : "main";
  return (
    <div className={embedded ? "vca-embed" : "vc vc-dark"}>
      {!embedded && (
        <header className="vc-bar">
          <Link href="/professional/ed" className="vc-brand">
            <span className="vc-brand-mark">
              <Icon name="heart" size={20} />
            </span>
            <span>
              VeriCare Mission Control
              <small>One agent for every emergency visit</small>
            </span>
          </Link>
          {data?.feed ? (
            <span className="vc-live" data-state={data.feed.stale ? "stale" : "live"}>
              <i aria-hidden="true" />
              {data.feed.stale ? "OPOR feed stale" : "OPOR feed live"} · department clock{" "}
              {clock(data.feed.feedTime)}
            </span>
          ) : (
            <span className="vc-live" data-state="stale">
              <i aria-hidden="true" />
              Waiting for the OPOR feed
            </span>
          )}
        </header>
      )}

      <Main className="vc-mission" id={embedded ? undefined : "workspace-main"}>
        {embedded && (
          <div className="vca-head">
            <div>
              <p className="vc-eyebrow">Oversight</p>
              <h1>Live feed</h1>
              <p className="vca-lede">
                The hospital feed as it arrives, what each Visit Agent decided, and what patients
                and families received, side by side.
              </p>
            </div>
          </div>
        )}
        {error && (
          <p className="vc-note" role="alert">
            <Icon name="alert" size={20} />
            {error}
          </p>
        )}
        <section className="vc-stats vc-stats-5" aria-label="Totals">
          <div className="vc-card vc-stat">
            <span>Visits with an agent</span>
            <strong>{totals?.open ?? "–"}</strong>
            <small>open right now</small>
          </div>
          <div className="vc-card vc-stat">
            <span>Agent decisions</span>
            <strong>{totals?.runs ?? "–"}</strong>
            <small>
              {totals?.modelRuns ?? 0} planned by the language model,{" "}
              {(totals?.runs ?? 0) - (totals?.modelRuns ?? 0)} by rules
            </small>
          </div>
          <div className="vc-card vc-stat">
            <span>Held back</span>
            <strong>{totals?.held ?? "–"}</strong>
            <small>times the agent chose not to message</small>
          </div>
          <div className="vc-card vc-stat">
            <span>Stopped by the Guardian</span>
            <strong>{totals?.denied ?? "–"}</strong>
            <small>proposed actions refused by code</small>
          </div>
          <div className="vc-card vc-stat">
            <span>Messages sent</span>
            <strong>{totals?.messages ?? "–"}</strong>
            <small>{totals?.tasks ?? 0} tasks raised for staff</small>
          </div>
        </section>

        <div className="vc-mission-grid">
          <section className="vc-card vc-section vc-col" aria-label="Hospital feed">
            <div className="vc-section-head">
              <Icon name="pulse" />
              <h2>OPOR feed</h2>
            </div>
            <p className="vc-muted">HL7 v2 messages from the hospital record, newest first.</p>
            <ul className="vc-feed">
              {data?.hl7.map((message) => (
                <li key={message.id}>
                  <button
                    onClick={() => setRaw(raw === message.id ? null : message.id)}
                    aria-expanded={raw === message.id}
                  >
                    <time dateTime={message.sentAt ?? message.at}>
                      {clock(message.sentAt ?? message.at)}
                    </time>
                    <code>{message.type}</code>
                    <span>
                      {hl7Names[message.type] ?? "Message"}
                      {message.name ? ` · ${message.name}` : ""}
                    </span>
                  </button>
                  {shown?.id === message.id && <pre>{shown.raw}</pre>}
                </li>
              ))}
              {data && data.hl7.length === 0 && (
                <li className="vc-muted">Start the OPOR Twin to see messages arrive.</li>
              )}
            </ul>
          </section>

          <section className="vc-card vc-section vc-col" aria-label="Agent decisions">
            <div className="vc-section-head">
              <Icon name="shield" />
              <h2>Visit Agent</h2>
            </div>
            <p className="vc-muted">
              What woke the agent, what it chose, and what the Guardian allowed.
            </p>
            <ul className="vc-runs">
              {data?.runs.map((run) => (
                <Run key={run.id} run={run} />
              ))}
              {data && data.runs.length === 0 && <li className="vc-muted">No decisions yet.</li>}
            </ul>
          </section>

          <section className="vc-card vc-section vc-col" aria-label="What people received">
            <div className="vc-section-head">
              <Icon name="phone" />
              <h2>Patients and families</h2>
            </div>
            <p className="vc-muted">Every message in and out, on any channel.</p>
            <ul className="vc-wire">
              {data?.thread.map((message) => (
                <li key={message.id} data-from={message.direction}>
                  <small>
                    {message.direction === "in" ? "From" : "To"}{" "}
                    {message.audience === "patient"
                      ? message.patientName
                      : `${message.patientName}'s ${(message.relationship ?? "contact").toLowerCase()}`}{" "}
                    · {message.channel === "sms" ? "text" : message.channel} · {clock(message.at)}
                  </small>
                  {message.body}
                </li>
              ))}
              {data && data.thread.length === 0 && <li className="vc-muted">Nothing sent yet.</li>}
            </ul>
            {(data?.texts.length ?? 0) > 0 && (
              <>
                <h3>Text messages</h3>
                <ul className="vc-texts">
                  {data!.texts.map((text) => (
                    <li key={text.id}>
                      <span
                        className="vc-chip"
                        data-tone={text.status === "failed" ? "danger" : "plain"}
                      >
                        {text.status}
                      </span>
                      <span>
                        <small>to {text.to}</small>
                        {text.body}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      </Main>
    </div>
  );
}

function Run({ run }: { run: AgentRun }) {
  return (
    <li>
      <div className="vc-run-top">
        <strong>{wakes[run.wake] ?? run.wake}</strong>
        <span className="vc-muted">{run.patientName}</span>
        <time dateTime={run.at}>{clock(run.at)}</time>
      </div>
      <div className="vc-run-by">
        <span className="vc-chip" data-tone={run.planner === "model" ? "good" : "plain"}>
          {run.planner === "model" ? `Model · ${run.model}` : "Rules path"}
        </span>
        {run.latencyMs !== null && (
          <span className="vc-muted">{(run.latencyMs / 1000).toFixed(1)} s</span>
        )}
        {run.fallbackReason && (
          <span className="vc-muted">fell back: {run.fallbackReason.replaceAll("_", " ")}</span>
        )}
      </div>
      <ol>
        {run.plan.map((step, index) => {
          const look = tools[step.tool] ?? { label: step.tool, icon: "alert" as IconName };
          const to = target(step);
          return (
            <li key={index} data-verdict={step.verdict}>
              <Icon name={step.verdict === "denied" ? "alert" : look.icon} size={16} />
              <span>
                <b>
                  {look.label}
                  {to ? ` · ${to}` : ""}
                </b>
                {step.verdict === "denied"
                  ? ` Refused: ${refusals[step.why] ?? step.why.replaceAll("_", " ")}.`
                  : step.why
                    ? ` ${step.why}`
                    : ""}
              </span>
            </li>
          );
        })}
      </ol>
    </li>
  );
}
