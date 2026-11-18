"use client";
import Link from "next/link";
import { useState, type HTMLAttributes, type ReactNode } from "react";
import type { DemoAction, DemoLive, JudgeContact, JudgePhone, Staffing } from "../lib/demo";
import { clock } from "../lib/journey";
import { Glyph } from "./demo-glyphs";
import { Brand } from "./demo-panel";

// The guided demo: three steps, one per app. Choosing a step opens that app in this tab and
// shows what to look for there, with only the controls that belong to it. Nothing sends a
// judge to a separate site: the emergency contact lives in a text thread inside the bar.
// "Advanced" opens the full bar (demo-advanced.tsx).

export type StepKey = 1 | 2 | 3;
type Run = (key: string, action: DemoAction | DemoAction[], note?: string) => void;

export const APPS: Record<StepKey, string> = {
  1: "/professional/ed",
  2: "/patient/visit",
  3: "/professional/ed/mission",
};
/** Whether `path` is already inside the app that `step` is about. */
export function onApp(step: StepKey, path: string): boolean {
  if (step === 2) return path.startsWith("/patient");
  if (step === 3) return path.startsWith(APPS[3]);
  return path.startsWith("/professional/ed") && !path.startsWith(APPS[3]);
}

const STEPS: Record<StepKey, { title: string; short: string; open: string }> = {
  1: {
    title: "Run the ER from the nursing app",
    short: "Nursing app",
    open: "Open the nursing app",
  },
  2: { title: "Be Maya, and be her family", short: "Patient side", open: "Open Maya's app" },
  3: { title: "Look under the hood", short: "Mission control", open: "Open mission control" },
};

const delivery: Record<string, string> = {
  queued: "Sending to your phone…",
  simulated: "Shown here only: this server does not send real texts.",
  accepted: "Also sent to your phone.",
  sent: "Also sent to your phone.",
  delivered: "Also delivered to your phone.",
  blocked: "Not sent to your phone: the number is not on this server's allow-list.",
  failed: "Not sent to your phone: the text provider refused it.",
};

