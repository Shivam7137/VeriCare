"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  clock,
  journey,
  minutesText,
  stageNames,
  type Accuracy,
  type AccuracyPoint,
  type StageName,
} from "../lib/journey";
import { enterWorkspace } from "../lib/workspace";
import { Icon } from "./journey-icons";

const REFRESH_MS = 5000;
const order: StageName[] = ["triage", "provider", "results", "decision", "bed"];
const describe: Record<StageName, string> = {
  triage: "Arrival to triage",
  provider: "Wait to be seen",
  results: "Test results back",
  decision: "Decision on next steps",
  bed: "Inpatient bed (staff only)",
};
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : null);
const outcome = (point: AccuracyPoint) =>
  point.actual > point.high ? "over" : point.actual < point.low ? "under" : "inside";
const outcomeWord = {
  inside: "Inside the range",
  over: "Ran over",
  under: "Sooner than the range",
};

/** Predicted against actual, by step. The page staff use to decide how far to trust a range. */
export default function EdAccuracy({ embedded = false }: { embedded?: boolean }) {
  const [data, setData] = useState<Accuracy | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<"chart" | "table">("chart");
  const ready = useRef(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await journey.accuracy();
        if (active) {
          setData(next);
          setError("");
        }
      } catch {
        if (active)
          setError("The accuracy ledger can't reach the server. Showing the last update.");
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
    // A tab brought back from the background catches up at once instead of showing old times.
    const wake = () => {
      if (ready.current && document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, []);

  const stages = useMemo(
    () =>
      order.flatMap((stage) => {
        const row = data?.stages.find((item) => item.stage === stage);
        return row ? [row] : [];
      }),
    [data],
  );
  const all = stages.reduce(
    (sum, row) => ({ total: sum.total + row.total, inside: sum.inside + row.inside }),
    { total: 0, inside: 0 },
  );
  const told = data?.published;

  const Main = embedded ? "div" : "main";
  return (
    <div className={embedded ? "vca-embed" : "vc"}>
      {!embedded && (
        <header className="vc-bar">
          <Link href="/professional/ed" className="vc-brand">
            <span className="vc-brand-mark">
              <Icon name="heart" size={20} />
            </span>
            <span>
              VeriCare Desk
              <small>Estimate accuracy</small>
            </span>
          </Link>
          <span className="vc-live" data-state={data?.model ? "live" : "stale"}>
            <i aria-hidden="true" />
            {data?.model ? `Model ${data.model}` : "No estimates scored yet"}
          </span>
        </header>
      )}

      <Main
        className={embedded ? undefined : "vc-desk"}
        id={embedded ? undefined : "workspace-main"}
      >
        <div className="vc-desk-head">
          <div>
            <p className="vc-eyebrow">Emergency department</p>
            <h1>How often the estimates held</h1>
          </div>
          {!embedded && (
            <Link href="/professional/ed" className="vc-btn" data-kind="quiet" data-size="sm">
              Back to the Desk
              <Icon name="arrow" size={18} />
            </Link>
          )}
        </div>
        {error && (
          <p className="vc-note" role="alert">
            <Icon name="alert" size={20} />
            {error}
          </p>
        )}
        <p className="vc-muted vc-lede">
          Every estimate is logged when it is made and scored when the step happens. A range is
          built to hold {data?.target ?? 80}% of the time. These numbers come from the simulated
          department in this demo, not from a real hospital.
        </p>

        {!data ? (
          // Never "0 of 0" before the first answer: that reads as a broken page.
          <div className="vc-skeleton" role="status" aria-label="Loading the accuracy ledger">
            <p className="vca-quiet">Loading the accuracy ledger…</p>
          </div>
        ) : (
          <>
            <section className="vc-stats" aria-label="Summary">
              <div className="vc-card vc-stat">
                <span>All steps</span>
                <strong>
                  {percent(all.inside, all.total) ?? "–"}
                  {all.total ? "%" : ""}
                </strong>
                <small>
                  {all.inside} of {all.total} estimates inside their range
                </small>
              </div>
              <div className="vc-card vc-stat">
                <span>Ranges patients were told</span>
                <strong>{told && told.total ? `${percent(told.inside, told.total)}%` : "–"}</strong>
                <small>
                  {told?.inside ?? 0} of {told?.total ?? 0} held, {told?.over ?? 0} ran over
                </small>
              </div>
              <div className="vc-card vc-stat">
                <span>Too busy to estimate</span>
                <strong>{told?.abstained ?? "–"}</strong>
                <small>times a range was withdrawn instead of guessed</small>
              </div>
              <div className="vc-card vc-stat">
                <span>Ranges adjusted here</span>
                <strong>
                  {stages.filter((row) => row.widening > 1 || row.localScale < 1).length}
                </strong>
                <small>
                  steps widened after overruns or tightened when visits kept finishing sooner
                </small>
              </div>
            </section>

            <section className="vc-card vc-section" aria-label="Accuracy by step">
              <div className="vc-section-head">
                <Icon name="list" />
                <h2>By step</h2>
              </div>
              <div className="vc-table-wrap">
                <table className="vc-table">
                  <thead>
                    <tr>
                      <th scope="col">Step</th>
                      <th scope="col">Held</th>
                      <th scope="col">Inside</th>
                      <th scope="col">Ran over</th>
                      <th scope="col">Sooner</th>
                      <th scope="col">Typical miss</th>
                      <th scope="col">Range width</th>
                      <th scope="col">Still open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stages.length === 0 && (
                      <tr>
                        <td colSpan={8} className="vc-muted">
                          Nothing has been scored yet. Play the scenario and estimates appear here
                          as each step happens.
                        </td>
                      </tr>
                    )}
                    {stages.map((row) => {
                      const held = percent(row.inside, row.total) ?? 0;
                      return (
                        <tr key={row.stage}>
                          <td>
                            <strong>{stageNames[row.stage]}</strong>
                            <div className="vc-muted">{describe[row.stage]}</div>
                          </td>
                          <td>
                            <div className="vc-cover">
                              <span>{held}%</span>
                              <div
                                className="vc-meter"
                                data-target={data?.target ?? 80}
                                role="img"
                                aria-label={`${held}% held against a target of ${data?.target ?? 80}%`}
                              >
                                <i style={{ width: `${held}%` }} />
                                <b style={{ left: `${data?.target ?? 80}%` }} />
                              </div>
                            </div>
                          </td>
                          <td>
                            {row.inside} of {row.total}
                          </td>
                          <td>{row.over}</td>
                          <td>{row.under}</td>
                          <td>
                            {row.medianErrorMinutes === null
                              ? "–"
                              : minutesText(row.medianErrorMinutes)}
                          </td>
                          <td>
                            {row.meanWidthMinutes === null
                              ? "–"
                              : minutesText(row.meanWidthMinutes)}
                            {row.localScale < 1 && (
                              <div className="vc-muted">
                                tightened ×{row.localScale.toFixed(2)} for this department
                              </div>
                            )}
                            {row.widening > 1 && (
                              <div className="vc-muted">widened ×{row.widening.toFixed(2)}</div>
                            )}
                          </td>
                          <td>{row.awaitingOutcome}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="vc-muted">
                Typical miss is the middle distance between the model&apos;s central estimate and
                what happened. The mark on each bar is the {data?.target ?? 80}% target.
              </p>
            </section>

            <section className="vc-card vc-section" aria-label="Predicted against actual">
              <div className="vc-section-head vc-split">
                <span>
                  <Icon name="clock" />
                  <h2>Predicted against actual</h2>
                </span>
                <div className="vc-toggle" role="group" aria-label="Show as">
                  {(["chart", "table"] as const).map((item) => (
                    <button
                      key={item}
                      className="vc-btn"
                      data-kind={view === item ? undefined : "quiet"}
                      data-size="sm"
                      aria-pressed={view === item}
                      onClick={() => setView(item)}
                    >
                      {item === "chart" ? "Chart" : "Table"}
                    </button>
                  ))}
                </div>
              </div>
              <p className="vc-muted">
                One row per visit: the first estimate made for that step, and when the step
                happened.
              </p>
              <ul className="vc-legend" aria-hidden={view === "table"}>
                <li>
                  <i data-mark="range" /> Estimated range
                </li>
                <li>
                  <i data-mark="typical" /> Central estimate
                </li>
                <li>
                  <i data-mark="inside" /> Happened inside the range
                </li>
                <li>
                  <i data-mark="over" /> Ran over
                </li>
                <li>
                  <i data-mark="under" /> Sooner than the range
                </li>
              </ul>
              {view === "chart" ? (
                <div className="vc-multiples">
                  {stages.map((row) => (
                    <RangeChart
                      key={row.stage}
                      stage={row.stage}
                      points={(data?.points ?? []).filter((point) => point.stage === row.stage)}
                    />
                  ))}
                </div>
              ) : (
                <div className="vc-table-wrap">
                  <table className="vc-table">
                    <thead>
                      <tr>
                        <th scope="col">Step</th>
                        <th scope="col">Patient</th>
                        <th scope="col">Estimated at</th>
                        <th scope="col">Range</th>
                        <th scope="col">Central</th>
                        <th scope="col">Actual</th>
                        <th scope="col">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data?.points ?? []).map((point, index) => (
                        <tr key={index}>
                          <td>{stageNames[point.stage]}</td>
                          <td>{point.patientName}</td>
                          <td>{clock(point.computedAt)}</td>
                          <td>
                            {minutesText(point.low)} to {minutesText(point.high)}
                          </td>
                          <td>{minutesText(point.typical)}</td>
                          <td>
                            {point.censored ? "more than " : ""}
                            {minutesText(point.actual)}
                          </td>
                          <td>{outcomeWord[outcome(point)]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </Main>
    </div>
  );
}

const ROW = 18;
const LEFT = 8;
const WIDTH = 420;
const MOST = 14;

/** Small multiple for one step: each visit's range as a thin bar, with what happened marked on it. */
function RangeChart({ stage, points }: { stage: StageName; points: AccuracyPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const shown = points.slice(0, MOST).reverse();
  const top = Math.max(15, ...shown.map((point) => Math.max(point.high, point.actual)));
  const step = top > 600 ? 240 : top > 240 ? 120 : top > 90 ? 60 : top > 30 ? 15 : 5;
  const max = Math.ceil(top / step) * step;
  const x = (minutes: number) => LEFT + (minutes / max) * (WIDTH - LEFT * 2);
  const height = shown.length * ROW + 26;
  const active = hover === null ? null : shown[hover];
  return (
    <figure className="vc-multiple">
      <figcaption>
        <strong>{describe[stage]}</strong>
        <span className="vc-muted">
          {shown.length} of {points.length} visits, minutes from the estimate
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="img"
        aria-label={`${describe[stage]}: estimated range against actual for ${shown.length} visits. The table view lists every value.`}
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: max / step + 1 }, (_, index) => index * step).map((tick) => (
          <g key={tick}>
            <line className="vc-grid" x1={x(tick)} x2={x(tick)} y1={0} y2={height - 20} />
            <text className="vc-tick" x={x(tick)} y={height - 5} textAnchor="middle">
              {tick >= 60 && tick % 60 === 0 ? `${tick / 60} h` : tick}
            </text>
          </g>
        ))}
        {shown.map((point, index) => {
          const y = index * ROW + ROW / 2;
          const result = outcome(point);
          return (
            <g
              key={index}
              data-active={hover === index}
              onMouseEnter={() => setHover(index)}
              onFocus={() => setHover(index)}
              onBlur={() => setHover(null)}
              tabIndex={0}
              aria-label={`${point.patientName}: estimated ${point.low} to ${point.high} minutes, actual ${point.actual}. ${outcomeWord[result]}.`}
            >
              <rect className="vc-hit" x={0} y={index * ROW} width={WIDTH} height={ROW} />
              <rect
                className="vc-span"
                x={x(point.low)}
                y={y - 3}
                width={Math.max(4, x(point.high) - x(point.low))}
                height={6}
                rx={3}
              />
              <rect
                className="vc-central"
                x={x(point.typical) - 1}
                y={y - 6}
                width={2}
                height={12}
              />
              {result === "over" ? (
                <path
                  className="vc-actual"
                  data-result="over"
                  d={`M${x(point.actual)} ${y - 6}l6 6-6 6-6-6z`}
                />
              ) : (
                <circle
                  className="vc-actual"
                  data-result={result}
                  cx={x(point.actual)}
                  cy={y}
                  r={5}
                />
              )}
            </g>
          );
        })}
      </svg>
      <p className="vc-readout" aria-live="polite">
        {active ? (
          <>
            <strong>{active.patientName}</strong> · estimated {minutesText(active.low)} to{" "}
            {minutesText(active.high)}, happened after {active.censored ? "more than " : ""}
            {minutesText(active.actual)} · {outcomeWord[outcome(active)]}
          </>
        ) : (
          "Point at a row to read its values."
        )}
      </p>
    </figure>
  );
}
