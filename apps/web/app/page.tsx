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
      <p className="home-demo-note">
        Fictional clinic demonstration. Appointment changes and follow-up updates use demo records.
        The phone simulator is clearly separated from the real phone line.
      </p>
      <footer>
        <span>careBridge</span>
        <span>Patient · Care team · Department</span>
      </footer>
    </main>
  );
}
