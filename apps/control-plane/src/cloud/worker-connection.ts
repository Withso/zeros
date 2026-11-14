import WebSocket from "ws";
import { CLOUD_V2_MAX_FRAME_BYTES, CLOUD_V2_WORKER_BRIDGE_PATH, CLOUD_V2_WORKER_BRIDGE_PROTOCOL } from "./contract.js";
import type { CloudV2Workspace } from "./store.js";

/** Port credentials stay out of ordinary documents; only an authorized sync
 * grant may also deliver them to the person's Mac. */
export type WorkerRoute = { workspace: CloudV2Workspace; accessEpoch: string; url: string | null; token: string | null; bootId: string | null;
  executionMode?: "legacy" | "prepared" | "active"; recoveryAttemptId?: string; workerTokenHash?: string | null; stopBootIds?: readonly string[]; portToken?: unknown };
const peerFeatures = new WeakMap<WebSocket, ReadonlySet<string>>();
export const workerSupportsCarrierDetach = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("carrier-detach-v1") ?? false;
export const workerSupportsActingUser = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("acting-user-v1") ?? false;
export const workerSupportsCreatorLogins = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("creator-agent-logins-v1") ?? false;
export const workerSupportsCreatorModels = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("creator-agent-models-v1") ?? false;
export const workerSupportsCreatorCommitIdentity = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("creator-commit-identity-v1") ?? false;
export const workerSupportsApi = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("workspace-api-v1") ?? false;
export const workerSupportsLocalCommands = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("local-commands-v1") ?? false;
export const workerSupportsLocalCommandReason = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("local-commands-reason-v1") ?? false;
export const workerSupportsNotifyUser = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("notify-user-v1") ?? false;
export const workerSupportsMcp = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("mcp-v1") ?? false;
export const workerSupportsSetup = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("workspace-setup-v1") ?? false;
export const workerSupportsRepositorySetup = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("repository-setup-v1") ?? false;
export const workerSupportsCheckout = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("checkout-v2") ?? false;
export const workerSupportsGithub = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("github-pr-v1") ?? false;
export const workerSupportsGithubUserTokens = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("github-user-token-v1") ?? false;
export const workerSupportsHistoryReplacement = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("history-replace-v1") ?? false;
export const workerSupportsBootTimings = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("boot-timings-v1") ?? false;
export const workerSupportsHistoryDigests = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("history-digest-v1") ?? false;
export const workerSupportsGitIdentity = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("git-identity-v1") ?? false;
export const workerSupportsCodeReview = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("code-review-v1") ?? false;
export const workerSupportsEnvironment = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("workspace-environment-v1") ?? false;
export const workerSupportsRuntimeUpdate = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("runtime-update-v1") ?? false;
export const workerSupportsRuntimeStaging = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("runtime-staging-v1") ?? false;
export const workerSupportsPushSignals = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("push-signals-v1") ?? false;
export const workerSupportsPush = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("worker-push-v1") ?? false;

export const workerSupportsAgentInteractions = (socket: WebSocket): boolean => peerFeatures.get(socket)?.has("agent-interactions-v1") ?? false;

export type WorkerConnectionReason = "route_unavailable" | "route_invalid" | "gateway" | "server_unavailable" | "refused" | "transport" | "timeout" | "cancelled";
export type WorkerConnectionStatusClass = "none" | "2xx" | "3xx" | "4xx" | "5xx";
export type WorkerResponseBodyClass = "empty" | "text" | "html" | "json" | "binary" | "truncated" | "incomplete";
export class WorkerConnectionFailure extends Error {
  constructor(readonly reason: WorkerConnectionReason, readonly statusClass: WorkerConnectionStatusClass = "none",
    readonly status?: number, readonly responseBodyClass?: WorkerResponseBodyClass) {
    super("Worker connection unavailable.");
  }
}

