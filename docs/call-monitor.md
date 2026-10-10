# Call monitor

Open **Care team → Call monitor**, or `/professional/monitor`. Get a phone access code in **Care team & phone**, then call the configured demo line. **Watch newest live call** selects a new verified live call automatically. Selecting a call manually turns that option off.

- **Transcript:** incremental caller and assistant text, finalized by conversation item ID. Caller turns stay in speech order even if transcription finishes late.
- **Tools:** tool name, inputs, result, running/failed status and elapsed time. The inspector observes actual backend tool execution; it cannot run tools or approve an appointment.
- **Events:** session model, voice, transcription model, application instructions, response timings and token usage when supplied, keypad results, interruptions and provider error codes.
- **Follow latest:** scrolls with incoming activity. Scroll upward or uncheck it to review earlier events while capture continues.
- **Search** filters the current call, including tool results. **Export JSON** downloads the saved snapshots currently loaded in the monitor.

The view refreshes every second. Completed calls remain available after an API restart. There is no automatic transcript deletion in this prototype. Older calls are not backfilled, and the button-based simulator has tool activity but no audio transcription. A development verification sample, if present, is explicitly labelled **Synthetic event playback**; its invented speech is not evidence of a handset test.

## Capture and interpretation

The bridge enables `audio.input.transcription` with `gpt-4o-mini-transcribe`. Caller transcription runs separately from the voice model and is approximate; it may arrive after an assistant response. Assistant transcripts describe generated speech, which may include words the caller never heard if playback was interrupted. Response timing measures provider events and first audio forwarded, not verified sound at the handset. There is no audio recording, hidden reasoning trace, or automatic model fine-tuning.

See OpenAI's [Realtime event reference](https://developers.openai.com/api/reference/resources/realtime/server-events) and [session configuration reference](https://developers.openai.com/api/reference/resources/realtime/client-events) for the provider protocol.

Migration `007_voice_monitor.sql` adds `voice_monitor_entries`. The capture writer coalesces partial updates every 250 ms, preserves first-observed order, and flushes during normal stream/server shutdown. A crash can lose the latest unflushed update. A database outage does not stop voice processing; the UI shows a capture warning, and the warning is saved when a later write succeeds. If the database never recovers, missing events cannot be reconstructed.

Capture is bounded to 1,000 entries per live call with a visible limit event, 8,000 characters per transcript turn, and bounded tool previews. Call access uses existing staff/operator department scope. Monitor reads pass through the same authenticated server proxy; no extra sign-in is introduced. Known credential fields, access-code patterns and full phone numbers are redacted from previews. This is not a general patient-data de-identification system: use fictional data only. The phone greeting tells callers that this demo saves a text transcript.

## Verification

Focused tests cover transcript streaming, late transcription, interrupted/failed responses, actual tool invocation and deduplication, redaction, database persistence across route restart, department scope, capture gaps, and rendered tool/transcript content. `npm test` and `npm run test:backend` include these checks. Provider session acceptance confirms configuration only; a real handset call is still needed to assess recognition quality, latency and spoken behavior.
