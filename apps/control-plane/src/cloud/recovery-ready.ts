import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { dialWorker, type WorkerRoute } from "./worker-connection.js";

/** Passive open crosses the worker's configuration barrier without admitting
 * a person's turn, attaching a terminal, or keeping an idle workspace awake. */
export async function recoveryWorkerReady(route: WorkerRoute, grant: string,
  options: { dial?: typeof dialWorker; timeoutMs?: number } = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  let socket: WebSocket;
  try { socket = await (options.dial ?? dialWorker)(route, grant, { timeoutMs: Math.min(15_000, timeoutMs) }); }
  catch { return false; }
  return new Promise(resolve => {
    const clientId = randomUUID();
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      socket.off("message", message); socket.off("close", closed); socket.off("error", closed);
      if (socket.readyState === WebSocket.OPEN && ready) {
        socket.send(JSON.stringify({ t: "close", clientId })); socket.close(1000);
      } else socket.terminate();
      resolve(ready);
    };
    const closed = () => finish(false);
    const message = (data: WebSocket.RawData, binary: boolean) => {
      const bytes = Array.isArray(data) ? data.reduce((sum, part) => sum + part.byteLength, 0) : data.byteLength;
      if (binary || bytes > 65536) return;
      try {
        const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        const frame = JSON.parse(raw.toString()) as { t?: unknown; clientId?: unknown; frame?: { type?: unknown } };
        if (frame.t === "frame" && frame.clientId === clientId && frame.frame?.type === "ENGINE_READY") finish(true);
      } catch { /* Other carrier frames cannot attest readiness. */ }
    };
    const timer = setTimeout(closed, Math.max(0, deadline - Date.now())); timer.unref();
    socket.on("message", message); socket.once("close", closed); socket.once("error", closed);
    socket.send(JSON.stringify({ t: "open", clientId, passive: true }));
  });
}
