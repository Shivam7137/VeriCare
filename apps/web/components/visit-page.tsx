"use client";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { clock, journey, type Visit } from "../lib/journey";
import { enterWorkspace } from "../lib/workspace";
import { Icon, type IconName } from "./journey-icons";
import VisitFamily from "./visit-family";
import VisitHome from "./visit/visit-home";
import { HelpTab, UpdatesTab } from "./visit/visit-tabs";

const REFRESH_MS = 2000;
const tabs = [
  { id: "visit", label: "My visit", icon: "home" },
  { id: "updates", label: "Updates", icon: "chat" },
  { id: "people", label: "People", icon: "people" },
  { id: "help", label: "Help", icon: "help" },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];
export type VisitTab = (typeof tabs)[number]["id"];
/** `toast: false` when the reply will appear in the conversation, so it isn't shown twice. */
export type Act = (
  work: () => Promise<{ reply: string }>,
  then?: VisitTab,
  toast?: boolean,
) => Promise<void>;

const SEEN_KEY = "vc-updates-seen";
const readSeen = () => {
  try {
    return window.sessionStorage.getItem(SEEN_KEY) ?? "";
  } catch {
    return "";
  }
};
const writeSeen = (value: string) => {
  try {
    window.sessionStorage.setItem(SEEN_KEY, value);
  } catch {
    // Private windows may refuse storage; the badge then simply resets.
  }
};
const indexOf = (tab: VisitTab) => tabs.findIndex((item) => item.id === tab);

/**
 * The patient's phone app: one screen per job, a tab bar the thumb can reach,
 * and "I feel worse" on every screen because it must never be a scroll away.
 */
export default function VisitPage() {
  const [visit, setVisit] = useState<Visit | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<VisitTab>("visit");
  // Which way the last tab change went, so the new panel enters from that side.
  const [direction, setDirection] = useState<"next" | "prev" | "intro">("intro");
  const [seenAt, setSeenAt] = useState("");
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
    setSeenAt(readSeen());
    const fromHash = window.location.hash.slice(1);
    if (tabs.some((item) => item.id === fromHash)) setTab(fromHash as VisitTab);
    let active = true;
    enterWorkspace("patient")
      .then(() => {
        ready.current = true;
        if (active) void refresh();
      })
      .catch(() => active && setError("This demo page isn't available right now."));
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

  const live = visit?.mode === "live" ? visit : null;
  const latest = live?.messages.at(-1)?.at ?? "";
  // Reading the Updates tab marks every message as seen.
  useEffect(() => {
    if (tab === "updates" && latest && latest !== seenAt) {
      setSeenAt(latest);
      writeSeen(latest);
    }
  }, [tab, latest, seenAt]);
  const unread =
    live?.messages.filter((message) => message.direction === "out" && message.at > seenAt).length ??
    0;

  const go = (next: VisitTab) => {
    if (next === tab) return window.scrollTo({ top: 0, behavior: "smooth" });
    setDirection(indexOf(next) > indexOf(tab) ? "next" : "prev");
    setTab(next);
    window.history.replaceState(null, "", `#${next}`);
    window.scrollTo({ top: 0 });
  };

  const act: Act = async (work, then, toast = true) => {
    if (busy) return;
    setBusy(true);
    try {
      const { reply } = await work();
      if (toast) setToast(reply);
      await refresh();
      if (then) go(then);
    } catch {
      setToast("That didn't go through. Please tell a staff member directly.");
    } finally {
      setBusy(false);
    }
  };

  const showHelp = visit !== null && visit.mode !== "none" && !live?.ended;
  // The newer of the visit's last feed change and its latest message.
  const updatedAt = live ? [live.lastUpdatedAt, latest].sort().at(-1)! : "";

  return (
    <div className="vc vcp">
      <header className="vcp-top">
        <div className="vcp-brand">
          <span className="vc-brand-mark">
            <Icon name="heart" size={18} />
          </span>
          <span>
            <b>
              <i>Veri</i>Care
            </b>
            <small>
              {live ? (
                <>
                  {/* Re-keyed on each change, so the dot pings once when there is news. */}
                  {live.ended ? (
                    <>Visit ended · last update {clock(updatedAt)}</>
                  ) : (
                    <>
                      <i key={updatedAt} className="vcp-ping" aria-hidden="true" />
                      Live · updated {clock(updatedAt)}
                    </>
                  )}
                </>
              ) : (
                "Halifax Infirmary Emergency"
              )}
            </small>
          </span>
        </div>
        {showHelp && (
          <button
            className="vcp-worse"
            disabled={busy}
            onClick={() => act(() => journey.checkIn("worse"))}
          >
            <Icon name="alert" size={18} />I feel worse
          </button>
        )}
      </header>

      <main className="vcp-main" id="workspace-main">
        {error && (
          <p className="vc-note" role="alert">
            <Icon name="alert" size={20} />
            {error}
          </p>
        )}
        {!visit && !error && <Skeleton />}
        {visit?.mode === "none" && (
          <section className="vcp-hero vcp-rise">
            <p className="vc-eyebrow">Your visit</p>
            <h1>No visit in progress</h1>
            <p>When you check in at the hospital, your updates will appear here.</p>
          </section>
        )}
        {visit?.mode === "handoff" && (
          <section className="vcp-hero vcp-rise">
            <p className="vc-eyebrow">Your visit</p>
            <h1>Please speak with the care team</h1>
            <p>{visit.message}</p>
          </section>
        )}
        {live && (
          // One entrance per container: the panel moves on a tab change and its
          // contents ride along. The first screen staggers its cards instead.
          <div key={tab} className="vcp-panel" data-enter={direction}>
            {tab === "visit" && (
              <VisitHome
                visit={live}
                busy={busy}
                act={act}
                go={go}
                unread={unread}
                intro={direction === "intro"}
              />
            )}
            {tab === "updates" && <UpdatesTab visit={live} busy={busy} act={act} />}
            {tab === "people" && (
              <>
                <div className="vcp-section-head">
                  <h1>People</h1>
                  <p className="vcp-muted">Choose who hears how your visit is going.</p>
                </div>
                <VisitFamily visit={live} refresh={refresh} />
              </>
            )}
            {tab === "help" && <HelpTab visit={live} busy={busy} act={act} />}
          </div>
        )}
        <p className="vc-demo-note">Demonstration with fictional patients. Not medical advice.</p>
      </main>

      {live && (
        <nav
          className="vcp-tabs"
          aria-label="Sections"
          style={{ "--tab": indexOf(tab) } as CSSProperties}
        >
          <span className="vcp-tab-pill" aria-hidden="true" />
          {tabs.map((item) => (
            <button
              key={item.id}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => go(item.id)}
            >
              <span className="vcp-tab-icon">
                <Icon name={item.icon} size={22} />
                {item.id === "updates" && unread > 0 && tab !== "updates" && (
                  <em aria-label={`${unread} new`}>{unread}</em>
                )}
              </span>
              {item.label}
            </button>
          ))}
        </nav>
      )}
      <div aria-live="polite">{toast && <p className="vc-toast vcp-toast">{toast}</p>}</div>
    </div>
  );
}

/** A still placeholder in the shape of the home screen, so nothing jumps on load. */
function Skeleton() {
  return (
    <div className="vcp-skeleton" aria-label="Loading your visit" role="status">
      <i data-w="30" />
      <i data-w="80" data-h="tall" />
      <i data-w="65" />
      <b />
      <b data-h="short" />
    </div>
  );
}
