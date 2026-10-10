import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { BackendError } from "../../src/domain.js";
import {
  authenticate,
  canAccessPatient,
  createSession,
  getPrincipal,
  grantAuthority,
  listAuthorityRequests,
  requestAuthority,
  requirePatientAccess,
  requireStaff,
  reviewAuthorityRequest,
  revokeAuthority,
} from "../../src/identity.js";
import { seedIdentity } from "../../src/identity-fixtures.js";
import { migrate } from "../../src/migrations.js";
import { isolatedDatabase } from "./database.js";

const now = new Date("2030-01-01T12:00:00.000Z");
const later = new Date("2030-01-01T13:00:00.000Z");
const patientId = "synthetic-patient-001";
const requesterId = "synthetic-representative-001";

async function fixture(t: TestContext) {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await migrate(pool);
  await seedIdentity(pool);
  return {
    pool,
    patient: await getPrincipal(pool, patientId),
    representative: await getPrincipal(pool, requesterId),
    staff: await getPrincipal(pool, "synthetic-staff-001"),
    otherStaff: await getPrincipal(pool, "synthetic-staff-other"),
    operator: await getPrincipal(pool, "synthetic-operator-001"),
  };
}

function rejected(code: string, statusCode: number) {
  return (error: unknown) =>
    error instanceof BackendError && error.code === code && error.statusCode === statusCode;
}

test("opaque sessions persist only token hashes and reject invalid, expired and revoked tokens", async (t) => {
  const { pool, patient } = await fixture(t);
  const first = await createSession(pool, patient.id, later, now);
  const second = await createSession(pool, patient.id, later, now);
  assert.notEqual(first.token, second.token);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.expiresAt, later.toISOString());
  const stored = (await pool.query("SELECT * FROM sessions WHERE id = $1", [first.sessionId]))
    .rows[0];
  assert.equal(stored.token_hash, createHash("sha256").update(first.token).digest("hex"));
  assert.ok(!JSON.stringify(stored).includes(first.token));
  assert.deepEqual(await authenticate(pool, first.token, now), patient);
  await assert.rejects(authenticate(pool, "invalid", now), rejected("unauthorized", 401));
  await assert.rejects(authenticate(pool, first.token, later), rejected("unauthorized", 401));
  await pool.query("UPDATE sessions SET revoked_at = $2 WHERE id = $1", [first.sessionId, now]);
  await assert.rejects(authenticate(pool, first.token, now), rejected("unauthorized", 401));
  assert.deepEqual(await authenticate(pool, second.token, now), patient);
});

test("identity verification and active status are rechecked for sessions and session provisioning", async (t) => {
  const { pool, patient } = await fixture(t);
  const session = await createSession(pool, patient.id, later, now);
  await pool.query("UPDATE principals SET verified = false WHERE id = $1", [patient.id]);
  await assert.rejects(authenticate(pool, session.token, now), rejected("unauthorized", 401));
  await assert.rejects(createSession(pool, patient.id, later, now), rejected("unauthorized", 401));
  await pool.query("UPDATE principals SET verified = true, active = false WHERE id = $1", [
    patient.id,
  ]);
  await assert.rejects(authenticate(pool, session.token, now), rejected("unauthorized", 401));
  await assert.rejects(createSession(pool, patient.id, later, now), rejected("unauthorized", 401));
  await assert.rejects(
    createSession(pool, "missing-actor", later, now),
    rejected("unauthorized", 401),
  );
  await assert.rejects(createSession(pool, patient.id, now, now), rejected("invalid_input", 400));
  await assert.rejects(
    createSession(pool, patient.id, new Date("invalid"), now),
    rejected("invalid_input", 400),
  );
});

test("patient and department scopes deny missing representative authority without exposing records", async (t) => {
  const { pool, patient, representative, staff, otherStaff, operator } = await fixture(t);
  assert.equal(await canAccessPatient(pool, patient, patientId, now), true);
  assert.equal(await canAccessPatient(pool, representative, "synthetic-patient-002", now), true);
  assert.equal(await canAccessPatient(pool, representative, patientId, now), false);
  assert.equal(await canAccessPatient(pool, staff, patientId, now), true);
  assert.equal(await canAccessPatient(pool, operator, patientId, now), true);
  assert.equal(await canAccessPatient(pool, otherStaff, patientId, now), false);
  assert.equal(await canAccessPatient(pool, staff, "synthetic-patient-other", now), false);
  assert.equal(await canAccessPatient(pool, patient, "missing-patient", now), false);
  await assert.rejects(
    requirePatientAccess(pool, representative, patientId, now),
    rejected("not_found", 404),
  );
  await assert.rejects(
    requirePatientAccess(pool, representative, "missing-patient", now),
    rejected("not_found", 404),
  );
  await requireStaff(pool, staff, "demo-department");
  await assert.rejects(requireStaff(pool, operator, "demo-department"), rejected("not_found", 404));
  await assert.rejects(
    requireStaff(pool, otherStaff, "demo-department"),
    rejected("not_found", 404),
  );
});

