import { NextRequest, NextResponse } from "next/server";

export const SESSION_COOKIE = "prc_demo_session";
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
