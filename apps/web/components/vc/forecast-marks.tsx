"use client";
import { useId, useState, type PointerEvent } from "react";
import { horizon, scale, stageLong, type StageOutlook } from "../../lib/forecast";
import { minutesText, stageNames, type DeskStage } from "../../lib/journey";

// Marks for the stage-time model. Position carries the prediction (research on
// clinical uncertainty displays found spatial ranges trusted over colour codes):
// a soft bar from the 10th to the 90th percentile and a solid tick at the median.

const hourTicks = (max: number) => {
  const step = max > 600 ? 240 : max > 300 ? 120 : 60;
  return Array.from({ length: Math.floor(max / step) + 1 }, (_, index) => index * step);
};
const tickLabel = (minutes: number) => (minutes === 0 ? "now" : `${minutes / 60} h`);

/** The hour scale shared by a column of range bars. */
export function RangeAxis({ max }: { max: number }) {
  const at = scale(max);
  return (
    <div className="vcf-axis" aria-hidden="true">
      {hourTicks(max).map((minutes) => (
        <span key={minutes} style={{ left: `${at(minutes) * 100}%` }}>
          {tickLabel(minutes)}
          {minutes === max ? "+" : ""}
        </span>
      ))}
    </div>
  );
}

/** One stage's predicted range on a shared scale, readable without colour. */
export function RangeBar({
  stage,
  max,
  label = true,
  told,
}: {
  stage: DeskStage;
  max: number;
  label?: boolean;
  /** The longest wait the patient was told, drawn as a marker for comparison. */
  told?: number;
}) {
  const at = scale(max);
  const left = at(stage.lowMinutes) * 100;
  const width = Math.max(at(stage.highMinutes) * 100 - left, 1.2);
  const clipped = stage.highMinutes > max;
  const words = `${stageLong[stage.stage]}: likely in about ${minutesText(stage.typicalMinutes)}, between ${minutesText(stage.lowMinutes)} and ${minutesText(stage.highMinutes)}`;
  return (
    <div className="vcf-range" data-tip={words}>
      {label && <span className="vcf-range-name">{stageNames[stage.stage]}</span>}
      <span className="vcf-track" role="img" aria-label={words}>
        {hourTicks(max).map((minutes) => (
          <i key={minutes} className="vcf-grid" style={{ left: `${at(minutes) * 100}%` }} />
        ))}
        <b
          className="vcf-band"
          data-clipped={clipped || undefined}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
        <b className="vcf-median" style={{ left: `${at(stage.typicalMinutes) * 100}%` }} />
        {told !== undefined && (
          <b className="vcf-told" style={{ left: `${at(told) * 100}%` }} title="Told the patient" />
        )}
      </span>
      {label && (
        <span className="vcf-range-text">
          ~{minutesText(stage.typicalMinutes)}
          <small>
            {minutesText(stage.lowMinutes)}–{minutesText(stage.highMinutes)}
          </small>
        </span>
      )}
    </div>
  );
}

const W = 320;
const H = 84;
const PAD = { top: 10, right: 8, bottom: 20, left: 8 };

/**
 * Expected number of patients reaching one milestone over the next eight hours:
 * a cumulative area, one per stage as small multiples so no colour key is needed.
 */
export function OutlookChart({ outlook, ceiling }: { outlook: StageOutlook; ceiling: number }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const last = horizon[horizon.length - 1]!;
  const x = (minutes: number) => PAD.left + (minutes / last) * (W - PAD.left - PAD.right);
  const y = (value: number) =>
    PAD.top + (1 - value / Math.max(ceiling, 1)) * (H - PAD.top - PAD.bottom);
  const line = outlook.expected.map((value, index) => `${x(horizon[index]!)},${y(value)}`);
  const area = `M${x(0)},${y(0)} L${line.join(" L")} L${x(last)},${y(0)} Z`;
  const at = (hours: number) => outlook.expected[horizon.indexOf(hours * 60)] ?? 0;
  const shown = hover ?? horizon.indexOf(120);

  const move = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = ((event.clientX - box.left) / box.width) * W;
    const minutes = ((ratio - PAD.left) / (W - PAD.left - PAD.right)) * last;
    const index = Math.round(Math.min(Math.max(minutes, 0), last) / 15);
    setHover(index);
  };

  return (
    <figure className="vcf-outlook">
      <figcaption>
        <strong>{stageLong[outlook.stage]}</strong>
        <span>
          {outlook.patients} {outlook.patients === 1 ? "patient" : "patients"} with an estimate
        </span>
      </figcaption>
      <dl className="vcf-outlook-nums">
        {[1, 2, 4].map((hours) => (
          <div key={hours}>
            <dt>Within {hours} h</dt>
            <dd>{at(hours).toFixed(1)}</dd>
          </div>
        ))}
      </dl>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby={`${id}-desc`}
        onPointerMove={move}
        onPointerLeave={() => setHover(null)}
      >
        <desc id={`${id}-desc`}>
          Expected {stageLong[outlook.stage].toLowerCase()}: {at(1).toFixed(1)} within 1 hour,{" "}
          {at(2).toFixed(1)} within 2 hours, {at(4).toFixed(1)} within 4 hours, {at(8).toFixed(1)}{" "}
          within 8 hours.
        </desc>
        {[0, 2, 4, 6, 8].map((hours) => (
          <g key={hours}>
            <line
              className="vcf-gridline"
              x1={x(hours * 60)}
              x2={x(hours * 60)}
              y1={PAD.top}
              y2={y(0)}
            />
            <text className="vcf-tick" x={x(hours * 60)} y={H - 5} textAnchor="middle">
              {hours === 0 ? "now" : `${hours} h`}
            </text>
          </g>
        ))}
        <line className="vcf-baseline" x1={x(0)} x2={x(last)} y1={y(0)} y2={y(0)} />
        <path className="vcf-area" d={area} />
        <polyline className="vcf-line" points={line.join(" ")} />
        <line
          className="vcf-cross"
          x1={x(horizon[shown]!)}
          x2={x(horizon[shown]!)}
          y1={PAD.top}
          y2={y(0)}
        />
        <circle
          className="vcf-dot"
          cx={x(horizon[shown]!)}
          cy={y(outlook.expected[shown]!)}
          r={4}
        />
      </svg>
      <p className="vcf-readout" aria-live="polite">
        By {tickLabel(horizon[shown]!) === "now" ? "now" : `+${minutesText(horizon[shown]!)}`}:{" "}
        <b>{outlook.expected[shown]!.toFixed(1)}</b> expected
        <span> of {outlook.patients}</span>
      </p>
    </figure>
  );
}
