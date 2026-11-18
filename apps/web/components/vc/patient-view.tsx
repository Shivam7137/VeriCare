"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { nextStage, stageLong, stageOrder } from "../../lib/forecast";
import { clock, journey, minutesText, stepNames, type PatientDetail } from "../../lib/journey";
import { Icon, type IconName } from "../journey-icons";
import { useDesk } from "./desk-context";
import { RangeAxis, RangeBar } from "./forecast-marks";
import { AgentTab, MessagesTab, PeopleTab, RecordTab } from "./patient-tabs";

const REFRESH_MS = 3000;
const flagNames: Record<string, string> = {
  confidential: "Confidential",
  vip: "Protected",
  security: "Security alert",
  deceased: "Deceased",
  critical: "Critical",
};
export const taskNames: Record<string, string> = {
  recheck: "Recheck",
  leaving: "Thinking of leaving",
  question: "Question",
  interpreter: "Interpreter",
  comfort: "Comfort",
};
const tabs = [
  { id: "overview", label: "Overview", icon: "home" },
  { id: "forecast", label: "Forecast", icon: "forecast" },
  { id: "record", label: "Hospital record", icon: "list" },
  { id: "messages", label: "Messages", icon: "chat" },
  { id: "agent", label: "Visit Agent", icon: "spark" },
  { id: "people", label: "Family & consent", icon: "people" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];
type Tab = (typeof tabs)[number]["id"];

/** One visit, with its parts on tabs so staff go straight to what they need. */
export default function PatientView({ id }: { id: string }) {
  const { ready, busy, run } = useDesk();
  const [detail, setDetail] = useState<PatientDetail | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (tabs.some((item) => item.id === fromHash)) setTab(fromHash as Tab);
  }, []);
  const choose = (next: Tab) => {
    setTab(next);
    window.history.replaceState(null, "", `#${next}`);
  };

  const load = useCallback(async () => {
    try {
      setDetail(await journey.patient(id));
      setError("");
    } catch {
      setError("This visit can't be loaded right now.");
    }
  }, [id]);

  useEffect(() => {
    if (!ready) return;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [ready, load]);

  const act = (key: string, work: () => Promise<unknown>) =>
    run(key, async () => {
      await work();
      await load();
    });

  const counts: Partial<Record<Tab, number>> = detail
    ? {
        messages: detail.messages.length,
        agent: detail.runs.length,
        people: detail.contacts.length,
        record: detail.timeline.length,
      }
    : {};
  const silenced = detail ? detail.flags.length > 0 || detail.unmapped : false;
  const confidential = detail?.flags.includes("confidential") ?? false;

  return (
    <>
      <Link href="/professional/ed/board" className="vca-back">
        <Icon name="back" size={18} />
        Board
      </Link>
      <div className="vca-head vca-patient-head">
        <div>
          <p className="vc-eyebrow">{detail ? `Visit ${detail.visitNumber}` : "Patient"}</p>
          <h1>
            {detail?.name ?? "Loading"}
            {detail?.ctas && (
              <span className="vc-level" data-level={detail.ctas}>
                <span className="vc-sr">Triage level </span>
                {detail.ctas}
              </span>
            )}
          </h1>
          {detail && (
            <p className="vca-lede">
              {stepNames[detail.step] ?? detail.step}
              {detail.minutesInDepartment !== null &&
                ` · ${minutesText(detail.minutesInDepartment)} in the department`}
              {detail.stream === "rapid_assessment" && " · Rapid assessment"}
            </p>
          )}
        </div>
        {detail && (
          <div className="vca-head-actions">
            <button
              className="vc-btn"
              data-kind={confidential ? "danger-quiet" : "quiet"}
              data-size="sm"
              disabled={busy === detail.id}
              aria-pressed={confidential}
              onClick={() =>
                act(detail.id, () => journey.setFlag(detail.id, "confidential", !confidential))
              }
            >
              <Icon name="shield" size={18} />
              {confidential ? "Confidential on" : "Mark confidential"}
            </button>
          </div>
        )}
      </div>

      {error && (
        <p className="vc-note" role="alert">
          <Icon name="alert" size={20} />
          {error}
        </p>
      )}

      <div className="vca-tabbar" role="tablist" aria-label="Visit">
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`panel-${item.id}`}
            tabIndex={tab === item.id ? 0 : -1}
            onClick={() => choose(item.id)}
            onKeyDown={(event) => {
              const index = tabs.findIndex((entry) => entry.id === tab);
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!step) return;
              const next = tabs[(index + step + tabs.length) % tabs.length]!.id;
              choose(next);
              document.getElementById(`tab-${next}`)?.focus();
            }}
          >
            <Icon name={item.icon} size={18} />
            {item.label}
            {counts[item.id] !== undefined && <em>{counts[item.id]}</em>}
          </button>
        ))}
      </div>

      <section
        className="vca-tabpanel"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {!detail && !error && <div className="vc-skeleton" aria-label="Loading the visit" />}
        {detail && tab === "overview" && (
          <Overview detail={detail} silenced={silenced} busy={busy} act={act} go={choose} />
        )}
        {detail && tab === "forecast" && <Forecast detail={detail} silenced={silenced} />}
        {detail && tab === "record" && <RecordTab detail={detail} />}
        {detail && tab === "messages" && <MessagesTab detail={detail} />}
        {detail && tab === "agent" && <AgentTab detail={detail} />}
        {detail && tab === "people" && <PeopleTab detail={detail} />}
      </section>
    </>
  );
}

