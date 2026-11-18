"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { clock } from "../../lib/journey";
import { Icon, type IconName } from "../journey-icons";
import { DeskProvider, useDesk } from "./desk-context";

const base = "/professional/ed";

type NavItem = { href: string; label: string; icon: IconName; hint: string };
const work: NavItem[] = [
  { href: base, label: "Now", icon: "inbox", hint: "Requests that need a person" },
  { href: `${base}/board`, label: "Board", icon: "board", hint: "Everyone in the department" },
];
const insight: NavItem[] = [
  {
    href: `${base}/forecasts`,
    label: "Forecasts",
    icon: "forecast",
    hint: "What the model expects",
  },
  { href: `${base}/accuracy`, label: "Accuracy", icon: "target", hint: "How often ranges held" },
];
const oversight: NavItem[] = [
  {
    href: `${base}/agent`,
    label: "Agent & audit",
    icon: "spark",
    hint: "Decisions and the ledger",
  },
  {
    href: `${base}/knowledge`,
    label: "Knowledge",
    icon: "help",
    hint: "Answers the agent may send",
  },
  { href: `${base}/mission`, label: "Live feed", icon: "feed", hint: "Feed, agent and messages" },
];

/** The staff app: a fixed sidebar of views, a status bar, and one view at a time. */
export default function Shell({ children }: { children: ReactNode }) {
  return (
    <DeskProvider>
      <Frame>{children}</Frame>
    </DeskProvider>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { desk, error } = useDesk();
  const urgent = desk?.tasks.filter((task) => task.priority === 1).length ?? 0;
  const counts: Record<string, number | undefined> = {
    [base]: desk?.tasks.length,
    [`${base}/board`]: desk?.patients.length,
  };
  const active = (href: string) =>
    href === base
      ? path === base
      : path === href ||
        path.startsWith(`${href}/`) ||
        (href === `${base}/board` && path.startsWith(`${base}/patients`));

  const group = (title: string, items: NavItem[]) => (
    <div className="vca-nav-group">
      <p className="vca-nav-title">{title}</p>
      <ul>
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="vca-nav-link"
              aria-current={active(item.href) ? "page" : undefined}
              title={item.hint}
            >
              <Icon name={item.icon} size={20} />
              <span>{item.label}</span>
              {counts[item.href] !== undefined && (
                <em
                  className="vca-count"
                  data-tone={item.href === base && urgent ? "danger" : undefined}
                >
                  {counts[item.href]}
                </em>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <div className="vc vca">
      <a href="#workspace-main" className="vca-skip">
        Skip to content
      </a>
      <aside className="vca-side" aria-label="VeriCare">
        <Link href="/" className="vca-brand">
          <span className="vc-brand-mark">
            <Icon name="heart" size={20} />
          </span>
          <span>
            <b>
              <i>Veri</i>Care
            </b>
            <small>Halifax Infirmary · Emergency</small>
          </span>
        </Link>
        <nav aria-label="Views">
          {group("Work", work)}
          {group("Model", insight)}
          {group("Oversight", oversight)}
        </nav>
        <div className="vca-side-foot">
          <Link href="/patient/visit" className="vca-nav-link" target="_blank">
            <Icon name="phone" size={20} />
            <span>Patient app</span>
            <Icon name="external" size={16} />
          </Link>
          <div className="vca-model">
            <Icon name="forecast" size={18} />
            <span>
              {desk?.model ? (
                <>
                  Stage-time model <b>{desk.model.version}</b>
                  <small>Gradient-boosted quantiles · calibrated to 80%</small>
                </>
              ) : (
                <>
                  Queue formula
                  <small>No trained model loaded</small>
                </>
              )}
            </span>
          </div>
        </div>
      </aside>

      <div className="vca-body">
        <header className="vca-top">
          <nav className="vca-tabs-mobile" aria-label="Views">
            {[...work, ...insight, ...oversight].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active(item.href) ? "page" : undefined}
              >
                <Icon name={item.icon} size={18} />
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="vca-status">
            {desk?.feed ? (
              <span className="vc-live" data-state={desk.feed.stale ? "stale" : "live"}>
                <i aria-hidden="true" />
                {desk.feed.stale ? "OPOR feed stale" : "OPOR feed live"}
              </span>
            ) : (
              <span className="vc-live" data-state="stale">
                <i aria-hidden="true" />
                Waiting for the OPOR feed
              </span>
            )}
            {desk?.feed && (
              <span className="vca-clock">
                Department clock <b>{clock(desk.feed.feedTime)}</b>
              </span>
            )}
          </div>
        </header>
        {error && (
          <p className="vc-note vca-banner" role="alert">
            <Icon name="alert" size={20} />
            {error}
          </p>
        )}
        <main className="vca-main" id="workspace-main" tabIndex={-1}>
          {children}
        </main>
        <p className="vca-foot">Demonstration with fictional patients. Not medical advice.</p>
      </div>
    </div>
  );
}

/** The heading block every view opens with. */
export function ViewHead({
  eyebrow,
  title,
  lede,
  actions,
}: {
  eyebrow: string;
  title: string;
  lede?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="vca-head">
      <div>
        <p className="vc-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {lede && <p className="vca-lede">{lede}</p>}
      </div>
      {actions && <div className="vca-head-actions">{actions}</div>}
    </div>
  );
}
