# Emergency Contact Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan inline, with a fresh final reviewer.

**Goal:** Let a registered emergency contact locate a fictional patient through a natural phone conversation and SMS verification.

**Architecture:** A separate patient-lookup service owns matching and call-scoped verification. It reuses the existing SMS records/provider/callbacks and keypad bridge, without granting appointment authority. The live scenario exposes only lookup and verification tools.

**Tech Stack:** Node 24, TypeScript, Fastify, PostgreSQL, Twilio, GPT-Live 1.

**Spec:** `docs/superpowers/specs/2026-10-10-emergency-contact-design.md`

## Global constraints

- Preserve records and existing web workflows; use additive migrations.
- Private contact configuration is never committed or included in tool results.
- Eight-digit codes, five-minute expiry, five attempts, 60-second resend cooldown.
- No real calls or SMS during automated validation.
- Continue inline under the user's implementation authorization.

## Review focus

- A repeated or concurrent tool call must not send duplicate SMS.
- A changed patient/contact record must revoke the old verification scope.
- Expired, consumed, incorrect and cross-call codes must not reveal location.
- A delivery callback arriving before send acknowledgment must stay reconciled.
- The keypad result must resume patient lookup without asking for a staff code.

## Task 1: Persist and verify the scenario

**Files:** Add `011_emergency_contact.sql`, `emergency-lookup.ts`, `emergency-sms.ts`, contract schemas and `integration/emergency-lookup.test.ts`; extend migration registration and the stored SMS template.

**Interfaces:** `EmergencyLookup.identify(callId, input)`, `sendCode(callId, toolCallId, input)`, `verifyCode(callId, code)`, `location(callId)`. Verification returns `status: verified, role: emergency_contact`; no principal is granted.

- [x] Write failing integration tests for matching, withholding location, registered destination, replay, code expiry/attempts, contact changes, resend and provider failures.
- [x] Implement the additive schema and services using existing transaction and SMS evidence helpers.
- [x] Run the targeted integration tests in isolated schemas; require all to pass.

## Task 2: Connect the live conversation and demo fixtures

**Files:** Extend `voice-agent.ts`, `voice-routes.ts`, `voice-config.ts`, `live-bridge.ts`; add `emergency-voice.ts`, demo seed command and scenario documentation. Add tests in `live-bridge.test.ts` and the emergency integration suite.

**Interfaces:** `VOICE_SCENARIO=emergency_contact` selects the narrow live toolset and instructions. `VoiceAgent.verifyCode` dispatches emergency verification separately from the existing portal-code flow. The seed command consumes private `DEMO_EMERGENCY_CONTACT_*` configuration.

- [x] Test that keypad verification resumes the location lookup and does not expose digits to the model or monitor.
- [x] Wire the scenario and seed all existing demo patients with preserved fictional records.
- [x] Run type checks, unit tests and the full backend suite; inspect the final diff and obtain a fresh review.
- [x] Apply the migration and seed, restart only after checking calls are idle, verify local/public config and provider startup, then commit and push the feature branch.
- [x] Give the user the exact fictional patient and birthday for a real caller-driven test.
