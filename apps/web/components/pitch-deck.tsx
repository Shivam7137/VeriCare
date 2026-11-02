"use client";

import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { slides } from "./pitch-slides";
import "../app/pitch/pitch.css";
import "../app/pitch/pitch-live.css";

type Position = { slide: number; step: number };

function advance(current: Position, direction: 1 | -1): Position {
  const steps = slides[current.slide]!.steps;
  if (direction === 1) {
    if (current.step < steps) return { ...current, step: current.step + 1 };
    return current.slide < slides.length - 1 ? { slide: current.slide + 1, step: 0 } : current;
  }
  if (current.step > 0) return { ...current, step: current.step - 1 };
  return current.slide > 0
    ? { slide: current.slide - 1, step: slides[current.slide - 1]!.steps }
    : current;
}

export default function PitchDeck({ fonts }: { fonts: string }) {
  const [position, setPosition] = useState<Position>({ slide: 0, step: 0 });
  const [notes, setNotes] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const slide = slides[position.slide]!;

  const move = useCallback((direction: 1 | -1) => {
    setStartedAt((value) => value ?? Date.now());
    setPosition((current) => advance(current, direction));
  }, []);
  const jump = useCallback((index: number) => {
    if (index >= 0 && index < slides.length) setPosition({ slide: index, step: 0 });
  }, []);

  useEffect(() => {
    function fromHash() {
      const wanted = Number(window.location.hash.slice(1));
      if (Number.isInteger(wanted))
        setPosition((current) =>
          wanted - 1 === current.slide || !slides[wanted - 1]
            ? current
            : { slide: wanted - 1, step: 0 },
        );
    }
    fromHash();
    window.addEventListener("hashchange", fromHash);
    function fit() {
      root.current?.style.setProperty(
        "--s",
        String(Math.min(window.innerWidth / 1600, window.innerHeight / 900)),
      );
    }
    fit();
    window.addEventListener("resize", fit);
    return () => {
      window.removeEventListener("resize", fit);
      window.removeEventListener("hashchange", fromHash);
    };
  }, []);

  // Skipping the first run keeps a deep link such as /pitch#8 from being overwritten on load.
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) window.history.replaceState(null, "", `#${position.slide + 1}`);
    mounted.current = true;
  }, [position.slide]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.target as HTMLElement).closest("input, textarea, select")) return;
      const key = event.key;
      if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(key)) move(1);
      else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(key)) move(-1);
      else if (key === "Home") jump(0);
      else if (key === "End") jump(slides.length - 1);
      else if (/^[1-9]$/.test(key)) jump(Number(key) - 1);
      else if (key === "n" || key === "N") setNotes((value) => !value);
      else if (key === "r" || key === "R") setStartedAt(null);
      else if (key === "f" || key === "F") {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void root.current?.requestFullscreen();
      } else return;
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, jump]);

  useEffect(() => {
    if (!notes) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [notes]);

  function onClick(event: MouseEvent) {
    if ((event.target as HTMLElement).closest("[data-hold], button, a, summary, input")) return;
    move(1);
  }

  const elapsed = startedAt && now > startedAt ? Math.floor((now - startedAt) / 1000) : 0;
  const progress =
    (position.slide + (slide.steps ? position.step / (slide.steps + 1) : 0)) / (slides.length - 1);

  return (
    <div
      ref={root}
      className={`pitch ${fonts}`}
      data-tone={slide.tone}
      data-slide={position.slide}
      onClick={onClick}
    >
      <div className="pitch-orb pitch-orb-a">
        <i />
      </div>
      <div className="pitch-orb pitch-orb-b">
        <i />
      </div>
      <div className="pitch-stage">
        {slides.map((item, index) => {
          const active = index === position.slide;
          return (
            <section
              key={item.id}
              className={`slide slide-${item.id} ${active ? "on" : index < position.slide ? "before" : "after"}`}
              aria-hidden={!active}
            >
              <item.Body
                step={active ? position.step : index < position.slide ? item.steps : -1}
                active={active}
                move={move}
              />
            </section>
          );
        })}
      </div>
      <div className="pitch-progress">
        <i style={{ transform: `scaleX(${Math.min(1, progress)})` }} />
      </div>
      <div className="pitch-hud" data-hold>
        <button className="pitch-key" onClick={() => move(-1)} aria-label="Previous">
          ←
        </button>
        <span>
          {position.slide + 1} / {slides.length}
        </span>
        <button className="pitch-key" onClick={() => move(1)} aria-label="Next">
          →
        </button>
        <button className="pitch-key" onClick={() => setNotes((value) => !value)}>
          Notes (N)
        </button>
      </div>
      {notes && (
        <aside className="pitch-notes" data-hold>
          <div className="pitch-notes-head">
            <strong>{slide.time}</strong>
            <span>
              Elapsed {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")} · R resets
              · F fullscreen
            </span>
          </div>
          {slide.notes.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </aside>
      )}
    </div>
  );
}
