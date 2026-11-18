import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import * as sessions from "../app/api/session/route";
import * as proxy from "../app/api/backend/[...path]/route";
import { api } from "../lib/ui";

const origin = "http://localhost:3100";
const roles = ["patient", "staff", "operator"] as const;
const originalDirectory = process.cwd();
const originalFetch = globalThis.fetch;
const originalDemoSetting = process.env.ENABLE_SYNTHETIC_DEMO;
const originalPublicOrigin = process.env.PUBLIC_DEMO_ORIGIN;
const originalCredentials = process.env.DEMO_SESSIONS_JSON;
const requests: { url: string; token: string; method?: string; body?: BodyInit | null }[] = [];
let temporaryDirectory: string;

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "prc-portal-test-"));
  const appDirectory = join(temporaryDirectory, "apps", "web");
  await mkdir(appDirectory, { recursive: true });
  await writeFile(
    join(temporaryDirectory, ".env.sessions.json"),
    JSON.stringify(
      Object.fromEntries(
        roles.map((role) => [
          `synthetic-${role}-001`,
          { token: `fixture-${role}`, expiresAt: new Date(Date.now() + 60_000).toISOString() },
        ]),
      ),
    ),
  );
  process.chdir(appDirectory);
  process.env.ENABLE_SYNTHETIC_DEMO = "true";
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const token = new Headers(init?.headers).get("authorization") ?? "";
    requests.push({ url, token, method: init?.method, body: init?.body });
    const role = roles.find((item) => token === `Bearer fixture-${item}`);
    if (!role) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json(
      url.endsWith("/me") ? { id: `synthetic-${role}-001`, role } : { ok: true },
    );
  };
});

beforeEach(() => {
  requests.length = 0;
  process.env.ENABLE_SYNTHETIC_DEMO = "true";
  delete process.env.PUBLIC_DEMO_ORIGIN;
  delete process.env.DEMO_SESSIONS_JSON;
});

