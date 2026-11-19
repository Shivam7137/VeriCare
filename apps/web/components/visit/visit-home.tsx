"use client";
import type { CSSProperties } from "react";
import { clock, journey, minutesText, type LiveVisit } from "../../lib/journey";
import { Icon } from "../journey-icons";
import type { Act, VisitTab } from "../visit-page";

type Row = { key: string; label: string; low: number; high: number; headline: string };

/** The home screen: where you are, what the model expects, and anything asked of you. */
export default function VisitHome({
  visit,
  busy,
  act,
  go,
  unread,
  intro,
}: {
  visit: LiveVisit;
  busy: boolean;
  act: Act;
  go: (tab: VisitTab) => void;
  unread: number;
  /** First screen of the session: the cards arrive as one wave, once. */
  intro: boolean;
}) {
  const { badges } = visit;
  const latest = [...visit.messages].reverse().find((message) => message.direction === "out");
  const now = visit.ended ? visit.steps.length + 1 : visit.friendlyStep;
  const next = visit.ended ? null : visit.steps[visit.friendlyStep];

  return (
    <div className="vcp-home" data-intro={intro || undefined}>
      <section className="vcp-hero" data-beat="0" aria-live="polite">
        <p className="vc-eyebrow">
          {visit.ended ? "Your visit" : `Step ${visit.friendlyStep} of ${visit.steps.length}`}
        </p>
        <h1 key={visit.step} className="vc-fade">
          {visit.ended ? "Visit ended" : visit.steps[visit.friendlyStep - 1]}
        </h1>
        <p>{visit.sentence}</p>
        <ol className="vcp-steps" aria-label="Steps in your visit">
          {visit.steps.map((label, index) => {
            const state = index + 1 < now ? "done" : index + 1 === now ? "now" : "next";
            return (
              <li
                key={label}
                data-state={state}
                aria-current={state === "now" ? "step" : undefined}
              >
                <span className="vc-sr">
                  {label}: {state === "done" ? "done" : state === "now" ? "now" : "later"}
                </span>
              </li>
            );
          })}
        </ol>
        {next && (
          <p className="vcp-next">
            Next: <b>{next}</b>
          </p>
        )}
        {(badges.testsInProgress || badges.resultsReady || badges.bedRequested) && (
          <div className="vc-chips">
            {badges.testsInProgress && (
              <span className="vc-chip">
                <Icon name="flask" size={16} />
                Tests underway
              </span>
            )}
            {badges.resultsReady && (
              <span className="vc-chip" data-tone="good">
                <Icon name="check" size={16} />
                Results are back
              </span>
            )}
            {badges.bedRequested && <span className="vc-chip">Bed requested</span>}
          </div>
        )}
      </section>

      {visit.checkInDue && (
        <section className="vcp-card vcp-checkin" data-beat="1">
          <h2>How are you feeling?</h2>
          <p>You&apos;ve been waiting a while. Your answer goes straight to the nurse.</p>
          <div className="vcp-trio">
            {(["better", "same", "worse"] as const).map((answer) => (
              <button
                key={answer}
                className="vc-btn"
                data-kind={answer === "worse" ? "danger-quiet" : "quiet"}
                disabled={busy}
                onClick={() => act(() => journey.checkIn(answer))}
              >
                {answer[0]!.toUpperCase() + answer.slice(1)}
              </button>
            ))}
          </div>
        </section>
      )}

      {!visit.ended && <Estimate visit={visit} />}

      {latest && (
        <button className="vcp-card vcp-latest" data-beat="2" onClick={() => go("updates")}>
          <span className="vcp-latest-head">
            <Icon name="chat" size={18} />
            Latest update
            <time dateTime={latest.at}>{clock(latest.at)}</time>
          </span>
          <span className="vcp-latest-body">{latest.body}</span>
          <span className="vcp-link">
            {unread > 1 ? `${unread} new updates` : "All updates"}
            <Icon name="arrow" size={16} />
          </span>
        </button>
      )}

      {!visit.ended && (
        <div className="vcp-shortcuts" data-beat="3">
          <button className="vcp-card" onClick={() => go("people")}>
            <Icon name="people" size={22} />
            <span>
              <b>Family updates</b>
              <small>
                {visit.contacts.length
                  ? `${visit.contacts.length} ${visit.contacts.length === 1 ? "person" : "people"} added`
                  : "Add someone"}
              </small>
            </span>
          </button>
          <button className="vcp-card" onClick={() => go("help")}>
            <Icon name="help" size={22} />
            <span>
              <b>Help and questions</b>
              <small>Parking, Wi-Fi, leaving</small>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The model's estimates for this visit, drawn on one time line from now. The
 * patient sees the published range only; the API withholds it whenever code
 * decides an estimate would not be reliable or appropriate.
 */
function Estimate({ visit }: { visit: LiveVisit }) {
  const rows: Row[] = [
    ...(visit.range
      ? [
          {
            key: "seen",
            label: "Seen by the care team",
            low: visit.range.lowMinutes,
            high: visit.range.highMinutes,
            headline: visit.range.headline,
          },
        ]
      : []),
    ...visit.outlook.map((item) => ({
      key: item.stage,
      label: item.label,
      low: item.lowMinutes,
      high: item.highMinutes,
      headline: item.headline,
    })),
  ];
  if (!rows.length) {
    return visit.step === "waiting" ? (
      <section className="vcp-card vcp-estimate" data-beat="1">
        <h2>
          <Icon name="clock" size={20} />
          Your time estimate
        </h2>
        <p className="vcp-muted">
          No estimate right now. We only show one when we can give you a range we trust. Sicker
          patients are always seen first.
        </p>
      </section>
    ) : null;
  }

  const longest = Math.max(...rows.map((row) => row.high));
  const step = longest > 360 ? 120 : 60;
  const max = Math.max(60, Math.ceil((longest * 1.1) / step) * step);
  const at = (minutes: number) => `${Math.min(minutes / max, 1) * 100}%`;
  // The band is clipped to the range; keep it at least 3% wide so a tight range stays visible.
  const band = (low: number, high: number) => {
    const lo = Math.min(low / max, 0.97);
    const hi = Math.max(Math.min(high / max, 1), lo + 0.03);
    return { "--lo": `${lo * 100}%`, "--hi": `${hi * 100}%` } as CSSProperties;
  };
  const ticks = Array.from({ length: max / step + 1 }, (_, index) => index * step);
  const [first, ...rest] = rows;

  return (
    <section className="vcp-card vcp-estimate" data-beat="1" aria-labelledby="vcp-est-title">
      <h2 id="vcp-est-title">
        <Icon name="clock" size={20} />
        Your time estimate
      </h2>
      <div className="vcp-est-main">
        <span>
          {first!.key === "seen" ? "You'll likely be seen within" : `${first!.label} within`}
        </span>
        {/* The number carries the message; the server's full sentence is what screen readers hear. */}
        <strong key={first!.high} className="vc-fade" aria-label={first!.headline}>
          <small>about</small> {minutesText(first!.high)}
        </strong>
        <span className="vcp-muted">{soonerLine(first!.low)}</span>
      </div>

      <div
        className="vcp-line"
        role="img"
        aria-label={rows
          .map((row) =>
            row.low < SOONEST
              ? `${row.label}: any time in the next ${minutesText(row.high)}`
              : `${row.label}: between ${minutesText(row.low)} and ${minutesText(row.high)} from now`,
          )
          .join(". ")}
      >
        <div className="vcp-line-axis" aria-hidden="true">
          {ticks.map((minutes) => (
            <span key={minutes} style={{ left: at(minutes) }}>
              {minutes === 0 ? "Now" : `${minutes / 60} h`}
            </span>
          ))}
        </div>
        {rows.map((row, index) => (
          <div key={row.key} className="vcp-line-row" data-first={index === 0 || undefined}>
            {rows.length > 1 && <span className="vcp-line-label">{row.label}</span>}
            <span className="vcp-line-track" aria-hidden="true">
              {ticks.map((minutes) => (
                <i key={minutes} style={{ left: at(minutes) }} />
              ))}
              <b style={band(row.low, row.high)} />
            </span>
          </div>
        ))}
      </div>
      <p className="vcp-legend">
        <span aria-hidden="true" />
        Most likely somewhere in the shaded part
      </p>

      {visit.range?.reason && (
        <p className="vcp-why">
          <Icon name="pulse" size={18} />
          <span>
            <b>Why it changed:</b> {visit.range.reason}
          </span>
        </p>
      )}

      {rest.length > 0 && (
        <ul className="vcp-est-more">
          {rest.map((row) => (
            <li key={row.key}>
              <span>{row.label}</span>
              <b aria-label={row.headline}>within about {minutesText(row.high)}</b>
            </li>
          ))}
        </ul>
      )}

      <details className="vcp-how">
        <summary>How is this worked out?</summary>
        <p>
          A prediction model looks at how busy the department is right now: how many people are
          ahead of you, how sick they are, how quickly patients are being seen, and the time of day.
          It was trained using about 50,000 real emergency visits and is built to be right about 8
          times out of 10, so we show a range rather than a single time.
        </p>
        <p>
          It updates by itself as things change. Sicker patients are always seen first, so a very
          urgent arrival can push the time later. It is an estimate, not an appointment.
        </p>
      </details>
    </section>
  );
}

/** Below this a lower bound means "it could be soon", not a time worth naming. */
const SOONEST = 15;

/** The line under the headline. Never "from about 0 min": a bound that low tells nobody anything. */
function soonerLine(low: number): string {
  return low < SOONEST
    ? "It could be sooner. Sicker patients are seen first, so this can change."
    : `Probably not before about ${minutesText(low)}. This can change.`;
}
