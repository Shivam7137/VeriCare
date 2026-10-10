# Team backlog

Build order: A → B → C and D → integrate E, F and G → H. Use shared fixtures and mocked interfaces while dependencies are unfinished. Each package needs a named owner and a separate reviewer before implementation; the guide supplies roles, not teammate identities.

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

Workspace structure, shared task/event schemas, synthetic T001 fixture, PostgreSQL migration and seed, a read-only demo endpoint/page, quality commands, GitHub workflow, contribution templates and repository instructions. These foundations do not close packages B, E or H.

Each issue should record completed, next, blocked by and help needed. Acceptance scenarios are listed in [acceptance.md](acceptance.md).
