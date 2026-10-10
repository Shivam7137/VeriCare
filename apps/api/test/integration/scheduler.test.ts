import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { BackendError } from "../../src/domain.js";
import { seed } from "../../src/fixtures.js";
import { migrate } from "../../src/migrations.js";
import { seedScheduler } from "../../src/scheduler-fixtures.js";
import { MockScheduler, type ChangeRequest, type SchedulerResult } from "../../src/scheduler.js";
import { isolatedDatabase } from "./database.js";

const now = new Date("2030-01-03T12:00:00.000Z");
const request: ChangeRequest = {
  operationKey: "synthetic-operation-001",
  appointmentId: "synthetic-appointment-001",
  patientId: "synthetic-patient-001",
  departmentId: "demo-department",
  slotId: "synthetic-slot-002",
  expectedBookingVersion: "1",
  expectedStartsAt: "2030-01-10T14:30:00.000Z",
  expectedEndsAt: "2030-01-10T15:00:00.000Z",
};

async function setup(t: TestContext) {
  const database = await isolatedDatabase(t);
  const pool = database.open();
  await migrate(pool);
  await seedScheduler(pool, now);
  return { database, pool, scheduler: new MockScheduler(pool, { now: () => now }) };
}

function confirmed(result: SchedulerResult) {
  assert.equal(result.status, "confirmed");
  if (result.status !== "confirmed") throw new Error("Expected confirmed scheduling result");
  return result;
}

test("scheduler moves a booking atomically and reports occupied slots unavailable", async (t) => {
  const { pool, scheduler } = await setup(t);
  assert.equal((await scheduler.getBooking(request.appointmentId))?.version, "1");
  assert.equal((await scheduler.getSlot("synthetic-slot-original"))?.available, false);
  assert.equal((await scheduler.getSlot(request.slotId))?.available, true);
  assert.equal(await scheduler.getBooking("missing"), null);
  assert.equal(await scheduler.getSlot("missing"), null);
  assert.equal(await scheduler.lookup("missing"), null);
  assert.deepEqual(await scheduler.listSlots("other-department"), []);

  const result = confirmed(await scheduler.change(request));
  assert.ok(result.confirmationRef);
  assert.deepEqual(result.booking, {
    id: request.appointmentId,
    patientId: request.patientId,
    departmentId: request.departmentId,
    slotId: request.slotId,
    version: "2",
    startsAt: "2030-01-10T14:30:00.000Z",
    endsAt: "2030-01-10T15:00:00.000Z",
  });
  assert.deepEqual(await scheduler.getBooking(request.appointmentId), result.booking);
  assert.equal((await scheduler.getSlot("synthetic-slot-original"))?.available, true);
  assert.equal((await scheduler.getSlot(request.slotId))?.available, false);
  const slots = await scheduler.listSlots(request.departmentId);
  assert.equal(slots.length, 4);
  assert.equal(slots.filter((slot) => slot.available).length, 2);
  assert.deepEqual(await scheduler.lookup(request.operationKey), result);
  assert.equal((await pool.query("SELECT * FROM scheduler_receipts")).rowCount, 1);
});

test("scheduler reads can use the caller's existing transaction connection", async (t) => {
  const { pool, scheduler } = await setup(t);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE scheduler_bookings SET version = 7 WHERE id = $1", [
      request.appointmentId,
    ]);
    await client.query("UPDATE scheduler_slots SET available = false WHERE id = $1", [
      request.slotId,
    ]);
    assert.equal((await scheduler.getBooking(request.appointmentId, client))?.version, "7");
    assert.equal((await scheduler.getSlot(request.slotId, client))?.available, false);
    assert.equal((await scheduler.getBooking(request.appointmentId))?.version, "1");
    assert.equal((await scheduler.getSlot(request.slotId))?.available, true);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("concurrent duplicate operation keys across pools change the booking once", async (t) => {
  const { database, pool } = await setup(t);
  let committed = 0;
  const options = {
    now: () => now,
    afterCommit: async () => {
      committed += 1;
    },
  };
  const first = new MockScheduler(pool, options);
  const second = new MockScheduler(database.open(), options);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? first : second).change({ ...request })),
  );
  const result = confirmed(results[0]!);
  for (const replay of results) assert.deepEqual(replay, result);
  assert.equal(committed, 1);
  assert.equal((await first.getBooking(request.appointmentId))?.version, "2");
  assert.equal((await pool.query("SELECT * FROM scheduler_receipts")).rowCount, 1);
});

