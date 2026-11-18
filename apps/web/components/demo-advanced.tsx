import type { HTMLAttributes, Ref } from "react";
import { SPEEDS, speedHint, type DemoAction, type DemoLive } from "../lib/demo";
import { clock, minutesText } from "../lib/journey";
import { Glyph } from "./demo-glyphs";
import { Brand } from "./demo-panel";

// The full control row: every lever the demo has. Judges start in the guided 1-2-3 steps
// (demo-steps.tsx); this is what "Advanced" opens.

const first = (name: string) => name.split(" ")[0] ?? name;

export function AdvancedRow({
  live,
  stuck,
  grip,
  open,
  resetRef,
  onRun,
  onOpen,
  onAskReset,
  onSimple,
  onTuck,
}: {
  live: DemoLive;
  stuck: boolean;
  grip: HTMLAttributes<HTMLButtonElement>;
  open: boolean;
  resetRef: Ref<HTMLButtonElement>;
  onRun: (key: string, action: DemoAction) => void;
  onOpen: (open: boolean) => void;
  onAskReset: () => void;
  onSimple: () => void;
  onTuck: () => void;
}) {
  const act = (key: string, action: DemoAction) => () => onRun(key, action);
  const focus = live.focus;
  return (
    <div className="dbar-row">
      <button
        type="button"
        className="dbar-grip"
        aria-label="Move the demo controls with the arrow keys. Home puts them back."
        title="Drag or use the arrow keys to move. Double-click or Home to put it back."
        {...grip}
      >
        <Glyph name="grip" />
      </button>
      <Brand running={live.running} />

      <div role="group" className="dbar-group" aria-label="Time">
        <span className="dbar-cap" data-skipping={live.skipping ? "" : undefined}>
          {live.skipping ? `Skipping ahead · ${minutesText(live.skipping)} to go` : "Time"}
        </span>
        <div className="dbar-line">
          <button
            type="button"
            className="dbar-play"
            aria-label={live.running ? "Pause time" : "Play time"}
            title={live.running ? "Pause" : "Play"}
            disabled={stuck}
            onClick={act("play", { type: live.running ? "pause" : "play" })}
          >
            <Glyph name={live.running ? "pause" : "play"} />
          </button>
          <div className="dbar-clock" title="The emergency department's clock (Halifax time)">
            <b>{clock(live.clock)}</b>
            <small>{live.running ? speedHint(live.speed) : "Paused"}</small>
          </div>
          <div className="dbar-seg" role="group" aria-label="Speed">
            {SPEEDS.map((speed) => (
              <button
                key={speed}
                type="button"
                aria-pressed={live.running && live.speed === speed}
                title={`${speedHint(speed)}`}
                disabled={stuck}
                onClick={act(`speed-${speed}`, { type: "speed", value: speed })}
              >
                ×{speed}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div role="group" className="dbar-group" aria-label="Patients">
        <span className="dbar-cap">
          {live.counts.inDepartment} in the ER · {live.counts.waiting} waiting
        </span>
        <div className="dbar-line">
          <button
            type="button"
            disabled={stuck}
            title="One patient walks in"
            onClick={act("add-1", { type: "add", count: 1 })}
          >
            +1
          </button>
          <button
            type="button"
            disabled={stuck}
            title="Five patients walk in"
            onClick={act("add-5", { type: "add", count: 5 })}
          >
            +5
          </button>
          <button
            type="button"
            className="dbar-surge"
            disabled={stuck}
            title="Five urgent patients arrive at once, like a bus crash"
            onClick={act("surge", { type: "surge" })}
          >
            <Glyph name="bolt" /> Surge
          </button>
        </div>
      </div>

      <div role="group" className="dbar-group" aria-label="Move things along">
        <span className="dbar-cap">Move things along</span>
        <div className="dbar-line">
          <button
            type="button"
            className="dbar-next"
            disabled={stuck || (focus !== null && focus.next === null)}
            title={
              focus?.next
                ? `${focus.name}: ${focus.next}`
                : "Choose a patient in the list, then move them on"
            }
            onClick={() =>
              focus ? onRun("next", { type: "next", patientId: focus.id }) : onOpen(true)
            }
          >
            <span>Next step</span>
            <small>
              {focus
                ? focus.next
                  ? `${first(focus.name)} → ${focus.next.toLowerCase()}`
                  : `${first(focus.name)} follows a script`
                : "Pick a patient"}
            </small>
          </button>
          <button
            type="button"
            disabled={stuck}
            title="Skip ahead 15 minutes"
            onClick={act("skip-15", { type: "skip", minutes: 15 })}
          >
            +15m
          </button>
          <button
            type="button"
            disabled={stuck}
            title="Skip ahead one hour"
            onClick={act("skip-60", { type: "skip", minutes: 60 })}
          >
            +1h
          </button>
        </div>
      </div>

      <div className="dbar-end">
        <button
          type="button"
          ref={resetRef}
          className="dbar-resetbtn"
          aria-label="Reset the demo"
          title="Start the demo over from the beginning"
          disabled={stuck}
          onClick={onAskReset}
        >
          <Glyph name="reset" />
          <span className="dbar-btn-text">Reset</span>
        </button>
        <button
          type="button"
          className="dbar-more"
          aria-label={open ? "Less controls" : "More controls"}
          aria-expanded={open}
          aria-controls="dbar-panel"
          onClick={() => onOpen(!open)}
        >
          <Glyph name={open ? "down" : "up"} />
          <span className="dbar-btn-text">{open ? "Less" : "More"}</span>
        </button>
        <button
          type="button"
          className="dbar-mode"
          title="Back to the three guided steps"
          onClick={onSimple}
        >
          Simple
        </button>
        <button
          type="button"
          className="dbar-icon"
          aria-label="Tuck the demo controls away"
          title="Tuck away"
          onClick={onTuck}
        >
          <Glyph name="close" />
        </button>
      </div>
    </div>
  );
}
