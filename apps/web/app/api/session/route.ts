import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { backend, guardDemo, json, portalSession, requestPortal } from "../../../lib/demo-server";
import { permitsRole, portalCookies } from "../../../lib/portal";

export const runtime = "nodejs";
const accounts = {
  patient: "synthetic-patient-001",
  staff: "synthetic-staff-001",
  operator: "synthetic-operator-001",
} as const;

export async function GET(request: NextRequest) {
  const denied = guardDemo(request);
  if (denied) return denied;
  const portal = requestPortal(request);
  if (!portal) return json({ error: "invalid_portal" }, 400);
  try {
    const session = await portalSession(request, portal);
    return session instanceof Response ? session : json(session.actor);
  } catch {
    return json({ error: "service_unavailable" }, 503);
  }
}

export async function POST(request: NextRequest) {
  const denied = guardDemo(request);
  if (denied) return denied;
  const portal = requestPortal(request);
  if (!portal) return json({ error: "invalid_portal" }, 400);
  let persona: keyof typeof accounts;
  try {
    const input = await request.json();
    if (!input || Object.keys(input).length !== 1 || !Object.hasOwn(accounts, input.persona))
      return json({ error: "invalid_input" }, 400);
    persona = input.persona;
  } catch {
    return json({ error: "invalid_input" }, 400);
  }
  if (!permitsRole(portal, persona)) return json({ error: "portal_role_not_allowed" }, 403);
  try {
    // Next runs from apps/web; credentials stay outside the public directory and Git.
    const saved = JSON.parse(
      await readFile(resolve(process.cwd(), "../../.env.sessions.json"), "utf8"),
    );
    const session = saved[accounts[persona]];
    if (!session || Date.parse(session.expiresAt) <= Date.now())
      return json({ error: "demo_session_expired" }, 401);
    const response = await backend("/me", session.token);
    if (!response.ok) return json({ error: "demo_session_expired" }, response.status);
    const actor = await response.json();
    if (
      actor.id !== accounts[persona] ||
      actor.role !== persona ||
      !permitsRole(portal, actor.role)
    )
      return json({ error: "portal_role_not_allowed" }, 403);
    const result = json(actor);
    result.cookies.set(portalCookies[portal], session.token, {
      httpOnly: true,
      sameSite: "strict",
      secure: request.nextUrl.protocol === "https:",
      path: "/api",
      expires: new Date(session.expiresAt),
    });
    return result;
  } catch {
    return json({ error: "demo_setup_required" }, 503);
  }
}

export async function DELETE(request: NextRequest) {
  const denied = guardDemo(request);
  if (denied) return denied;
  const portal = requestPortal(request);
  if (!portal) return json({ error: "invalid_portal" }, 400);
  const result = json({ signedOut: true });
  result.cookies.set(portalCookies[portal], "", {
    httpOnly: true,
    sameSite: "strict",
    secure: request.nextUrl.protocol === "https:",
    path: "/api",
    maxAge: 0,
  });
  return result;
}