test("an existing operation key rejects changes to every semantic field", async (t) => {
  const { scheduler, pool } = await setup(t);
  const result = await scheduler.change(request);
  const changes: Partial<ChangeRequest>[] = [
    { appointmentId: "synthetic-appointment-002" },
    { patientId: "synthetic-patient-002" },
    { departmentId: "other-department" },
    { slotId: "synthetic-slot-003" },
    { expectedBookingVersion: "2" },
    { expectedStartsAt: "2030-01-10T14:40:00.000Z" },
    { expectedEndsAt: "2030-01-10T15:10:00.000Z" },
  ];
  for (const change of changes) {
    await assert.rejects(
      scheduler.change({ ...request, ...change }),
      (error: unknown) =>
        error instanceof BackendError &&
        error.code === "idempotency_conflict" &&
        error.statusCode === 409,
    );
  }
  assert.deepEqual(
    await scheduler.change({
      expectedBookingVersion: request.expectedBookingVersion,
      expectedStartsAt: request.expectedStartsAt,
      expectedEndsAt: request.expectedEndsAt,
      slotId: request.slotId,
      departmentId: request.departmentId,
      patientId: request.patientId,
      appointmentId: request.appointmentId,
      operationKey: request.operationKey,
    }),
    result,
  );
  assert.equal((await pool.query("SELECT * FROM scheduler_receipts")).rowCount, 1);
});

