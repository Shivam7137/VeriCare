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
const requests: { url: string; token: string }[] = [];
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
    requests.push({ url, token });
    const role = roles.find((item) => token === `Bearer fixture-${item}`);
    if (!role) return Response.json({ error: "unauthorized" }, { status: 401 });
    return Response.json(
      url.endsWith("/me") ? { id: `synthetic-${role}-001`, role } : { ok: true },
    );
  };
});

beforeEach(() => {
  requests.length = 0;
});

after(async () => {
  process.chdir(originalDirectory);
  globalThis.fetch = originalFetch;
  if (originalDemoSetting === undefined) delete process.env.ENABLE_SYNTHETIC_DEMO;
  else process.env.ENABLE_SYNTHETIC_DEMO = originalDemoSetting;
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

test("portal scope is required and never falls back to another or legacy cookie", async () => {
  for (const portal of [undefined, "staff", "invalid"]) {
    const response = await sessions.GET(request("/api/session", { portal, cookie: bothCookies }));
    assert.equal(response.status, 400);
  }
  for (const cookie of [
    "prc_professional_session=fixture-staff",
    "prc_demo_session=fixture-patient",
  ]) {
    const response = await sessions.GET(request("/api/session", { portal: "patient", cookie }));
    assert.equal(response.status, 401);
  }
  assert.equal(requests.length, 0);
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
    ["POST", "voice/access-codes"],
    ["POST", "voice/simulate"],
    ["POST", "voice/callbacks"],
    ["POST", `voice/calls/${callId}/tool`],
    ["POST", `voice/calls/${callId}/confirm`],
    ["POST", `voice/calls/${callId}/end`],
    ["POST", `voice/calls/${callId}/verify`],
    ["POST", `voice/calls/${callId}/cancel`],
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
