# Security and data boundary

This is a local synthetic-data prototype. Authentication, representative authorization and production access controls are not implemented. The demo API exposes only the fixed T001 fixture when ENABLE_SYNTHETIC_DEMO=true and the server is bound to loopback. Other patient lookup and booking mutation endpoints do not exist.

Do not use real patient information, hospital credentials, live phone numbers or production schedulers. The example database password is a public local fixture value and must not be reused outside this development database. Environment files, database files, backups and private keys are ignored by Git.

Report security concerns privately to the repository owner using an established private channel; do not include sensitive reproduction data in issues. No clinical, institutional security or regulatory approval is claimed.

Before a hosted or live pilot, implement and review identity, patient/action-level authorization, representative authority, progress-link access, audit retention, secrets management, deployment controls and department-approved policy. These are tracked requirements, not current guarantees.
