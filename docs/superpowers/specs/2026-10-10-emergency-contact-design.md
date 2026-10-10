# Emergency contact patient lookup

The current phone demo focuses on one scenario: a registered emergency contact locating a fictional patient. Alex remains an empathetic feminine AI voice on GPT-Live 1. Existing appointment workflows and saved records remain available in the web app.

The caller supplies the patient's full name and date of birth, one question at a time. The backend matches both within the call's department. It returns no location, contact name or clinical details at this stage. Alex then asks the caller's name and relationship. A match to the registered emergency contact triggers an eight-digit SMS code to the number already stored in the record. The caller enters the code using the phone keypad. Successful verification permits the patient's current fictional facility, department, area and visitor instructions to be returned.

The user has supplied one shared emergency contact for all demo patients. Store their name, relationship and E.164 phone number in private local configuration and the local database, never committed fixtures. Supply deterministic fictional birthdays and locations for the existing ten demo patients, preserving existing records. Maya Chen's demo birthday is 1990-04-12.

Verification is scoped to this patient and call; it grants no patient or staff principal, appointment authority or access to another patient. A wrong or changed identity clears prior verification. Codes expire after five minutes, are single-use and allow five attempts. Only a salted hash is persisted; SMS bodies shown in the monitor redact the code. Explicit resends invalidate the previous code and have a 60-second cooldown and bounded send count. Provider uncertainty must not trigger an automatic resend.

Use the existing SMS provider, delivery callbacks and call monitor. SMS acceptance is distinct from delivery. No test SMS or outbound call is sent during implementation. Tests use isolated database schemas and a fake SMS provider. This remains a fictional demo without a hospital record integration.
