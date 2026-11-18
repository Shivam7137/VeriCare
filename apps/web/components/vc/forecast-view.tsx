"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { departmentOutlook, stageLong } from "../../lib/forecast";
import { journey, minutesText, type Accuracy } from "../../lib/journey";
import type { ModelCard } from "../../lib/model-card";
import { Icon, type IconName } from "../journey-icons";
import { useDesk } from "./desk-context";
import { OutlookChart } from "./forecast-marks";
import { ViewHead } from "./shell";

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** Where each prediction goes, so nobody has to guess what the model drives. */
const uses: { icon: IconName; title: string; body: string; href: string; who: string }[] = [
  {
    icon: "phone",
    title: "The patient's wait range",
    body: "The wait to be seen, published as “likely within about …”. Code withholds it for triage levels 1 and 2, flagged visits, a stale feed or a range wider than six hours.",
    href: "/patient/visit",
    who: "Patient and approved family",
  },
  {
    icon: "spark",
    title: "When the Visit Agent wakes",
    body: "A range that moves past a threshold wakes the agent, which decides whether the change is worth a message. At most one range text per 30 minutes.",
    href: "/professional/ed/agent",
    who: "Visit Agent",
  },
  {
    icon: "inbox",
    title: "Who waited past their range",
    body: "Patients still waiting after the longest time they were told are listed on Now, for a Waiting Room Care Provider to check on.",
    href: "/professional/ed",
    who: "Waiting room staff",
  },
  {
    icon: "board",
    title: "Next milestone on the Board",
    body: "Every open visit shows its next step as a range, including results, the decision and an inpatient bed, which patients never see.",
    href: "/professional/ed/board",
    who: "Charge nurse, patient flow",
  },
  {
    icon: "target",
    title: "Scored against what happened",
    body: "Each estimate is logged with the model version and scored when the step happens. A run of misses widens the next ranges for that step.",
    href: "/professional/ed/accuracy",
    who: "Anyone checking the model",
  },
];

export default function ForecastView({ card }: { card: ModelCard | null }) {
  const { desk, ready } = useDesk();
  const [accuracy, setAccuracy] = useState<Accuracy | null>(null);

  useEffect(() => {
    if (!ready) return;
    let active = true;
    const load = () =>
      journey
        .accuracy()
        .then((next) => active && setAccuracy(next))
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [ready]);

  const outlook = departmentOutlook(desk?.patients ?? []);
  const ceiling = Math.max(1, ...outlook.map((row) => row.patients));
  const live = (stage: string) => accuracy?.stages.find((row) => row.stage === stage);

  return (
    <>
      <ViewHead
        eyebrow="Model"
        title="Forecasts"
        lede="The stage-time model estimates the minutes until every step still ahead in each visit. Here are those estimates added up for the department, where each one is used, and how well the model scored before it shipped."
      />

      <section className="vca-panel" aria-labelledby="vcf-out-title">
        <div className="vca-panel-head">
          <h2 id="vcf-out-title">Next eight hours</h2>
          <span className="vca-model-tag">
            <Icon name="forecast" size={16} />
            {desk?.model?.version ?? "model"}
          </span>
        </div>
        <p className="vca-hint">
          Expected number of patients reaching each milestone: every open visit&apos;s chance of
          getting there in time, read off its 10th, 50th and 90th percentile and added up. Silenced
          visits are left out. Move along a chart to read any time.
        </p>
        {!desk && <div className="vc-skeleton" aria-label="Loading the forecast" />}
        {desk && outlook.length === 0 && (
          <p className="vca-quiet">No open visits with a step ahead.</p>
        )}
        <div className="vcf-outlooks">
          {outlook.map((row) => (
            <OutlookChart key={row.stage} outlook={row} ceiling={ceiling} />
          ))}
        </div>
      </section>

      <section className="vca-panel" aria-labelledby="vcf-use-title">
        <h2 id="vcf-use-title">Where the predictions go</h2>
        <p className="vca-hint">
          The model only produces numbers. Code decides who may see them; the language model never
          writes a number.
        </p>
        <ol className="vcf-uses">
          {uses.map((use, index) => (
            <li key={use.title}>
              <span className="vcf-use-step">{index + 1}</span>
              <div>
                <h3>
                  <Icon name={use.icon} size={18} />
                  {use.title}
                </h3>
                <p>{use.body}</p>
                <Link href={use.href} className="vca-more">
                  {use.who}
                  <Icon name="arrow" size={16} />
                </Link>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="vca-panel" aria-labelledby="vcf-card-title">
        <div className="vca-panel-head">
          <h2 id="vcf-card-title">Model card</h2>
          {card && <span className="vca-model-tag">{card.version}</span>}
        </div>
        <p className="vca-hint">
          One gradient-boosted quantile model per step and percentile, 47 inputs all computable from
          the OPOR feed, then conformal calibration per triage band and time of day. Trained on
          50,258 real US emergency visits (NHAMCS 2018–22) placed in simulated departments tuned to
          Nova Scotia&apos;s published waits. It has never seen Nova Scotia patient data.
        </p>
        {!card ? (
          <p className="vca-quiet">The training report isn&apos;t available on this server.</p>
        ) : (
          <>
            <div className="vc-table-wrap">
              <table className="vc-table vcf-card">
                <thead>
                  <tr>
                    <th scope="col">Step</th>
                    <th scope="col">Held, NS reference</th>
                    <th scope="col">Held, 12 unseen depts</th>
                    <th scope="col">Ran over</th>
                    <th scope="col">Typical error</th>
                    <th scope="col">Median width</th>
                    <th scope="col">Better than a lookup table</th>
                    <th scope="col">Held in this demo</th>
                  </tr>
                </thead>
                <tbody>
                  {card.stages.map((row) => {
                    const here = live(row.stage);
                    return (
                      <tr key={row.stage}>
                        <th scope="row">{stageLong[row.stage]}</th>
                        <td className="vca-num">
                          <Meter value={row.reference.coverage} />
                        </td>
                        <td className="vca-num">
                          <Meter value={row.unseen.coverage} />
                        </td>
                        <td className="vca-num">{pct(row.reference.ranOver)}</td>
                        <td className="vca-num">{minutesText(row.reference.error)}</td>
                        <td className="vca-num">{minutesText(row.reference.width)}</td>
                        <td className="vca-num">
                          {row.gainVsTable === null ? "–" : pct(row.gainVsTable)}
                        </td>
                        <td className="vca-num">
                          {here && here.total
                            ? `${pct(here.inside / here.total)} of ${here.total}`
                            : "–"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {card.atTriage && (
              <p className="vca-hint">
                Wait to be seen, estimated at triage: typical error {card.atTriage.model} min,
                against {card.atTriage.rolling} min for a rolling average of recent waits and{" "}
                {card.atTriage.formula} min for the queue formula it replaced. Simulated departments
                flatter this gap; published real-hospital gains are 10–30%.
              </p>
            )}
          </>
        )}
        <div className="vcf-roadmap">
          <span>
            <b>Built:</b> stage times for triage, being seen, results, decision and bed
          </span>
          <span>
            <b>Proposed, not built:</b> leave-risk and admission-likelihood models
          </span>
        </div>
      </section>
    </>
  );
}

function Meter({ value }: { value: number }) {
  return (
    <span className="vcf-meter" aria-label={`${pct(value)} against an 80% target`}>
      <span aria-hidden="true">
        <i style={{ width: `${value * 100}%` }} />
        <b />
      </span>
      {pct(value)}
    </span>
  );
}
