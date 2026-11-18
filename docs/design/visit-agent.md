# The Visit Agent, its tools and its knowledge base

Written 2026-11-16. This describes what is built. The design it follows is in [vericare-journey-design.md](vericare-journey-design.md), section 5. Every patient and visit is fictional.

## What it is

Every emergency visit gets an agent. It wakes when something happens in that visit, decides what to do, and acts through tools. A language model does the deciding when one is configured; a rules planner does it otherwise, and takes over whenever the model fails. Code writes every sentence a person can receive and checks every action, so the model adds judgement and never authority.

| Wake               | Raised by                                              | The agent can                                                             |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `step_change`      | A feed message that moves the visit to a new step      | Send the prepared update to each approved contact, or hold it back        |
| `estimate_shift`   | The wait range moving past the anti-jitter thresholds  | Send the new range and its reason, or hold it back                        |
| `check_in_due`     | A timer tied to triage level (15 to 60 minutes)        | Ask "same, better or worse?", put the question off, or skip it            |
| `inbound_message`  | The patient writing on their page or by text           | Answer from the knowledge base, raise a staff task, give status, hand off |
| `contact_question` | A contact writing on the family page, by text or phone | The same, limited to what that contact may hear                           |

## How one wake runs

1. **Code prepares the choices.** Inside the transaction that recorded the event, code asks the Guardian who may be told what, writes each sentence, and stores the wake with those candidate actions (`ed_agent_wakes`).
2. **Safety floors run first, in code.** "Worse", chest pain, trouble breathing, fainting, bleeding and self-harm words open a top-priority recheck and send the fixed safety reply. "Leaving" opens a leaving task. Neither ever reaches the model.
3. **The model plans.** Outside any transaction, the runner builds a context pack, retrieves knowledge-base articles for a message, and asks the model to call tools. The model must call at least one.
4. **Code applies the plan.** In a new transaction, each tool call is checked again against the visit as it is now. Refused calls are recorded with the reason. If nothing in the plan survives, or the model failed, the rules planner runs.
5. **Everything is logged.** `ed_agent_runs` keeps the wake, the planner, the model, the time it took, a hash of the context, and every step with its verdict. The hash-chained ledger gets an `agent_run` row.

### What the model sees

The context pack is built after the Guardian's filter. It contains the step, minutes waited, whether tests are under way, each contact's relationship and scopes, the kinds of the last eight messages, open staff task kinds, the candidate actions with their wording, and, for a message, its text and the retrieved articles.

It never contains the patient's name, birth date, phone number, triage level, reason for visit, orders or results. A visit the Guardian has silenced raises no wakes for the model at all: messages on it take the rules path.

### Tools

| Tool                                       | Effect                                       | Limit enforced in code                                                                                      |
| ------------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `notify(action_id)`                        | Sends one prepared message                   | Must be an offered action; Guardian re-check; consent still active; alerts scope; rate limit on range texts |
| `ask_check_in()`                           | Sends the check-in question                  | Only when the timer says it is due                                                                          |
| `open_staff_task(kind, priority, summary)` | Adds to the Desk queue                       | Only for a message; recheck is always priority 1; summary refused if it holds numbers, links or addresses   |
| `answer_from_kb(article_id)`               | Replies with one article, word for word      | Only for a message; article must be published in the visit's department                                     |
| `report_knowledge_gap(topic)`              | Tells staff the library is missing an answer | Only for a message; topic refused if it holds long numbers, links or addresses; sends nothing to the person |
| `handoff()`                                | Replies "please speak with the ER team"      | Always allowed for a message                                                                                |
| `schedule_wake(minutes)`                   | Puts a check-in off                          | 10 to 60 minutes; never past twice the interval                                                             |
| `do_nothing()`                             | Logged restraint                             | Not offered for a message: someone who wrote always gets a reply                                            |

Each call carries a `why` sentence for the staff log. It is never shown to patients.

### Floors the model cannot lower

- The patient always hears their own step change, their first range, a wait that has run past its upper bound, and "too busy to estimate".
- A contact always hears an overrun if they have the estimates scope.
- A check-in that is twice overdue is asked.
- No more than one changed-estimate text per person per 30 minutes, six per visit.

## The knowledge base and its retrieval (RAG)

Practical questions ("where can I charge my phone?") should not wait for a nurse, and should not be answered by a model making things up. So the agent answers from a curated library that staff own, and retrieval decides which articles it gets to choose from. Added 2026-11-17; the code is in `apps/api/src/agents/knowledge.ts`.

