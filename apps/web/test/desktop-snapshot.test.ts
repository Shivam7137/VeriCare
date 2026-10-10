import assert from "node:assert/strict";
import test from "node:test";
import { loadDesktopSnapshot } from "../lib/desktop";

test("desktop snapshot reuses and deduplicates scoped queue bookings without per-booking calls", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  const booking = {
    id: "appointment-1",
    patientId: "patient-1",
    startsAt: "2026-10-10T10:00:00Z",
    endsAt: "2026-10-10T10:30:00Z",
  };
  const progress = {
    task: { id: "task-1", patientId: "patient-1" },
    patient: { displayName: "Fictional Patient" },
    workflow: { appointmentId: booking.id },
    booking,
  };
  try {
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      paths.push(path);
      assert.equal(new Headers(init?.headers).get("x-prc-portal"), "professional");
      if (path.endsWith("operator/queue"))
        return Response.json({
          counts: {},
          tasks: [
            progress,
            { ...progress, task: { ...progress.task, id: "task-2" } },
            { ...progress, booking: null, workflow: null },
          ],
        });
      if (path.endsWith("voice/calls"))
        return Response.json({ calls: [{ id: "call-1", taskId: "task-1" }] });
      if (path.endsWith("voice/config"))
        return Response.json({ mode: "simulated", phoneNumber: null, allNumbersAllowed: false });
      if (path.includes("/slots?")) return Response.json({ slots: [{ id: "slot-1" }] });
      throw new Error("Unexpected snapshot request");
    };
    const snapshot = await loadDesktopSnapshot();
    assert.deepEqual(snapshot.bookings, [booking]);
    assert.equal(snapshot.tasks.length, 3);
    assert.equal(snapshot.calls[0]?.patientName, "Fictional Patient");
    assert.equal(snapshot.slots[0]?.id, "slot-1");
    assert.equal(paths.length, 4);
    assert.equal(
      paths.some((path) => path.includes("/bookings/")),
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("empty queue keeps the snapshot shape and does not request patient slots", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  try {
    globalThis.fetch = async (input) => {
      const path = String(input);
      paths.push(path);
      return Response.json(
        path.endsWith("operator/queue")
          ? { counts: {}, tasks: [] }
          : path.endsWith("voice/calls")
            ? { calls: [] }
            : { mode: "simulated" },
      );
    };
    const snapshot = await loadDesktopSnapshot();
    assert.deepEqual(snapshot.bookings, []);
    assert.deepEqual(snapshot.slots, []);
    assert.deepEqual(snapshot.calls, []);
    assert.equal(paths.length, 3);
    assert.ok(Number.isFinite(Date.parse(snapshot.updatedAt)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
