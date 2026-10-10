import { taskSchema } from "@prc/contracts";

export const dynamic = "force-dynamic";

export default async function Home() {
  let task = null;
  try {
    const response = await fetch(
      `${process.env.API_URL ?? "http://127.0.0.1:4100"}/demo/tasks/T001`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(2500),
      },
    );
    if (response.ok) task = taskSchema.parse(await response.json());
  } catch {
    /* Show an honest setup state when the API/database is not running. */
  }

  return (
    <main>
      <header>
        <span className="brand">PRC / DEVELOPMENT</span>
        <span className="badge">Synthetic records only</span>
      </header>
      <section className="intro">
        <p className="eyebrow">REPOSITORY FOUNDATION</p>
        <h1>
          Patient Request
          <br />
          Coordination
        </h1>
        <p className="lede">
          One request, a clear next step, and a recorded outcome. Start with appointment
          rescheduling for one fictional department.
        </p>
      </section>
      <section aria-labelledby="task-heading" className="task">
        <div>
          <p className="eyebrow">SHARED TASK · T001</p>
          <h2 id="task-heading">
            {task ? "A request is ready to build on." : "Connect the local task store."}
          </h2>
        </div>
        {task ? (
          <>
            <p>{task.summary}</p>
            <dl>
              <div>
                <dt>State</dt>
                <dd>{task.state.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Next step</dt>
                <dd>{task.nextAction}</dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd>{task.owner}</dd>
              </div>
              <div>
                <dt>Revision</dt>
                <dd>{task.revision}</dd>
              </div>
            </dl>
          </>
        ) : (
          <>
            <p>
              The API or seeded database is unavailable. Run these commands from the repository
              root, then refresh.
            </p>
            <pre>
              npm run setup{"\n"}npm run db:up{"\n"}npm run db:migrate{"\n"}npm run db:seed{"\n"}npm
              run dev
            </pre>
          </>
        )}
      </section>
      <section className="scope" aria-label="Implementation scope">
        <h2>What comes next</h2>
        <p>
          Patient verification, versioned proposals, staff approval, patient confirmation, booking
          reconciliation, and follow-up are tracked in the project backlog. This starter does not
          change appointments or place calls.
        </p>
      </section>
      <footer>One department · Test integrations · No clinical or real patient use</footer>
    </main>
  );
}
