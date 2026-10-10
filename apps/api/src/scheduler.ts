import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { BackendError, transaction, type Database } from "./domain.js";

export type Slot = {
  id: string;
  departmentId: string;
  startsAt: string;
  endsAt: string;
  available: boolean;
};

export type Booking = {
  id: string;
  patientId: string;
  departmentId: string;
  slotId: string;
  version: string;
  startsAt: string;
  endsAt: string;
};

export type ChangeRequest = {
  operationKey: string;
  appointmentId: string;
  patientId: string;
  departmentId: string;
  slotId: string;
  expectedBookingVersion: string;
  expectedStartsAt: string;
  expectedEndsAt: string;
};

export type SchedulerResult =
  | { status: "confirmed"; confirmationRef: string; booking: Booking }
  | { status: "rejected"; reason: string };

export interface Scheduler {
  getBooking(id: string, client?: Database): Promise<Booking | null>;
  getSlot(id: string, client?: Database): Promise<Slot | null>;
  listSlots(departmentId: string): Promise<Slot[]>;
  change(request: ChangeRequest): Promise<SchedulerResult>;
  lookup(operationKey: string): Promise<SchedulerResult | null>;
}

type BookingRow = {
  id: string;
  patient_id: string;
  department_id: string;
  slot_id: string;
  version: number;
};

type SlotRow = {
  id: string;
  department_id: string;
  starts_at: Date;
  ends_at: Date;
  available: boolean;
};

function toSlot(row: SlotRow): Slot {
  return {
    id: row.id,
    departmentId: row.department_id,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    available: row.available,
  };
}

function toBooking(row: BookingRow, slot: Pick<SlotRow, "starts_at" | "ends_at">): Booking {
  return {
    id: row.id,
    patientId: row.patient_id,
    departmentId: row.department_id,
    slotId: row.slot_id,
    version: String(row.version),
    startsAt: slot.starts_at.toISOString(),
    endsAt: slot.ends_at.toISOString(),
  };
}

const slotSelection = `SELECT s.id, s.department_id, s.starts_at, s.ends_at,
  (s.available AND s.starts_at > $2 AND s.ends_at > s.starts_at
    AND NOT EXISTS (SELECT 1 FROM scheduler_bookings b WHERE b.slot_id = s.id)) AS available
  FROM scheduler_slots s`;