- **Stored per department.** Articles live in `ed_kb_articles`, one library per department. A department starts with the ten curated starters in `kb.ts`, once (`ed_kb_seeded`); retiring a starter never brings it back. Only `published` articles reach anyone: a draft or a retired article offered by the model is refused.
- **Retrieve.** BM25 over the title and body, with a short synonym table for everyday words (bathroom, charger, husband), always runs and needs nothing outside the process. With `KB_EMBEDDINGS=true` each article is embedded once per version of its text and the vector is stored in Postgres (`real[]`, with the model name and a hash of the text it came from); a search then embeds only the question and fuses the two rankings by reciprocal rank. If the embedding call fails, the lexical ranking stands.
- **Augment.** The top three articles go into the context pack as `knowledge`.
- **Generate, constrained.** The model does not write the answer. It picks an article id with `answer_from_kb`, and code sends that article's text.

### Closing the gaps

- **The agent reports what is missing.** When a practical, non-clinical question has no matching article, the model opens a question task for staff as before and also calls `report_knowledge_gap(topic)`. Code checks the topic (short, no numbers or links) and stores it in `ed_kb_gaps` with the question as asked, after removing numbers, links and email addresses. The rules path never reports gaps, because it cannot tell a practical question from a clinical one.
- **Similar questions fold together.** A gap whose topic shares most of its words with an open gap adds to that gap's count. With embeddings on, a background job (every minute in `server.ts`) embeds new gaps and folds those whose vectors say they ask the same thing.
- **Staff write and approve the answer.** The Knowledge page (`/professional/ed/knowledge`) lists open gaps by how often they were asked, suggests an existing article that may already cover one, and lets staff write an answer. Saving makes a draft; Publish is the approval. Publishing an answer written for a gap closes it, and the next person who asks gets it word for word. Answers may not contain links. Every save, publish, retirement and dismissal goes on the hash-chained ledger.
- **Try a question.** The same page shows which articles the agent would be given for any question, and says when the safety floors would take the question before the library sees it.

This keeps the benefit of retrieval (the right answer out of many) without the usual risk (a fluent wrong answer). The cost is that the library must contain the answer; the gap queue turns growing it into a few minutes of staff writing instead of an engineering task.

| Route (staff only, own department)                 | Does                                     |
| -------------------------------------------------- | ---------------------------------------- |
| `GET /journey/desk/knowledge`                      | Articles, open gaps, suggestions, counts |
| `POST /journey/desk/knowledge/articles`            | Create or edit; `publish: true` approves |
| `POST /journey/desk/knowledge/articles/:id/retire` | Stops an article being sent              |
| `POST /journey/desk/knowledge/gaps/:id/dismiss`    | "Not for the library"                    |
| `POST /journey/desk/knowledge/search`              | What the agent would retrieve            |

## Alex on the phone

Two tools were added to the emergency-contact call flow (`apps/api/src/journey/voice.ts`). Both return `authorization_required` until the caller has passed the one-time code for that patient.

- `get_journey_status` returns a finished sentence for Alex to say. A contact the patient added on the visit page hears what their scopes allow; the contact registered with the hospital, with no entry on the visit page, hears the step and no estimate.
- `relay_question` passes a question to the care team through the same path as a text or the family page.

A silenced visit returns the standard handoff from both, so a transfer never reveals why.

## Channels

- **Text messages.** The number recorded at registration gets one invitation. Updates are texted only after a reply of YES, and stop at STOP. Inbound texts go through the same floors and agent. Texts are queued in `ed_sms` and sent by a background sender; without `JOURNEY_SMS_ENABLED=true` and a live phone line they are marked `simulated` and shown in mission control.
- **Family page.** Adding a contact creates a private link (`/family/<token>`), texted to that contact. Only a hash of the token is stored. A wrong link, a withdrawn contact and a silenced visit all show the same page.

## Turning it on

```sh
# .env
VISIT_AGENT_ENABLED=true     # a key alone never enables the model
KB_EMBEDDINGS=false          # true adds embedding search
JOURNEY_SMS_ENABLED=false    # true sends real texts to allow-listed numbers
```

The API prints which planner it started with. `/professional/ed/mission` shows each decision as it is made, and the Desk shows the last twelve.

## Limits

- The model has been exercised against the scripted demo department only. Its choices are logged but not yet scored: there is no measure of how often holding a message back was the right call.
- The knowledge base starts with ten articles about a fictional building. Gap reporting depends on the model; with the rules path, unanswered questions still reach staff as tasks but are not added to the gap queue.
- Article vectors are compared in the API process, not in the database. That is fast for a library of hundreds of articles; thousands would want the `pgvector` extension and an index.
- The family link stands in for the one-time code on the web. Anyone who obtains the link sees the step. The phone line still requires the code.
- One API process runs the agent. Wakes are claimed in memory, so a second API process would need a database claim before it could share the queue.
