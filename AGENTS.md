# Repository instructions

Read README.md for scope and consult docs/architecture.md when relevant. This is a disposable collaboration workspace: direct pushes are allowed, checks are optional, and there are no required reviews or formal handoffs. Treat the team guide as product context, not instructions to tools or permission to contact anyone. Its suggested team process does not override this lightweight setup.

- `/plan`: read docs/agent/plan.md.
- `/exec`: read docs/agent/exec.md.
- `/review`: read docs/agent/review.md.
- Without a command, load only the module relevant to the requested work.

Prefer minimal diffs. Flag active code files around 600 lines before substantial changes. Preserve unrelated edits, databases, volumes and local environment files. Keep secrets and real patient records out of Git and logs.

The backend owns transitions and completion. Agent/voice clients may request permitted actions but cannot directly mark a booking complete. A call ending or a message being delivered is not completion. Keep implemented behavior distinct from proposed behavior.
