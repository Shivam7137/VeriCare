# Call monitor

Open **Care team → Call monitor**, or `/professional/monitor`, then call the configured demo line. **Watch newest live call** selects a new live call, including a caller who has not entered an access code. Set `VOICE_DEPARTMENT_ID=demo-department` on the API so new unverified calls belong to the department's monitor scope. The assistant greets first and asks for a keypad code only when the caller requests a protected lookup or action. Selecting a call manually turns automatic selection off.

- **Transcript:** native GPT-Live caller and assistant captions, grouped by speaker and timing. Displayed turn grouping is approximate.
- **Tools:** tool name, inputs, result, running/failed status and elapsed time. The inspector observes actual backend tool execution; it cannot run tools or approve an appointment.
- **Events:** Live model, voice, Responses backend model, response timing and usage when supplied, authorization/keypad results, interruptions and provider error codes.
- **SMS:** full prepared message, masked recipient and the latest durable send/delivery status. This is separate from the tool's initial result.
- **Follow latest:** scrolls with incoming activity. Scroll upward or uncheck it to review earlier events while capture continues.
- **Search** filters the current call, including tool results. **Export JSON** downloads the saved snapshots currently loaded in the monitor.

The view refreshes every second. Completed calls remain available after an API restart. There is no automatic transcript deletion in this prototype. Older calls are not backfilled, and the button-based simulator has tool activity but no audio transcription. A development verification sample, if present, is explicitly labelled **Synthetic event playback**; its invented speech is not evidence of a handset test.

## Capture and interpretation

The active bridge uses native `session.input_transcript.delta` and `session.output_transcript.delta` captions from GPT-Live 1. Their time intervals do not provide stable conversation turn IDs, so the monitor groups each speaker's fragments separately. It does not configure a separate transcription model. The older Realtime capture path remains for compatibility tests. Assistant captions describe generated speech and can include words the caller never heard if playback was interrupted. Timing measures provider/application events, not verified sound at the handset. There is no audio recording, hidden reasoning trace, or automatic model fine-tuning.

The default session uses `gpt-live-1`, Cedar, and `gpt-6-luna` for Responses delegation. Voice captions and delegated backend tool work are separate event sources. See OpenAI's [Live session guide](https://developers.openai.com/api/docs/guides/live-conversations) and [delegation guide](https://developers.openai.com/api/docs/guides/live-delegation) for the provider protocol.

Migration `007_voice_monitor.sql` adds `voice_monitor_entries`. The capture writer coalesces partial updates every 250 ms, preserves first-observed order, and flushes during normal stream/server shutdown. A crash can lose the latest unflushed update. A database outage does not stop voice processing; the UI shows a capture warning, and the warning is saved when a later write succeeds. If the database never recovers, missing events cannot be reconstructed.

Capture is bounded to 1,000 entries per live call with a visible limit event, 8,000 characters per transcript turn, and bounded tool previews. Call access uses existing staff/operator department scope; an unverified caller's visibility comes from the configured department, not inferred patient identity. Monitor reads pass through the same authenticated server proxy; no extra sign-in is introduced. Keypad access-code digits are not forwarded to the model or captured. Known credential fields, access-code patterns and full phone numbers are redacted from previews. This is not a general patient-data de-identification system: use fictional data only.

SMS entries show `prepared`, `dispatching`, `accepted`, `sent`, `delivered`, `failed`, `unknown`, `simulated` or `cancelled`. A prepared text needs caller keypad approval. Provider acceptance and `sent` are not delivery evidence; `unknown` must not be treated as a failure safe to retry. `simulated` means no provider message was sent. Templates are limited to a portal link, authorized request status or the patient's current appointment; message delivery never establishes appointment completion. See [SMS behavior](phone-setup.md#caller-requested-sms) for destination and callback rules.

## Verification

Focused tests cover native Live captions and delegation, retained Realtime capture behavior, actual tool invocation and deduplication, keypad authorization/approval, redaction, database persistence, department scope, SMS states, capture gaps, and rendered tool/transcript content. `npm test` and `npm run test:backend` include these checks. The configured key has passed a GPT-Live/Responses session startup check; no real handset speech, transfer or SMS delivery has been validated. Recognition quality, latency and spoken behavior still require a handset test.
