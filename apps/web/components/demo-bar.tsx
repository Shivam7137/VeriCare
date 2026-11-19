"use client";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  DemoError,
  deltaText,
  demo,
  sparkline,
  type DemoAction,
  type DemoLive,
  type DemoState,
  type JudgeContact,
} from "../lib/demo";
import { clock, minutesText } from "../lib/journey";
import "../app/demo-bar.css";
import "../app/demo-steps.css";
import { AdvancedRow } from "./demo-advanced";
import { Glyph } from "./demo-glyphs";
import { Brand, ConfirmReset, Panel, Toast } from "./demo-panel";
import { STORE, read, useBarPlacement, useReserveSpace, write } from "./demo-placement";
import { APPS, GuidedDeck, onApp, type StepKey } from "./demo-steps";

// The floating demo bar. Judges cannot wait hours for an emergency department to move, so
// this lets them speed time up, add patients, skip ahead and push one visit to its next step,
// and shows what the wait model makes of each change. It opens on three guided steps
// (demo-steps.tsx); "Advanced" shows every control (demo-advanced.tsx). It only asks the API;
// the API owns the simulation, and every change flows through the hospital's own feed.

type Mode = "guided" | "advanced";

const first = (name: string) => name.split(" ")[0] ?? name;

export default function DemoBar() {
  const path = usePathname();
  const router = useRouter();
  const portal = path.startsWith("/patient") ? "patient" : "professional";
  const fromPath = /^\/professional\/ed\/patients\/([0-9a-f-]{36})/i.exec(path)?.[1] ?? null;

  const [state, setState] = useState<DemoState | null>(null);
  const [gone, setGone] = useState(false);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [clean, setClean] = useState(false);
  const place = useBarPlacement(!hidden && !clean);
  useReserveSpace(place.barRef, !hidden && !clean && !gone);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState<{ id: number; text: string; warn: boolean } | null>(null);
  const [flash, setFlash] = useState<{ text: string; worse: boolean } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const resetRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(false);
  // Each request is numbered; an answer older than the last one shown is dropped.
  const issued = useRef(0);
  const shown = useRef(0);
  const focusRef = useRef<string | null>(null);
  const skipping = useRef(false);
  const inflight = useRef(false);
  const autoSeen = useRef<string | null | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("guided");
  const [step, setStep] = useState<StepKey>(1);
  const [surged, setSurged] = useState(false);
  const [contact, setContact] = useState<JudgeContact | null>(null);
  const contactRef = useRef<string | null>(null);

  const live: DemoLive | null = state?.active ? state : null;
  const focusId = picked ?? fromPath;
  useEffect(() => setPicked(null), [fromPath]);
  useEffect(() => {
    focusRef.current = focusId;
    skipping.current = (live?.skipping ?? 0) > 0;
  });

  // Whether the bar was tucked away last time, which mode and step it was in, and the
  // emergency contact this browser created (its family link exists nowhere else).
  useEffect(() => {
    // ?clean=1 removes the bar entirely (no pill) in this browser until ?clean=0.
    const cleanParam = new URLSearchParams(window.location.search).get("clean");
    if (cleanParam === "1" || cleanParam === "0") write(STORE.clean, cleanParam === "1");
    setClean(read<boolean>(STORE.clean) === true);
    setHidden(read<boolean>(STORE.hidden) === true);
    if (read<Mode>(STORE.mode) === "advanced") setMode("advanced");
    const savedStep = read<number>(STORE.step);
    if (savedStep === 1 || savedStep === 2 || savedStep === 3) setStep(savedStep);
    const saved = read<JudgeContact>(STORE.contact);
    if (saved && typeof saved.id === "string" && typeof saved.phone === "string") {
      setContact(saved);
      contactRef.current = saved.id;
    }
  }, []);
  const remember = (next: JudgeContact | null) => {
    setContact(next);
    contactRef.current = next?.id ?? null;
    write(STORE.contact, next);
  };
  const switchMode = (next: Mode) => {
    setMode(next);
    setOpen(false);
    write(STORE.mode, next);
  };
  // Each step is one of the three apps; choosing it opens that app in this tab.
  const goStep = (next: StepKey) => {
    setStep(next);
    write(STORE.step, next);
    if (!onApp(next, path)) router.push(APPS[next]);
  };

  // One poll for the bar's whole life. Faster while a skip is running, paused when hidden.
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      // Clean mode (?clean=1): no bar and no polling, so recordings show only the product.
      if (read<boolean>(STORE.clean) === true) return;
      if (document.visibilityState === "visible" && !inflight.current) {
        inflight.current = true;
        const ticket = ++issued.current;
        try {
          const next = await demo.state(
            focusRef.current ?? undefined,
            contactRef.current ?? undefined,
          );
          if (!stopped && ticket >= shown.current) {
            shown.current = ticket;
            setState(next);
            setOffline(false);
            // A reset wiped the contact this browser made: forget it.
            if (next.active && next.phone === null && contactRef.current) {
              contactRef.current = null;
              setContact(null);
              write(STORE.contact, null);
            }
            if (next.active) {
              const marker = next.idleReset.lastAutoReset;
              // The demo started over by itself since we last looked: say so once.
              if (autoSeen.current !== undefined && marker && marker !== autoSeen.current)
                setToast({
                  id: Date.now(),
                  text: `The demo started over after ${next.idleReset.minutes} minutes without use.`,
                  warn: false,
                });
              autoSeen.current = marker;
            }
          }
        } catch (error) {
          // No such route here (a host without the demo): the bar steps aside entirely.
          if (error instanceof DemoError && error.status === 404) {
            setGone(true);
            stopped = true;
          } else if (!stopped) setOffline(true);
        } finally {
          inflight.current = false;
        }
      }
      if (!stopped) timer = window.setTimeout(tick, skipping.current ? 500 : 1000);
    };
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, []);

  // A picked patient who has gone home is no longer a target.
  useEffect(() => {
    if (picked && live && !live.patients.some((patient) => patient.id === picked)) setPicked(null);
  }, [picked, live]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), 8000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const say = (text: string, warn = false) => setToast({ id: Date.now(), text, warn });

  /** One action, or several in order (step 1's start is a reset and a speed). */
  const run = useCallback(
    async (key: string, actions: DemoAction | DemoAction[], label?: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(key);
      const list = Array.isArray(actions) ? actions : [actions];
      const before = state?.active ? state.model.medianMinutes : null;
      try {
        let reply: Awaited<ReturnType<typeof demo.act>> | null = null;
        for (const action of list) {
          const ticket = ++issued.current;
          reply = await demo.act(
            action,
            focusRef.current ?? undefined,
            contactRef.current ?? undefined,
          );
          if (ticket >= shown.current) {
            shown.current = ticket;
            setState(reply.state);
            setOffline(false);
          }
          if (reply.contact) remember(reply.contact);
        }
        if (!reply) return;
        const after = reply.state.active ? reply.state.model.medianMinutes : null;
        // Only actions that change the queue get a before/after line; the running clock's
        // own drift would otherwise be credited to a pause or a reset.
        const changes = list.some((action) =>
          ["add", "surge", "next", "arrivals", "staffing"].includes(action.type),
        );
        const change = changes ? deltaText(before, after) : null;
        const note = label ?? reply.note;
        say(change ? `${note} · typical wait ${before} → ${after} min` : note);
        if (change && after !== null && before !== null)
          setFlash({ text: change, worse: after > before });
        if (list.some((action) => action.type === "surge")) setSurged(true);
        if (list.some((action) => action.type === "reset")) setSurged(false);
      } catch (error) {
        say(
          error instanceof DemoError ? error.message : "That didn't go through. Please try again.",
          true,
        );
      } finally {
        busyRef.current = false;
        setBusy("");
      }
    },
    [state],
  );

  const closeConfirm = () => {
    setConfirmReset(false);
    resetRef.current?.focus();
  };

  const tuck = (value: boolean) => {
    setHidden(value);
    setOpen(false);
    write(STORE.hidden, value);
  };

  const addContact = (phone: string, estimates: boolean) =>
    void run("contact", { type: "contact", name: "", phone, ...(estimates ? {} : { estimates }) });

  if (gone || clean) return null;
  if (hidden)
    return (
      <button
        type="button"
        className="dbar-pill"
        data-portal={portal}
        onClick={() => tuck(false)}
        aria-label="Show the demo controls"
      >
        <Glyph name="play" />
        Demo controls
        {live && <span className="dbar-pill-clock">{clock(live.clock)}</span>}
      </button>
    );

  const frame = (children: ReactNode, extra?: ReactNode) => (
    <div
      ref={place.barRef}
      className="dbar"
      data-portal={portal}
      data-flip={place.flipped || undefined}
      style={place.style}
      role="region"
      aria-label="Demo controls"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        setOpen(false);
        if (confirmReset) closeConfirm();
      }}
    >
      {extra}
      {children}
    </div>
  );

  const guided = (
    <GuidedDeck
      live={live}
      ready={state !== null}
      stuck={offline}
      busy={busy}
      step={step}
      surged={surged}
      contact={contact}
      grip={place.grip}
      onStep={goStep}
      onRun={(key, actions, label) => void run(key, actions, label)}
      onContact={addContact}
      onForget={() => remember(null)}
      onAsk={(text) =>
        contact && void run("ask", { type: "ask", contactId: contact.id, text }, "Answered.")
      }
      path={path}
      onAskReset={() => setConfirmReset(true)}
      onAdvanced={() => switchMode("advanced")}
      onTuck={() => tuck(true)}
    />
  );
  const confirm = confirmReset && (
    <ConfirmReset
      busy={offline}
      onYes={() => {
        closeConfirm();
        void run("reset", { type: "reset" });
      }}
      onNo={closeConfirm}
    />
  );

  // Guided, before the demo is running: step 1 starts it.
  if (mode === "guided" && !live)
    return frame(
      <div className="dbar-deck" ref={place.deckRef} data-mode="guided">
        {guided}
      </div>,
      <>
        {confirm}
        {toast && <Toast {...toast} />}
      </>,
    );

  // Connecting, or the demo has not been started yet.
  if (!state || !state.active) {
    const starting = busy === "reset";
    return frame(
      <div className="dbar-deck" ref={place.deckRef}>
        <div className="dbar-row" data-simple>
          <Brand />
          {!state ? (
            <p className="dbar-note">{offline ? "Reconnecting to the demo…" : "Connecting…"}</p>
          ) : (
            <>
              <p className="dbar-note">The emergency department isn&rsquo;t running yet.</p>
              <button
                type="button"
                className="dbar-start"
                disabled={starting}
                onClick={() => void run("reset", { type: "reset" })}
              >
                {starting ? "Starting…" : "Start the ER demo"}
              </button>
            </>
          )}
          <button type="button" className="dbar-mode" onClick={() => switchMode("guided")}>
            Simple
          </button>
        </div>
      </div>,
      toast && <Toast {...toast} />,
    );
  }

  const model = live!.model;
  const spark = sparkline(
    model.trend.map((point) => point.median),
    80,
    28,
  );
  // Buttons stay live while an action runs (a second press is simply ignored), so the bar
  // never flickers grey; only a lost connection disables them.
  const stuck = offline;
  const focus = live!.focus;
  const drift = driftReason(model.trend);

  return frame(
    <div className="dbar-deck" ref={place.deckRef} data-mode={mode}>
      {mode === "guided" ? (
        guided
      ) : (
        <AdvancedRow
          live={live!}
          stuck={stuck}
          grip={place.grip}
          open={open}
          resetRef={resetRef}
          onRun={(key, action) => void run(key, action)}
          onOpen={setOpen}
          onAskReset={() => setConfirmReset(true)}
          onSimple={() => switchMode("guided")}
          onTuck={() => tuck(true)}
        />
      )}
      <div className="dbar-readout" role="group" aria-label="What the wait model predicts">
        <span className="dbar-readout-label">ML model</span>
        <strong>{model.medianMinutes === null ? "—" : minutesText(model.medianMinutes)}</strong>
        <span className="dbar-readout-text">predicted typical wait to be seen</span>
        {flash ? (
          <em className="dbar-flash" data-worse={flash.worse}>
            {flash.worse ? "▲" : "▼"} {flash.text}
          </em>
        ) : (
          drift && (
            <em className="dbar-flash" data-worse={drift.worse} title="Why the typical wait moved">
              {drift.worse ? "▲" : "▼"} {drift.text}
            </em>
          )
        )}
        {spark && (
          <svg
            className="dbar-spark"
            width="80"
            height="24"
            viewBox="0 0 80 24"
            role="img"
            aria-label="How the typical wait has moved"
          >
            <path d={spark.area} className="dbar-spark-area" />
            <path d={spark.line} className="dbar-spark-line" />
            <circle cx={spark.last.x} cy={spark.last.y} r="2.6" className="dbar-spark-dot" />
          </svg>
        )}
        <span className="dbar-readout-focus">
          {focus?.silenced
            ? `${first(focus.name)}: estimate withheld (silenced)`
            : focus?.estimate
              ? `${first(focus.name)}: ${focus.estimate.low}–${focus.estimate.high} min ${focus.estimate.label}`
              : model.longestMinutes !== null
                ? `Longest wait up to ${minutesText(model.longestMinutes)}`
                : "Nobody is waiting"}
        </span>
        {live!.idleReset.inMinutes !== null && live!.idleReset.inMinutes <= 5 && (
          <button
            type="button"
            className="dbar-idle"
            onClick={() => void run("keep", { type: "keep" })}
          >
            Starts over in {Math.max(1, live!.idleReset.inMinutes)} min if idle · Keep going
          </button>
        )}
        {live!.recent[0] && (
          <span className="dbar-readout-latest">
            <time>{clock(live!.recent[0].at)}</time> {live!.recent[0].text}
          </span>
        )}
      </div>
      {offline && (
        <p className="dbar-fault" role="alert">
          Connection to the demo lost. Retrying…
        </p>
      )}
      {live!.fault && (
        <p className="dbar-fault" role="alert">
          {live!.fault}
        </p>
      )}
    </div>,
    <>
      {open && mode === "advanced" && (
        <Panel
          live={live!}
          focusId={focus?.id ?? null}
          busy={stuck}
          onAskReset={() => setConfirmReset(true)}
          onPick={setPicked}
          onRun={(key, action) => void run(key, action)}
        />
      )}
      {confirm}
      {toast && <Toast {...toast} />}
    </>,
  );
}

/**
 * Why the typical wait moved on its own between the last two readings, so a change is never
 * shown without a reason. Null when it barely moved.
 */
function driftReason(
  trend: readonly { median: number; waiting: number }[],
): { text: string; worse: boolean } | null {
  const [before, after] = trend.slice(-2);
  if (!before || !after || Math.abs(after.median - before.median) < 5) return null;
  const worse = after.median > before.median;
  const moved = after.waiting - before.waiting;
  const why =
    moved > 0
      ? `${moved} more waiting`
      : moved < 0
        ? `${-moved} ${moved === -1 ? "person" : "people"} seen`
        : "same number waiting, but who is in the queue changed";
  return { text: `${before.median} → ${after.median} min: ${why}`, worse };
}
