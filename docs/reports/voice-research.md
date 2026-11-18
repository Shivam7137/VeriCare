# Alex: conversational voice design

Alex uses GPT-Live 1 with Gleam for speech and GPT-6 Luna for delegated backend work. [OpenAI lists Gleam as a feminine North American voice](https://developers.openai.com/api/docs/guides/live-conversations#voice-options). The conversation prompt requests a gentle, expressive delivery, brief acknowledgment of worry, and one helpful next step. The opening is one sentence introducing Alex as an AI assistant, followed by “How can I help?” The caller can explain the request before any authorization question.

## What changed and why

- **Remove the telephone announcement.** Incoming TwiML connects straight to GPT-Live. The previous long introduction and access-code Gather no longer precede the conversation.
- **Let the voice model handle timing.** GPT-Live listens and speaks continuously. The relay forwards native 8 kHz μ-law audio and leaves ordinary conversational turn-taking to the model. Delayed caption fragments never clear the audio queue or cut off fresh speech. Backend response completion is separate from spoken playback.
- **Give Alex a restrained personality.** Warm phrasing, contractions, varied pace, occasional acknowledgment, one question at a time, and short replies. No forced laughter, repetitive enthusiasm, menu recitation, or claims to be human. Worried or frustrated callers get a calmer response.
- **Ask for access at the relevant moment.** Greetings, general help and requested portal-link texts do not require a code. Appointment records and care-team actions trigger a backend challenge. Codes are collected on the keypad, never included in model input or monitor events. Verification resumes the existing request.
- **Keep actions explicit.** Describe the proposed action in everyday language, preserve its exact details, then ask for keypad approval. Staff and patient appointment decisions remain separate. The model cannot complete bookings or invent transfer outcomes.
- **Use SMS when asked.** Texts go to the current caller's number after approval. Templates cover the portal link, an authorized request's status, and the caller's current appointment. `get_sms_status` checks delivery without sending another text. Accepted, delivered, uncertain and simulated outcomes remain distinct.
- **Make tuning observable.** Save native speaker captions, backend tool arguments/results, verification outcomes and SMS status. Captions are approximate, and generated words are not proof they were heard.

## Personal connection

Both phone scenarios share one `voiceCareStyle` block in `apps/api/src/voice-persona.ts`. It has not yet been heard on a real call.

- **Names.** Alex uses the caller's first name once when they say it, then only before a hard step, with reassurance, with good news and at goodbye. In the appointment scenario Alex may ask once who is calling, after hearing the request. In the emergency scenario the name arrives during contact verification.
- **The caller's words.** "Your mom", not "the patient"; the patient's first name once the caller has given it.
- **Feelings before questions.** A shaky or rushed caller gets a slower pace and one line naming what Alex hears. A brisk caller gets speed.
- **Reason before request, no pressure, presence, goodbye.** Alex says why a personal detail is needed, takes the blame off mismatches, stays present during waits, and closes with one sentence about the caller's situation.
- **First real call (2026-11-15).** The full emergency-contact flow completed and name use landed as intended. Three prompt fixes followed: use details the caller already gave in one breath, say "checking" only alongside a real backend request and once per lookup, and on a misheard SMS code ask again without claiming to check.
- **No change to access.** A spoken name is conversational only. Alex uses only names said in the call, never one from records, and using a name never signals that verification matched.

## Languages

Alex greets in English, invites the caller to use any language, then replies in whatever language the caller speaks and follows them if they switch. The shared `voiceLanguageStyle` block in `apps/api/src/voice-persona.ts` holds these rules; names and place names stay untranslated. GPT-Live has no language setting, so this is prompt behaviour only.

- **Backend stays in English.** Tool arguments use fixed formats and tool results stay in English; Alex translates when speaking. The emergency relationship is passed as one English word (so "amiga" still matches "Friend"), and spoken code digits are passed as numerals, because the server only parses English digit words.
- **Approval phrase stays in English.** The keypad readback gate in `live-bridge.ts` opens only after the exact English sentence "Press one to approve or two to cancel". Alex says it in English, then repeats the instruction in the caller's language. The gate is unchanged.
- **Not localized yet.** The SMS texts are English, and Gleam is listed as an English voice, so other languages may carry an English accent. Neither has been heard on a non-English call.

## Evidence and remaining listening checks

A synthetic caller generated locally asked the real GPT-Live service for an app-link text. The captured conversation introduced Alex briefly, called `prepare_sms` with `portal_link`, and asked for action approval without an access-code challenge. The final prompt produced “I can text the patient portal link to your number ending in zero one zero two,” followed by the approval prompt. The provider returned audio with no reported session error. No telephone call or actual SMS was sent in this test.

Automated tests cover delayed authorization, secret-code handling, current-call SMS destinations, replay/duplicate dispatch, delivery callbacks that arrive before send acknowledgements, interruptions, early keypad presses, asynchronous shutdown, and saved monitoring. All 132 unit tests and 188 backend tests passed, along with type checks and the production build. The Twilio number reports both Voice and SMS capability. After replacing an inconsistently cached restricted key with equivalent permissions and expiry, consecutive provider connections accepted GPT-Live 1, Cedar and the GPT-6 Luna backend, including two successful audio tests.

The native readback gate uses the closing confirmation phrase, audible speech followed by 320 ms of quiet audio, and Twilio playback acknowledgments. This is an application heuristic, not a provider guarantee of exact word-to-audio alignment. An interrupted or unplayed candidate does not authorize an action; confirmation still binds to the exact pending action and backend state.

The final test of likability is a person listening on the actual phone line. Check a casual greeting, a pause to think, an interruption, a corrected date, a frustrated caller, an appointment lookup, a transfer request, and a requested text. Listen for natural pacing and useful brevity, and inspect the monitor for correct tool choice. Real handset audio, transfer completion and SMS delivery remain separate from the synthetic audio test.

## Primary references

- [GPT-Live 1 model](https://developers.openai.com/api/docs/models/gpt-live-1): native full-duplex voice model.
- [Prompting GPT-Live](https://developers.openai.com/api/docs/guides/live-prompting): separate speaking style, backchannels, interruptions and delegation policy.
- [GPT-Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live): continuous audio, supported codecs and session startup.
- [Delegation and tools](https://developers.openai.com/api/docs/guides/live-delegation): nested Responses events and application-owned tool execution.
- [Managing sessions](https://developers.openai.com/api/docs/guides/live-conversations): greeting first, caption timing and playback limits.
- [Twilio Message resource](https://www.twilio.com/docs/messaging/api/message-resource): creation acknowledgments and delivery status callbacks.

## Emergency-contact scenario

The focused phone scenario matches a full patient name and birthday, verifies the registered contact name and relationship, sends an eight-digit SMS code to the stored destination, and retrieves the fictional location only after keypad verification. It grants no patient or staff principal. All 137 unit tests and 201 backend tests pass, including wrong/expired/replayed codes, changed identity, concurrent attempts, duplicate sends, provider uncertainty and early delivery callbacks. Type and formatting checks pass. An independent review found no blocking issues. GPT-Live 1 accepted Gleam and the focused toolset; local and public API readiness and Twilio voice/SMS capability and routing checks pass. Automated tests use fake SMS and sockets; handset SMS receipt and the complete spoken flow require a caller-driven test.
