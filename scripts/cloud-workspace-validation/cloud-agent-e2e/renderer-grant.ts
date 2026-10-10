import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";
import type { ClientRequest } from "node:http";
import { z } from "zod";
import { CloudAgentExecutionAdmissionSchema, CloudAgentProviderSchema, CloudNativeCapabilitiesSchema,
  isCloudAgentAdmissionCode, type CloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";

const ERROR_CODES = ["renderer_grant_origin_invalid", "renderer_grant_identity_invalid", "renderer_grant_request_invalid",
  "renderer_grant_invalid", "renderer_runtime_unqualified", "renderer_prepare_denied", "renderer_prepare_response_invalid",
  "renderer_prepare_transport_failed", "renderer_prepare_timeout", "renderer_prepare_cancelled"] as const;
type FailureCode = typeof ERROR_CODES[number] | CloudAgentAdmissionCode;
export class RendererGrantError extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = "RendererGrantError"; }
}
export interface RendererGrantRequestOptions {
  method: "POST"; headers: Record<string, string>; body: Record<string, never>;
  ca: Buffer; timeoutMs: number; signal?: AbortSignal;
}
type JsonResponse = { status: number; body: unknown };
type JsonRequest = (url: URL, options: RendererGrantRequestOptions) => Promise<JsonResponse>;
type Options = { baseUrl: string; workspaceId: string; actorUserId: string; bearerToken: string; ca: Buffer;
  timeoutMs?: number; now?: () => number; requestJson?: JsonRequest };
const metadata = z.object({
  compute: z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    trust: z.enum(["zeros-managed", "compute-administrator"]) }).strict().optional(),
  delegations: z.array(z.object({
    id: z.uuid(), ownerUserId: z.uuid(), kind: z.string().min(1).max(128),
    models: z.array(CloudAgentExecutionAdmissionSchema.shape.model).max(256),
    allModels: z.boolean().optional(), expiresAt: z.string().datetime(),
    runtimeQualified: z.boolean().optional(), runtimeUpgradeRequired: z.boolean().optional(),
    mcpQualified: z.boolean().optional(), nativeCapabilities: CloudNativeCapabilitiesSchema.optional(),
  }).strict()).max(100),
}).strict();
function fail(code: FailureCode): never { throw new RendererGrantError(code); }

/** A private fixture transport: no redirects, ambient trust override or raw
 * HTTP/JSON/TLS/cancellation error escapes into retained evidence. */
const privateRequest: JsonRequest = (url, options) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { reject(new RendererGrantError("renderer_prepare_cancelled")); return; }
  let request: ClientRequest | undefined, timer: ReturnType<typeof setTimeout> | undefined, settled = false;
  const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
  const refuse = (code: FailureCode) => {
    if (settled) return;
    settled = true; cleanup(); request?.destroy(); reject(new RendererGrantError(code));
  };
  const abort = () => refuse("renderer_prepare_cancelled");
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    request = httpsRequest(url, { method: options.method, headers: options.headers, ca: options.ca,
      rejectUnauthorized: true, agent: false }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        // Same read limit as the real renderer's readCloudJson.
        if (bytes > 4 * 1024 * 1024) { chunks.length = 0; refuse("renderer_prepare_response_invalid"); return; }
        chunks.push(chunk);
      });
      response.on("error", () => refuse("renderer_prepare_transport_failed"));
      response.on("aborted", () => refuse("renderer_prepare_transport_failed"));
      response.on("end", () => {
        if (settled) return;
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { refuse("renderer_prepare_response_invalid"); return; }
        settled = true; cleanup(); resolve({ status: response.statusCode ?? 0, body });
      });
    });
    request.on("error", () => refuse("renderer_prepare_transport_failed"));
    timer = setTimeout(() => refuse("renderer_prepare_timeout"), options.timeoutMs);
    request.end(JSON.stringify(options.body));
    if (options.signal?.aborted) abort();
  } catch { refuse("renderer_prepare_transport_failed"); }
});

