import Link from "next/link";
import type { Portal } from "../lib/portal";

export default function PortalHeader({ portal }: { portal?: Portal }) {
  return (
    <header className="portal-header">
      <Link href="/" className="brand">
        <span className="brand-mark" aria-hidden="true">
          +
        </span>
        Care coordination
      </Link>
      {portal ? (
        <nav className="portal-nav" aria-label="Portal navigation">
          <a href="#requests">{portal === "patient" ? "My requests" : "Department queue"}</a>
          <a href="#phone">Phone assistance</a>
          <Link href="/desktop">Desktop overview</Link>
          <Link href="/">All portals</Link>
        </nav>
      ) : (
        <span className="badge">Synthetic demo · One department</span>
      )}
    </header>
  );
}
