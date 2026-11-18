"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { clock, journey, type LiveVisit } from "../../lib/journey";
import { Icon } from "../journey-icons";
import type { Act } from "../visit-page";

const quick = ["STATUS", "Where can I charge my phone?", "I need an interpreter"];

/** The conversation with the care team, newest at the bottom, composer by the thumb. */
export function UpdatesTab({ visit, busy, act }: { visit: LiveVisit; busy: boolean; act: Act }) {
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState("");
  const count = visit.messages.length;
  const opened = useRef(false);
  // Messages already here when the tab opened sit still; only new arrivals animate.
  const [openedAt] = useState(() => visit.messages.at(-1)?.at ?? "");
  // Newest message at the bottom, just above the composer and tab bar: a jump when
  // the tab opens, a glide for a message that arrives while the patient is reading.
  useEffect(() => {
    const top = document.documentElement.scrollHeight;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top, behavior: opened.current && !calm ? "smooth" : "instant" });
    opened.current = true;
  }, [count, pending]);

  const send = (text: string) => {
    const clean = text.trim();
    if (!clean || busy) return;
    setQuestion("");
    // Show the patient's words at once; the reply follows when the server answers.
    setPending(clean === "STATUS" ? "Where am I in the visit?" : clean);
    void act(() => journey.say(clean), undefined, false).finally(() => setPending(""));
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(question);
  };

  return (
    <section className="vcp-updates" aria-labelledby="vcp-updates-title">
      <div className="vcp-section-head">
        <h1 id="vcp-updates-title">Updates</h1>
        <p className="vcp-muted">From the care team and VeriCare. A nurse reads your questions.</p>
      </div>
      <ul className="vcp-thread">
        {visit.messages.map((message, index) => {
          const previous = visit.messages[index - 1];
          const first = previous?.direction !== message.direction;
          return (
            <li
              key={message.id}
              data-from={message.direction}
              data-first={first || undefined}
              data-new={message.at > openedAt || undefined}
            >
              {first && message.direction === "out" && (
                <span className="vcp-sender">
                  <span className="vc-brand-mark" aria-hidden="true">
                    <Icon name="heart" size={12} />
                  </span>
                  VeriCare
                </span>
              )}
              <p>{message.body}</p>
              <time dateTime={message.at}>{clock(message.at)}</time>
            </li>
          );
        })}
        {pending && (
          <>
            <li data-from="in" data-first data-new data-pending>
              <p>{pending}</p>
              <time>Sending…</time>
            </li>
            <li data-from="out" data-new className="vcp-typing" aria-label="VeriCare is replying">
              <i />
              <i />
              <i />
            </li>
          </>
        )}
      </ul>
      {!visit.ended && (
        <div className="vcp-composer">
          <div className="vcp-chips" role="group" aria-label="Quick messages">
            {quick.map((text) => (
              <button key={text} disabled={busy} onClick={() => send(text)}>
                {text === "STATUS" ? "Where am I in the visit?" : text}
              </button>
            ))}
          </div>
          <form className="vc-ask" onSubmit={submit}>
            <label className="vc-sr" htmlFor="vcp-question">
              Ask the care team a question
            </label>
            <input
              id="vcp-question"
              value={question}
              maxLength={500}
              placeholder="Ask a question"
              onChange={(event) => setQuestion(event.target.value)}
            />
            <button className="vc-btn" disabled={busy || !question.trim()} aria-label="Send">
              <Icon name="send" size={20} />
            </button>
          </form>
        </div>
      )}
    </section>
  );
}

const answers = [
  { text: "Where can I charge my phone?", label: "Charging my phone" },
  { text: "Where do I park and how do I pay?", label: "Parking" },
  { text: "What is the Wi-Fi?", label: "Wi-Fi" },
  { text: "Can I eat or drink while I wait?", label: "Eating and drinking" },
  { text: "Can someone wait with me?", label: "Visitors" },
  { text: "Why are other people seen before me?", label: "Why others go first" },
  { text: "Can I step outside for a moment?", label: "Stepping outside" },
  { text: "I need an interpreter", label: "An interpreter" },
];

/** Urgent actions first, then everyday questions the agent can answer on its own. */
export function HelpTab({ visit, busy, act }: { visit: LiveVisit; busy: boolean; act: Act }) {
  return (
    <section className="vcp-help" aria-labelledby="vcp-help-title">
      <div className="vcp-section-head">
        <h1 id="vcp-help-title">Help</h1>
        <p className="vcp-muted">Both buttons tell the triage nurse straight away.</p>
      </div>
      <div className="vcp-urgent">
        <button
          className="vc-btn"
          data-kind="danger"
          disabled={busy}
          onClick={() => act(() => journey.checkIn("worse"))}
        >
          <Icon name="alert" size={22} />
          <span>
            I feel worse
            <small>A nurse will recheck you</small>
          </span>
        </button>
        <button
          className="vc-btn"
          data-kind="quiet"
          disabled={busy || !visit.canLeave}
          onClick={() => act(() => journey.say("I'm thinking of leaving"), "updates")}
        >
          <Icon name="door" size={22} />
          <span>
            I&apos;m thinking of leaving
            <small>
              {visit.canLeave ? "Talk to us before you go" : "Only while you are waiting"}
            </small>
          </span>
        </button>
      </div>
      <p className="vcp-911">
        <Icon name="phone" size={18} />
        In an emergency, tell the triage desk now or call 911.
      </p>

      <div className="vcp-card">
        <h2>Quick questions</h2>
        <p className="vcp-muted">The answer appears in Updates.</p>
        <ul className="vcp-answers">
          {answers.map((item) => (
            <li key={item.text}>
              <button
                disabled={busy}
                onClick={() => act(() => journey.say(item.text), "updates", false)}
              >
                {item.label}
                <Icon name="arrow" size={16} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
