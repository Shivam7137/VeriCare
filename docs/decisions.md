# Decisions

## Repository setup choices

- Private repository under Shivam7137, as explicitly requested.
- One npm workspace: TypeScript, Next.js, persistent Fastify API and PostgreSQL 17.
- Node.js 24; exact direct application dependencies and committed npm lockfile.
- main is the default integration branch; changes use pull requests.
- GitHub Actions validates format, types, unit tests, build and PostgreSQL persistence.
- No open-source license selected. No collaborator identities assumed.
- No hosting, provider credentials or live calls configured.

## Decisions for the first team session

The following remain open and must be recorded before their dependent features are implemented:

| Decision                                                | Responsible role             | Blocks                        |
| ------------------------------------------------------- | ---------------------------- | ----------------------------- |
| Named owner and reviewer for A–H                        | Project lead                 | Work assignment               |
| Demo department policy and staff approval rule          | Domain lead                  | Workflow transitions          |
| Verification and representative consent method          | Identity/security lead       | Patient access                |
| Callback hours, explicit windows and time-zone handling | Domain and integration leads | Follow-up/voice               |
| Proposal and decision expiry                            | Domain lead                  | Versioned decisions/execution |
| Mock scheduler result and reconciliation contract       | Integration lead             | Booking executor              |
| Voice model and test-call configuration                 | AI/voice lead                | Live voice integration        |
| Hosting, access control, retention and observability    | Technical lead               | Hosted pilot                  |

The guide's staff approval is a rule for the example journey. Do not silently promote it into a universal hospital policy.

## Technical references

- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation)
- [GitHub Actions Node.js setup](https://github.com/actions/setup-node)
- [PostgreSQL transactions](https://www.postgresql.org/docs/17/tutorial-transactions.html)
- [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams)
- [OpenAI Realtime](https://platform.openai.com/docs/guides/realtime)

References support future design work; listing a service here does not mean it is integrated.