after(async () => {
  process.chdir(originalDirectory);
  globalThis.fetch = originalFetch;
  if (originalDemoSetting === undefined) delete process.env.ENABLE_SYNTHETIC_DEMO;
  else process.env.ENABLE_SYNTHETIC_DEMO = originalDemoSetting;
  if (originalPublicOrigin === undefined) delete process.env.PUBLIC_DEMO_ORIGIN;
  else process.env.PUBLIC_DEMO_ORIGIN = originalPublicOrigin;
  if (originalCredentials === undefined) delete process.env.DEMO_SESSIONS_JSON;
  else process.env.DEMO_SESSIONS_JSON = originalCredentials;
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function request(
  path: string,
  {
    method = "GET",
    portal,
    cookie,
    body,
    headers = {},
  }: {
    method?: string;
    portal?: string;
    cookie?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
) {
  return new NextRequest(`${origin}${path}`, {
    method,
    headers: {
      host: "localhost:3100",
      origin,
      ...(portal ? { "x-prc-portal": portal } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const bothCookies = "prc_patient_session=fixture-patient; prc_professional_session=fixture-staff";

test("patient and professional sign-ins issue separate HttpOnly cookies and retain both identities", async () => {
  for (const [portal, persona] of [
    ["patient", "patient"],
    ["professional", "staff"],
  ] as const) {
    const response = await sessions.POST(
      request("/api/session", {
        method: "POST",
        portal,
        cookie: bothCookies,
        body: { persona },
      }),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).role, persona);
    const cookie = response.headers.get("set-cookie")!;
    assert.match(cookie, new RegExp(`^prc_${portal}_session=`));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=strict/i);
    assert.match(cookie, /Path=\/api/i);
    assert.equal(response.cookies.getAll().length, 1);
    const restored = await sessions.GET(request("/api/session", { portal, cookie: bothCookies }));
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).role, persona);
  }
});

test("a portal rejects another portal's personas before requesting backend credentials", async () => {
  for (const [portal, persona] of [
    ["patient", "staff"],
    ["patient", "operator"],
    ["professional", "patient"],
  ]) {
    const response = await sessions.POST(
      request("/api/session", { method: "POST", portal, body: { persona } }),
    );
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "portal_role_not_allowed");
  }
  assert.equal(requests.length, 0);
  const operator = await sessions.POST(
    request("/api/session", {
      method: "POST",
      portal: "professional",
      body: { persona: "operator" },
    }),
  );
  assert.equal(operator.status, 200);
  assert.equal((await operator.json()).role, "operator");
});

test("restoration and proxy reject a wrong-role token even in a correctly named cookie", async () => {
  for (const [portal, cookie] of [
    ["patient", "prc_patient_session=fixture-staff"],
    ["professional", "prc_professional_session=fixture-patient"],
  ]) {
    const restore = await sessions.GET(request("/api/session", { portal, cookie }));
    assert.equal(restore.status, 403);
    const forwarded = await proxy.GET(request("/api/backend/tasks", { portal, cookie }), {
      params: Promise.resolve({ path: ["tasks"] }),
    });
    assert.equal(forwarded.status, 403);
  }
  assert.ok(requests.every(({ url }) => url.endsWith("/me")));
});

test("portal scope is required and another or legacy cookie cannot select the auto identity", async () => {
  for (const portal of [undefined, "staff", "invalid"]) {
    const response = await sessions.GET(request("/api/session", { portal, cookie: bothCookies }));
    assert.equal(response.status, 400);
  }
  assert.equal(requests.length, 0);
  for (const cookie of [
    "prc_professional_session=fixture-staff",
    "prc_demo_session=fixture-patient",
  ]) {
    const response = await sessions.GET(request("/api/session", { portal: "patient", cookie }));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).role, "patient");
    assert.ok(response.cookies.get("prc_patient_session"));
  }
  assert.ok(requests.every(({ token }) => token === "Bearer fixture-patient"));
});

test("sign-out clears only the selected portal cookie", async () => {
  const response = await sessions.DELETE(
    request("/api/session", {
      method: "DELETE",
      portal: "patient",
      cookie: bothCookies,
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.cookies.getAll().length, 1);
  assert.equal(response.cookies.get("prc_patient_session")?.maxAge, 0);
  assert.equal(response.cookies.get("prc_professional_session"), undefined);
  assert.equal((await sessions.DELETE(request("/api/session", { method: "DELETE" }))).status, 400);
});

test("local host and same-origin mutation restrictions remain enforced", async () => {
  const deniedOrigin = await sessions.POST(
    request("/api/session", {
      method: "POST",
      portal: "patient",
      body: { persona: "patient" },
      headers: { origin: "https://example.com" },
    }),
  );
  assert.equal(deniedOrigin.status, 403);
  const deniedHost = await sessions.GET(
    request("/api/session", {
      portal: "patient",
      cookie: bothCookies,
      headers: { host: "example.com" },
    }),
  );
  assert.equal(deniedHost.status, 404);
  assert.equal(requests.length, 0);
});

test("proxy uses the selected cookie and permits only the documented voice routes", async () => {
  const callId = "00000000-0000-4000-8000-000000000001";
  const paths = [
    ["GET", "voice/config"],
    ["GET", "voice/calls"],
    ["GET", `voice/calls/${callId}`],
    ["GET", "voice/directory"],
    ["GET", `voice/calls/${callId}/transfers`],
    ["POST", "voice/access-codes"],
    ["POST", "voice/simulate"],
    ["POST", "voice/callbacks"],
    ["POST", `voice/calls/${callId}/tool`],
    ["POST", `voice/calls/${callId}/confirm`],
    ["POST", `voice/calls/${callId}/end`],
    ["POST", `voice/calls/${callId}/verify`],
    ["POST", `voice/calls/${callId}/cancel`],
    ["POST", `voice/calls/${callId}/transfers`],
    ["POST", `voice/transfers/${callId}/simulate-result`],
  ] as const;
  for (const [method, path] of paths) {
    const response = await proxy[method](
      request(`/api/backend/${path}`, {
        method,
        portal: "patient",
        cookie: bothCookies,
        ...(method === "POST" ? { body: {} } : {}),
      }),
      { params: Promise.resolve({ path: path.split("/") }) },
    );
    assert.equal(response.status, 200, path);
    assert.equal(requests.at(-1)?.token, "Bearer fixture-patient");
  }
  for (const path of ["voice/calls/not-a-uuid", "voice/webhooks", "voice/calls/extra/path"]) {
    const response = await proxy.GET(
      request(`/api/backend/${path}`, {
        portal: "professional",
        cookie: bothCookies,
      }),
      { params: Promise.resolve({ path: path.split("/") }) },
    );
    assert.equal(response.status, 404, path);
  }
  const professional = await proxy.GET(
    request("/api/backend/tasks", {
      portal: "professional",
      cookie: bothCookies,
    }),
    { params: Promise.resolve({ path: ["tasks"] }) },
  );
  assert.equal(professional.status, 200);
  assert.equal(requests.at(-1)?.token, "Bearer fixture-staff");
});

test("the demo control bar reaches exactly its two journey routes, as staff or as the patient", async () => {
  for (const portal of ["professional", "patient"] as const) {
    const state = await proxy.GET(
      request("/api/backend/journey/demo/state?visit=abc", {
        portal,
        cookie: bothCookies,
      }),
      { params: Promise.resolve({ path: ["journey", "demo", "state"] }) },
    );
    assert.equal(state.status, 200, portal);
    assert.equal(requests.at(-1)?.url.endsWith("/journey/demo/state?visit=abc"), true);
    const act = await proxy.POST(
      request("/api/backend/journey/demo/act", {
        method: "POST",
        portal,
        cookie: bothCookies,
        body: { type: "pause" },
      }),
      { params: Promise.resolve({ path: ["journey", "demo", "act"] }) },
    );
    assert.equal(act.status, 200, portal);
    assert.equal(requests.at(-1)?.url.endsWith("/journey/demo/act"), true);
  }
  // Nothing else under demo is reachable, and the state route cannot be posted to.
  for (const [method, path] of [
    ["GET", "journey/demo/act"],
    ["GET", "journey/demo"],
    ["GET", "journey/demo/state/extra"],
    ["POST", "journey/demo/state"],
    ["POST", "journey/demo/reset"],
  ] as const) {
    const response = await proxy[method](
      request(`/api/backend/${path}`, {
        method,
        portal: "professional",
        cookie: bothCookies,
        ...(method === "POST" ? { body: {} } : {}),
      }),
      { params: Promise.resolve({ path: path.split("/") }) },
    );
    assert.equal(response.status, 404, `${method} ${path}`);
  }
});

test("directory PATCH forwards its method and body and rejects provider callbacks and other PATCH routes", async () => {
  const path = "voice/directory/synthetic-staff-001";
  const body = { phoneNumber: null, expectedRevision: 1 };
  const response = await proxy.PATCH(
    request(`/api/backend/${path}`, {
      method: "PATCH",
      portal: "professional",
      cookie: bothCookies,
      body,
    }),
    { params: Promise.resolve({ path: path.split("/") }) },
  );
  assert.equal(response.status, 200);
  assert.equal(requests.at(-1)?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.body)), body);
  for (const invalid of [
    "tasks/task-1",
    "voice/config",
    "voice/transfers/00000000-0000-4000-8000-000000000001/result",
  ]) {
    const denied = await proxy.PATCH(
      request(`/api/backend/${invalid}`, {
        method: "PATCH",
        portal: "professional",
        cookie: bothCookies,
        body,
      }),
      { params: Promise.resolve({ path: invalid.split("/") }) },
    );
    assert.equal(denied.status, 404);
  }
});

test("the client sends explicit portal scope or infers it from the current portal path", async () => {
  const backendFetch = globalThis.fetch;
  const scopes: (string | null)[] = [];
  try {
    globalThis.fetch = async (_input, init) => {
      scopes.push(new Headers(init?.headers).get("x-prc-portal"));
      return Response.json({ ok: true });
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { pathname: "/patient" } },
    });
    await api("/api/backend/tasks");
    await api("/api/backend/tasks", undefined, undefined, "professional");
    assert.deepEqual(scopes, ["patient", "professional"]);
  } finally {
    globalThis.fetch = backendFetch;
    delete (globalThis as { window?: unknown }).window;
  }
});

