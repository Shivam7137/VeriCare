"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { clock, journey, type FamilyVisit } from "../lib/journey";
import { Icon } from "./journey-icons";

const REFRESH_MS = 3000;

/** What an approved family member or friend sees from the link in their text message. */
export default function FamilyPage({ token }: { token: string }) {
  const [visit, setVisit] = useState<FamilyVisit | null>(null);
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  const refresh = useCallback(async () => {
    try {
      setVisit(await journey.family(token));
      setError("");
    } catch {
      setError("We can't reach the hospital system right now. Please try again in a moment.");
    }
  }, [token]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 7000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || busy) return;
    setBusy(true);
    setQuestion("");
    try {
      setToast((await journey.familyAsk(token, text)).reply);
      await refresh();
    } catch {
      setToast("That didn't go through. Please call the emergency department.");
    } finally {
      setBusy(false);
    }
  };

  const live = visit?.mode === "live" ? visit : null;
  return (
    <div className="vc">
      <header className="vc-bar">
        <span className="vc-brand">
          <span className="vc-brand-mark">
            <Icon name="heart" size={20} />
          </span>
          <span>
            VeriCare
            <small>Halifax Infirmary Emergency</small>
          </span>
        </span>
        {live && (
          <span className="vc-live" data-state="live">
            <i aria-hidden="true" />
            Updated {clock(live.lastUpdatedAt)}
          </span>
        )}
      </header>

      <main className="vc-visit vc-family" id="workspace-main">
        {error && (
          <p className="vc-note" role="alert">
            <Icon name="alert" size={20} />
            {error}
          </p>
        )}
        {!visit && !error && <div className="vc-skeleton" aria-label="Loading" />}
        {visit?.mode === "handoff" && (
          <section className="vc-card vc-now">
            <p className="vc-eyebrow">Emergency visit updates</p>
            <h1>Please speak with the ER team</h1>
            <p>
              There is no update to show on this page right now. The emergency department can help
              you directly.
            </p>
          </section>
        )}
        {live && (
          <>
            <section className="vc-card vc-now" aria-live="polite">
              <p className="vc-eyebrow">
                {live.ended
                  ? `${live.patientFirstName}'s ER visit`
                  : `${live.patientFirstName}'s ER visit · step ${live.friendlyStep} of ${live.steps.length}`}
              </p>
              <h1 key={live.step} className="vc-fade">
                {live.ended ? "Visit ended" : live.steps[live.friendlyStep - 1]}
              </h1>
              <p>{live.sentence}</p>
              {live.range && (
                <div className="vc-range">
                  <span className="vc-range-label">
                    <Icon name="clock" size={18} />
                    Likely to be seen
                  </span>
                  <strong key={live.range.headline} className="vc-fade">
                    {live.range.headline}
                  </strong>
                  <p>Possibly sooner. Sicker patients are seen first, so this can change.</p>
                </div>
              )}
              <ol className="vc-steps" aria-label="Steps in the visit">
                {live.steps.map((label, index) => {
                  const number = index + 1;
                  const state =
                    live.ended || number < live.friendlyStep
                      ? "done"
                      : number === live.friendlyStep
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

            <section className="vc-card vc-section">
              <div className="vc-section-head">
                <Icon name="shield" />
                <h2>What you can see here</h2>
              </div>
              <p className="vc-muted">
                {live.patientFirstName} chose to share{" "}
                {live.sharesEstimates ? "their step and wait estimate" : "their step"} with you.
                Medical details are never shown on this page. {live.patientFirstName} can stop
                sharing at any time.
              </p>
            </section>

            <section className="vc-card vc-section">
              <div className="vc-section-head">
                <Icon name="chat" />
                <h2>Updates</h2>
              </div>
              {live.messages.length === 0 && (
                <p className="vc-muted">Updates will appear here when the step changes.</p>
              )}
              <ul className="vc-thread">
                {live.messages.map((message) => (
                  <li key={message.id} data-from={message.direction}>
                    {message.body}
                    <time dateTime={message.at}>{clock(message.at)}</time>
                  </li>
                ))}
              </ul>
              {!live.ended && (
                <>
                  <form className="vc-ask" onSubmit={ask}>
                    <label className="vc-sr" htmlFor="vc-family-question">
                      Ask the care team a question
                    </label>
                    <input
                      id="vc-family-question"
                      value={question}
                      maxLength={500}
                      placeholder="Ask the care team a question"
                      onChange={(event) => setQuestion(event.target.value)}
                    />
                    <button
                      className="vc-btn"
                      disabled={busy || !question.trim()}
                      aria-label="Send"
                    >
                      <Icon name="send" size={20} />
                    </button>
                  </form>
                  <p className="vc-muted">
                    Questions go to the care team; this page can&apos;t answer medical questions. In
                    an emergency, call 911.
                  </p>
                </>
              )}
            </section>
          </>
        )}
        <p className="vc-demo-note">Demonstration with fictional patients. Not medical advice.</p>
      </main>
      <div aria-live="polite">{toast && <p className="vc-toast">{toast}</p>}</div>
    </div>
  );
}
