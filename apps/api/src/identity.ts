import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { BackendError, transaction, type Database } from "./domain.js";

export type Principal = {
  id: string;
  role: "patient" | "staff" | "operator";
  patientId: string | null;
  departmentId: string | null;
  verified: boolean;
  active: boolean;
};

export type AuthorityGrant = {
  id: string;
  patientId: string;
  requesterId: string;
  grantedBy: string;
  expiresAt: string;
  revokedAt: string | null;
  evidenceRef: string;
};

export type AuthorityRequest = {
  id: string;
  patientId: string;
  requesterId: string;
  status: "pending" | "approved" | "denied";
  createdAt: string;
  reviewedBy: string | null;
  evidenceRef: string | null;
};

type GrantInput = {
  patientId: string;
  requesterId: string;
  expiresAt: string;
  evidenceRef: string;
};
type ReviewInput = { approved: boolean; expiresAt?: string; evidenceRef: string };

const principalColumns = `id, role, patient_id AS "patientId", department_id AS "departmentId", verified, active`;
const requestColumns = `id, patient_id AS "patientId", requester_id AS "requesterId", status,
  created_at AS "createdAt", reviewed_by AS "reviewedBy", evidence_ref AS "evidenceRef"`;
const grantColumns = `id, patient_id AS "patientId", requester_id AS "requesterId", granted_by AS "grantedBy",
  expires_at AS "expiresAt", revoked_at AS "revokedAt", evidence_ref AS "evidenceRef"`;

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function requireText(value: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 1000) {
    throw new BackendError("invalid_input", 400);
  }
}

function requireFuture(expiresAt: Date, now: Date) {
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    !Number.isFinite(now.getTime()) ||
    expiresAt <= now
  ) {
    throw new BackendError("invalid_input", 400);
  }
}

function parseExpiry(expiresAt: string | undefined, now: Date) {
  if (typeof expiresAt !== "string" || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(expiresAt)) {
    throw new BackendError("invalid_input", 400);
  }
  const expiry = new Date(expiresAt);
  requireFuture(expiry, now);
  return expiry;
}