test("concurrent different payloads under one operation key have one winner", async (t) => {
  const { database, scheduler } = await setup(t);
  const other = new MockScheduler(database.open(), { now: () => now });
  const results = await Promise.allSettled([
    scheduler.change(request),
    other.change({
      ...request,
      slotId: "synthetic-slot-003",
      expectedStartsAt: "2030-01-10T15:30:00.000Z",
      expectedEndsAt: "2030-01-10T16:00:00.000Z",
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.equal(rejected.reason.code, "idempotency_conflict");
  assert.equal((await scheduler.getBooking(request.appointmentId))?.version, "2");
});

test("two bookings racing for one slot cannot both occupy it", async (t) => {
  const { database, pool, scheduler } = await setup(t);
  const other = new MockScheduler(database.open(), { now: () => now });
  const results = await Promise.all([
    scheduler.change(request),
    other.change({
      ...request,
      operationKey: "synthetic-operation-002",
      appointmentId: "synthetic-appointment-002",
      patientId: "synthetic-patient-002",
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "confirmed").length, 1);
  assert.deepEqual(
    results.find((result) => result.status === "rejected"),
    {
      status: "rejected",
      reason: "slot_unavailable",
    },
  );
  assert.equal(
    (await pool.query("SELECT * FROM scheduler_bookings WHERE slot_id = $1", [request.slotId]))
      .rowCount,
    1,
  );
  assert.equal(
    (await pool.query("SELECT sum(version) AS total FROM scheduler_bookings")).rows[0].total,
    "3",
  );
  assert.equal((await pool.query("SELECT * FROM scheduler_receipts")).rowCount, 2);
});

test("concurrent changes to one booking reject the stale version", async (t) => {
  const { database, scheduler } = await setup(t);
  const other = new MockScheduler(database.open(), { now: () => now });
  const results = await Promise.all([
    scheduler.change(request),
    other.change({
      ...request,
      operationKey: "second-operation",
      slotId: "synthetic-slot-003",
      expectedStartsAt: "2030-01-10T15:30:00.000Z",
      expectedEndsAt: "2030-01-10T16:00:00.000Z",
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "confirmed").length, 1);
  assert.deepEqual(
    results.find((result) => result.status === "rejected"),
    {
      status: "rejected",
      reason: "booking_version_conflict",
    },
  );
});

test("opposing changes between occupied slots reject without deadlocking", async (t) => {
  const { database, pool, scheduler } = await setup(t);
  const secondPool = database.open();
  await Promise.all([
    pool.query("SET statement_timeout = '2s'"),
    secondPool.query("SET statement_timeout = '2s'"),
  ]);
  const other = new MockScheduler(secondPool, { now: () => now });
  const results = await Promise.all([
    scheduler.change({
      ...request,
      slotId: "synthetic-slot-original-002",
      expectedStartsAt: "2030-01-10T16:30:00.000Z",
      expectedEndsAt: "2030-01-10T17:00:00.000Z",
    }),
    other.change({
      ...request,
      operationKey: "second-operation",
      appointmentId: "synthetic-appointment-002",
      patientId: "synthetic-patient-002",
      slotId: "synthetic-slot-original",
      expectedStartsAt: "2030-01-10T13:30:00.000Z",
      expectedEndsAt: "2030-01-10T14:00:00.000Z",
    }),
  ]);
  assert.deepEqual(results, [
    { status: "rejected", reason: "slot_unavailable" },
    { status: "rejected", reason: "slot_unavailable" },
  ]);
  assert.equal((await scheduler.getBooking(request.appointmentId))?.version, "1");
  assert.equal((await other.getBooking("synthetic-appointment-002"))?.version, "1");
});

test("a failed receipt insert rolls back the booking change and permits a clean retry", async (t) => {
  const { pool, scheduler } = await setup(t);
  const original = await scheduler.getBooking(request.appointmentId);
  await pool.query(`
    CREATE FUNCTION reject_scheduler_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated receipt persistence failure'; END;
    $$;
    CREATE TRIGGER reject_receipt BEFORE INSERT ON scheduler_receipts
      FOR EACH ROW EXECUTE FUNCTION reject_scheduler_receipt();
  `);
  await assert.rejects(scheduler.change(request), /simulated receipt persistence failure/);
  assert.deepEqual(await scheduler.getBooking(request.appointmentId), original);
  assert.equal(await scheduler.lookup(request.operationKey), null);
  assert.equal((await scheduler.getSlot(request.slotId))?.available, true);
  await pool.query("DROP TRIGGER reject_receipt ON scheduler_receipts");
  assert.equal(confirmed(await scheduler.change(request)).booking.version, "2");
});

test("booking validation rejects wrong patient, department, version and unknown records durably", async (t) => {
  const { scheduler } = await setup(t);
  const before = await scheduler.getBooking(request.appointmentId);
  const cases: [Partial<ChangeRequest>, string][] = [
    [{ appointmentId: "missing" }, "booking_not_found"],
    [{ patientId: "synthetic-patient-002" }, "patient_mismatch"],
    [{ departmentId: "other-department" }, "department_mismatch"],
    [{ expectedBookingVersion: "0" }, "booking_version_conflict"],
    [{ expectedBookingVersion: "01" }, "booking_version_conflict"],
    [{ slotId: "missing" }, "slot_not_found"],
    [
      {
        slotId: "synthetic-slot-original",
        expectedStartsAt: "2030-01-10T13:30:00.000Z",
        expectedEndsAt: "2030-01-10T14:00:00.000Z",
      },
      "slot_unavailable",
    ],
  ];
  for (const [index, [change, reason]] of cases.entries()) {
    const attempted = { ...request, ...change, operationKey: `invalid-${index}` };
    const expected = { status: "rejected", reason };
    assert.deepEqual(await scheduler.change(attempted), expected);
    assert.deepEqual(await scheduler.lookup(attempted.operationKey), expected);
    assert.deepEqual(await scheduler.change(attempted), expected);
  }
  assert.deepEqual(await scheduler.getBooking(request.appointmentId), before);
});

test("disabled, expired and different-department slots cannot be booked", async (t) => {
  const { pool, scheduler } = await setup(t);
  const cases = [
    {
      id: "disabled",
      department: request.departmentId,
      start: "2030-01-11T12:00Z",
      end: "2030-01-11T13:00Z",
      available: false,
      reason: "slot_unavailable",
    },
    {
      id: "expired",
      department: request.departmentId,
      start: "2030-01-02T12:00Z",
      end: "2030-01-02T13:00Z",
      available: true,
      reason: "slot_expired",
    },
    {
      id: "started",
      department: request.departmentId,
      start: now.toISOString(),
      end: "2030-01-03T13:00Z",
      available: true,
      reason: "slot_expired",
    },
    {
      id: "wrong-department",
      department: "other-department",
      start: "2030-01-11T12:00Z",
      end: "2030-01-11T13:00Z",
      available: true,
      reason: "department_mismatch",
    },
  ];
  for (const slot of cases) {
    await pool.query(
      `INSERT INTO scheduler_slots (id, department_id, starts_at, ends_at, available) VALUES ($1,$2,$3,$4,$5)`,
      [slot.id, slot.department, slot.start, slot.end, slot.available],
    );
    assert.deepEqual(
      await scheduler.change({
        ...request,
        operationKey: slot.id,
        slotId: slot.id,
        expectedStartsAt: slot.start,
        expectedEndsAt: slot.end,
      }),
      {
        status: "rejected",
        reason: slot.reason,
      },
    );
    if (slot.department === request.departmentId)
      assert.equal((await scheduler.getSlot(slot.id))?.available, false);
  }
  assert.equal((await scheduler.getBooking(request.appointmentId))?.version, "1");
});

test("patient department consistency is rechecked before moving the booking", async (t) => {
  const { pool, scheduler } = await setup(t);
  await pool.query("UPDATE patients SET department_id = 'other-department' WHERE id = $1", [
    request.patientId,
  ]);
  assert.deepEqual(await scheduler.change(request), {
    status: "rejected",
    reason: "department_mismatch",
  });
  assert.equal((await scheduler.getBooking(request.appointmentId))?.version, "1");
});

test("a target slot time changed after proposal consent is rejected and recorded", async (t) => {
  const { pool, scheduler } = await setup(t);
  const original = await scheduler.getBooking(request.appointmentId);
  for (const column of ["starts_at", "ends_at"] as const) {
    await pool.query(
      `UPDATE scheduler_slots SET ${column} = ${column} + interval '10 minutes' WHERE id = $1`,
      [request.slotId],
    );
    const attempted = { ...request, operationKey: `changed-${column}` };
    const result = { status: "rejected", reason: "slot_time_conflict" };
    assert.deepEqual(await scheduler.change(attempted), result);
    assert.deepEqual(await scheduler.lookup(attempted.operationKey), result);
    assert.deepEqual(await scheduler.getBooking(request.appointmentId), original);
    await pool.query("UPDATE scheduler_slots SET starts_at = $2, ends_at = $3 WHERE id = $1", [
      request.slotId,
      request.expectedStartsAt,
      request.expectedEndsAt,
    ]);
    assert.deepEqual(await scheduler.change(attempted), result);
  }
  confirmed(await scheduler.change({ ...request, operationKey: "unchanged-times" }));
});

test("recorded rejections remain unchanged if the slot later becomes available", async (t) => {
  const { pool, scheduler } = await setup(t);
  await pool.query("UPDATE scheduler_slots SET available = false WHERE id = $1", [request.slotId]);
  const result = await scheduler.change(request);
  assert.deepEqual(result, { status: "rejected", reason: "slot_unavailable" });
  await pool.query("UPDATE scheduler_slots SET available = true WHERE id = $1", [request.slotId]);
  assert.deepEqual(await scheduler.change(request), result);
  assert.equal((await scheduler.getBooking(request.appointmentId))?.version, "1");
  confirmed(await scheduler.change({ ...request, operationKey: "new-operation" }));
});

test("response loss after commit can be recovered from a newly opened pool", async (t) => {
  const { database, pool } = await setup(t);
  const scheduler = new MockScheduler(pool, {
    now: () => now,
    afterCommit: async (result) => {
      assert.equal(result.status, "confirmed");
      const receipt = await pool.query(
        "SELECT result FROM scheduler_receipts WHERE operation_key = $1",
        [request.operationKey],
      );
      assert.deepEqual(receipt.rows[0].result, result);
      throw new Error("simulated response loss");
    },
  });
  await assert.rejects(scheduler.change(request), /simulated response loss/);
  await database.close(pool);
  const restarted = new MockScheduler(database.open(), {
    now: () => now,
    afterCommit: async () => {
      throw new Error("replay must not invoke afterCommit");
    },
  });
  const recovered = confirmed((await restarted.lookup(request.operationKey))!);
  assert.equal(recovered.booking.version, "2");
  assert.deepEqual(await restarted.change(request), recovered);
  assert.deepEqual(await restarted.getBooking(request.appointmentId), recovered.booking);
});

test("rejected receipts persist across scheduler restart", async (t) => {
  const { database, pool, scheduler } = await setup(t);
  const attempted = { ...request, expectedBookingVersion: "stale-version" };
  const result = await scheduler.change(attempted);
  assert.deepEqual(result, { status: "rejected", reason: "booking_version_conflict" });
  await database.close(pool);
  const restarted = new MockScheduler(database.open(), { now: () => now });
  assert.deepEqual(await restarted.lookup(request.operationKey), result);
  assert.deepEqual(await restarted.change(attempted), result);
});

test("seeding again preserves existing slots, moved bookings and original fixtures", async (t) => {
  const { pool, scheduler } = await setup(t);
  await seed(pool);
  const beforePatients = (await pool.query("SELECT * FROM patients ORDER BY id")).rows;
  const beforeTasks = (await pool.query("SELECT * FROM tasks ORDER BY id")).rows;
  const beforeEvents = (await pool.query("SELECT * FROM task_events ORDER BY id")).rows;
  const beforeSlots = (await pool.query("SELECT * FROM scheduler_slots ORDER BY id")).rows;
  const moved = confirmed(await scheduler.change(request));
  await seedScheduler(pool, new Date("2040-01-01T00:00:00Z"));
  assert.deepEqual(await scheduler.getBooking(request.appointmentId), moved.booking);
  assert.deepEqual(
    (await pool.query("SELECT * FROM scheduler_slots ORDER BY id")).rows,
    beforeSlots,
  );
  assert.deepEqual((await pool.query("SELECT * FROM patients ORDER BY id")).rows, beforePatients);
  assert.deepEqual((await pool.query("SELECT * FROM tasks ORDER BY id")).rows, beforeTasks);
  assert.deepEqual((await pool.query("SELECT * FROM task_events ORDER BY id")).rows, beforeEvents);
});

test("new fixtures offer the next Thursday at 14:30 UTC, including when today is Thursday", async (t) => {
  for (const date of ["2030-01-03T12:00:00Z", "2030-01-07T12:00:00Z"]) {
    const database = await isolatedDatabase(t);
    const pool = database.open();
    await migrate(pool);
    const seedTime = new Date(date);
    await seedScheduler(pool, seedTime);
    const scheduler = new MockScheduler(pool, { now: () => seedTime });
    const slot = await scheduler.getSlot("synthetic-slot-002");
    assert.equal(slot?.startsAt, "2030-01-10T14:30:00.000Z");
    assert.equal(slot?.endsAt, "2030-01-10T15:00:00.000Z");
    assert.equal(new Date(slot!.startsAt).getUTCDay(), 4);
    assert.equal(slot?.available, true);
    assert.equal(
      (await scheduler.getBooking(request.appointmentId))?.startsAt,
      "2030-01-10T13:30:00.000Z",
    );
  }
});