test("forged roles and stale principal objects cannot retain access", async (t) => {
  const { pool, patient, representative, staff } = await fixture(t);
  const forged = { ...representative, role: "staff" as const, departmentId: "demo-department" };
  assert.equal(await canAccessPatient(pool, forged, patientId, now), false);
  await assert.rejects(requireStaff(pool, forged, "demo-department"), rejected("not_found", 404));
  const forgedSelf = { ...representative, patientId };
  assert.equal(await canAccessPatient(pool, forgedSelf, patientId, now), false);
  await pool.query("UPDATE principals SET active = false WHERE id = $1", [patient.id]);
  assert.equal(await canAccessPatient(pool, patient, patientId, now), false);
  await pool.query("UPDATE principals SET department_id = 'other-department' WHERE id = $1", [
    staff.id,
  ]);
  assert.equal(await canAccessPatient(pool, staff, patientId, now), false);
  await assert.rejects(requireStaff(pool, staff, "demo-department"), rejected("not_found", 404));
});

test("explicit patient consent grants access until expiry or revocation", async (t) => {
  const { pool, patient, representative } = await fixture(t);
  const grant = await grantAuthority(
    pool,
    patient,
    { patientId, requesterId, expiresAt: later.toISOString(), evidenceRef: "synthetic-consent-1" },
    now,
  );
  assert.equal(grant.grantedBy, patient.id);
  assert.equal(await canAccessPatient(pool, representative, patientId, now), true);
  assert.equal(await canAccessPatient(pool, representative, patientId, later), false);
  await revokeAuthority(pool, patient, patientId, requesterId, now);
  assert.equal(await canAccessPatient(pool, representative, patientId, now), false);
  assert.ok((await pool.query("SELECT revoked_at FROM authority_grants")).rows[0].revoked_at);
  await grantAuthority(
    pool,
    patient,
    { patientId, requesterId, expiresAt: later.toISOString(), evidenceRef: "renewed-consent" },
    now,
  );
  assert.equal(await canAccessPatient(pool, representative, patientId, now), true);
  assert.equal(
    Number((await pool.query("SELECT count(*) FROM authority_grants")).rows[0].count),
    1,
  );
});

test("only the patient or current department staff may change representative authority", async (t) => {
  const { pool, patient, representative, staff, otherStaff, operator } = await fixture(t);
  const input = { patientId, requesterId, expiresAt: later.toISOString(), evidenceRef: "consent" };
  for (const actor of [representative, otherStaff, operator]) {
    await assert.rejects(grantAuthority(pool, actor, input, now), rejected("not_found", 404));
    await assert.rejects(
      revokeAuthority(pool, actor, patientId, requesterId, now),
      rejected("not_found", 404),
    );
  }
  await grantAuthority(pool, staff, input, now);
  await assert.rejects(
    grantAuthority(pool, representative, { ...input, requesterId: patient.id }, now),
    rejected("not_found", 404),
  );
  await pool.query("UPDATE principals SET verified = false WHERE id = $1", [staff.id]);
  await assert.rejects(grantAuthority(pool, staff, input, now), rejected("not_found", 404));
  await assert.rejects(
    revokeAuthority(pool, staff, patientId, requesterId, now),
    rejected("not_found", 404),
  );
  await revokeAuthority(pool, patient, patientId, requesterId, now);
});

test("grants reject blank evidence, expired dates and invalid recipients without mutations", async (t) => {
  const { pool, patient, operator } = await fixture(t);
  const input = { patientId, requesterId, expiresAt: later.toISOString(), evidenceRef: "consent" };
  for (const patch of [
    { evidenceRef: " " },
    { expiresAt: now.toISOString() },
    { expiresAt: "invalid" },
  ]) {
    await assert.rejects(
      grantAuthority(pool, patient, { ...input, ...patch }, now),
      rejected("invalid_input", 400),
    );
  }
  for (const id of ["missing-actor", operator.id]) {
    await assert.rejects(
      grantAuthority(pool, patient, { ...input, requesterId: id }, now),
      rejected("not_found", 404),
    );
  }
  await assert.rejects(
    grantAuthority(pool, patient, { ...input, patientId: "unknown" }, now),
    rejected("not_found", 404),
  );
  assert.equal(
    Number((await pool.query("SELECT count(*) FROM authority_grants")).rows[0].count),
    0,
  );
});

