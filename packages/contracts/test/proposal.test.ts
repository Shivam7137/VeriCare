import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "../src/index.js";

const draft = {
  id: "proposal-001",
  taskId: "T001",
  version: 1,
  status: "draft",
  appointmentId: "synthetic-appointment-001",
  slotId: "synthetic-slot-002",
  expectedBookingVersion: "booking-v1",
  startsAt: "2030-01-10T14:30:00.000Z",
  endsAt: "2030-01-10T15:00:00.000Z",
  expiresAt: "2030-01-09T18:00:00.000Z",
  createdAt: "2030-01-07T12:00:00.000Z",
  createdBy: "synthetic-staff-001",
};

test("proposal draft records identify an exact version and booking change", () => {
  assert.ok(contracts.proposalDraftSchema, "proposalDraftSchema must be exported");
  assert.deepEqual(contracts.proposalDraftSchema.parse(draft), draft);
});

test("proposal drafts reject invalid versions, booking references, and time windows", () => {
  assert.ok(contracts.proposalDraftSchema, "proposalDraftSchema must be exported");
  for (const invalid of [
    { version: 0 },
    { version: 1.5 },
    { expectedBookingVersion: "" },
    { startsAt: "2030-01-10T14:30:00" },
    { endsAt: draft.startsAt },
    { expiresAt: draft.createdAt },
    { expiresAt: draft.endsAt },
    { status: "approved" },
  ]) {
    assert.equal(contracts.proposalDraftSchema.safeParse({ ...draft, ...invalid }).success, false);
  }
});
