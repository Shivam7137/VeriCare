"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { journey, type Desk } from "../../lib/journey";
import { enterWorkspace } from "../../lib/workspace";

const REFRESH_MS = 2000;

type DeskState = {
  desk: Desk | null;
  error: string;
  /** True once the staff session exists, so views with their own feeds may fetch. */
  ready: boolean;
  busy: string;
  refresh: () => Promise<void>;
  /** Runs a staff action, marks `key` busy meanwhile, then refreshes the Desk. */
  run: (key: string, work: () => Promise<unknown>) => Promise<void>;
};

const DeskContext = createContext<DeskState | null>(null);

/**
 * One staff session and one Desk poll for every screen in the VeriCare app, so
 * moving between views is instant and the sidebar counts stay current.
 */
export function DeskProvider({ children }: { children: ReactNode }) {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState("");
  const started = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setDesk(await journey.desk());
      setError("");
    } catch {
      setError("VeriCare can't reach the server. Showing the last update.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    enterWorkspace("professional", true)
      .then(() => {
        started.current = true;
        if (!active) return;
        setReady(true);
        void refresh();
      })
      .catch(() => active && setError("The staff demo account isn't available right now."));
    const timer = window.setInterval(() => {
      if (started.current && document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    // A tab brought back from the background catches up at once instead of showing old times.
    const wake = () => {
      if (started.current && document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", wake);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refresh]);

  const run = useCallback(
    async (key: string, work: () => Promise<unknown>) => {
      setBusy(key);
      try {
        await work();
        await refresh();
      } catch {
        setError("That action didn't go through. Please try again.");
      } finally {
        setBusy("");
      }
    },
    [refresh],
  );

  return (
    <DeskContext.Provider value={{ desk, error, ready, busy, refresh, run }}>
      {children}
    </DeskContext.Provider>
  );
}

export function useDesk(): DeskState {
  const value = useContext(DeskContext);
  if (!value) throw new Error("useDesk needs a DeskProvider");
  return value;
}