export function GuidedDeck({
  live,
  ready,
  stuck,
  busy,
  step,
  surged,
  contact,
  path,
  grip,
  onStep,
  onRun,
  onContact,
  onAsk,
  onForget,
  onAskReset,
  onAdvanced,
  onTuck,
}: {
  live: DemoLive | null;
  /** False while connecting. */
  ready: boolean;
  stuck: boolean;
  busy: string;
  step: StepKey;
  surged: boolean;
  contact: JudgeContact | null;
  path: string;
  grip: HTMLAttributes<HTMLButtonElement>;
  onStep: (step: StepKey) => void;
  onRun: Run;
  onContact: (phone: string) => void;
  onAsk: (text: string) => void;
  onForget: () => void;
  onAskReset: () => void;
  onAdvanced: () => void;
  onTuck: () => void;
}) {
  const phone = live?.phone?.active ? live.phone : null;
  const done: Record<StepKey, boolean> = {
    1: Boolean(live?.running),
    2: Boolean(phone && contact),
    3: surged,
  };
  const here = onApp(step, path);
  return (
    <>
      <div className="dbar-row dbar-guide-head">
        <button
          type="button"
          className="dbar-grip"
          aria-label="Move the demo controls with the arrow keys. Home puts them back."
          title="Drag or use the arrow keys to move. Double-click or Home to put it back."
          {...grip}
        >
          <Glyph name="grip" />
        </button>
        <Brand running={live?.running} />
        <ol className="dbar-steps" aria-label="Demo steps, one per app">
          {([1, 2, 3] as const).map((key) => (
            <li key={key}>
              <button
                type="button"
                className="dbar-stepbtn"
                aria-current={step === key ? "step" : undefined}
                data-done={done[key] || undefined}
                title={STEPS[key].title}
                onClick={() => onStep(key)}
              >
                <span className="dbar-stepnum" aria-hidden="true">
                  {done[key] ? "✓" : key}
                </span>
                <span className="dbar-steptext">{STEPS[key].short}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="dbar-end">
          {live && (
            <span className="dbar-miniclock" title="The emergency department's clock">
              {clock(live.clock)}
              {live.running ? ` · ×${live.speed}` : " · paused"}
            </span>
          )}
          <button
            type="button"
            className="dbar-mode"
            title="Every control: speed, patients, staffing, each visit"
            onClick={onAdvanced}
          >
            Advanced
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

      <section className="dbar-stage" aria-label={`Step ${step}: ${STEPS[step].title}`}>
        {!ready ? (
          <p className="dbar-note">Connecting to the demo…</p>
        ) : (
          <>
            <div className="dbar-lead">
              <h3>
                <span>Step {step}</span> {STEPS[step].title}
              </h3>
              <p>{LEADS[step]}</p>
              {here ? (
                <span className="dbar-here">You&rsquo;re in this app</span>
              ) : (
                <Link className="dbar-open" href={APPS[step]}>
                  {STEPS[step].open} ›
                </Link>
              )}
            </div>
            {step === 1 ? (
              <StepOne
                live={live}
                stuck={stuck}
                busy={busy}
                onRun={onRun}
                onAskReset={onAskReset}
              />
            ) : step === 2 ? (
              <StepTwo
                live={live}
                stuck={stuck}
                busy={busy}
                phone={contact ? phone : null}
                onRun={onRun}
                onAskReset={onAskReset}
                onContact={onContact}
                onAsk={onAsk}
                onForget={onForget}
              />
            ) : (
              <StepThree live={live} stuck={stuck} busy={busy} onRun={onRun} />
            )}
          </>
        )}
        <div className="dbar-stage-nav">
          {step > 1 && (
            <button type="button" onClick={() => onStep((step - 1) as StepKey)}>
              Back
            </button>
          )}
          {step < 3 ? (
            <button
              type="button"
              className="dbar-nextstage"
              disabled={!live}
              onClick={() => onStep((step + 1) as StepKey)}
            >
              Step {step + 1}: {STEPS[(step + 1) as StepKey].short} ›
            </button>
          ) : (
            <button type="button" onClick={onAdvanced}>
              Every control ›
            </button>
          )}
        </div>
      </section>
    </>
  );
}

const LEADS: Record<StepKey, ReactNode> = {
  1: (
    <>
      What the nurses see: a live emergency department fed by the same HL7 messages a hospital
      sends. <b>Now</b> ranks who needs a person, <b>Board</b> shows every patient. One real minute
      is an hour of ER.
    </>
  ),
  2: (
    <>
      Maya Chen&rsquo;s own app shows her step and her wait range. Add your phone number to be her
      emergency contact: her updates come to you by text, and you can text back a question about
      her.
    </>
  ),
  3: (
    <>
      Everything underneath, live: each hospital feed message, the wait model&rsquo;s predictions,
      and every decision the agent made about who to tell what. Surge the ER and watch it react.
    </>
  ),
};

function StepOne({
  live,
  stuck,
  busy,
  onRun,
  onAskReset,
}: {
  live: DemoLive | null;
  stuck: boolean;
  busy: string;
  onRun: Run;
  onAskReset: () => void;
}) {
  const start: DemoAction[] = live
    ? [{ type: "speed", value: 60 }]
    : [{ type: "reset" }, { type: "speed", value: 60 }];
  return (
    <>
      <div className="dbar-actions">
        {!live?.running ? (
          <button
            type="button"
            className="dbar-start"
            disabled={stuck || busy === "start"}
            onClick={() => onRun("start", start, "The ER is running: 1 minute every second.")}
          >
            <Glyph name="play" /> {busy === "start" ? "Starting…" : "Start the ER"}
          </button>
        ) : (
          <button type="button" disabled={stuck} onClick={() => onRun("pause", { type: "pause" })}>
            <Glyph name="pause" /> Pause
          </button>
        )}
        {live && (
          <>
            <div className="dbar-seg" role="group" aria-label="Speed">
              {([10, 60, 300] as const).map((speed) => (
                <button
                  key={speed}
                  type="button"
                  aria-pressed={live.running && live.speed === speed}
                  disabled={stuck}
                  onClick={() => onRun(`speed-${speed}`, { type: "speed", value: speed })}
                >
                  {speed === 10 ? "Slow" : speed === 60 ? "Fast" : "Faster"}
                </button>
              ))}
            </div>
            <button
              type="button"
              disabled={stuck}
              title="Five patients walk in"
              onClick={() => onRun("add-5", { type: "add", count: 5 })}
            >
              +5 walk-ins
            </button>
            <button type="button" className="dbar-quiet" disabled={stuck} onClick={onAskReset}>
              <Glyph name="reset" /> Start over
            </button>
          </>
        )}
      </div>
      {live && (
        <p className="dbar-fact">
          {live.counts.inDepartment} in the ER · {live.counts.waiting} waiting ·{" "}
          {live.counts.finished} gone home
        </p>
      )}
    </>
  );
}

function StepTwo({
  live,
  stuck,
  busy,
  phone,
  onRun,
  onContact,
  onAsk,
  onForget,
  onAskReset,
}: {
  live: DemoLive | null;
  stuck: boolean;
  busy: string;
  phone: JudgePhone | null;
  onRun: Run;
  onAskReset: () => void;
  onContact: (phone: string) => void;
  onAsk: (text: string) => void;
  onForget: () => void;
}) {
  const [number, setNumber] = useState("");
  const [question, setQuestion] = useState("");
  const maya = phone ? live?.patients.find((patient) => patient.id === phone.patientId) : null;

  if (!live) return <p className="dbar-note">Start the ER in step 1 first.</p>;
  // At speed Maya is seen and sent home within the hour; a fresh demo brings her back.
  if (!live.patients.some((patient) => patient.name === "Maya Chen"))
    return (
      <div className="dbar-actions">
        <p className="dbar-note">
          Maya has been sent home. Start over to meet her in the waiting room.
        </p>
        <button type="button" className="dbar-start" disabled={stuck} onClick={onAskReset}>
          <Glyph name="reset" /> Start over
        </button>
      </div>
    );
  if (!phone)
    return (
      <form
        className="dbar-actions dbar-phoneform"
        onSubmit={(event) => {
          event.preventDefault();
          if (number.trim()) onContact(number);
        }}
      >
        <label>
          <span className="dbar-sr">Your mobile number</span>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="Your mobile, e.g. 902 555 0134"
            value={number}
            maxLength={32}
            onChange={(event) => setNumber(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="dbar-start"
          disabled={stuck || busy === "contact" || !number.trim()}
        >
          {busy === "contact" ? "Adding…" : "Be her emergency contact"}
        </button>
        <small className="dbar-fine">
          Demo only. Your number is kept in the fictional demo data and wiped on every reset.
        </small>
      </form>
    );

  return (
    <>
      <div className="dbar-actions">
        <button
          type="button"
          disabled={stuck || !maya?.next}
          title={maya?.next ?? "Maya has nothing left to do right now"}
          onClick={() => maya && onRun("maya-next", { type: "next", patientId: maya.id })}
        >
          Move Maya to her next step ›
        </button>
        <button
          type="button"
          disabled={stuck}
          onClick={() => onRun("skip-60", { type: "skip", minutes: 60 })}
        >
          Skip 1 hour
        </button>
        <button type="button" className="dbar-quiet" onClick={onForget}>
          Use another number
        </button>
      </div>
      <div className="dbar-inbox" aria-label={`Text thread with ${phone.phone}`}>
        <h4>
          Your texts as Maya&rsquo;s emergency contact <small>{phone.phone}</small>
        </h4>
        <ol aria-live="polite">
          {phone.messages.slice(0, 4).map((message, index) => (
            <li key={`${message.at}-${index}`} data-dir={message.direction}>
              <p>{message.body}</p>
              <small>
                <time>{clock(message.at)}</time>
                {message.direction === "in" ? " · you" : ""}
              </small>
            </li>
          ))}
        </ol>
        <form
          className="dbar-ask"
          onSubmit={(event) => {
            event.preventDefault();
            const text = question.trim();
            if (!text) return;
            onAsk(text);
            setQuestion("");
          }}
        >
          <label>
            <span className="dbar-sr">Text a question about Maya</span>
            <input
              type="text"
              placeholder="Text back, e.g. How long until she's seen?"
              value={question}
              maxLength={500}
              onChange={(event) => setQuestion(event.target.value)}
            />
          </label>
          <button type="submit" disabled={stuck || busy === "ask" || !question.trim()}>
            {busy === "ask" ? "Sending…" : "Send"}
          </button>
        </form>
        {phone.delivery && <p className="dbar-fine">{delivery[phone.delivery] ?? ""}</p>}
      </div>
    </>
  );
}

function StepThree({
  live,
  stuck,
  busy,
  onRun,
}: {
  live: DemoLive | null;
  stuck: boolean;
  busy: string;
  onRun: Run;
}) {
  if (!live) return <p className="dbar-note">Start the ER in step 1 first.</p>;
  return (
    <>
      <div className="dbar-actions">
        <button
          type="button"
          className="dbar-surge"
          disabled={stuck || busy === "surge"}
          title="Five urgent patients arrive at once"
          onClick={() => onRun("surge", { type: "surge" })}
        >
          <Glyph name="bolt" /> Surge: 5 urgent patients
        </button>
        <button
          type="button"
          disabled={stuck}
          title="One level-1 patient, the most urgent"
          onClick={() => onRun("level-1", { type: "add", count: 1, ctas: 1 })}
        >
          +1 critical
        </button>
        <span className="dbar-inline-label">Staff on shift</span>
        <div className="dbar-seg" role="group" aria-label="Staff on shift">
          {(["low", "normal", "high"] as const satisfies readonly Staffing[]).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={live.staffing === value}
              disabled={stuck}
              onClick={() => onRun(`staffing-${value}`, { type: "staffing", value })}
            >
              {{ low: "Few", normal: "Normal", high: "Many" }[value]}
            </button>
          ))}
        </div>
      </div>
      <p className="dbar-fact">
        {live.counts.waiting} waiting ·{" "}
        {live.model.version
          ? `wait model ${live.model.version}, re-run after every change`
          : "no trained model loaded, using the queue formula"}
      </p>
    </>
  );
}