/** Headless CURRENT-path grant preparation. This uses actual public HTTP and
 * the renderer's actor/provider/model/expiry selection, with synthetic fixture
 * user authority. It does not emulate OAuth, /me or browser account switching. */
export function createRendererGrant(options: Options) {
  let origin: URL;
  try { origin = new URL(options.baseUrl); } catch { return fail("renderer_grant_origin_invalid"); }
  if (origin.protocol !== "https:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) ||
    origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
    fail("renderer_grant_origin_invalid");
  if (!z.uuid().safeParse(options.workspaceId).success || !z.uuid().safeParse(options.actorUserId).success ||
    typeof options.bearerToken !== "string" || options.bearerToken.length < 16 || options.bearerToken.length > 16_384 ||
    !/^[A-Za-z0-9._~+\/-]+={0,2}$/.test(options.bearerToken) || !Buffer.isBuffer(options.ca) ||
    options.ca.length < 1 || options.ca.length > 64 * 1024) fail("renderer_grant_identity_invalid");
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) fail("renderer_grant_identity_invalid");
  const actorUserId = options.actorUserId, bearerToken = options.bearerToken, ca = Buffer.from(options.ca);
  const url = new URL("/v1/cloud-workspaces/" + options.workspaceId + "/agent-credentials/prepare", origin);
  const requestJson = options.requestJson ?? privateRequest, now = options.now ?? Date.now;
  return async (provider: string, model: string, signal?: AbortSignal): Promise<string> => {
    if (signal?.aborted) fail("renderer_prepare_cancelled");
    if (!CloudAgentProviderSchema.safeParse(provider).success || !CloudAgentExecutionAdmissionSchema.shape.model.safeParse(model).success)
      fail("renderer_grant_request_invalid");
    let response: JsonResponse;
    try {
      response = await requestJson(new URL(url), { method: "POST", body: {}, ca, timeoutMs, signal,
        headers: { "content-type": "application/json", authorization: "Bearer " + bearerToken,
          "idempotency-key": randomUUID() } });
    } catch (error) {
      let code: unknown;
      try { code = error && typeof error === "object" ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined; } catch {}
      if (typeof code === "string" && ((ERROR_CODES as readonly string[]).includes(code) || isCloudAgentAdmissionCode(code)))
        fail(code as FailureCode);
      fail(signal?.aborted ? "renderer_prepare_cancelled" : "renderer_prepare_transport_failed");
    }
    if (signal?.aborted) fail("renderer_prepare_cancelled");
    if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599)
      fail("renderer_prepare_response_invalid");
    if (response.status < 200 || response.status >= 300) {
      const refusal = z.object({ error: z.object({ code: z.unknown() }) }).safeParse(response.body);
      if (refusal.success && isCloudAgentAdmissionCode(refusal.data.error.code)) fail(refusal.data.error.code);
      fail("renderer_prepare_denied");
    }
    const parsed = metadata.safeParse(response.body);
    if (!parsed.success) fail("renderer_grant_invalid");
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0) fail("renderer_grant_identity_invalid");
    const selected = parsed.data.delegations.filter(row => row.ownerUserId === actorUserId && Date.parse(row.expiresAt) > at);
    const candidates = selected.filter(row => row.kind.startsWith(provider + "-") && row.models.includes(model));
    if (!candidates.length) fail(selected.some(row => row.kind.startsWith(provider + "-"))
      ? "cloud_agent_model_not_authorized" : "cloud_agent_credential_required");
    const grant = candidates.find(row => row.runtimeQualified === true) ?? candidates.find(row => row.runtimeQualified !== false);
    if (!grant) fail(candidates.some(row => row.runtimeUpgradeRequired) ? "cloud_runtime_upgrade_required" : "renderer_runtime_unqualified");
    return grant.id;
  };
}
