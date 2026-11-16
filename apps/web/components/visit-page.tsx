"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { clock, journey, type LiveVisit, type Visit } from "../lib/journey";
import { enterWorkspace } from "../lib/workspace";
import { Icon } from "./journey-icons";
import VisitFamily from "./visit-family";

const REFRESH_MS = 2000;

export default function VisitPage() {
  const [visit, setVisit] = useState<Visit | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setVisit(await journey.visit());
      setError("");
    } catch {
      setError(
        "We can't reach the hospital system right now. Please ask your nurse for an update.",
      );
    }
  }, []);

  useEffect(() => {
    let active = true;
    enterWorkspace("patient")
      .then(() => {
        ready.current = true;
        if (active) void refresh();
      })
      .catch(() => {
        if (active) setError("This demo page isn't available right now.");
      });
    // Poll only while the tab is visible; the server decides what may be shown.
    const timer = window.setInterval(() => {
      if (ready.current && document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const act = async (work: () => Promise<{ reply: string }>) => {
    if (busy) return;
    setBusy(true);
    try {
      setToast((await work()).reply);
      await refresh();
    } catch {
      setToast("That didn't go through. Please tell a staff member directly.");
    } finally {
      setBusy(false);
    }
  };

  const live = visit?.mode === "live" ? visit : null;
  return (
    <div className="vc">
      <header className="vc-bar">
        <Link href="/" className="vc-brand">
          <span className="vc-brand-mark">
            <Icon name="heart" size={20} />
          </span>
          <span>
            VeriCare
            <small>Halifax Infirmary Emergency</small>
          </span>
        </Link>
        {live && (
          <span className="vc-live" data-state="live">
            <i aria-hidden="true" />
            Updated {clock(live.lastUpdatedAt)}
          </span>
        )}
      </header>

      <main className="vc-visit" id="workspace-main">
        {error && (
          <p className="vc-note" role="alert">
            <Icon name="alert" size={20} />
            {error}
          </p>
        )}
        {!visit && !error && <div className="vc-skeleton" aria-label="Loading your visit" />}
        {visit?.mode === "none" && (
          <section className="vc-card vc-now">
            <p className="vc-eyebrow">Your ER visit</p>
            <h1>No visit in progress</h1>
            <p>When you check in at the emergency department, your updates will appear here.</p>
          </section>
        )}
        {visit?.mode === "handoff" && (
          <section className="vc-card vc-now">
            <p className="vc-eyebrow">Your ER visit</p>
            <h1>Please speak with the ER team</h1>
            <p>{visit.message}</p>
          </section>
        )}
        {live && <LiveView visit={live} busy={busy} act={act} refresh={refresh} />}
        <p className="vc-demo-note">Demonstration with fictional patients. Not medical advice.</p>
      </main>

      {visit && visit.mode !== "none" && (!live || !live.ended) && (
        <aside className="vc-help" aria-label="Get help now">
          <div>
            <button
              className="vc-btn"
              data-kind="danger"
              disabled={busy}
              onClick={() => act(() => journey.checkIn("worse"))}
            >
              <Icon name="alert" size={20} />I feel worse
            </button>
            <button
              className="vc-btn"
              data-kind="quiet"
              disabled={busy || !live?.canLeave}
              onClick={() => act(() => journey.say("I'm thinking of leaving"))}
            >
              <Icon name="door" size={20} />I may leave
            </button>
          </div>
          <p>Both buttons tell the triage nurse. In an emergency, call 911.</p>
        </aside>
      )}
      <div aria-live="polite">{toast && <p className="vc-toast">{toast}</p>}</div>
    </div>
  );
}

function LiveView({
  visit,
  busy,
  act,
  refresh,
}: {
  visit: LiveVisit;
  busy: boolean;
  act: (work: () => Promise<{ reply: string }>) => Promise<void>;
  refresh: () => Promise<void>;
}) {
  const [question, setQuestion] = useState("");
  const ask = (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    setQuestion("");
    void act(() => journey.say(text));
  };
  const { badges } = visit;
  return (
    <>
      <section className="vc-card vc-now" aria-live="polite">
        <p className="vc-eyebrow">
          {visit.ended ? "Your ER visit" : `Step ${visit.friendlyStep} of ${visit.steps.length}`}
        </p>
        <h1 key={visit.step} className="vc-fade">
          {visit.ended ? "Visit ended" : visit.steps[visit.friendlyStep - 1]}
        </h1>
        <p>{visit.sentence}</p>
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
        {visit.range && (
          <div className="vc-range">
            <span className="vc-range-label">
              <Icon name="clock" size={18} />
              You&apos;ll likely be seen
            </span>
            <strong key={visit.range.highMinutes} className="vc-fade">
              {visit.range.headline}
            </strong>
            <p>Possibly sooner. Sicker patients are seen first, so this can change.</p>
            {visit.range.reason && (
              <p className="vc-note">
                <Icon name="pulse" size={20} />
                {visit.range.reason}
              </p>
            )}
          </div>
        )}
        {visit.outlook.length > 0 && (
          <dl className="vc-outlook" aria-label="What to expect next">
            {visit.outlook.map((item) => (
              <div key={item.stage}>
                <dt>{item.label}</dt>
                <dd>
                  <strong key={item.highMinutes} className="vc-fade">
                    {item.headline}
                  </strong>
                  <span>{item.sentence}</span>
                </dd>
              </div>
            ))}
            <p>Typical times for visits like yours. They are estimates, not appointments.</p>
          </dl>
        )}
        <ol className="vc-steps" aria-label="Steps in your visit">
          {visit.steps.map((label, index) => {
            const number = index + 1;
            const state =
              visit.ended || number < visit.friendlyStep
                ? "done"
                : number === visit.friendlyStep
                  ? "now"
                  : "next";
            return (
              <li
                key={label}
                data-state={state}
                aria-current={state === "now" ? "step" : undefined}
              >
                <span className="vc-dot">
                  {state === "done" ? <Icon name="check" size={18} /> : number}
                </span>
                {label}
                <em>{state === "done" ? "Done" : state === "now" ? "Now" : ""}</em>
              </li>
            );
          })}
        </ol>
      </section>

      {visit.checkInDue && (
        <section className="vc-card vc-checkin">
          <h2>How are you feeling?</h2>
          <p className="vc-muted">
            You&apos;ve been waiting a while. Your answer goes to the nurse.
          </p>
          <div className="vc-trio">
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

      {!visit.ended && <VisitFamily visit={visit} refresh={refresh} />}

      <section className="vc-card vc-section">
        <div className="vc-section-head">
          <Icon name="chat" />
          <h2>Updates</h2>
        </div>
        <ul className="vc-thread">
          {visit.messages.map((message) => (
            <li key={message.id} data-from={message.direction}>
              {message.body}
              <time dateTime={message.at}>{clock(message.at)}</time>
            </li>
          ))}
        </ul>
        {!visit.ended && (
          <form className="vc-ask" onSubmit={ask}>
            <label className="vc-sr" htmlFor="vc-question">
              Ask the care team a question
            </label>
            <input
              id="vc-question"
              value={question}
              maxLength={500}
              placeholder="Ask a question, or type STATUS"
              onChange={(event) => setQuestion(event.target.value)}
            />
            <button className="vc-btn" disabled={busy || !question.trim()} aria-label="Send">
              <Icon name="send" size={20} />
            </button>
          </form>
        )}
      </section>
    </>
  );
}