test("GET and proxy automatically verify the patient/staff identities and keep tokens HttpOnly", async () => {
  for (const [portal, role] of [
    ["patient", "patient"],
    ["professional", "staff"],
  ] as const) {
    const session = await sessions.GET(request("/api/session", { portal }));
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), { id: `synthetic-${role}-001`, role });
    assert.match(session.headers.get("set-cookie")!, /HttpOnly/i);
    assert.equal(session.cookies.getAll().length, 1);
    const result = await proxy.GET(request("/api/backend/operator/queue", { portal }), {
      params: Promise.resolve({ path: ["operator", "queue"] }),
    });
    assert.equal(result.status, 200);
    assert.equal(result.cookies.getAll().length, 1);
    assert.equal(requests.at(-1)?.token, `Bearer fixture-${role}`);
  }
});

test("a rejected cookie refreshes exactly once from the provisioned identity", async () => {
  const result = await proxy.GET(
    request("/api/backend/tasks", {
      portal: "patient",
      cookie: "prc_patient_session=expired-fixture",
    }),
    { params: Promise.resolve({ path: ["tasks"] }) },
  );
  assert.equal(result.status, 200);
  assert.equal(result.cookies.getAll().length, 1);
  assert.deepEqual(
    requests.map(({ token }) => token),
    ["Bearer expired-fixture", "Bearer fixture-patient", "Bearer fixture-patient"],
  );
});

