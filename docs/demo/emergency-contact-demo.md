# Emergency contact phone demo

This phone scenario helps a registered emergency contact locate a fictional patient. The local database contains demonstration locations, not live hospital records. Alex uses GPT-Live 1 with the feminine Gleam voice and short, empathetic replies.

## Configure

Set `VOICE_SCENARIO=emergency_contact` and the private `DEMO_EMERGENCY_CONTACT_NAME`, `DEMO_EMERGENCY_CONTACT_RELATIONSHIP` and `DEMO_EMERGENCY_CONTACT_PHONE` values in `.env`. Use E.164 format for the registered phone. Run `npm run demo:emergency` after populating the usual demo patients, then restart the API. The command applies the additive migration and configures the existing ten fictional patients. Repeating it updates the registered contact without replacing birthdays, locations, appointments or call history. It does not send SMS.

The original appointment and forwarding phone scenario remains selectable with `VOICE_SCENARIO=coordination`; existing web workflows remain available.

## Caller journey

1. Call the configured Twilio number and explain that you are trying to find a patient.
2. Give the patient's full name, then date of birth. Alex asks one question at a time and checks both details in the call's department.
3. Give your full name and relationship. The backend compares both to the registered emergency contact.
4. A one-time text is sent to the registered number. Read its eight digits aloud, one at a time, or enter them on the phone keypad. Alex submits spoken digits to the backend verifier without guessing missing digits or repeating the code aloud. The code expires after five minutes; press `*` to clear partial keypad digits. No portal or staff code is required.
5. After verification, Alex reads the recorded hospital, department and area, plus visitor instructions. Verification applies only to the selected patient and this call.

Use **Maya Chen**, born **12 April 1990**, for the main demo. Her fictional record places her at **Halifax Infirmary, Emergency Department, Assessment area B**. The shared contact identity and real SMS destination are deliberately absent from committed documentation; use the values configured privately for this demo.

With `ENABLE_SYNTHETIC_DEMO=true`, **12345678** is also accepted at the SMS verification step, either spoken one digit at a time or entered on the keypad. It works repeatedly, even after the random SMS code expires or its retry limit is reached. The patient and registered contact must still match on the current active call; changing those details invalidates the challenge. Successful use records `mode: demo_override` in the verification event and grants only this patient's fictional location access. This fixed code demonstrates the workflow; it does not prove possession of the registered phone. Disabling synthetic demo mode removes the fallback and retains ordinary SMS verification.

## Monitoring and failure behavior

Open `/professional/monitor` to view the call's transcript and tool events. SMS delivery is recorded separately: accepted or queued is not yet delivered. The saved message body and verification tool arguments redact the code. After an emergency SMS challenge, caller digit words and numbers are masked in saved captions until hangup, including delayed fragments. Spoken codes pass through the voice provider and the verification tool; keypad digits are never forwarded to the model or monitor.

An unmatched patient or contact prompts a correction without revealing expected answers. Incorrect codes allow five attempts. A requested resend invalidates the prior code, waits at least 60 seconds and respects send limits. Uncertain provider outcomes do not trigger automatic retries. A changed patient or contact requires fresh verification. If verification cannot finish, Alex directs the caller to hospital reception and does not claim a live handover.

Automated validation uses isolated schemas and a fake SMS provider. A real demo call confirmed SMS delivery; a new caller-driven test must confirm spoken or corrected keypad verification through the location response. Ordinary SMS codes share the same expiry, single-use code and five-attempt limit; the fixed demo fallback is the explicit exception above.
