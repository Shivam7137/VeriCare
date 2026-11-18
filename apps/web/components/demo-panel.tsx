import {
  stepLabel,
  type Arrivals,
  type DemoAction,
  type DemoLive,
  type DemoPatient,
  type Staffing,
} from "../lib/demo";
import { clock, minutesText } from "../lib/journey";
import { Glyph } from "./demo-glyphs";
import "../app/demo-panel.css";

// The detail panel of the demo bar: every patient with a "Next" button, the department's
// levers, and a short feed of what just happened.

export function Brand({ running }: { running?: boolean }) {
  return (
    <div className="dbar-brand">
      <span className="dbar-dot" data-live={running ? "on" : "off"} aria-hidden="true" />
      <b>Demo</b>
    </div>
  );
}

export function Toast({ text, warn }: { text: string; warn: boolean }) {
  return (
    <p className="dbar-toast" role="status" data-warn={warn || undefined}>
      {text}
    </p>
  );
}

function Seg<T extends string>({
  label,
  value,
  options,
  disabled,
  onPick,
}: {
  label: string;
  value: T;
  options: readonly { value: T; text: string }[];
  disabled: boolean;
  onPick: (value: T) => void;
}) {
  return (
    <div className="dbar-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onPick(option.value)}
        >
          {option.text}
        </button>
      ))}
    </div>
  );
}

export function Panel({
  live,
  focusId,
  busy,
  onAskReset,
  onPick,
  onRun,
}: {
  live: DemoLive;
  focusId: string | null;
  busy: boolean;
  onAskReset: () => void;
  onPick: (id: string) => void;
  onRun: (key: string, action: DemoAction) => void;
}) {
  const { counts, model } = live;
  return (
    <div className="dbar-panel" id="dbar-panel">
      <div role="group" className="dbar-people" aria-label="Patients">
        <h3>Patients</h3>
        <ul>
          {live.patients.map((patient: DemoPatient) => (
            <li key={patient.id} data-focus={patient.id === focusId || undefined}>
              <button
                type="button"
                className="dbar-pick"
                aria-pressed={patient.id === focusId}
                onClick={() => onPick(patient.id)}
              >
                <span
                  className="dbar-ctas"
                  data-ctas={patient.ctas ?? 0}
                  aria-label={patient.ctas ? `Triage level ${patient.ctas}` : "Not triaged yet"}
                >
                  {patient.ctas ?? "–"}
                </span>
                <span className="dbar-name">
                  {patient.name}
                  {patient.mine && <em>you</em>}
                </span>
                <span className="dbar-step">
                  {stepLabel[patient.step] ?? patient.step}
                  {patient.waitMinutes !== null && ` · ${minutesText(patient.waitMinutes)}`}
                </span>
              </button>
              <button
                type="button"
                className="dbar-go"
                disabled={busy || patient.next === null}
                title={patient.next ?? "This visit follows its own script"}
                aria-label={
                  patient.next
                    ? `Move ${patient.name}: ${patient.next}`
                    : `${patient.name} follows a script`
                }
                onClick={() => onRun(`go-${patient.id}`, { type: "next", patientId: patient.id })}
              >
                Next ▸
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div role="group" className="dbar-levers" aria-label="The department">
        <h3>The department</h3>
        <div className="dbar-field">
          <span>Walk-ins</span>
          <Seg<Arrivals>
            label="Walk-ins"
            value={live.arrivals}
            disabled={busy}
            options={[
              { value: "off", text: "None" },
              { value: "normal", text: "Normal" },
              { value: "busy", text: "Busy" },
            ]}
            onPick={(value) => onRun(`arrivals-${value}`, { type: "arrivals", value })}
          />
        </div>
        <div className="dbar-field">
          <span>Staff on shift</span>
          <Seg<Staffing>
            label="Staff on shift"
            value={live.staffing}
            disabled={busy}
            options={[
              { value: "low", text: "Few" },
              { value: "normal", text: "Normal" },
              { value: "high", text: "Many" },
            ]}
            onPick={(value) => onRun(`staffing-${value}`, { type: "staffing", value })}
          />
        </div>
        <div className="dbar-field">
          <span>Add one patient at triage level (1 most urgent, 5 least)</span>
          <div className="dbar-levels">
            {([1, 2, 3, 4, 5] as const).map((level) => (
              <button
                key={level}
                type="button"
                className="dbar-ctas"
                data-ctas={level}
                disabled={busy}
                title={`Level ${level}${level === 1 ? " (most urgent)" : level === 5 ? " (least urgent)" : ""}`}
                aria-label={`Add a level ${level} patient`}
                onClick={() => onRun(`level-${level}`, { type: "add", count: 1, ctas: level })}
              >
                {level}
              </button>
            ))}
          </div>
        </div>
        <dl className="dbar-counts">
          <div>
            <dt>Waiting</dt>
            <dd>{counts.waiting}</dd>
          </div>
          <div>
            <dt>With a team</dt>
            <dd>{counts.beingSeen}</dd>
          </div>
          <div>
            <dt>Waiting for a bed</dt>
            <dd>{counts.boarding}</dd>
          </div>
          <div>
            <dt>Gone home</dt>
            <dd>{counts.finished}</dd>
          </div>
        </dl>
        <div className="dbar-reset">
          <button type="button" disabled={busy} onClick={onAskReset}>
            Reset the demo
          </button>
          <span>
            {live.idleReset.minutes > 0
              ? `It also starts over by itself after ${live.idleReset.minutes} minutes without use.`
              : "It does not start over by itself."}
          </span>
        </div>
      </div>

      <div role="group" className="dbar-feed" aria-label="What just happened">
        <h3>What just happened</h3>
        <ol>
          {live.recent.length === 0 && <li>Nothing yet.</li>}
          {live.recent.map((item, index) => (
            <li key={`${item.at}-${index}`}>
              <time>{clock(item.at)}</time> {item.text}
            </li>
          ))}
        </ol>
        <p className="dbar-model-note">
          {model.version
            ? `Wait times come from the trained model (${model.version}), re-run after every change.`
            : "No trained model is loaded, so waits use the queue formula."}
        </p>
      </div>
    </div>
  );
}

/** Asks before wiping every fictional visit. Sits above the bar, where the toast does. */
export function ConfirmReset({
  busy,
  onYes,
  onNo,
}: {
  busy: boolean;
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <div className="dbar-confirm" role="alertdialog" aria-label="Start the demo over?">
      <Glyph name="reset" />
      <span>Start over? This clears every fictional visit.</span>
      <button type="button" className="dbar-danger" disabled={busy} onClick={onYes}>
        Reset the demo
      </button>
      <button type="button" onClick={onNo} autoFocus>
        Keep going
      </button>
    </div>
  );
}
