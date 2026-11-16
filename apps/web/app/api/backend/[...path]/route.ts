import { NextRequest } from "next/server";
import {
  backend,
  guardDemo,
  json,
  portalSession,
  requestPortal,
  sessionCookie,
} from "../../../../lib/demo-server";

const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const readPaths = new RegExp(
  `^(journey/(visit|desk(?:/(?:accuracy|mission))?)|tasks(?:/[A-Za-z0-9-]+)?|slots|bookings/[A-Za-z0-9-]+|operator/queue|voice/(config|directory|calls(?:/${uuid}(?:/(?:transfers|monitor))?)?))$`,
);
const writePaths = new RegExp(
  `^(journey/(visit/(messages|check-in|contacts(?:/${uuid}/withdraw)?)|desk/(encounters/${uuid}/flags|tasks/${uuid}/close))|tasks(?:/[A-Za-z0-9-]+/(verify|proposals|staff-approval|confirmation|callback|withdraw|takeover))?|voice/(access-codes|simulate|callbacks|calls/${uuid}/(tool|confirm|end|verify|cancel|transfers)|transfers/${uuid}/simulate-result))$`,
);
const patchPaths = /^voice\/directory\/[A-Za-z0-9-]+$/;

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const denied = guardDemo(request);
  if (denied) return denied;
  const portal = requestPortal(request);
  if (!portal) return json({ error: "invalid_portal" }, 400);
  const path = (await context.params).path.join("/");
  const allowed =
    request.method === "GET"
      ? readPaths
      : request.method === "POST"
        ? writePaths
        : request.method === "PATCH"
          ? patchPaths
          : null;
  if (!allowed?.test(path)) return json({ error: "not_found" }, 404);
  try {
    const session = await portalSession(request, portal);
    if (session instanceof Response) return session;
    const body =
      request.method === "POST" || request.method === "PATCH" ? await request.text() : undefined;
    if (body && body.length > 16_384) return json({ error: "invalid_input" }, 400);
    const response = await backend(
      `/${path}${request.nextUrl.search}`,
      session.token,
      body,
      request.method as "GET" | "POST" | "PATCH",
    );
    return sessionCookie(json(await response.json(), response.status), request, portal, session);
  } catch {
    return json({ error: "service_unavailable" }, 503);
  }
}
export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
