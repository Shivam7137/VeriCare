import assert from "node:assert/strict";
import test from "node:test";
import { harness, settle, start } from "./realtime-bridge-fixtures.js";

test("finished waits for closure and the asynchronous call cleanup", async (t) => {
  let releaseCleanup!: () => void;
  let cleanupCalls = 0;
  const h = harness({
    onClose: () => {
      cleanupCalls++;
      return new Promise((resolve) => {
        releaseCleanup = resolve;
      });
    },
  });
  t.after(() => h.controller.close());
  assert.ok(h.controller.finished instanceof Promise);
  let finished = false;
  void h.controller.finished.then(() => {
    finished = true;
  });
  await h.connect();
  assert.equal(finished, false);
  h.controller.close("server_shutdown");
  await settle();
  assert.equal(cleanupCalls, 1);
  assert.equal(finished, false);
  releaseCleanup();
  await h.controller.finished;
  assert.equal(finished, true);
  h.controller.close();
  assert.equal(cleanupCalls, 1);
});

test("finished includes late authorization and the resulting cleanup after shutdown", async (t) => {
  let authorize!: (value: { callId: string }) => void;
  let releaseCleanup!: () => void;
  const cleaned: unknown[][] = [];
  const h = harness({
    verifyStart: () =>
      new Promise((resolve) => {
        authorize = resolve;
      }),
    onClose: (...args) => {
      cleaned.push(args);
      return new Promise((resolve) => {
        releaseCleanup = resolve;
      });
    },
  });
  t.after(() => h.controller.close());
  assert.ok(h.controller.finished instanceof Promise);
  let finished = false;
  void h.controller.finished.then(() => {
    finished = true;
  });
  h.twilio.receive(start);
  h.controller.close("server_shutdown");
  await settle();
  assert.equal(finished, false);
  authorize({ callId: "phone-call-1" });
  await settle();
  assert.deepEqual(cleaned, [["phone-call-1", "server_shutdown"]]);
  assert.equal(h.connections.length, 0);
  assert.equal(finished, false);
  releaseCleanup();
  await h.controller.finished;
  assert.equal(finished, true);
});

test("finished resolves without authentication and after rejected late authorization", async (t) => {
  const noStart = harness();
  t.after(() => noStart.controller.close());
  assert.ok(noStart.controller.finished instanceof Promise);
  noStart.controller.close();
  await noStart.controller.finished;
  assert.deepEqual(noStart.closed, []);

  let deny!: (error: Error) => void;
  const denied = harness({
    verifyStart: () =>
      new Promise((_resolve, reject) => {
        deny = reject;
      }),
  });
  t.after(() => denied.controller.close());
  let finished = false;
  void denied.controller.finished.then(() => {
    finished = true;
  });
  denied.twilio.receive(start);
  denied.controller.close();
  await settle();
  assert.equal(finished, false);
  deny(new Error("not authorized"));
  await denied.controller.finished;
  assert.equal(finished, true);
  assert.deepEqual(denied.closed, []);
});

test("cleanup failure settles finished without exposing provider or storage errors", async (t) => {
  const h = harness({
    onClose: async () => {
      throw new Error("private storage failure");
    },
  });
  t.after(() => h.controller.close());
  assert.ok(h.controller.finished instanceof Promise);
  await h.connect();
  h.controller.close();
  await assert.doesNotReject(h.controller.finished);
});