export class MockScheduler implements Scheduler {
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    private readonly options: {
      afterCommit?: (result: SchedulerResult) => Promise<void>;
      now?: () => Date;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async getBooking(id: string, client?: Database): Promise<Booking | null> {
    const result = await (client ?? this.pool).query<
      BookingRow & Pick<SlotRow, "starts_at" | "ends_at">
    >(
      `SELECT b.*, s.starts_at, s.ends_at FROM scheduler_bookings b
       JOIN scheduler_slots s ON s.id = b.slot_id WHERE b.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toBooking(row, row) : null;
  }

  async getSlot(id: string, client?: Database): Promise<Slot | null> {
    const result = await (client ?? this.pool).query<SlotRow>(`${slotSelection} WHERE s.id = $1`, [
      id,
      this.now(),
    ]);
    return result.rows[0] ? toSlot(result.rows[0]) : null;
  }

  async listSlots(departmentId: string): Promise<Slot[]> {
    const result = await this.pool.query<SlotRow>(
      `${slotSelection} WHERE s.department_id = $1 ORDER BY s.starts_at, s.id`,
      [departmentId, this.now()],
    );
    return result.rows.map(toSlot);
  }

  async lookup(operationKey: string): Promise<SchedulerResult | null> {
    const result = await this.pool.query<{ result: SchedulerResult }>(
      "SELECT result FROM scheduler_receipts WHERE operation_key = $1",
      [operationKey],
    );
    return result.rows[0]?.result ?? null;
  }

  async change(input: ChangeRequest): Promise<SchedulerResult> {
    // Persist only the semantic request fields; object property order is immaterial in JSONB.
    const request: ChangeRequest = {
      operationKey: input.operationKey,
      appointmentId: input.appointmentId,
      patientId: input.patientId,
      departmentId: input.departmentId,
      slotId: input.slotId,
      expectedBookingVersion: input.expectedBookingVersion,
      expectedStartsAt: input.expectedStartsAt,
      expectedEndsAt: input.expectedEndsAt,
    };
    const receipt = await transaction(this.pool, async (client) => {
      // All changes acquire locks in this order: operation key, booking, target slot.
      // Never lock another booking or the source slot, including when checking occupancy.
      // A schema-qualified advisory key also keeps isolated test databases independent.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('scheduler:' || current_schema() || ':' || $1, 0))",
        [request.operationKey],
      );
      const previous = await client.query<{ same_request: boolean; result: SchedulerResult }>(
        "SELECT request = $2::jsonb AS same_request, result FROM scheduler_receipts WHERE operation_key = $1",
        [request.operationKey, request],
      );
      if (previous.rows[0]) {
        if (!previous.rows[0].same_request) throw new BackendError("idempotency_conflict", 409);
        return { result: previous.rows[0].result, created: false };
      }
      const result = await this.applyChange(client, request);
      await client.query(
        "INSERT INTO scheduler_receipts (operation_key, request, result, created_at) VALUES ($1,$2,$3,$4)",
        [request.operationKey, request, result, this.now()],
      );
      return { result, created: true };
    });

    // Injection is available only in process for response-loss tests, after durable commit.
    if (receipt.created) await this.options.afterCommit?.(receipt.result);
    return receipt.result;
  }

  private async applyChange(client: Database, request: ChangeRequest): Promise<SchedulerResult> {
    const rejected = (reason: string): SchedulerResult => ({ status: "rejected", reason });
    const bookings = await client.query<BookingRow>(
      "SELECT * FROM scheduler_bookings WHERE id = $1 FOR UPDATE",
      [request.appointmentId],
    );
    const booking = bookings.rows[0];
    if (!booking) return rejected("booking_not_found");
    if (booking.patient_id !== request.patientId) return rejected("patient_mismatch");
    const patients = await client.query<{ department_id: string }>(
      "SELECT department_id FROM patients WHERE id = $1",
      [request.patientId],
    );
    if (
      booking.department_id !== request.departmentId ||
      patients.rows[0]?.department_id !== request.departmentId
    ) {
      return rejected("department_mismatch");
    }
    if (String(booking.version) !== request.expectedBookingVersion) {
      return rejected("booking_version_conflict");
    }
    const slots = await client.query<SlotRow>(
      "SELECT * FROM scheduler_slots WHERE id = $1 FOR UPDATE",
      [request.slotId],
    );
    const slot = slots.rows[0];
    if (!slot) return rejected("slot_not_found");
    if (slot.department_id !== request.departmentId) return rejected("department_mismatch");
    if (
      slot.starts_at.getTime() !== Date.parse(request.expectedStartsAt) ||
      slot.ends_at.getTime() !== Date.parse(request.expectedEndsAt)
    ) {
      return rejected("slot_time_conflict");
    }
    if (!slot.available) return rejected("slot_unavailable");
    if (slot.starts_at <= this.now() || slot.ends_at <= slot.starts_at) {
      return rejected("slot_expired");
    }
    const occupants = await client.query("SELECT id FROM scheduler_bookings WHERE slot_id = $1", [
      slot.id,
    ]);
    if (occupants.rowCount !== 0) return rejected("slot_unavailable");

    const updated = await client.query<BookingRow>(
      "UPDATE scheduler_bookings SET slot_id = $2, version = version + 1 WHERE id = $1 RETURNING *",
      [booking.id, slot.id],
    );
    return {
      status: "confirmed",
      confirmationRef: `mock-confirmation:${randomUUID()}`,
      booking: toBooking(updated.rows[0]!, slot),
    };
  }
}
