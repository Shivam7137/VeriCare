"use client";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  DemoError,
  SPEEDS,
  deltaText,
  demo,
  sparkline,
  speedHint,
  type DemoAction,
  type DemoLive,
  type DemoState,
} from "../lib/demo";
import { clock, minutesText } from "../lib/journey";
import "../app/demo-bar.css";
import { Glyph } from "./demo-glyphs";
import { Brand, ConfirmReset, Panel, Toast } from "./demo-panel";
import { STORE, read, useBarPlacement, write } from "./demo-placement";

// The floating demo bar. Judges cannot wait hours for an emergency department to move, so
// this lets them speed time up, add patients, skip ahead and push one visit to its next step,
// and shows what the wait model makes of each change. It only asks the API; the API owns the
// simulation, and every change flows through the same feed as the hospital's own messages.

const first = (name: string) => name.split(" ")[0] ?? name;

export default function DemoBar() {
  const path = usePathname();
  const portal = path.startsWith("/patient") ? "patient" : "professional";
  const fromPath = /^\/professional\/ed\/patients\/([0-9a-f-]{36})/i.exec(path)?.[1] ?? null;

  const [state, setState] = useState<DemoState | null>(null);
  const [gone, setGone] = useState(false);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(false);
  const place = useBarPlacement(!hidden);
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

  const live: DemoLive | null = state?.active ? state : null;
  const focusId = picked ?? fromPath;
  useEffect(() => setPicked(null), [fromPath]);
  useEffect(() => {
    focusRef.current = focusId;
    skipping.current = (live?.skipping ?? 0) > 0;
  });

  // Whether the bar was tucked away last time.
  useEffect(() => setHidden(read<boolean>(STORE.hidden) === true), []);

  // One poll for the bar's whole life. Faster while a skip is running, paused when hidden.
  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const tick = async () => {
      if (document.visibilityState === "visible" && !inflight.current) {
        inflight.current = true;
        const ticket = ++issued.current;
        try {
          const next = await demo.state(focusRef.current ?? undefined);
          if (!stopped && ticket >= shown.current) {
            shown.current = ticket;
            setState(next);
            setOffline(false);
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

  const run = useCallback(
    async (key: string, action: DemoAction) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(key);
      const before = state?.active ? state.model.medianMinutes : null;
      const ticket = ++issued.current;
      try {
        const reply = await demo.act(action, focusRef.current ?? undefined);
        if (ticket >= shown.current) {
          shown.current = ticket;
          setState(reply.state);
          setOffline(false);
        }
        const after = reply.state.active ? reply.state.model.medianMinutes : null;
        // Only actions that change the queue get a before/after line; the running clock's
        // own drift would otherwise be credited to a pause or a reset.
        const changes = ["add", "surge", "next", "arrivals", "staffing"].includes(action.type);
        const change = changes ? deltaText(before, after) : null;
        say(change ? `${reply.note} · typical wait ${before} → ${after} min` : reply.note);
        if (change && after !== null && before !== null)
          setFlash({ text: change, worse: after > before });
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

  if (gone) return null;
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
        </div>
      </div>,
      toast && <Toast {...toast} />,
    );
  }

  const act = (key: string, action: DemoAction) => () => void run(key, action);
  const focus = live!.focus;
  const model = live!.model;
  const spark = sparkline(
    model.trend.map((point) => point.median),
    80,
    28,
  );
  // Buttons stay live while an action runs (a second press is simply ignored), so the bar
  // never flickers grey; only a lost connection disables them.
  const stuck = offline;

  return frame(
    <div className="dbar-deck" ref={place.deckRef}>
      <div className="dbar-row">
        <button
          type="button"
          className="dbar-grip"
          aria-label="Move the demo controls with the arrow keys. Home puts them back."
          title="Drag or use the arrow keys to move. Double-click or Home to put it back."
          {...place.grip}
        >
          <Glyph name="grip" />
        </button>
        <Brand running={live!.running} />

        <div role="group" className="dbar-group" aria-label="Time">
          <span className="dbar-cap" data-skipping={live!.skipping ? "" : undefined}>
            {live!.skipping ? `Skipping ahead · ${minutesText(live!.skipping)} to go` : "Time"}
          </span>
          <div className="dbar-line">
            <button
              type="button"
              className="dbar-play"
              aria-label={live!.running ? "Pause time" : "Play time"}
              title={live!.running ? "Pause" : "Play"}
              disabled={stuck}
              onClick={act("play", { type: live!.running ? "pause" : "play" })}
            >
              <Glyph name={live!.running ? "pause" : "play"} />
            </button>
            <div className="dbar-clock" title="The emergency department's clock (Halifax time)">
              <b>{clock(live!.clock)}</b>
              <small>{live!.running ? speedHint(live!.speed) : "Paused"}</small>
            </div>
            <div className="dbar-seg" role="group" aria-label="Speed">
              {SPEEDS.map((speed) => (
                <button
                  key={speed}
                  type="button"
                  aria-pressed={live!.running && live!.speed === speed}
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
            {live!.counts.inDepartment} in the ER · {live!.counts.waiting} waiting
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
                focus ? void run("next", { type: "next", patientId: focus.id }) : setOpen(true)
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
            onClick={() => setConfirmReset(true)}
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
            onClick={() => setOpen(!open)}
          >
            <Glyph name={open ? "down" : "up"} />
            <span className="dbar-btn-text">{open ? "Less" : "More"}</span>
          </button>
          <button
            type="button"
            className="dbar-icon"
            aria-label="Tuck the demo controls away"
            title="Tuck away"
            onClick={() => tuck(true)}
          >
            <Glyph name="close" />
          </button>
        </div>
      </div>
      <div className="dbar-readout" role="group" aria-label="What the wait model predicts">
        <span className="dbar-readout-label">ML model</span>
        <strong>{model.medianMinutes === null ? "—" : minutesText(model.medianMinutes)}</strong>
        <span className="dbar-readout-text">predicted typical wait to be seen</span>
        {flash && (
          <em className="dbar-flash" data-worse={flash.worse}>
            {flash.worse ? "▲" : "▼"} {flash.text}
          </em>
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
          {focus?.estimate
            ? `${first(focus.name)}: ${focus.estimate.low}–${focus.estimate.high} min ${focus.estimate.label}`
            : model.longestMinutes !== null
              ? `Longest wait up to ${minutesText(model.longestMinutes)}`
              : "Nobody is waiting"}
        </span>
        {live!.idleReset.inMinutes !== null && live!.idleReset.inMinutes <= 5 && (
          <button type="button" className="dbar-idle" onClick={act("keep", { type: "keep" })}>
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
      {open && (
        <Panel
          live={live!}
          focusId={focus?.id ?? null}
          busy={stuck}
          onAskReset={() => setConfirmReset(true)}
          onPick={setPicked}
          onRun={(key, action) => void run(key, action)}
        />
      )}
      {confirmReset && (
        <ConfirmReset
          busy={stuck}
          onYes={() => {
            closeConfirm();
            void run("reset", { type: "reset" });
          }}
          onNo={closeConfirm}
        />
      )}
      {toast && <Toast {...toast} />}
    </>,
  );
}
