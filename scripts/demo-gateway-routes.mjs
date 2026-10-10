const providerPath =
  /^\/voice\/(?:incoming|verify|status|transfers\/[a-f0-9-]{36}\/result|outbound\/[a-zA-Z0-9_-]{1,128})(?:\?[^\s#]*)?$/;
const apiPath =
  /^\/backend\/(?:me|tasks(?:\/[A-Za-z0-9-]+(?:\/(?:verify|proposals|staff-approval|confirmation|callback|withdraw|takeover))?)?|slots|bookings\/[A-Za-z0-9-]+|operator\/queue|voice\/(?:config|calls(?:\/[A-Za-z0-9-]+(?:\/(?:tool|confirm|end|verify|cancel|transfers))?)?|access-codes|simulate|callbacks|directory(?:\/[A-Za-z0-9-]+)?|transfers\/[A-Za-z0-9-]+\/simulate-result))(?:\?[^\s#]*)?$/;

export function gatewayPath(method, url = "", authorization = "") {
  const backend =
    (method === "GET" ||
      method === "POST" ||
      (method === "PATCH" && /^\/backend\/voice\/directory\/[A-Za-z0-9-]+$/.test(url))) &&
    apiPath.test(url) &&
    /^Bearer [A-Za-z0-9_-]{43}$/i.test(authorization);
  // This is a header-format filter. The API authenticates and authorizes the bearer.
  if (backend) return url.slice("/backend".length);
  // The API validates Twilio signatures (and stream identity) after forwarding.
  return method === "POST" && providerPath.test(url) ? url : null;
}

export function permitsStream(method, url) {
  return method === "GET" && url === "/voice/stream";
}
