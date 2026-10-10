import http from "node:http";
import { gatewayPath, permitsStream } from "./demo-gateway-routes.mjs";

const server = http.createServer((req, res) => {
  const path = gatewayPath(req.method, req.url, req.headers.authorization);
  if (path === null) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    return;
  }
  // Keep the original form/body, query and signature headers untouched.
  const upstream = http.request(
    { hostname: "127.0.0.1", port: 4100, path, method: req.method, headers: req.headers },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  if (!permitsStream(req.method, req.url)) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = http.request({
    hostname: "127.0.0.1",
    port: 4100,
    path: req.url,
    method: "GET",
    headers: req.headers,
  });
  upstream.on("upgrade", (response, peer, upstreamHead) => {
    socket.write(
      `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
        response.rawHeaders.reduce(
          (all, value, i, fields) =>
            i % 2 === 0 ? all + value + ": " + fields[i + 1] + "\r\n" : all,
          "",
        ) +
        "\r\n",
    );
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) peer.write(head);
    socket.on("error", () => peer.destroy());
    peer.on("error", () => socket.destroy());
    socket.on("close", () => peer.destroy());
    peer.on("close", () => socket.destroy());
    socket.pipe(peer).pipe(socket);
  });
  upstream.on("response", (response) => {
    socket.end(`HTTP/1.1 ${response.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`);
    response.resume();
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
});
server.listen(4199, "127.0.0.1", () => console.log("Demo gateway listening on 127.0.0.1:4199"));