function bodyClass(body: Buffer): WorkerResponseBodyClass {
  if (!body.length) return "empty";
  if (body.includes(0)) return "binary";
  const text = body.toString("utf8").trim();
  if (/^(?:<!doctype\s+html|<html(?:\s|>))/i.test(text)) return "html";
  try { JSON.parse(text); return "json"; } catch { return "text"; }
}

export function dialWorker(route: WorkerRoute, grant: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<WebSocket> {
  if (!route.url || !route.token) throw new WorkerConnectionFailure("route_unavailable");
  let url: URL;
  try { url = new URL(route.url); } catch { throw new WorkerConnectionFailure("route_invalid"); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/" || !/^[A-Za-z0-9._~+/=-]{16,8192}$/.test(route.token))
    throw new WorkerConnectionFailure("route_invalid");
  if (options.signal?.aborted) throw new WorkerConnectionFailure("cancelled");
  const timeoutMs = Math.min(15_000, Math.max(0, options.timeoutMs ?? 15_000));
  if (!Number.isFinite(timeoutMs) || timeoutMs === 0) throw new WorkerConnectionFailure("timeout");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = CLOUD_V2_WORKER_BRIDGE_PATH;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, CLOUD_V2_WORKER_BRIDGE_PROTOCOL, {
      headers: { Cookie: `_port_auth=${route.token}`, "X-Zeros-Worker-Auth": grant },
      maxPayload: CLOUD_V2_MAX_FRAME_BYTES, perMessageDeflate: false, followRedirects: false,
    });
    let settled = false, refusal: WorkerConnectionFailure | undefined, bodyTimer: NodeJS.Timeout | undefined;
    let closeResponse: (() => void) | undefined;
    const cleanup = () => { clearTimeout(timer); clearTimeout(bodyTimer); closeResponse?.(); options.signal?.removeEventListener("abort", abort); };
    const fail = (reason: WorkerConnectionReason, statusClass: WorkerConnectionStatusClass = "none") => {
      if (settled) return;
      settled = true; cleanup(); reject(refusal ?? new WorkerConnectionFailure(reason, statusClass)); ws.terminate();
    };
    const abort = () => fail("cancelled");
    // An explicit refusal can take ten seconds at the provider. The caller's
    // original connect deadline, not a fresh retry budget, bounds this wait.
    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    ws.on("upgrade", response => {
      peerFeatures.set(ws, new Set(String(response.headers["x-zeros-worker-features"] ?? "").split(",").map(value => value.trim())));
    });
    ws.on("error", () => fail("transport"));
    ws.on("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      const statusClass: WorkerConnectionStatusClass = status >= 500 && status < 600 ? "5xx" : status >= 400 && status < 500 ? "4xx"
        : status >= 300 && status < 400 ? "3xx" : status >= 200 && status < 300 ? "2xx" : "none";
      const reason = status === 502 || status === 504 ? "gateway" : status === 503 ? "server_unavailable" : "refused";
      refusal = new WorkerConnectionFailure(reason, statusClass, status, "incomplete");
      closeResponse = () => response.destroy();
      let bytes = 0;
      const chunks: Buffer[] = [];
      const finish = (responseBodyClass: WorkerResponseBodyClass) => {
        if (settled) return;
        refusal = new WorkerConnectionFailure(reason, statusClass, status, responseBodyClass); fail(reason, statusClass);
      };
      // A provider response never becomes a log payload, and its body cannot
      // extend the original dial deadline or grow an unbounded buffer.
      bodyTimer = setTimeout(() => finish("incomplete"), 500);
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 1024) finish("truncated");
        else chunks.push(chunk);
      });
      response.once("end", () => finish(bodyClass(Buffer.concat(chunks))));
      response.once("error", () => finish("incomplete"));
      response.once("aborted", () => finish("incomplete"));
    });
    ws.once("open", () => { if (settled) { ws.terminate(); return; } settled = true; cleanup(); resolve(ws); });
  });
}
