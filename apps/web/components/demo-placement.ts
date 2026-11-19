"use client";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

// Where the demo bar sits: its default dock, a dragged position remembered per browser, and
// keyboard moves. The stored position is the top-left corner of the controls ("deck").

export const STORE = {
  pos: "vc-demo-bar-pos",
  hidden: "vc-demo-bar-hidden",
  mode: "vc-demo-bar-mode",
  step: "vc-demo-bar-step",
  contact: "vc-demo-contact",
  // Set by ?clean=1 (cleared by ?clean=0): no bar at all, for screen recordings.
  clean: "vc-demo-clean",
};
export const read = <T>(key: string): T | null => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
};
export const write = (key: string, value: unknown) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A private window may refuse storage; the bar then simply forgets where it was.
  }
};

/** Top-left of the controls, and their height when it was set (for anchoring by the bottom). */
type Pos = { x: number; y: number; h?: number };
const clamp = (pos: Pos, box: { width: number; height: number }): Pos => ({
  x: Math.min(Math.max(8, pos.x), Math.max(8, window.innerWidth - box.width - 8)),
  y: Math.min(Math.max(8, pos.y), Math.max(8, window.innerHeight - box.height - 8)),
  h: box.height,
});

/** `shown` changes whenever the bar element is replaced (tucked away and back), so it is re-measured. */
export function useBarPlacement(shown: boolean) {
  const barRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Pos | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [viewport, setViewport] = useState({ width: 1280, height: 800 });
  const [deckHeight, setDeckHeight] = useState(0);

  useEffect(() => {
    const saved = read<Pos>(STORE.pos);
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) setPos(saved);
  }, []);
  useEffect(() => {
    // On a phone the bar spans the screen and cannot be dragged.
    const keep = () => {
      setNarrow(window.innerWidth <= 880);
      setViewport({ width: window.innerWidth, height: window.innerHeight });
      setDeckHeight(deckRef.current?.offsetHeight ?? 0);
      // Re-fit whenever the window or the bar changes size, e.g. once the full bar loads.
      setPos((current) => {
        const box = deckRef.current?.getBoundingClientRect();
        return current && box ? clamp(current, box) : current;
      });
    };
    keep();
    window.addEventListener("resize", keep);
    const watcher = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keep);
    if (barRef.current) watcher?.observe(barRef.current);
    return () => {
      window.removeEventListener("resize", keep);
      watcher?.disconnect();
    };
  }, [shown]);

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const box = deckRef.current?.getBoundingClientRect();
    if (!box || event.button !== 0) return;
    drag.current = { x: event.clientX - box.left, y: event.clientY - box.top };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const box = deckRef.current?.getBoundingClientRect();
    if (!drag.current || !box) return;
    setPos(clamp({ x: event.clientX - drag.current.x, y: event.clientY - drag.current.y }, box));
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    setPos((current) => {
      write(STORE.pos, current);
      return current;
    });
  };
  const goHome = () => {
    setPos(null);
    write(STORE.pos, null);
  };
  // Arrow keys move the bar (Shift for bigger steps); Home puts it back.
  const keyDrag = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Home") {
      event.preventDefault();
      goHome();
      return;
    }
    const steps: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const step = steps[event.key];
    const box = deckRef.current?.getBoundingClientRect();
    if (!step || !box) return;
    event.preventDefault();
    const size = event.shiftKey ? 96 : 24;
    const next = clamp({ x: box.left + step[0] * size, y: box.top + step[1] * size }, box);
    setPos(next);
    write(STORE.pos, next);
  };

  const free = pos !== null && !narrow;
  // In the top half the panel opens downward; in the bottom half the bar is pinned by its
  // bottom edge so the panel opens upward and never pushes the controls off the screen.
  const height = pos?.h ?? deckHeight;
  const flipped = free && pos.y + height / 2 < viewport.height / 2;
  const style: CSSProperties | undefined = !free
    ? undefined
    : flipped
      ? { left: pos.x, top: pos.y, bottom: "auto", transform: "none" }
      : {
          left: pos.x,
          top: "auto",
          bottom: Math.max(8, viewport.height - pos.y - height),
          transform: "none",
        };

  return {
    barRef,
    deckRef,
    style,
    flipped,
    grip: {
      onPointerDown: startDrag,
      onPointerMove: moveDrag,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onLostPointerCapture: endDrag,
      onKeyDown: keyDrag,
      onDoubleClick: goHome,
    },
  };
}

/**
 * Keeps the page scrollable past the bar: while it sits over the lower part of the screen,
 * the page gets that much extra room at the bottom (body padding, via --dbar-reserve), so
 * nothing the bar covers is ever out of reach.
 */
export function useReserveSpace(barRef: { current: HTMLElement | null }, shown: boolean) {
  useEffect(() => {
    const root = document.documentElement;
    if (!shown) {
      root.style.removeProperty("--dbar-reserve");
      return;
    }
    const measure = () => {
      const box = barRef.current?.getBoundingClientRect();
      const lower = box && box.bottom > window.innerHeight * 0.6;
      if (box && lower)
        root.style.setProperty(
          "--dbar-reserve",
          `${Math.ceil(window.innerHeight - box.top + 12)}px`,
        );
      else root.style.removeProperty("--dbar-reserve");
    };
    measure();
    window.addEventListener("resize", measure);
    const watcher = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (barRef.current) watcher?.observe(barRef.current);
    // A drag moves the bar without resizing it.
    const timer = window.setInterval(measure, 1000);
    return () => {
      window.removeEventListener("resize", measure);
      watcher?.disconnect();
      window.clearInterval(timer);
      root.style.removeProperty("--dbar-reserve");
    };
  }, [barRef, shown]);
}
