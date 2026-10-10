import Link from "next/link";
import type { Portal } from "../lib/portal";
export default function PortalHeader({
  portal,
  requestId,
  patientId,
  team = false,
  monitor = false,
}: {
  portal?: Portal;
  requestId?: string;
  patientId?: string;
  team?: boolean;
  monitor?: boolean;
}) {
  const query = requestId ? `?request=${encodeURIComponent(requestId)}` : "";
  return (
    <header className="portal-header">
      <a className="skip-link" href="#workspace-main">
        Skip to workspace
      </a>
      <Link href="/" className="brand">
        <span className="brand-mark" aria-hidden="true">
          +
        </span>
        careBridge
      </Link>
      <nav className="portal-nav" aria-label="Workspace navigation">
        {portal === "patient" ? (
          <>
            <a href="#requests" aria-current="page">
              My requests
            </a>
            <a href="#phone">Phone assistance</a>
            <Link href={`/professional${query}`}>View with care team →</Link>
          </>
        ) : portal ? (
          <>
            <Link
              href={`/professional${query}`}
              aria-current={!team && !monitor ? "page" : undefined}
            >
              Requests
            </Link>
            <Link href="/professional/team" aria-current={team ? "page" : undefined}>
              Care team & phone
            </Link>
            <Link href="/professional/monitor" aria-current={monitor ? "page" : undefined}>
              Call monitor
            </Link>
            {patientId === "synthetic-patient-001" && (
              <Link href={`/patient${query}`}>Patient view →</Link>
            )}
          </>
        ) : (
          <Link href="/patient">Patient workspace</Link>
        )}
        <Link href="/desktop">Overview</Link>
      </nav>
    </header>
  );
}
