import WebSocket from "ws";
import { CLOUD_V2_MAX_FRAME_BYTES, CLOUD_V2_WORKER_BRIDGE_PATH, CLOUD_V2_WORKER_BRIDGE_PROTOCOL } from "./contract.js";
import type { CloudV2Workspace } from "./store.js";

/** Only the control plane can read this route's private port credential. */
export type WorkerRoute = { workspace: CloudV2Workspace; accessEpoch: string; url: string | null; token: string | null; bootId: string | null };
const peerFeatures = new WeakMap<WebSocket, ReadonlySet<string>>();
export const workerSupportsMcp = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("mcp-v1") ?? false;
export const workerSupportsSetup = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("workspace-setup-v1") ?? false;
export const workerSupportsCheckout = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("checkout-v2") ?? false;
export const workerSupportsGithub = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("github-pr-v1") ?? false;

export function dialWorker(route: WorkerRoute, grant: string): Promise<WebSocket> {
  if (!route.url || !route.token) throw new Error("Worker route unavailable.");
  const url = new URL(route.url);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/" || !/^[A-Za-z0-9._~+/=-]{16,8192}$/.test(route.token))
    throw new Error("Invalid worker route.");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = CLOUD_V2_WORKER_BRIDGE_PATH;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, CLOUD_V2_WORKER_BRIDGE_PROTOCOL, {
      headers: { Cookie: `_port_auth=${route.token}`, "X-Zeros-Worker-Auth": grant },
      maxPayload: CLOUD_V2_MAX_FRAME_BYTES, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 3000,
    });
    const fail = () => { ws.terminate(); reject(new Error("Worker connection unavailable.")); };
    ws.on("upgrade", response => {
      peerFeatures.set(ws, new Set(String(response.headers["x-zeros-worker-features"] ?? "").split(",").map(value => value.trim())));
    });
    ws.on("error", fail);
    ws.on("unexpected-response", (_request, response) => { response.resume(); fail(); });
    ws.once("open", () => { ws.off("error", fail); ws.on("error", () => {}); resolve(ws); });
  });
}
