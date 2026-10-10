import { NextRequest, NextResponse } from "next/server";
import { isPortal, permitsRole, portalCookies, type Portal } from "./portal";
import type { Actor } from "./ui";
import { demoAccounts, demoCredential, type DemoPersona } from "./demo-credentials";

const loopbackHosts = new Set(["127.0.0.1:3100", "localhost:3100", "[::1]:3100"]);

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

// Forwarded HTTPS is trusted only for the explicitly configured public host.
export function demoOrigin(request: NextRequest): string | null {
  const host = request.headers.get("host") ?? "";
  if (loopbackHosts.has(host)) return `${request.nextUrl.protocol}//${host}`;
  try {
    const configured = process.env.PUBLIC_DEMO_ORIGIN;
    if (!configured) return null;
    const url = new URL(configured);
    if (
      url.origin !== configured ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.host !== host ||
      (request.nextUrl.protocol !== "https:" &&
        request.headers.get("x-forwarded-proto") !== "https")
    )
      return null;
    return configured;
  } catch {
    return null;
  }
}

export function guardDemo(request: NextRequest) {
  const origin = demoOrigin(request);
  if (process.env.ENABLE_SYNTHETIC_DEMO !== "true" || !origin)
    return json({ error: "demo_unavailable" }, 404);
  if (request.method !== "GET" && request.headers.get("origin") !== origin)
    return json({ error: "origin_not_allowed" }, 403);
  return null;
}

export async function backend(path: string, token: string, body?: string) {
  return fetch(`${process.env.API_URL ?? "http://127.0.0.1:4100"}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
}

export function requestPortal(request: NextRequest): Portal | null {
  const portal = request.headers.get("x-prc-portal");
  return isPortal(portal) ? portal : null;
}

// A cookie name chooses a workspace; the backend identity still establishes its authority.
export async function portalSession(request: NextRequest, portal: Portal, persona?: DemoPersona) {
  if (persona) return provisionSession(portal, persona);
  const token = request.cookies.get(portalCookies[portal])?.value;
  if (token) {
    const response = await backend("/me", token);
    if (response.ok) {
      const actor = await response.json();
      if (!permitsRole(portal, actor.role)) return json({ error: "portal_role_not_allowed" }, 403);
      return { token, actor: actor as Actor };
    }
    // Only an expired/missing identity permits one refresh; failures and role errors stop here.
    if (response.status !== 401) return json({ error: "service_unavailable" }, response.status);
  }
  return provisionSession(portal, portal === "patient" ? "patient" : "staff");
}

async function provisionSession(portal: Portal, persona: DemoPersona) {
  try {
    const credential = await demoCredential(persona);
    const response = await backend("/me", credential.token);
    if (!response.ok)
      return json(
        {
          error: response.status === 401 ? "demo_session_expired" : "service_unavailable",
          message: "The demo account is unavailable. Please ask the demo host to refresh it.",
        },
        503,
      );
    const actor = await response.json();
    if (
      actor.id !== demoAccounts[persona] ||
      actor.role !== persona ||
      !permitsRole(portal, actor.role)
    )
      return json({ error: "portal_role_not_allowed" }, 403);
    return { ...credential, actor: actor as Actor };
  } catch (error) {
    const expired = error instanceof Error && error.message === "demo_session_expired";
    return json(
      {
        error: expired ? "demo_session_expired" : "demo_setup_required",
        message: "The demo account needs attention. Please ask the demo host to refresh it.",
      },
      503,
    );
  }
}

export function sessionCookie(
  response: ReturnType<typeof json>,
  request: NextRequest,
  portal: Portal,
  session: { token: string; expiresAt?: string },
) {
  if (session.expiresAt)
    response.cookies.set(portalCookies[portal], session.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: demoOrigin(request)?.startsWith("https:") === true,
      path: "/api",
      expires: new Date(session.expiresAt),
    });
  return response;
}
