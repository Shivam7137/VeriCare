# Plan: mentor suggestion report (18 Nov 2026)

Source: `vericare-suggestion-report.pdf` (live-demo test, 18 Nov, 4:41–4:49 pm AST).
Target: judge-ready by the **Nov 28 final** (≤ 5 min with live demo). Work top-down; each phase ends with a check.

Confirmed in code before planning:

- Default speed is ×60 (`apps/api/src/journey/demo/director.ts:119`), so Maya's visit ends in ~1–2 real minutes.
- Contact save swallows the server's reason (`apps/web/components/visit-family.tsx:48` → generic "We couldn't save that"). The API already returns specific codes (`featured_gone`, `invalid_phone`, `contact_limit` in `demo/contact.ts`).
- `demo/view.ts` has no silence/Confidential check, so the bar can show a silenced patient's estimate (P1-4).
- "Possibly sooner, from about {low}" copy lives in `apps/web/components/visit/visit-home.tsx:213` and `family-page.tsx:115`.

---

## Phase 1 — P0: make the 10-minute script completable (done 18 Nov)

Done: Slow (×10) start; Maya held in the waiting room until a judge moves her; **Re-seat Maya**; "Move Maya to her next step" shown before a contact is added; the patient app's contact form shows the server's reason (visit ended, duplicate number) and is replaced by "This visit has ended" after discharge; every refusal logged as `contact_refused`; silenced visits show no estimate in the demo bar. Tests in `demo-director.test.ts`.

