// The native check's egress guard: a proxy on 127.0.0.1 that the app's processes are pointed at (HTTPS_PROXY,
// HTTP_PROXY, ALL_PROXY; loopback exempt). It never connects anywhere: it records each destination it was asked
// for and refuses it. A short-lived child (a git clone, a CLI's update check) that a socket snapshot would miss is
// caught here; anything that ignores proxy settings is still seen by the socket snapshots and Chromium's net log.
import http from "node:http";

export async function startEgressGuard() {
  const attempts = [];
  const server = http.createServer((request, response) => {
    attempts.push({ method: request.method, host: (() => { try { return new URL(request.url ?? "").host; } catch { return request.headers.host ?? "?"; } })() });
    response.writeHead(403, { "content-type": "text/plain" });
    response.end("The native check allows no network beyond loopback.\n");
  });
  server.on("connect", (request, socket) => {
    attempts.push({ method: "CONNECT", host: request.url ?? "?" });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, attempts, close: () => new Promise(resolve => server.close(() => resolve())) };
}
