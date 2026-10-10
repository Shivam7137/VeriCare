import type { Pool } from "pg";
import {
  careTeamDestinationInputSchema,
  careTeamQuerySchema,
  type CareTeamMember,
  type CareTeamDirectoryResult,
} from "@prc/contracts";
import { BackendError, transaction, type Database } from "./domain.js";
import { getPrincipal, requirePatientAccess, type Principal } from "./identity.js";
import { demoPatients } from "./demo-catalog.js";
import { mask } from "./voice-store-support.js";

export type DirectoryRow = {
  id: string;
  name: string;
  role: CareTeamMember["role"];
  department_id: string;
  department_name: string;
  phone_number: string | null;
  revision: number;
};
export function directoryMember(row: DirectoryRow, actor: Principal): CareTeamMember {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    departmentId: row.department_id,
    departmentName: row.department_name,
    phoneNumber: actor.role === "staff" ? row.phone_number : null,
    maskedNumber: row.phone_number ? mask(row.phone_number) : null,
    configured: row.phone_number !== null,
    revision: row.revision,
    fictional: true,
  };
}
export async function directoryScope(
  db: Database,
  actor: Principal,
  patientId?: string,
  now = new Date(),
) {
  const current = await getPrincipal(db, actor.id);
  if (!current.active || !current.verified) throw new BackendError("unauthorized", 401);
  if (patientId) await requirePatientAccess(db, current, patientId, now);
  const subject = patientId ?? (current.role === "patient" ? current.patientId : null);
  const departmentId = subject
    ? (await db.query("SELECT department_id FROM patients WHERE id=$1", [subject])).rows[0]
        ?.department_id
    : current.departmentId;
  if (!departmentId) throw new BackendError("not_found", 404);
  return { actor: current, patientId: subject, departmentId: departmentId as string };
}
export function validateDestination(number: string | null, ownNumber?: string | null) {
  if (!number) throw new BackendError("destination_unconfigured", 409);
  if (!/^\+[1-9]\d{7,14}$/.test(number)) throw new BackendError("invalid_destination", 400);
  if (ownNumber && number === ownNumber) throw new BackendError("transfer_loop", 400);
}
// Repeat safe. Never replace configured destinations or an existing patient association.
export async function seedCareTeam(db: Database) {
  const ids = [...demoPatients.map((patient) => patient.id), "synthetic-patient-002"];
  for (const [index, id] of ids.entries()) {
    await db.query(
      `INSERT INTO patient_care_team(patient_id,member_id)
      SELECT id,$2 FROM patients WHERE id=$1 AND department_id='demo-department'
      AND NOT EXISTS (SELECT 1 FROM patient_care_team WHERE patient_id=$1)
      ON CONFLICT DO NOTHING`,
      [id, index % 2 === 0 ? "synthetic-staff-001" : "demo-staff-daniel-morris"],
    );
  }
}
export class CareTeamDirectory {
  constructor(
    readonly pool: Pool,
    readonly options: { ownNumber?: string | null; now?: () => Date } = {},
  ) {}
  async list(actor: Principal, raw: unknown = {}): Promise<CareTeamDirectoryResult> {
    const input = careTeamQuerySchema.parse(raw);
    const scope = await directoryScope(
      this.pool,
      actor,
      input.patientId,
      this.options.now?.() ?? new Date(),
    );
    if (input.doctor && !scope.patientId) throw new BackendError("patient_required", 400);
    const found = await this.pool.query<DirectoryRow>(
      `SELECT d.* FROM care_team_directory d
      WHERE d.department_id=$1 AND ($2::boolean IS NOT TRUE OR
        (d.role='doctor' AND EXISTS (SELECT 1 FROM patient_care_team p WHERE p.member_id=d.id AND p.patient_id=$3)))
      AND ($4::text IS NULL OR d.name ILIKE '%' || $4 || '%') ORDER BY d.name,d.id`,
      [scope.departmentId, input.doctor ?? false, scope.patientId, input.query ?? null],
    );
    const patients = (
      await this.pool.query(
        `SELECT p.id,COALESCE(p.display_name,p.id) AS name,
      COALESCE(array_agg(d.id) FILTER (WHERE d.role='doctor'),ARRAY[]::text[]) AS "doctorMemberIds"
      FROM patients p LEFT JOIN patient_care_team c ON c.patient_id=p.id
      LEFT JOIN care_team_directory d ON d.id=c.member_id AND d.department_id=p.department_id
      WHERE p.department_id=$1 AND ($2::text IS NULL OR p.id=$2) GROUP BY p.id ORDER BY name,p.id`,
        [
          scope.departmentId,
          scope.actor.role === "patient" ? scope.patientId : (input.patientId ?? null),
        ],
      )
    ).rows;
    return {
      caller: {
        role: scope.actor.role,
        patientId: scope.patientId,
        departmentId: scope.departmentId,
      },
      members: found.rows.map((row) => directoryMember(row, scope.actor)),
      patients,
      selection: !input.doctor
        ? "directory"
        : found.rows.length === 1
          ? "resolved"
          : found.rows.length
            ? "ambiguous"
            : "unassigned",
    };
  }
  async update(actor: Principal, id: string, raw: unknown): Promise<CareTeamMember> {
    const input = careTeamDestinationInputSchema.parse(raw);
    return transaction(this.pool, async (db) => {
      const current = await getPrincipal(db, actor.id);
      if (!current.active || !current.verified) throw new BackendError("unauthorized", 401);
      if (current.role !== "staff") throw new BackendError("forbidden", 403);
      if (input.phoneNumber !== null)
        validateDestination(input.phoneNumber, this.options.ownNumber);
      const row = (
        await db.query<DirectoryRow>(
          "SELECT * FROM care_team_directory WHERE id=$1 AND department_id=$2 FOR UPDATE",
          [id, current.departmentId],
        )
      ).rows[0];
      if (!row) throw new BackendError("not_found", 404);
      if (row.revision !== input.expectedRevision) throw new BackendError("revision_conflict", 409);
      const changed = (
        await db.query<DirectoryRow>(
          "UPDATE care_team_directory SET phone_number=$2,revision=revision+1 WHERE id=$1 RETURNING *",
          [id, input.phoneNumber],
        )
      ).rows[0]!;
      return directoryMember(changed, current);
    });
  }
}
