import type { CloudCommandEngineRequest } from "@zeros/protocol/cloud-commands";
import type { CloudActionEngineRequest } from "@zeros/protocol/cloud-actions";
import type { CloudRuntimeAuthority } from "./cloud-runtime-registration";

const MAX_BYTES = 8 * 1024 * 1024;
const codes = new Set(["command_conflict", "command_context_changed", "command_not_found", "command_limit", "invalid_command", "engine_authority_rejected", "cloud_actor_authority_rejected"]);
export class CloudCommandRuntimeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CloudCommandRuntimeError"; }
}
/** Token stays in the engine. Queue payloads cannot override the authority or
 * redirect credentials to a caller-controlled endpoint. */
export async function requestCloudCommand(authority: CloudRuntimeAuthority, request: CloudCommandEngineRequest,
  signal: AbortSignal, requestFetch: typeof fetch = fetch,actorSessionId?:string): Promise<unknown> {
  return requestCloudControl(authority, request, signal, requestFetch, "commands",actorSessionId);
}
export async function requestCloudAction(authority: CloudRuntimeAuthority, request: CloudActionEngineRequest,
  signal: AbortSignal, requestFetch: typeof fetch = fetch,actorSessionId?:string): Promise<unknown> {
  return requestCloudControl(authority, request, signal, requestFetch, "actions",actorSessionId);
}
async function requestCloudControl(authority: CloudRuntimeAuthority, request: CloudCommandEngineRequest | CloudActionEngineRequest,
  signal: AbortSignal, requestFetch: typeof fetch, resource: "commands" | "actions",actorSessionId?:string): Promise<unknown> {
  const { heartbeatEndpoint, heartbeatToken, ...scope } = authority;
  let response: Response;
  try {
    response = await requestFetch(new URL(`/internal/v1/cloud-workspaces/engine/${resource}`, heartbeatEndpoint), {
      method: "POST", redirect: "error", cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { "content-type": "application/json", authorization: `Bearer ${heartbeatToken}` },
      body: JSON.stringify({ ...scope, request,...(actorSessionId?{actorSessionId}:{}) }),
    });
  } catch { throw new CloudCommandRuntimeError("command_service_unavailable"); }
  const limit = response.ok ? MAX_BYTES : 1024;
  if (Number(response.headers.get("content-length")) > limit || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new CloudCommandRuntimeError("command_response_invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("oversized");
      chunks.push(value);
    }
    const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("invalid");
    if (!response.ok) {
      const code = (document as { error?: unknown }).error;
      throw new CloudCommandRuntimeError(typeof code === "string" && codes.has(code) ? code : "command_service_unavailable");
    }
    if (Object.keys(document).length !== 1 || !("result" in document)) throw new Error("invalid");
    return document.result;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CloudCommandRuntimeError) throw error;
    throw new CloudCommandRuntimeError("command_response_invalid");
  } finally { reader.releaseLock(); }
}
