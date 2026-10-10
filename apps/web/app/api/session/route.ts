import { NextRequest } from "next/server";
import {
  guardDemo,
  json,
  portalSession,
  requestPortal,
  sessionCookie,
  demoOrigin,
} from "../../../lib/demo-server";
import { demoAccounts, type DemoPersona } from "../../../lib/demo-credentials";
import { permitsRole, portalCookies } from "../../../lib/portal";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const denied = guardDemo(request);
  if (denied) return denied;
  const portal = requestPortal(request);
  if (!portal) return json({ error: "invalid_portal" }, 400);
  try {
    const session = await portalSession(request, portal);
    return session instanceof Response
      ? session
      : sessionCookie(json(session.actor), request, portal, session);
  } catch {
    return json({ error: "service_unavailable" }, 503);
  }
}

export async function POST(request: NextRequest) {
  const denied = guardDemo(request);
  if (denied) return denied;
  const portal = requestPortal(request);
  if (!portal) return json({ error: "invalid_portal" }, 400);
  let persona: DemoPersona;
  try {
    const input = await request.json();
    if (
      !input ||
      Object.keys(input).length !== 1 ||
      typeof input.persona !== "string" ||
      !Object.hasOwn(demoAccounts, input.persona)
    )
      return json({ error: "invalid_input" }, 400);
    persona = input.persona;
  } catch {
    return json({ error: "invalid_input" }, 400);
  }
  if (!permitsRole(portal, persona)) return json({ error: "portal_role_not_allowed" }, 403);
  const session = await portalSession(request, portal, persona);
  return session instanceof Response
    ? session
    : sessionCookie(json(session.actor), request, portal, session);
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
    secure: demoOrigin(request)?.startsWith("https:") === true,
    path: "/api",
    maxAge: 0,
  });
  return result;
}
