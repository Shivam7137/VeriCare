"use client";
import Link from "next/link";
import { useState } from "react";
import { minutesPastTold } from "../../lib/forecast";
import { clock, journey, minutesText, type DeskTask } from "../../lib/journey";
import { Icon, type IconName } from "../journey-icons";
import { useDesk } from "./desk-context";
import { RangeAxis, RangeBar } from "./forecast-marks";
import { ViewHead } from "./shell";

export const patientHref = (id: string) => `/professional/ed/patients/${id}`;

const taskLook: Record<DeskTask["kind"], { icon: IconName; label: string }> = {
  recheck: { icon: "alert", label: "Recheck patient" },
  leaving: { icon: "door", label: "Thinking of leaving" },
  question: { icon: "chat", label: "Question" },
  interpreter: { icon: "globe", label: "Interpreter" },
  comfort: { icon: "heart", label: "Comfort" },
};
const priorityWord = { 1: "Now", 2: "Soon", 3: "When free" } as const;
type Filter = "all" | 1 | 2 | 3;

export default function NowView() {
  const { desk, busy, run } = useDesk();
  const [filter, setFilter] = useState<Filter>("all");
  const tasks = desk?.tasks ?? [];
  const shown = filter === "all" ? tasks : tasks.filter((task) => task.priority === filter);
  const feedTime = desk?.feed?.feedTime;
  const waiting = desk?.patients.filter((patient) => patient.step === "waiting") ?? [];
  const overdue = waiting
    .map((patient) => ({ patient, past: minutesPastTold(patient, feedTime) }))
    .filter((row): row is { patient: (typeof waiting)[number]; past: number } => row.past !== null)
    .sort((a, b) => b.past - a.past);
  const nextSeen = waiting
    .flatMap((patient) => {
      const stage = patient.stages.find((item) => item.stage === "provider");
      return stage && !patient.flags.length ? [{ patient, stage }] : [];
    })
    .sort((a, b) => a.stage.typicalMinutes - b.stage.typicalMinutes)
    .slice(0, 6);
  const longest = Math.max(0, ...waiting.map((patient) => patient.waitingMinutes ?? 0));

  return (
    <>
      <ViewHead
        eyebrow="Work"
        title="Who needs a person now"
        lede="Requests from patients and families, ranked by code-set priority. The model's watch list on the right shows who has waited past what they were told."
      />

      <section className="vca-stats" aria-label="Right now">
        <Stat
          label="Needs a person"
          value={desk ? tasks.length : null}
          tone={tasks.some((t) => t.priority === 1) ? "danger" : undefined}
        >
          {tasks.filter((task) => task.priority === 1).length} marked now
        </Stat>
        <Stat label="Waiting to be seen" value={desk ? waiting.length : null}>
          Longest {waiting.length ? minutesText(longest) : "–"}
        </Stat>
        <Stat
          label="Past the time they were told"
          value={desk ? overdue.length : null}
          tone={overdue.length ? "warn" : undefined}
          model
        >
          From the stage-time model
        </Stat>
        <Stat label="In the department" value={desk?.patients.length ?? null}>
          {desk?.patients.filter((patient) => patient.flags.length || patient.unmapped).length ?? 0}{" "}
          silenced
        </Stat>
      </section>
      {feedTime && (
        <p className="vca-hint">
          As of {clock(feedTime)} on the department clock. Every screen reads the same feed and
          refreshes every 2 seconds.
        </p>
      )}

      <div className="vca-split">
        <section className="vca-panel" aria-labelledby="vca-queue-title">
          <div className="vca-panel-head">
            <h2 id="vca-queue-title">Queue</h2>
            <div className="vca-seg" role="group" aria-label="Filter by priority">
              {(["all", 1, 2, 3] as Filter[]).map((value) => {
                const count =
                  value === "all" ? tasks.length : tasks.filter((t) => t.priority === value).length;
                return (
                  <button
                    key={value}
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {value === "all" ? "All" : priorityWord[value]}
                    <em>{count}</em>
                  </button>
                );
              })}
            </div>
          </div>
          {!desk && <div className="vc-skeleton" aria-label="Loading the queue" />}
          {desk && shown.length === 0 && (
            <div className="vca-empty">
              <Icon name="check" size={28} />
              <p>
                {tasks.length
                  ? "Nothing at this priority."
                  : "Nobody is waiting on you. New requests appear here on their own."}
              </p>
            </div>
          )}
          <ul className="vca-tasks">
            {shown.map((task) => (
              <li key={task.id} className="vca-task" data-priority={task.priority}>
                <span className="vca-task-icon">
                  <Icon name={taskLook[task.kind].icon} size={20} />
                </span>
                <div className="vca-task-main">
                  <div className="vca-task-top">
                    <span
                      className="vc-chip"
                      data-tone={
                        task.priority === 1 ? "danger" : task.priority === 2 ? "warn" : "plain"
                      }
                    >
                      {taskLook[task.kind].label} · {priorityWord[task.priority]}
                    </span>
                    <time dateTime={task.createdAt}>{clock(task.createdAt)}</time>
                  </div>
                  <Link href={patientHref(task.encounterId)} className="vca-name">
                    {task.patientName}
                    {task.ctas && (
                      <span className="vc-level" data-level={task.ctas}>
                        <span className="vc-sr">Triage level </span>
                        {task.ctas}
                      </span>
                    )}
                  </Link>
                  <p>{task.summary}</p>
                </div>
                <div className="vca-task-actions">
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
              </li>
            ))}
          </ul>
        </section>

        <div className="vca-stack">
          <section className="vca-panel" aria-labelledby="vca-over-title">
            <div className="vca-panel-head">
              <h2 id="vca-over-title">Waited past their range</h2>
              <span className="vca-model-tag">
                <Icon name="forecast" size={16} />
                Model
              </span>
            </div>
            <p className="vca-hint">
              Waiting patients whose told range has run out. A good moment for a Waiting Room Care
              Provider to check in. The agent also asks them how they feel.
            </p>
            {!desk ? (
              <p className="vca-quiet" role="status">
                Loading…
              </p>
            ) : overdue.length === 0 ? (
              <p className="vca-quiet">
                Everyone waiting is still inside the range they were told.
              </p>
            ) : (
              <ul className="vca-watch">
                {overdue.map(({ patient, past }) => (
                  <li key={patient.id}>
                    <Link href={patientHref(patient.id)} className="vca-name">
                      {patient.name}
                    </Link>
                    <span>
                      Told within {minutesText(patient.range!.highMinutes)} · now{" "}
                      <b>{minutesText(past)} past</b>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="vca-panel" aria-labelledby="vca-next-title">
            <div className="vca-panel-head">
              <h2 id="vca-next-title">Likely seen next</h2>
              <span className="vca-model-tag">
                <Icon name="forecast" size={16} />
                Model
              </span>
            </div>
            <p className="vca-hint">
              Wait to be seen, 10th to 90th percentile; the tick is the median.
            </p>
            {!desk ? (
              <p className="vca-quiet" role="status">
                Loading…
              </p>
            ) : nextSeen.length === 0 ? (
              <p className="vca-quiet">Nobody is waiting to be seen.</p>
            ) : (
              <div className="vcf-column">
                <RangeAxis max={360} />
                {nextSeen.map(({ patient, stage }) => (
                  <div key={patient.id} className="vca-next-row">
                    <Link href={patientHref(patient.id)} className="vca-name">
                      {patient.name}
                    </Link>
                    <RangeBar stage={stage} max={360} label={false} />
                  </div>
                ))}
              </div>
            )}
            <Link href="/professional/ed/forecasts" className="vca-more">
              Department forecast
              <Icon name="arrow" size={16} />
            </Link>
          </section>
        </div>
      </div>
    </>
  );
}

export function Stat({
  label,
  value,
  children,
  tone,
  model,
}: {
  label: string;
  value: number | string | null;
  children?: React.ReactNode;
  tone?: "danger" | "warn";
  model?: boolean;
}) {
  return (
    <div className="vca-stat" data-tone={tone}>
      <span>
        {label}
        {model && <Icon name="forecast" size={14} />}
      </span>
      <strong>{value ?? "–"}</strong>
      {children && <small>{children}</small>}
    </div>
  );
}