test("pending authority requests reveal no appointment or target existence and have scoped lists", async (t) => {
  const { pool, patient, representative, staff, otherStaff, operator } = await fixture(t);
  const pending = await requestAuthority(pool, representative, { patientId }, now);
  const unknown = await requestAuthority(pool, representative, { patientId: "unknown" }, now);
  assert.equal(pending.status, "pending");
  assert.equal(unknown.status, "pending");
  assert.deepEqual(Object.keys(pending).sort(), Object.keys(unknown).sort());
  assert.ok(!("appointmentId" in pending));
  assert.equal(await canAccessPatient(pool, representative, patientId, now), false);
  assert.deepEqual(
    (await listAuthorityRequests(pool, representative)).map((r) => r.id).sort(),
    [pending.id, unknown.id].sort(),
  );
  assert.deepEqual(
    (await listAuthorityRequests(pool, patient)).map((r) => r.id),
    [pending.id],
  );
  assert.deepEqual(
    (await listAuthorityRequests(pool, staff)).map((r) => r.id),
    [pending.id],
  );
  assert.deepEqual(await listAuthorityRequests(pool, otherStaff), []);
  assert.deepEqual(await listAuthorityRequests(pool, operator), []);
});

test("reviewing pending consent binds the grant to the request and prevents repeated decisions", async (t) => {
  const { pool, patient, representative, otherStaff, operator } = await fixture(t);
  const pending = await requestAuthority(pool, representative, { patientId }, now);
  const approval = {
    approved: true,
    expiresAt: later.toISOString(),
    evidenceRef: "review-consent",
  };
  for (const actor of [representative, otherStaff, operator]) {
    await assert.rejects(
      reviewAuthorityRequest(pool, actor, pending.id, approval, now),
      rejected("not_found", 404),
    );
  }
  const reviewed = await reviewAuthorityRequest(pool, patient, pending.id, approval, now);
  assert.equal(reviewed.status, "approved");
  assert.equal(reviewed.reviewedBy, patient.id);
  assert.equal(await canAccessPatient(pool, representative, patientId, now), true);
  await assert.rejects(
    reviewAuthorityRequest(pool, patient, pending.id, approval, now),
    rejected("already_reviewed", 409),
  );
});

test("denying consent and invalid approval evidence never create a grant", async (t) => {
  const { pool, patient, representative, staff } = await fixture(t);
  const pending = await requestAuthority(pool, representative, { patientId }, now);
  await assert.rejects(
    reviewAuthorityRequest(
      pool,
      patient,
      pending.id,
      { approved: true, evidenceRef: "consent" },
      now,
    ),
    rejected("invalid_input", 400),
  );
  await assert.rejects(
    reviewAuthorityRequest(pool, patient, pending.id, { approved: false, evidenceRef: " " }, now),
    rejected("invalid_input", 400),
  );
  assert.equal((await listAuthorityRequests(pool, patient))[0]?.status, "pending");
  const reviewed = await reviewAuthorityRequest(
    pool,
    staff,
    pending.id,
    { approved: false, evidenceRef: "patient-declined" },
    now,
  );
  assert.equal(reviewed.status, "denied");
  assert.equal(await canAccessPatient(pool, representative, patientId, now), false);
  assert.equal(
    Number((await pool.query("SELECT count(*) FROM authority_grants")).rows[0].count),
    0,
  );
});

test("inactive actors cannot create or list requests using stale identity", async (t) => {
  const { pool, representative } = await fixture(t);
  await pool.query("UPDATE principals SET active = false WHERE id = $1", [representative.id]);
  await assert.rejects(
    requestAuthority(pool, representative, { patientId }, now),
    rejected("not_found", 404),
  );
  await assert.rejects(listAuthorityRequests(pool, representative), rejected("not_found", 404));
});

test("seeding identity is repeatable and preserves existing records and grants", async (t) => {
  const { pool, patient } = await fixture(t);
  await grantAuthority(
    pool,
    patient,
    { patientId, requesterId, expiresAt: later.toISOString(), evidenceRef: "keep-consent" },
    now,
  );
  await pool.query("UPDATE principals SET verified = false WHERE id = $1", [patient.id]);
  await seedIdentity(pool);
  assert.equal((await getPrincipal(pool, patient.id)).verified, false);
  assert.equal(Number((await pool.query("SELECT count(*) FROM principals")).rows[0].count), 6);
  assert.equal(Number((await pool.query("SELECT count(*) FROM patients")).rows[0].count), 3);
  assert.equal(
    (await pool.query("SELECT evidence_ref FROM authority_grants")).rows[0].evidence_ref,
    "keep-consent",
  );
});
