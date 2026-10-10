# Emergency contact phone demo

This phone scenario helps a registered emergency contact locate a fictional patient. The local database contains demonstration locations, not live hospital records. Alex uses GPT-Live 1 with the feminine Gleam voice and short, empathetic replies.

## Configure

Set `VOICE_SCENARIO=emergency_contact` and the private `DEMO_EMERGENCY_CONTACT_NAME`, `DEMO_EMERGENCY_CONTACT_RELATIONSHIP` and `DEMO_EMERGENCY_CONTACT_PHONE` values in `.env`. Use E.164 format for the registered phone. Run `npm run demo:emergency` after populating the usual demo patients, then restart the API. The command applies the additive migration and configures the existing ten fictional patients. Repeating it updates the registered contact without replacing birthdays, locations, appointments or call history. It does not send SMS.

The original appointment and forwarding phone scenario remains selectable with `VOICE_SCENARIO=coordination`; existing web workflows remain available.

## Caller journey

1. Call the configured Twilio number and explain that you are trying to find a patient.
2. Give the patient's full name, then date of birth. Alex asks one question at a time and checks both details in the call's department.
3. Give your full name and relationship. The backend compares both to the registered emergency contact.
4. A one-time text is sent to the registered number. Enter the eight digits on the phone keypad. The code expires after five minutes; press `*` to clear partial digits. No portal or staff code is required.
5. After verification, Alex reads the recorded hospital, department and area, plus visitor instructions. Verification applies only to the selected patient and this call.

Use **Maya Chen**, born **12 April 1990**, for the main demo. Her fictional record places her at **Halifax Infirmary, Emergency Department, Assessment area B**. The shared contact identity and real SMS destination are deliberately absent from committed documentation; use the values configured privately for this demo.

## Monitoring and failure behavior

Open `/professional/monitor` to view the call's transcript and tool events. SMS delivery is recorded separately: accepted or queued is not yet delivered. The saved message body redacts the code, and keypad digits are never forwarded to the model or monitor.

An unmatched patient or contact prompts a correction without revealing expected answers. Incorrect codes allow five attempts. A requested resend invalidates the prior code, waits at least 60 seconds and respects send limits. Uncertain provider outcomes do not trigger automatic retries. A changed patient or contact requires fresh verification. If verification cannot finish, Alex directs the caller to hospital reception and does not claim a live handover.

Automated validation uses isolated schemas and a fake SMS provider. A caller-driven phone test is needed to confirm handset audio and SMS receipt together.
