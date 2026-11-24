// The Alpha check's egress guard: a proxy on 127.0.0.1 that the app (Chromium's --proxy-server, and HTTPS_PROXY for
// Node, bun, git and CLIs) and the sign-in browser are pointed at. It tunnels only to Alpha, WorkOS and GitHub on port
// 443 and refuses everything else, recording every destination it was asked for. Anything that ignores the proxy is
// caught by the socket snapshot: no process of the run may hold a socket beyond loopback.
import http from "node:http";
import net from "node:net";

/** Exact hosts, and suffixes (leading dot) for AuthKit's hosted sign-in page, whose host the environment names. */
export const ALLOWED_HOSTS = Object.freeze([
  "api-alpha.zeros.build", "app-alpha.zeros.build",
  "api.workos.com", "forwarder.workos.com", ".authkit.app",
  "github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com",
]);

/** host:port from a CONNECT target or URL host; only port 443 is ever allowed. */
export function egressAllowed(target, allowed = ALLOWED_HOSTS) {
  const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(String(target ?? "").trim().toLowerCase());
  if (!match || match[2] !== "443") return false;
  const host = match[1];
  return allowed.some(entry => entry.startsWith(".") ? host.endsWith(entry) && host.length > entry.length : host === entry);
}

export async function startEgressGuard({ allowed = ALLOWED_HOSTS, connect = net.connect } = {}) {
  const attempts = [];
  const record = (method, host, outcome) => attempts.push({ method, host, outcome });
  const server = http.createServer((request, response) => {
    // Plain HTTP is never allowed: every destination on the list is HTTPS.
    let host = request.headers.host ?? "?";
    try { host = new URL(request.url ?? "").host || host; } catch { /* the Host header */ }
    record(request.method ?? "?", host, "refused");
    response.writeHead(403, { "content-type": "text/plain" });
    response.end("The Alpha check allows only Alpha, WorkOS and GitHub over HTTPS.\n");
  });
  server.on("connect", (request, client, head) => {
    const target = request.url ?? "?";
    if (!egressAllowed(target, allowed)) { record("CONNECT", target, "refused"); client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return; }
    const [host, port] = [target.slice(0, target.lastIndexOf(":")).replace(/^\[|\]$/g, ""), Number(target.slice(target.lastIndexOf(":") + 1))];
    const upstream = connect(port, host, () => {
      record("CONNECT", target, "tunnelled");
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    const close = () => { upstream.destroy(); client.destroy(); };
    upstream.on("error", () => { record("CONNECT", target, "upstream_error"); close(); });
    client.on("error", close);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`, port, attempts,
    refused: () => [...new Set(attempts.filter(attempt => attempt.outcome === "refused").map(attempt => attempt.host))],
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