| #   | Change                                                                                                                                                                                                           | Where                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1a  | Start paused; first press of Step 1 runs at **Slow (×10)**. README Step 1 says so.                                                                                                                               | `director.ts` defaults + reset, `demo-steps.tsx`, README                    |
| 1b  | **Re-seat Maya**: action that ends her current visit (if any) and re-admits a fresh Maya at "waiting", without truncating the department. Show it in Step 2 whenever Maya has ended or is past "seen".           | new `reseat` action in `director.ts`/`types.ts`, button in `demo-steps.tsx` |
| 1c  | **Hold Maya**: while a judge is on Step 2, Maya does not auto-advance past "waiting" until they press "Move Maya to her next step".                                                                              | `flow.ts` (skip featured visit while held), `director.ts`                   |
| 2a  | Ended visit → People form disabled with "This visit has ended — contacts can no longer be added."                                                                                                                | `visit-family.tsx` (read visit state)                                       |
| 2b  | Map every API error code to a plain sentence next to the field (ended, invalid number, duplicate, limit, consent). Stop catching to a generic string.                                                            | `visit-family.tsx`, contact route errors                                    |
| 2c  | Log contact-save failures (code + visit) to the Mission control decision feed.                                                                                                                                   | contact route → audit/decision log                                          |
| 2d  | Tests: add contact to live visit (succeeds) vs ended visit (409 `visit_ended`, distinct message).                                                                                                                | `test/integration/`, `apps/web/test/`                                       |
| 3a  | Every README control label exists verbatim in the Step panel (incl. "Move Maya to her next step" — it exists in `demo-steps.tsx:398` but was not visible; check it isn't hidden by state or covered by the bar). | `demo-steps.tsx`, README                                                    |
| 3b  | Text-back thread in Step 2 works without a real phone (simulated pane already planned there: verify it renders the agent's consent-scoped answer).                                                               | `demo-steps.tsx`, `contact.ts` `ask`                                        |
| 3c  | Scripted loop: add contact → contact asks "How long until she's seen?" → answer within consent → surge → Maya **and** contact get a new range **with a reason**.                                                 | flow + messages                                                             |

**Check:** someone who has never seen VeriCare follows only the README on the deployed demo, finishes Steps 1–3 in 10 min, no "Start over", no help.

## Phase 2 — P1: credibility (done 18 Nov)

Done: Guardian leak (Phase 1); loading states on Now / Live feed / Accuracy and a "Connecting…" chip; tabs refresh when brought back; "as of" department-clock lines on Now and Board, clock labels per Live-feed column, "ER" on the bar's clock; patient app "Visit ended" header and Help actions disabled with a reason; no "from about 0 min" (headline + "It could be sooner" / "Probably not before…"); local recalibration for Results / Decision / Bed (migration 017, `journey/recalibration.ts`, shown on Accuracy); the bar gives a reason when the typical wait drifts on its own. 12-hour simulated shift: Decision 50% → 95% inside, Bed 74% → 88%, Results 53% → 81%, all with narrower ranges.

| #   | Change                                                                                                                                                                                                                                                                                         | Where                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 4   | **Guardian leak**: demo bar/view hides estimates for silenced visits ("Withheld"). Add a test. Smallest fix in the report — do it with Phase 1.                                                                                                                                                | `demo/view.ts`                                                           |
| 5   | **Loading states**: Now, Live feed, Accuracy render skeleton/"Connecting…" until first fetch resolves; never "Nobody is waiting" / "0 of 0" / "No trained model" before data. Small live/connecting dot.                                                                                       | those pages' components                                                  |
| 6   | **One source of truth**: demo bar, Board and Now read the same department snapshot (same endpoint/tick); show "as of" time. Label clocks ("Department time" vs "Your time"); HL7 and decision columns use the same clock.                                                                      | `view.ts`, board/now/mission components                                  |
| 7   | **Visit ended state**: patient app replaces "Live · updated" with "Visit ended", freezes timestamp, disables Help actions (incl. "I feel worse") with a reason.                                                                                                                                | `visit-home.tsx`, help actions                                           |
| 8   | **Ranges**: (a) patient copy never shows a 0-min lower bound — use headline + range ("Seen in about 25 min, usually 15 min–1 h") or "at least ~15 min"; (b) recalibrate **Decision** and **Bed** upper bounds (120/120 misses were "sooner"); (c) show a reason whenever a told range changes. | `visit-home.tsx`, `family-page.tsx`, `ml/vericare_ml`, forecast/messages |

**Check:** screenshot test where bar/Board/Now counts match; fresh run Accuracy trending up from 63% (Decision ≥ 70%, Bed ≥ 65% as a working goal); grep finds no "from about 0 min".

## Phase 3 — P2 polish (done 18 Nov)

Done: the page reserves the bar's height at the bottom (`useReserveSpace`), so everything under the bar can be scrolled into view, and the step text keeps to two lines on short screens; Step 1 says **Resume** after a pause and every resume says so ("Resumed at ×10"); each HL7 order/result line names its order (lab, X-ray, consult…) and truly identical lines fold into "×n re-sent"; Live feed shows "Rules planner · language model off on this server" and each rules decision has a one-line reason; step 2 can add a steps-only contact, and the Guardian logs "Estimate withheld (no consent)" each time it holds a range back.

- **Demo bar coverage**: collapsed by default under ~800 px height and pad page bottom by bar height, so "Share updates", bottom nav, Open tasks and Board rows stay reachable.
- **Controls**: Step 1 button reads "Resume" when paused; speed buttons don't silently resume (show "Resumed at Slow" or keep pause sticky).
- **HL7 feed**: dedupe on message control ID (likely re-sent featured steps after rebuild — `director.ts:179` comment); label genuine re-sends "×3".
- **Rules vs LLM**: Mission control label "Rules planner (LLM off in public demo)"; one line of reasoning on key decisions; seed one **consent/content** Guardian refusal (e.g. contact asks for a diagnosis Maya didn't share).

## Phase 4 — redeploy + rehearsal

(Pitch video is done; the report's pitch suggestions are out of date and skipped.)

- README: keep pilot staging (baseline → shadow → live with consent, PIA, Canadian hosting, security review) prominent.
- Redeploy to Cloud Run, then two timed dress rehearsals with a first-time reviewer; fix only blockers.

## Out of scope for now

Alex voice in-demo surface (report's "beyond bugs") — only if Phase 1–2 finish early; the bar already has the text thread as the family surface.

## Pre-submission checklist

- [ ] Script completable without "Start over"
- [ ] Contact add + text-back works on a live visit
- [ ] Every failure states its reason
- [ ] No "0 min" patient ranges
- [ ] Silenced patients leak nowhere
- [ ] No false empty states on Now / Live feed / Accuracy
- [ ] Counts and clocks agree
- [ ] Demo bar covers nothing essential
- [ ] Rules-vs-LLM labelled in Mission control
