# Fictional clinic dataset

Run from the repository root after `npm ci`, `npm run setup` and `npm run db:up`:

```sh
npm run demo:populate
npm run demo:credentials
npm run dev
```

Population applies additive migrations and ensures the small starter fixtures are present. It does not require Twilio or OpenAI credentials and never invokes a provider API. Every new call is explicitly simulated; callback numbers use the reserved fictional 202-555-0100–0199 range. Names and scheduling notes are invented. No real patient records, audio or transcripts are included.

## What appears

| Area           | Added per new batch                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| People         | 10 named fictional patients, 4 named care-team members; these identities are reused across batches                                                           |
| Requests       | 26 requests with 26 separate appointments                                                                                                                    |
| Request stages | 2 to verify, 4 awaiting proposals, 4 for staff review, 5 awaiting patient confirmation, 6 completed, 3 with staff, 2 withdrawn                               |
| Scheduler      | 90 future weekday slots, including original bookings, proposed alternatives and spare availability                                                           |
| Proposals      | Five scenarios with a second immutable proposal version; two with rejected staff decisions                                                                   |
| Calls          | 26 incoming simulations plus 6 future scheduled callbacks; 3 human handovers and 1 AI-prepared confirmation                                                  |
| Evidence       | Request timelines, named reviewers, exact-version decisions, mock callback receipts, six confirmed scheduler operations, agent tool results and voice events |
| Exception      | One callback delivery exhausts its three mock retries and appears in failed-delivery monitoring                                                              |

The usual starter records and any earlier user-created records remain, so screen totals can be higher. Workers continue normal processing after population: reminders can deliver, callbacks can become due, proposals expire, and patients can make decisions. The initial stage counts above describe a new batch before subsequent user/worker activity. Ending a call does not complete its request.

The patient portal uses **Maya Chen** (`synthetic-patient-001`), whose eight new scenarios span verification, review, patient confirmation, completed bookings, withdrawal and staff help. The professional portal and desktop overview show all department patients. Names are stored in PostgreSQL, returned only with authorized request progress, and searchable on the desktop. Other department identities retain their existing access restrictions. No extra login sessions are provisioned for the new fictional identities.

Completed requests run through the normal backend verification, proposal, approval, callback delivery, confirmation and booking executor. Phone approval examples use the same prepared-action and explicit keypad-confirmation services as the simulator. The open prepared action expires after five minutes, just like a normal simulation; use the patient phone panel to prepare another if needed.

## Repeat and refresh

The default batch name is today's UTC date. Rerunning on the same day skips populated scenarios and preserves any changes you made. Running on a later day adds another batch with fresh future appointments. To add a new batch today deliberately:

```sh
npm run demo:populate -- --batch afternoon-demo
```

Reuse that batch name to avoid duplicates. Dates are anchored when a batch is first created, not shifted on reruns. Existing names are preserved; missing demo profile names are filled in. Existing appointments, requests, credentials, active voice codes, identity activation and consent are retained. The command is additive and has no reset/delete option. The task/call APIs show the latest 200 accessible records, so avoid creating unlimited batches if you want all scenarios visible together.

All population writes use one transaction with a schema-specific advisory lock and savepoints for sequential domain commands. A failure rolls the whole batch back, and workers see only the committed dataset. The fixture adapter is confined to this local mock-backed command. Targeted fake callback dispatch touches only each new scenario's jobs, leaving unrelated due jobs alone.

## Verification

```sh
node --env-file=.env --import tsx --test apps/api/test/integration/demo-population.test.ts
npm run test:backend
npm run check
```

The population integration tests use disposable schemas. They check workflow evidence, scope separation, future dates, repeat and concurrent runs, transaction rollback, preservation of an active portal code and unrelated jobs, and edits made after population.
