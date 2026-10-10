# Contributing

Choose a package from the backlog and name an owner and reviewer in its issue before implementation. Use a short branch such as `feat/task-persistence` or `fix/proposal-expiry`, then open a pull request against `main`.

Run `npm run check` before requesting review. Run PostgreSQL integration tests when storage or API behavior changes. CI uses the same commands. Format with `npm run format`. Keep package-lock.json committed and use npm ci for reproducible installation.

Keep shared record shapes in packages/contracts and update docs/contracts.md with behavior changes. Review contract changes before dependent packages merge. A passing schema test does not prove access control or workflow correctness.

Use fictional IDs rather than names, phone numbers, appointment details or copied production payloads. Do not put credentials in screenshots, issues, commits or logs. Package owners are initially unassigned; CODEOWNERS identifies the repository steward, not a complete team roster.

Every handoff includes: completed, next, blocked by, help needed. Attach the specific command or scenario evidence that supports completion.
