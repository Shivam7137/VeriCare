import { NextRequest, NextResponse } from "next/server";
import { isPortal, permitsRole, portalCookies, type Portal } from "./portal";
import type { Actor } from "./ui";

const loopbackHosts = new Set(["127.0.0.1:3100", "localhost:3100", "[::1]:3100"]);

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

// Demo accounts are available only through the explicitly enabled loopback UI.
export function guardDemo(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (process.env.ENABLE_SYNTHETIC_DEMO !== "true" || !loopbackHosts.has(host))
    return json({ error: "demo_unavailable" }, 404);
  if (
    request.method !== "GET" &&
    request.headers.get("origin") !== `${request.nextUrl.protocol}//${host}`
  )
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
export async function portalSession(request: NextRequest, portal: Portal) {
  const token = request.cookies.get(portalCookies[portal])?.value;
  if (!token) return json({ error: "unauthorized" }, 401);
  const response = await backend("/me", token);
  const actor = await response.json();
  if (!response.ok) return json(actor, response.status);
  if (!permitsRole(portal, actor.role)) return json({ error: "portal_role_not_allowed" }, 403);
  return { token, actor: actor as Actor };
}
