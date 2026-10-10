# Team backlog

Suggested build order: A → B → C and D → integrate E, F and G → H. Use shared fixtures and mocked interfaces while dependencies are unfinished. Packages and suggested roles are optional coordination aids. No owner assignment, separate reviewer or formal handoff is required to start experimenting.

| Package           | Suggested owner       | Dependencies      | First task and completion evidence                                                                                                         |
| ----------------- | --------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A Workflow        | Domain lead           | None              | Write the callback rescheduling journey; agree required decisions, callback condition and completion evidence.                             |
| B Backend         | Backend developer     | A                 | Extend the foundation beyond T001 persistence; preserve state, proposal versions and event history across restart.                         |
| C Identity        | Backend/security      | A, B              | Deny wrong-patient access; distinguish requester identity from recorded representative authority; withhold details pending consent/review. |
| D Scheduler       | Integration developer | A, B              | Seed slots; perform one change per operation key; retrieve the original result after response loss.                                        |
| E Frontend        | Frontend developer    | B, C, D contracts | Replace the development page with patient, staff and operator views sharing saved state and the next action.                               |
| F Follow-up       | Backend/integration   | B, C, D contracts | Persist fake reminders/callbacks; survive restart; cancel resolved work; recheck immediately before sending.                               |
| G Agent and voice | AI/voice developer    | A, B, C, D        | Extract availability and explicit callback windows in a text harness; add test calls after backend tools and web journey pass.             |
| H Integration     | Test lead             | A–G               | Run the full clean-setup demonstration, confirmation, failure recovery and staff takeover with saved evidence.                             |

## Setup already supplied

Workspace structure, shared task/event/proposal schemas, synthetic T001 fixture, PostgreSQL migrations and seed, read-only demo task/history endpoints and page, optional local checks and repository instructions. Initial backend work adds immutable proposal drafts with revision checks and atomic events. Migration upgrades, concurrency, rollback, and persistence across connections have integration coverage. These foundations do not close packages B, E or H: workflow transitions, versioned decisions, authorized mutations, and booking execution remain unfinished. Automated workflows and contribution forms have been removed.

Use issues however the team finds helpful. Acceptance scenarios are listed in [acceptance.md](acceptance.md).
