"use client";
import Link from "next/link";
import { useState } from "react";
import { clock } from "../../lib/journey";
import { Icon } from "../journey-icons";
import { actionNames, describeRun } from "./agent-words";
import { useDesk } from "./desk-context";
import { patientHref } from "./now-view";
import { ViewHead } from "./shell";

type Pane = "decisions" | "ledger";

export default function AgentView() {
  const { desk } = useDesk();
  const [pane, setPane] = useState<Pane>("decisions");
  const runs = desk?.agent.runs ?? [];
  const ledger = desk?.ledger ?? [];
  const idFor = (name: string) => desk?.patients.find((patient) => patient.name === name)?.id;

  return (
    <>
      <ViewHead
        eyebrow="Oversight"
        title="Agent & audit"
        lede="Each visit has an agent that chooses which approved message to send, or none. It cannot write facts or numbers, and code checks every choice before anything leaves."
        actions={
          <Link href="/professional/ed/mission" className="vc-btn" data-kind="quiet" data-size="sm">
            <Icon name="feed" size={18} />
            Live feed
          </Link>
        }
      />
      <div className="vca-toolbar">
        <div className="vca-seg" role="group" aria-label="Show">
          <button aria-pressed={pane === "decisions"} onClick={() => setPane("decisions")}>
            Agent decisions<em>{runs.length}</em>
          </button>
          <button aria-pressed={pane === "ledger"} onClick={() => setPane("ledger")}>
            Audit ledger<em>{ledger.length}</em>
          </button>
        </div>
      </div>

      {pane === "decisions" ? (
        <section className="vca-panel" aria-label="Agent decisions">
          <p className="vca-hint">
            The latest decisions across the department. “Model” means the language model planned;
            “rules” is the fallback path that sends the same approved messages.
          </p>
          {!desk && <div className="vc-skeleton" aria-label="Loading decisions" />}
          {desk && runs.length === 0 && <p className="vca-quiet">No decisions yet.</p>}
          <ul className="vca-runs">
            {runs.map((run) => {
              const text = describeRun(run);
              const id = idFor(run.patientName);
              return (
                <li key={run.id}>
                  <time dateTime={run.at}>{clock(run.at)}</time>
                  <code data-planner={run.planner}>
                    {run.planner === "model" ? "model" : "rules"}
                  </code>
                  <span>
                    <strong>{text.wake}</strong> ·{" "}
                    {id ? (
                      <Link href={`${patientHref(id)}#agent`}>{run.patientName}</Link>
                    ) : (
                      run.patientName
                    )}
                    : {text.did}
                    {text.refused ? ` · ${text.refused} refused by the Guardian` : ""}
                    {text.why && <q>{text.why}</q>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <section className="vca-panel" aria-label="Audit ledger">
          <p className="vca-hint">
            Every feed message, disclosure decision and staff action, newest first. Each entry is
            chained to the one before it, so a change would show.
          </p>
          <ul className="vca-runs">
            {ledger.map((entry) => (
              <li key={entry.seq}>
                <time dateTime={entry.at}>{clock(entry.at)}</time>
                <code>{entry.actor.length > 14 ? "staff" : entry.actor}</code>
                <span>
                  {actionNames[entry.action] ?? entry.action}
                  {entry.patientName ? ` · ${entry.patientName}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
