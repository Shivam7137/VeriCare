import Link from "next/link";
import PortalHeader from "../components/portal-header";

export default function Home() {
  return (
    <main className="portal-home">
      <PortalHeader />
      <section className="portal-welcome">
        <p className="eyebrow">PATIENT REQUEST COORDINATION</p>
        <h1>
          The right place
          <br />
          <span>for your next step.</span>
        </h1>
        <p className="lede">
          Manage your appointment or coordinate care for your department. Choose your portal to get
          started.
        </p>
      </section>
      <section className="portal-choices" aria-label="Choose your portal">
        <Link href="/patient" className="portal-card patient-card">
          <span className="portal-symbol" aria-hidden="true">
            01
          </span>
          <p className="eyebrow">FOR PATIENTS</p>
          <h2>
            Your appointment,
            <br />
            at a time that works.
          </h2>
          <p>
            Request a new time, review your appointment proposal, and get phone assistance with your
            next step.
          </p>
          <span className="portal-card-link">
            Enter patient portal <span aria-hidden="true">→</span>
          </span>
        </Link>
        <Link href="/professional" className="portal-card professional-card">
          <span className="portal-symbol" aria-hidden="true">
            02
          </span>
          <p className="eyebrow">FOR HEALTHCARE PROFESSIONALS</p>
          <h2>
            A shared view.
            <br />A coordinated response.
          </h2>
          <p>
            Review your department’s requests, propose and approve appointment times, and follow
            phone handovers.
          </p>
          <span className="portal-card-link">
            Enter professional portal <span aria-hidden="true">→</span>
          </span>
        </Link>
      </section>
      <aside className="portal-demo-note">
        <span className="dot" aria-hidden="true" />
        <div>
          <strong>Explore with fictional records</strong>
          <p>
            These local demo portals have separate sign-ins, so you can keep both open while trying
            the appointment journey. Phone simulation needs no provider credentials.
          </p>
        </div>
      </aside>
      <footer>
        <span>Patient Request Coordination</span>
        <span>Synthetic records only · All times UTC</span>
      </footer>
    </main>
  );
}
