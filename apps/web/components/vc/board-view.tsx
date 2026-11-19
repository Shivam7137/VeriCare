"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { minutesPastTold, nextStage } from "../../lib/forecast";
import { clock, journey, minutesText, stepNames, type DeskPatient } from "../../lib/journey";
import { Icon } from "../journey-icons";
import { useDesk } from "./desk-context";
import { RangeAxis, RangeBar } from "./forecast-marks";
import { patientHref } from "./now-view";
import { ViewHead } from "./shell";

const AXIS = 480;
const groups = {
  all: { label: "Everyone", test: () => true },
  waiting: {
    label: "Waiting",
    test: (p: DeskPatient) => p.step === "arrived" || p.step === "waiting",
  },
  seen: { label: "Being seen", test: (p: DeskPatient) => p.step === "being_seen" },
  deciding: { label: "Results back", test: (p: DeskPatient) => p.step === "deciding" },
  admitted: { label: "Admitted", test: (p: DeskPatient) => p.step === "admitted_waiting_bed" },
  silenced: { label: "Silenced", test: (p: DeskPatient) => p.flags.length > 0 || p.unmapped },
} as const;
type Group = keyof typeof groups;
const sorts = {
  next: "Next milestone",
  triage: "Triage level",
  time: "Time in department",
  name: "Name",
} as const;
type Sort = keyof typeof sorts;

export default function BoardView() {
  const { desk, busy, run } = useDesk();
  const [group, setGroup] = useState<Group>("all");
  const [sort, setSort] = useState<Sort>("next");
  const [query, setQuery] = useState("");
  const patients = desk?.patients ?? [];
  const feedTime = desk?.feed?.feedTime;

  const rows = useMemo(() => {
    const text = query.trim().toLowerCase();
    const picked = patients.filter(
      (patient) => groups[group].test(patient) && patient.name.toLowerCase().includes(text),
    );
    const key: Record<Sort, (p: DeskPatient) => number | string> = {
      next: (p) => nextStage(p)?.typicalMinutes ?? Number.MAX_SAFE_INTEGER,
      triage: (p) => p.ctas ?? 9,
      time: (p) => -(p.minutesInDepartment ?? 0),
      name: (p) => p.name,
    };
    return [...picked].sort((a, b) => {
      const x = key[sort](a);
      const y = key[sort](b);
      return typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
    });
  }, [patients, group, sort, query]);

  return (
    <>
      <ViewHead
        eyebrow="Work"
        title="Board"
        lede="Everyone in the department with the step they are on and the next milestone the stage-time model expects. Open a name for the whole visit."
      />
      <div className="vca-toolbar">
        <div className="vca-seg" role="group" aria-label="Show">
          {(Object.keys(groups) as Group[]).map((key) => (
            <button key={key} aria-pressed={group === key} onClick={() => setGroup(key)}>
              {groups[key].label}
              <em>{patients.filter(groups[key].test).length}</em>
            </button>
          ))}
        </div>
        <div className="vca-tools">
          <label className="vca-search">
            <span className="vc-sr">Find a patient</span>
            <input
              type="search"
              placeholder="Find a patient"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="vca-select">
            <span>Sort</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
              {(Object.keys(sorts) as Sort[]).map((key) => (
                <option key={key} value={key}>
                  {sorts[key]}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {desk?.feed && (
        <p className="vca-hint">
          {desk.patients.length} in the department as of {clock(desk.feed.feedTime)} on the
          department clock.
        </p>
      )}
      <section className="vca-panel vca-panel-flush" aria-label="Patients">
        {!desk && <div className="vc-skeleton" aria-label="Loading the board" />}
        {desk && rows.length === 0 && (
          <div className="vca-empty">
            <Icon name="board" size={28} />
            <p>{patients.length ? "No one matches." : "Nobody is in the department."}</p>
          </div>
        )}
        {rows.length > 0 && (
          <div className="vc-table-wrap">
            <table className="vc-table vca-board">
              <thead>
                <tr>
                  <th scope="col">Patient</th>
                  <th scope="col">Triage</th>
                  <th scope="col">Step</th>
                  <th scope="col">In dept.</th>
                  <th scope="col" className="vca-forecast-col">
                    <span className="vca-th-model">
                      Next milestone <Icon name="forecast" size={14} />
                    </span>
                    <RangeAxis max={AXIS} />
                  </th>
                  <th scope="col">Told</th>
                  <th scope="col">Privacy</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((patient) => (
                  <Row
                    key={patient.id}
                    patient={patient}
                    past={minutesPastTold(patient, feedTime)}
                    busy={busy === patient.id}
                    toggle={(active) =>
                      run(patient.id, () => journey.setFlag(patient.id, "confidential", active))
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Row({
  patient,
  past,
  busy,
  toggle,
}: {
  patient: DeskPatient;
  past: number | null;
  busy: boolean;
  toggle: (active: boolean) => void;
}) {
  const silenced = patient.flags.length > 0 || patient.unmapped;
  const confidential = patient.flags.includes("confidential");
  const next = nextStage(patient);
  return (
    <tr data-silenced={silenced}>
      <td>
        <Link href={patientHref(patient.id)} className="vca-name">
          {patient.name}
        </Link>
        {patient.stream === "rapid_assessment" && <div className="vc-muted">Rapid assessment</div>}
      </td>
      <td>
        {patient.ctas ? (
          <span className="vc-level" data-level={patient.ctas}>
            <span className="vc-sr">Triage level </span>
            {patient.ctas}
          </span>
        ) : (
          "–"
        )}
      </td>
      <td>
        {stepNames[patient.step] ?? patient.step}
        {patient.testsInProgress && <div className="vc-muted">Tests underway</div>}
      </td>
      <td className="vca-num">
        {patient.minutesInDepartment == null ? "–" : minutesText(patient.minutesInDepartment)}
      </td>
      <td className="vca-forecast-col">
        {next && !silenced ? (
          <RangeBar stage={next} max={AXIS} />
        ) : (
          <span className="vc-muted">{silenced ? "Withheld" : "No milestone ahead"}</span>
        )}
      </td>
      <td>
        {silenced ? (
          <span className="vc-chip" data-tone="danger">
            <Icon name="shield" size={16} />
            Silenced
          </span>
        ) : patient.range ? (
          <span className="vca-told" data-over={past !== null || undefined}>
            Within {minutesText(patient.range.highMinutes)}
            {past !== null && <small>{minutesText(past)} past</small>}
          </span>
        ) : (
          "–"
        )}
      </td>
      <td>
        <button
          className="vc-btn"
          data-kind={confidential ? "danger-quiet" : "quiet"}
          data-size="sm"
          disabled={busy}
          aria-pressed={confidential}
          onClick={() => toggle(!confidential)}
        >
          Confidential
        </button>
      </td>
    </tr>
  );
}
