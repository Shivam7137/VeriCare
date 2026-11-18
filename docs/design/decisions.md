# Decisions

## Repository setup choices

- Private repository under Shivam7137, as explicitly requested.
- One npm workspace: TypeScript, Next.js, persistent Fastify API and PostgreSQL 17.
- Node.js 24; exact direct application dependencies and committed npm lockfile.
- main is the shared branch; direct pushes and optional pull requests are both welcome.
- CI, Dependabot updates, CODEOWNERS and mandatory contribution templates are removed. Local checks remain optional.
- No open-source license selected. No collaborator identities assumed.
- No hosting, provider credentials or live calls configured.

## Implemented prototype decisions

- `demo-department` requires staff approval and requester confirmation of the exact proposal version. This is an explicit rule for this fictional department, not a universal hospital policy.
- Identity is pre-provisioned locally; verified synthetic principals receive opaque 24-hour sessions. No HTTP endpoint can select a role or mint sessions. This does not perform real-world identity proof.
- The patient or current department staff can grant/revoke representative rescheduling authority with evidence and expiry. Emergency-contact status supplies no authority.
- Availability and callback windows use explicit UTC instants and a named IANA time zone. Relative phrases need clarification. Callback windows end before the appointment availability starts; confirmations must occur after delivery and before the window ends.
- Staff chooses proposal expiry. Both decisions expire with that proposal. A replacement or changed callback window invalidates prior decisions and pending communications.
- Approval enqueues one fake callback and, when it fits the window and expiry, one reminder five minutes after the later of approval time and window start. Delivery retries at most three times with bounded backoff. Expired work returns to proposal preparation.
- The database-backed mock scheduler records both confirmations and rejections per operation key. Uncertain results reconcile against that receipt before retry. A committed dispatch cannot be assumed cancelled by a later withdrawal or takeover.
- Text interpretation is deterministic and read-only. Agent tools request the same permitted workflow commands and cannot approve for staff, execute bookings or declare completion.

## Remaining integration decisions

Real identity verification, hospital scheduling adapters, voice/model configuration, complete frontend journeys, hosting, retention and production observability remain outside the synthetic backend. No paid services or external messages are configured.

## Technical references

- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation)
- [GitHub Actions Node.js setup](https://github.com/actions/setup-node)
- [PostgreSQL transactions](https://www.postgresql.org/docs/17/tutorial-transactions.html)
- [Twilio Media Streams](https://www.twilio.com/docs/voice/media-streams)
- [OpenAI Realtime](https://platform.openai.com/docs/guides/realtime)

References support future design work; listing a service here does not mean it is integrated.
