# Setup verification

The initial implementation is commit `bcc1c45e2cb9f5657107f3db8594977fba721c7b`.

These are historical setup checks. CI and automated dependency updates were subsequently removed at the user's request. Local check commands remain available, without mandatory gates.

- Local Node.js 24: formatting and type checks passed, four unit checks passed, and the Next.js production build passed.
- A real `npm run dev` launch on Windows started the web page on loopback port 3100 and API on port 4100. API health returned success. The rendered page accurately displayed the database-unavailable setup state.
- [GitHub CI run 38019175036](https://github.com/Shivam7137/patient-request-coordination/actions/runs/38019175036) passed on a clean Linux checkout: npm ci, formatting, types, unit tests, build, and the PostgreSQL integration test.
- The integration test reapplied migrations and seeds, closed the original connection pool, opened a new pool/API instance, and retrieved T001 with one initial event. This verifies persistence across application connections, not complete workflow or job recovery.
- Dependency installation reported zero known npm audit vulnerabilities at setup time. This is a point-in-time package check, not a security assessment.

Docker Desktop was stopped locally and was left unchanged. The local PostgreSQL-backed browser state was therefore not exercised; PostgreSQL persistence was verified in CI. Full demonstration scenarios remain unimplemented as listed in acceptance.md. Repository privacy, eight open package issues, milestone, merge settings and enabled vulnerability alerts were checked through the authenticated GitHub API.

The current workspace intentionally has no branch protection or required reviews; see github-settings.md. Full workflow implementation and hosting remain future project work.