function requestRecord(
  row: Omit<AuthorityRequest, "createdAt"> & { createdAt: Date },
): AuthorityRequest {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

export async function getPrincipal(db: Database, id: string): Promise<Principal> {
  const result = await db.query<Principal>(
    `SELECT ${principalColumns} FROM principals WHERE id = $1`,
    [id],
  );
  if (!result.rows[0]) throw new BackendError("not_found", 404);
  return result.rows[0];
}

// Session provisioning is a local administrative operation, never an HTTP login endpoint.
export async function createSession(
  pool: Pool,
  actorId: string,
  expiresAt: Date,
  now = new Date(),
) {
  requireFuture(expiresAt, now);
  return transaction(pool, async (db) => {
    const actor = await db.query(
      "SELECT id FROM principals WHERE id = $1 AND verified AND active FOR SHARE",
      [actorId],
    );
    if (!actor.rows[0]) throw new BackendError("unauthorized", 401);
    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    await db.query(
      "INSERT INTO sessions (id, token_hash, actor_id, expires_at) VALUES ($1,$2,$3,$4)",
      [sessionId, tokenHash(token), actorId, expiresAt],
    );
    return { token, sessionId, expiresAt: expiresAt.toISOString() };
  });
}

export async function authenticate(
  db: Database,
  token: string,
  now = new Date(),
): Promise<Principal> {
  if (
    typeof token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    !Number.isFinite(now.getTime())
  ) {
    throw new BackendError("unauthorized", 401);
  }
  const result = await db.query<Principal>(
    `SELECT p.id, p.role, p.patient_id AS "patientId", p.department_id AS "departmentId", p.verified, p.active
     FROM sessions s JOIN principals p ON p.id = s.actor_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 AND p.verified AND p.active`,
    [tokenHash(token), now],
  );
  if (!result.rows[0]) throw new BackendError("unauthorized", 401);
  return result.rows[0];
}

export async function canAccessPatient(
  db: Database,
  principal: Principal,
  patientId: string,
  now = new Date(),
): Promise<boolean> {
  if (!Number.isFinite(now.getTime())) return false;
  // Never accept caller-provided role, department, verification or self-patient claims.
  const result = await db.query(
    `SELECT 1 FROM principals actor JOIN patients patient ON patient.id = $2
     WHERE actor.id = $1 AND actor.verified AND actor.active AND (
       (actor.role = 'patient' AND (actor.patient_id = patient.id OR EXISTS (
         SELECT 1 FROM authority_grants g WHERE g.patient_id = patient.id AND g.requester_id = actor.id
         AND g.revoked_at IS NULL AND g.expires_at > $3
       ))) OR (actor.role IN ('staff', 'operator') AND actor.department_id = patient.department_id)
     )`,
    [principal.id, patientId, now],
  );
  return result.rows.length > 0;
}

export async function requirePatientAccess(
  db: Database,
  principal: Principal,
  patientId: string,
  now = new Date(),
): Promise<void> {
  if (!(await canAccessPatient(db, principal, patientId, now)))
    throw new BackendError("not_found", 404);
}

export async function requireStaff(
  db: Database,
  principal: Principal,
  departmentId: string,
): Promise<void> {
  const result = await db.query(
    "SELECT id FROM principals WHERE id = $1 AND role = 'staff' AND department_id = $2 AND verified AND active",
    [principal.id, departmentId],
  );
  if (!result.rows[0]) throw new BackendError("not_found", 404);
}

async function requireAuthorityManager(db: Database, actor: Principal, patientId: string) {
  const result = await db.query(
    `SELECT actor.id FROM principals actor JOIN patients patient ON patient.id = $2
     WHERE actor.id = $1 AND actor.verified AND actor.active
     AND ((actor.role = 'patient' AND actor.patient_id = patient.id)
       OR (actor.role = 'staff' AND actor.department_id = patient.department_id))
     FOR SHARE OF actor, patient`,
    [actor.id, patientId],
  );
  if (!result.rows[0]) throw new BackendError("not_found", 404);
}

async function writeGrant(
  db: Database,
  actorId: string,
  input: GrantInput,
  expiry: Date,
): Promise<AuthorityGrant> {
  const recipient = await db.query(
    "SELECT id FROM principals WHERE id = $1 AND role = 'patient' AND verified AND active FOR SHARE",
    [input.requesterId],
  );
  if (!recipient.rows[0]) throw new BackendError("not_found", 404);
  const result = await db.query(
    `INSERT INTO authority_grants (id, patient_id, requester_id, granted_by, expires_at, evidence_ref)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (patient_id, requester_id) DO UPDATE
     SET granted_by = EXCLUDED.granted_by, expires_at = EXCLUDED.expires_at,
         evidence_ref = EXCLUDED.evidence_ref, revoked_at = NULL
     RETURNING ${grantColumns}`,
    [randomUUID(), input.patientId, input.requesterId, actorId, expiry, input.evidenceRef],
  );
  const row = result.rows[0];
  return {
    ...row,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export async function grantAuthority(
  pool: Pool,
  actor: Principal,
  input: GrantInput,
  now = new Date(),
): Promise<AuthorityGrant> {
  requireText(input.patientId);
  requireText(input.requesterId);
  requireText(input.evidenceRef);
  const expiry = parseExpiry(input.expiresAt, now);
  return transaction(pool, async (db) => {
    await requireAuthorityManager(db, actor, input.patientId);
    return writeGrant(db, actor.id, input, expiry);
  });
}

export async function revokeAuthority(
  pool: Pool,
  actor: Principal,
  patientId: string,
  requesterId: string,
  now = new Date(),
): Promise<void> {
  requireText(patientId);
  requireText(requesterId);
  if (!Number.isFinite(now.getTime())) throw new BackendError("invalid_input", 400);
  await transaction(pool, async (db) => {
    await requireAuthorityManager(db, actor, patientId);
    await db.query(
      "UPDATE authority_grants SET revoked_at = $3 WHERE patient_id = $1 AND requester_id = $2",
      [patientId, requesterId, now],
    );
  });
}

export async function requestAuthority(
  pool: Pool,
  actor: Principal,
  input: { patientId: string },
  now = new Date(),
): Promise<AuthorityRequest> {
  requireText(input.patientId);
  if (!Number.isFinite(now.getTime())) throw new BackendError("invalid_input", 400);
  return transaction(pool, async (db) => {
    const current = await db.query(
      "SELECT id FROM principals WHERE id = $1 AND role = 'patient' AND verified AND active FOR SHARE",
      [actor.id],
    );
    if (!current.rows[0]) throw new BackendError("not_found", 404);
    // Deliberately do not look up the target: known and unknown IDs get identical pending records.
    const result = await db.query(
      `INSERT INTO authority_requests (id, patient_id, requester_id, status, created_at)
       VALUES ($1,$2,$3,'pending',$4) RETURNING ${requestColumns}`,
      [randomUUID(), input.patientId, actor.id, now],
    );
    return requestRecord(result.rows[0]);
  });
}

export async function reviewAuthorityRequest(
  pool: Pool,
  actor: Principal,
  id: string,
  input: ReviewInput,
  now = new Date(),
): Promise<AuthorityRequest> {
  requireText(id);
  requireText(input.evidenceRef);
  if (typeof input.approved !== "boolean" || !Number.isFinite(now.getTime()))
    throw new BackendError("invalid_input", 400);
  const expiry = input.approved ? parseExpiry(input.expiresAt, now) : undefined;
  return transaction(pool, async (db) => {
    const found = await db.query(
      `SELECT ${requestColumns} FROM authority_requests WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!found.rows[0]) throw new BackendError("not_found", 404);
    const request = requestRecord(found.rows[0]);
    await requireAuthorityManager(db, actor, request.patientId);
    if (request.status !== "pending") throw new BackendError("already_reviewed", 409);
    if (expiry) {
      await writeGrant(
        db,
        actor.id,
        {
          patientId: request.patientId,
          requesterId: request.requesterId,
          expiresAt: expiry.toISOString(),
          evidenceRef: input.evidenceRef,
        },
        expiry,
      );
    }
    const result = await db.query(
      `UPDATE authority_requests SET status = $2, reviewed_by = $3, evidence_ref = $4 WHERE id = $1 RETURNING ${requestColumns}`,
      [id, input.approved ? "approved" : "denied", actor.id, input.evidenceRef],
    );
    return requestRecord(result.rows[0]);
  });
}

export async function listAuthorityRequests(
  db: Database,
  actor: Principal,
): Promise<AuthorityRequest[]> {
  const current = await getPrincipal(db, actor.id);
  if (!current.verified || !current.active) throw new BackendError("not_found", 404);
  const result = await db.query(
    `SELECT r.id, r.patient_id AS "patientId", r.requester_id AS "requesterId", r.status,
       r.created_at AS "createdAt", r.reviewed_by AS "reviewedBy", r.evidence_ref AS "evidenceRef"
     FROM authority_requests r JOIN principals actor ON actor.id = $1
     LEFT JOIN patients patient ON patient.id = r.patient_id
     WHERE actor.verified AND actor.active AND (
       (actor.role = 'patient' AND (r.requester_id = actor.id OR r.patient_id = actor.patient_id))
       OR (actor.role = 'staff' AND patient.department_id = actor.department_id)
     ) ORDER BY r.created_at, r.id`,
    [actor.id],
  );
  return result.rows.map(requestRecord);
}
