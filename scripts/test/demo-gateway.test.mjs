import assert from "node:assert/strict";
import test from "node:test";
import { gatewayPath, permitsStream } from "../demo-gateway-routes.mjs";

// Format-only fixture: no provisioned session or real credential is used.
const authorization = `Bearer ${"x".repeat(43)}`;

test("backend routes strip only the gateway prefix and preserve queries", () => {
  assert.equal(
    gatewayPath("GET", "/backend/tasks/T-123?limit=5", authorization),
    "/tasks/T-123?limit=5",
  );
  assert.equal(
    gatewayPath("POST", "/backend/tasks/T-123/confirmation", authorization),
    "/tasks/T-123/confirmation",
  );
  assert.equal(gatewayPath("GET", "/backend/operator/queue", authorization), "/operator/queue");
});

test("directory is the only PATCH route", () => {
  assert.equal(
    gatewayPath("PATCH", "/backend/voice/directory/member-1", authorization),
    "/voice/directory/member-1",
  );
  for (const path of [
    "/backend/tasks/T-123",
    "/backend/voice/directory",
    "/backend/voice/directory/member-1?x=1",
  ]) {
    assert.equal(gatewayPath("PATCH", path, authorization), null);
  }
});

test("backend requests require a bearer-shaped header before API authentication", () => {
  assert.equal(
    gatewayPath("GET", "/backend/voice/calls/call-1/monitor", authorization),
    "/voice/calls/call-1/monitor",
  );
  assert.equal(gatewayPath("GET", "/backend/voice/calls/call-1/monitor"), null);
  for (const header of [undefined, "", "Basic test", "Bearer short"]) {
    assert.equal(gatewayPath("GET", "/backend/me", header), null);
  }
  assert.equal(gatewayPath("GET", "/backend/me", authorization), "/me");
});

test("fixtures, provisioning, unknown paths and unsupported methods are rejected", () => {
  for (const path of [
    "/fixtures",
    "/backend/fixtures",
    "/backend/demo/session",
    "/backend/admin",
    "/backend/tasks/T-123/unknown",
    "/backend/voice/directory/member-1/extra",
    "https://example.com/backend/me",
  ]) {
    assert.equal(gatewayPath("GET", path, authorization), null);
  }
  assert.equal(gatewayPath("DELETE", "/backend/tasks/T-123", authorization), null);
});

test("provider transfer callback preserves its exact query for signature validation", () => {
  const path = "/voice/transfers/12345678-1234-1234-1234-123456789abc/result?attempt=1";
  assert.equal(gatewayPath("POST", path), path);
  assert.equal(gatewayPath("GET", path), null);
  assert.equal(gatewayPath("POST", "/voice/transfers/not-an-id/result"), null);
});

test("existing signed provider routes retain their method and path restrictions", () => {
  for (const path of [
    "/voice/incoming",
    "/voice/verify",
    "/voice/status?callId=call-1",
    "/voice/outbound/call-1",
  ]) {
    assert.equal(gatewayPath("POST", path), path);
    assert.equal(gatewayPath("GET", path), null);
  }
  assert.equal(gatewayPath("POST", "/voice/unknown"), null);
  assert.equal(gatewayPath("POST", "/voice/stream"), null);
});

test("only the exact voice stream GET route permits WebSocket upgrade", () => {
  assert.equal(permitsStream("GET", "/voice/stream"), true);
  for (const path of [
    "/voice/stream?token=x",
    "/backend/voice/stream",
    "/fixtures",
    "/voice/incoming",
  ]) {
    assert.equal(permitsStream("GET", path), false);
  }
  assert.equal(permitsStream("POST", "/voice/stream"), false);
});
