import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { backend, guardDemo, json, SESSION_COOKIE } from "../../../lib/demo-server";

export const runtime = "nodejs";
const accounts = {
  patient: "synthetic-patient-001",
  staff: "synthetic-staff-001",
  operator: "synthetic-operator-001",
} as const;

export async function GET(request: NextRequest) {
  const denied = guardDemo(request);
  if (denied) return denied;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return json({ error: "unauthorized" }, 401);
  try {
    const response = await backend("/me", token);
    return json(await response.json(), response.status);
  } catch {
    return json({ error: "service_unavailable" }, 503);
  }
}

export async function POST(request: NextRequest) {
  const denied = guardDemo(request);
  if (denied) return denied;
  let persona: keyof typeof accounts;
  try {
    const input = await request.json();
    if (!input || Object.keys(input).length !== 1 || !Object.hasOwn(accounts, input.persona))
      return json({ error: "invalid_input" }, 400);
    persona = input.persona;
  } catch {
    return json({ error: "invalid_input" }, 400);
  }
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
    const result = json(await response.json());
    result.cookies.set(SESSION_COOKIE, session.token, {
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
  const result = json({ signedOut: true });
  result.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "strict",
    path: "/api",
    maxAge: 0,
  });
  return result;
}
