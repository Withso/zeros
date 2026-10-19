import net from "node:net";

// This process owns public ingress only. It receives no registration/provider
// credentials, SQLite handles, dispatch method or general execution RPC.
// Authenticated HTTP/WebSocket bytes go unchanged to its original owner.
const MAX_CONNECTIONS = 128, MAX_CONTROL_BYTES = 4096, WATCHDOG_MS = 15_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let started = false, frontendId, server, watchdog, pending = "", closed = false;
const connections = new Set();

function close() {
  if (closed) return;
  closed = true;
  clearTimeout(watchdog);
  for (const socket of connections) socket.destroy();
  server?.close();
  process.stdin.destroy();
  process.exitCode = 1;
}
function send(frame) {
  if (closed) return;
  if (process.stdout.writableLength > MAX_CONTROL_BYTES) return close();
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}
function alive() { clearTimeout(watchdog); watchdog = setTimeout(close, WATCHDOG_MS); }
function frame(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return close();
  if (!started) {
    if (Object.keys(value).length !== 5 || value.type !== "start" || !uuid.test(value.frontendId ?? "") ||
        [value.socketPath, value.loopbackPath].some(p => typeof p !== "string" || !p.startsWith("/") || p.length > 104 || /[\0\r\n]/.test(p)) ||
        !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) return close();
    started = true; frontendId = value.frontendId;
    server = net.createServer({ pauseOnConnect: true }, socket => {
      if (closed || connections.size >= MAX_CONNECTIONS * 2) { socket.destroy(); return; }
      connections.add(socket);
      const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socket.remoteAddress);
      const backend = net.createConnection({ path: loopback ? value.loopbackPath : value.socketPath });
      connections.add(backend);
      const retire = () => { socket.destroy(); backend.destroy(); connections.delete(socket); connections.delete(backend); };
      socket.on("error", retire); socket.on("close", retire);
      backend.on("error", retire); backend.on("close", retire);
      // Stream backpressure bounds retained bytes. A backend that cannot accept
      // the connection cannot pin a public socket forever.
      const timer = setTimeout(retire, 5_000); timer.unref();
      backend.once("connect", () => {
        clearTimeout(timer);
        if (closed || socket.destroyed) return retire();
        socket.pipe(backend).pipe(socket); socket.resume();
      });
      backend.once("close", () => clearTimeout(timer));
    });
    server.on("error", close);
    server.listen(value.port, "0.0.0.0", () => {
      if (closed) { server.close(); return; }
      alive(); send({ type: "ready", frontendId });
    });
    return;
  }
  if (Object.keys(value).length !== 3 || value.type !== "ping" || value.frontendId !== frontendId ||
      !uuid.test(value.challengeId ?? "")) return close();
  alive(); send({ type: "pong", frontendId, challengeId: value.challengeId });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  if (closed || Buffer.byteLength(pending) + Buffer.byteLength(chunk) > MAX_CONTROL_BYTES) return close();
  pending += chunk;
  for (let newline; (newline = pending.indexOf("\n")) >= 0;) {
    const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
    try { frame(JSON.parse(line)); } catch { close(); }
    if (closed) return;
  }
});
process.stdin.on("end", close); process.stdin.on("error", close); process.stdout.on("error", close);
process.on("SIGTERM", close); process.on("SIGINT", close);
alive();
