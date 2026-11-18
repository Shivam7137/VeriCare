import Link from "next/link";
import PortalHeader from "../components/portal-header";
export default function Home() {
  return (
    <main className="portal-home">
      <PortalHeader />
      <section className="home-intro" id="workspace-main">
        <p className="eyebrow">Appointments & care-team coordination</p>
        <h1>
          Care starts with
          <br />a clear next step.
        </h1>
        <p>
          Request a new appointment time, review it with your care team, and follow the confirmed
          outcome.
        </p>
      </section>
      <section className="home-workspaces" aria-label="Choose a workspace">
        <Link href="/patient" className="home-patient">
          <span className="home-entry-label">
            Patient workspace <span aria-hidden="true">↗</span>
          </span>
          <h2>
            Your appointment.
            <br />A time that works.
          </h2>
          <p>Share your availability, review a proposed time, and confirm your choice.</p>
          <span className="home-entry-action">Open patient workspace →</span>
        </Link>
        <div className="home-team-entries">
          <Link href="/professional">
            <span className="home-entry-label">
              Care team <span aria-hidden="true">↗</span>
            </span>
            <h2>Coordinate the next step.</h2>
            <p>Review requests, approve exact appointments, and reach a teammate.</p>
            <span className="home-entry-action">Open care-team workspace →</span>
          </Link>
          <Link href="/desktop">
            <span className="home-entry-label">
              Department overview <span aria-hidden="true">↗</span>
            </span>
            <h2>The work in view.</h2>
            <p>See requests, saved booking outcomes, phone activity, and handovers together.</p>
            <span className="home-entry-action">Open overview →</span>
          </Link>
        </div>
      </section>
      <section className="home-journey" aria-labelledby="home-journey-title">
        <h2 id="home-journey-title">VeriCare Journey: an agent for every emergency visit</h2>
        <div className="home-workspaces">
          <Link href="/patient/visit">
            <span className="home-entry-label">
              Patient <span aria-hidden="true">↗</span>
            </span>
            <h2>My ER visit</h2>
            <p>Your step, a personal wait range, check-ins and a way to ask questions.</p>
            <span className="home-entry-action">Open the visit page →</span>
          </Link>
          <Link href="/professional/ed">
            <span className="home-entry-label">
              Triage and waiting room <span aria-hidden="true">↗</span>
            </span>
            <h2>Emergency Desk</h2>
            <p>Who needs a person now, what the agent decided, and the audit ledger.</p>
            <span className="home-entry-action">Open the Desk →</span>
          </Link>
          <Link href="/professional/ed/accuracy">
            <span className="home-entry-label">
              Charge nurse <span aria-hidden="true">↗</span>
            </span>
            <h2>Estimate accuracy</h2>
            <p>Every estimate scored against what happened, step by step.</p>
            <span className="home-entry-action">Open the ledger →</span>
          </Link>
          <Link href="/professional/ed/mission">
            <span className="home-entry-label">
              Demo <span aria-hidden="true">↗</span>
            </span>
            <h2>Mission control</h2>
            <p>The hospital feed, agent decisions and messages on one screen.</p>
            <span className="home-entry-action">Open mission control →</span>
          </Link>
        </div>
      </section>
      <p className="home-demo-note">
        Fictional clinic demonstration. Appointment changes and follow-up updates use demo records.
        The phone simulator is clearly separated from the real phone line.
      </p>
      <footer>
        <span>VeriCare</span>
        <span>Patient · Care team · Department</span>
      </footer>
    </main>
  );
}