function Overview({
  detail,
  silenced,
  busy,
  act,
  go,
}: {
  detail: PatientDetail;
  silenced: boolean;
  busy: string;
  act: (key: string, work: () => Promise<unknown>) => Promise<void>;
  go: (tab: Tab) => void;
}) {
  const next = nextStage({ stages: detail.estimates });
  const open = detail.tasks.filter((task) => task.state === "open");
  return (
    <div className="vca-overview">
      <div className="vca-stack">
        <div className="vca-panel">
          <h2>Steps</h2>
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
            <p className="vca-hint">
              Tests started in the waiting room at {clock(detail.testsStartedWaiting)}, before the
              patient was seen.
            </p>
          )}
        </div>

        <div className="vca-panel">
          <h2>Open tasks</h2>
          {open.length === 0 ? (
            <p className="vca-quiet">No open tasks for this visit.</p>
          ) : (
            <ul className="vca-mini-tasks">
              {open.map((task) => (
                <li key={task.id} data-priority={task.priority}>
                  <div>
                    <strong>{taskNames[task.kind] ?? task.kind}</strong>
                    <span>{task.summary}</span>
                  </div>
                  <button
                    className="vc-btn"
                    data-size="sm"
                    disabled={busy === task.id}
                    onClick={() => act(task.id, () => journey.closeTask(task.id, "done"))}
                  >
                    <Icon name="check" size={18} />
                    Done
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="vca-stack">
        <div className="vca-panel vca-next-card">
          <div className="vca-panel-head">
            <h2>Next milestone</h2>
            <span className="vca-model-tag">
              <Icon name="forecast" size={16} />
              Model
            </span>
          </div>
          {silenced ? (
            <p className="vca-quiet">Estimates are withheld while the visit is silenced.</p>
          ) : next ? (
            <>
              <p className="vca-next-big">
                {stageLong[next.stage]} in about <b>{minutesText(next.typicalMinutes)}</b>
              </p>
              <p className="vca-hint">
                80% range {minutesText(next.lowMinutes)} to {minutesText(next.highMinutes)}
              </p>
              <button className="vca-more" onClick={() => go("forecast")}>
                Every remaining step
                <Icon name="arrow" size={16} />
              </button>
            </>
          ) : (
            <p className="vca-quiet">No milestone ahead for this visit.</p>
          )}
        </div>

        <div className="vca-panel">
          <h2>Details</h2>
          <dl className="vca-facts">
            <div>
              <dt>Age</dt>
              <dd>{detail.age ?? "–"}</dd>
            </div>
            <div>
              <dt>Area</dt>
              <dd>{detail.area ?? "–"}</dd>
            </div>
            <div>
              <dt>Waiting since triage</dt>
              <dd>{detail.minutesWaiting === null ? "–" : minutesText(detail.minutesWaiting)}</dd>
            </div>
            <div>
              <dt>Updates go to</dt>
              <dd>
                {detail.contacts.length
                  ? detail.contacts.map((contact) => contact.name).join(", ")
                  : "Patient only"}
              </dd>
            </div>
          </dl>
          {(silenced ||
            detail.consultRequested ||
            detail.bedRequested ||
            detail.testsInProgress) && (
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
            <p className="vca-hint">
              Silenced: the patient and their contacts get only the standard handoff, and the agent
              is not asked about this visit.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Forecast({ detail, silenced }: { detail: PatientDetail; silenced: boolean }) {
  const stages = stageOrder.flatMap((name) => detail.estimates.filter((s) => s.stage === name));
  const longest = Math.max(240, ...stages.map((stage) => stage.highMinutes));
  const max = Math.min(Math.ceil(longest / 120) * 120, 1440);
  return (
    <div className="vca-stack">
      <div className="vca-panel">
        <div className="vca-panel-head">
          <h2>What the model expects from here</h2>
          <span className="vca-model-tag">
            <Icon name="forecast" size={16} />
            stage-time model
          </span>
        </div>
        <p className="vca-hint">
          Minutes from now to each step still ahead. The band runs from the 10th to the 90th
          percentile and is calibrated to hold 80% of the time; the tick is the median. Recomputed
          on every feed event. The bed estimate is for staff only.
        </p>
        {silenced ? (
          <p className="vca-quiet">Estimates are withheld while the visit is silenced.</p>
        ) : stages.length === 0 ? (
          <p className="vca-quiet">No steps ahead to estimate.</p>
        ) : (
          <div className="vcf-column vcf-column-labeled">
            <RangeAxis max={max} />
            {stages.map((stage) => (
              <RangeBar key={stage.stage} stage={stage} max={max} />
            ))}
          </div>
        )}
      </div>

      <div className="vca-panel">
        <h2>Ranges the patient was told</h2>
        <p className="vca-hint">
          The wait to be seen, as published to the patient, scored against what happened. Older
          entries first.
        </p>
        {detail.published.length === 0 ? (
          <p className="vca-quiet">No range has been published for this visit.</p>
        ) : (
          <ul className="vca-told-list">
            {detail.published.map((item, index) => {
              const held =
                item.actual === null || item.high === null || item.low === null
                  ? null
                  : item.actual >= item.low && item.actual <= item.high;
              return (
                <li key={index} data-held={held === null ? "open" : held}>
                  <time dateTime={item.at}>{clock(item.at)}</time>
                  <span>
                    {item.abstain
                      ? "Too busy to estimate"
                      : `${minutesText(item.low ?? 0)} to ${minutesText(item.high ?? 0)}`}
                    {item.reason && <small>{item.reason.replaceAll("_", " ")}</small>}
                  </span>
                  <span className="vca-verdict">
                    {item.actual === null ? (
                      "Still waiting"
                    ) : (
                      <>
                        <Icon name={held ? "check" : "alert"} size={16} />
                        Seen after {minutesText(item.actual)} · {held ? "held" : "missed"}
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <Link href="/professional/ed/accuracy" className="vca-more">
          Department accuracy
          <Icon name="arrow" size={16} />
        </Link>
      </div>
    </div>
  );
}