test("the explicitly configured HTTPS origin supports forwarded TLS and exact same-origin mutations", async () => {
  process.env.PUBLIC_DEMO_ORIGIN = "https://demo.example.com";
  const publicHeaders = {
    host: "demo.example.com",
    origin: "https://demo.example.com",
    "x-forwarded-proto": "https",
  };
  const accepted = await sessions.GET(
    request("/api/session", { portal: "professional", headers: publicHeaders }),
  );
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers.get("set-cookie")!, /Secure/);
  const mutation = await proxy.POST(
    request("/api/backend/tasks", {
      method: "POST",
      portal: "patient",
      headers: publicHeaders,
      body: {},
    }),
    { params: Promise.resolve({ path: ["tasks"] }) },
  );
  assert.equal(mutation.status, 200);
  for (const headers of [
    { ...publicHeaders, origin: "https://demo.example.com.evil.test" },
    { ...publicHeaders, origin: "http://demo.example.com" },
    { ...publicHeaders, origin: "" },
  ]) {
    assert.equal(
      (
        await sessions.POST(
          request("/api/session", {
            method: "POST",
            portal: "patient",
            headers,
            body: { persona: "patient" },
          }),
        )
      ).status,
      403,
    );
  }
  for (const headers of [
    { ...publicHeaders, host: "evil.example.com", "x-forwarded-host": "demo.example.com" },
    { ...publicHeaders, "x-forwarded-proto": "http" },
    { ...publicHeaders, "x-forwarded-proto": "https,http" },
  ]) {
    assert.equal(
      (await sessions.GET(request("/api/session", { portal: "patient", headers }))).status,
      404,
    );
  }
  process.env.PUBLIC_DEMO_ORIGIN = "https://demo.example.com/path";
  assert.equal(
    (await sessions.GET(request("/api/session", { portal: "patient", headers: publicHeaders })))
      .status,
    404,
  );
});

test("disabled demo never issues or refreshes credentials", async () => {
  process.env.ENABLE_SYNTHETIC_DEMO = "false";
  for (const cookie of [undefined, bothCookies]) {
    assert.equal(
      (await sessions.GET(request("/api/session", { portal: "patient", cookie }))).status,
      404,
    );
    assert.equal(
      (
        await proxy.GET(request("/api/backend/tasks", { portal: "professional", cookie }), {
          params: Promise.resolve({ path: ["tasks"] }),
        })
      ).status,
      404,
    );
  }
  assert.equal(requests.length, 0);
});

test("hosted credentials fail closed for malformed, absent, expired and invalid identities", async () => {
  for (const saved of [
    "not-json",
    "{}",
    JSON.stringify({ "synthetic-patient-001": { token: "fixture-patient", expiresAt: "invalid" } }),
    JSON.stringify({
      "synthetic-patient-001": { token: "fixture-patient", expiresAt: "2000-01-01T00:00:00Z" },
    }),
  ]) {
    process.env.DEMO_SESSIONS_JSON = saved;
    const result = await sessions.GET(request("/api/session", { portal: "patient" }));
    assert.equal(result.status, 503);
    assert.equal(result.cookies.getAll().length, 0);
    assert.ok((await result.json()).message);
  }
  assert.equal(requests.length, 0);
  process.env.DEMO_SESSIONS_JSON = JSON.stringify({
    "synthetic-patient-001": {
      token: "revoked-fixture",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const revoked = await sessions.GET(
    request("/api/session", { portal: "patient", cookie: "prc_patient_session=expired-fixture" }),
  );
  assert.equal(revoked.status, 503);
  assert.equal(requests.length, 2);
  assert.equal(revoked.cookies.getAll().length, 0);
  process.env.DEMO_SESSIONS_JSON = JSON.stringify({
    "synthetic-patient-001": {
      token: "fixture-staff",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  assert.equal((await sessions.GET(request("/api/session", { portal: "patient" }))).status, 403);
  process.env.DEMO_SESSIONS_JSON = JSON.stringify({
    "synthetic-patient-001": {
      token: "fixture-patient",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const valid = await sessions.GET(request("/api/session", { portal: "patient" }));
  assert.equal(valid.status, 200);
  assert.equal(JSON.stringify(await valid.json()).includes("fixture-patient"), false);
});

test("invalid persona shapes cannot coerce to a provisioned role", async () => {
  for (const persona of [["patient"], {}, null, "constructor", "administrator"]) {
    assert.equal(
      (
        await sessions.POST(
          request("/api/session", { method: "POST", portal: "patient", body: { persona } }),
        )
      ).status,
      400,
    );
  }
  assert.equal(requests.length, 0);
});

test("backend failures stop resolution without refreshing a valid-cookie request", async () => {
  const fixtureFetch = globalThis.fetch;
  try {
    let count = 0;
    globalThis.fetch = async () => {
      count += 1;
      return Response.json({ error: "storage_unavailable" }, { status: 503 });
    };
    const unavailable = await sessions.GET(
      request("/api/session", { portal: "patient", cookie: bothCookies }),
    );
    assert.equal(unavailable.status, 503);
    assert.equal(count, 1);
    assert.equal(unavailable.cookies.getAll().length, 0);
    globalThis.fetch = async () => {
      throw new Error("fictional-network-failure");
    };
    assert.equal(
      (await sessions.GET(request("/api/session", { portal: "patient", cookie: bothCookies })))
        .status,
      503,
    );
    assert.equal((await sessions.GET(request("/api/session", { portal: "patient" }))).status, 503);
  } finally {
    globalThis.fetch = fixtureFetch;
  }
});

test("an allowed role with a different identity cannot impersonate the provisioned demo account", async () => {
  const fixtureFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({ id: "another-synthetic-patient", role: "patient" });
    const response = await sessions.GET(request("/api/session", { portal: "patient" }));
    assert.equal(response.status, 403);
    assert.equal(response.cookies.getAll().length, 0);
  } finally {
    globalThis.fetch = fixtureFetch;
  }
});

test("forwarded HTTPS cannot change a loopback cookie's transport", async () => {
  const result = await sessions.GET(
    request("/api/session", {
      portal: "patient",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "demo.example.com" },
    }),
  );
  assert.equal(result.status, 200);
  assert.doesNotMatch(result.headers.get("set-cookie")!, /Secure/);
});
