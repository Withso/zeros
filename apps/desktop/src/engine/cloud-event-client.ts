import type { CloudEventEngineRequest } from "@zeros/protocol/cloud-events";
import type { CloudRuntimeAuthority } from "./cloud-runtime-registration";

const codes = new Set(["invalid_event", "event_conflict", "event_cursor_expired", "event_stream_changed", "engine_authority_rejected"]);
export class CloudEventRuntimeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CloudEventRuntimeError"; }
}
export async function requestCloudEvent(authority: CloudRuntimeAuthority, request: CloudEventEngineRequest,
  signal: AbortSignal, requestFetch: typeof fetch = fetch): Promise<unknown> {
  const { heartbeatEndpoint, heartbeatToken, ...scope } = authority;
  let response: Response;
  try {
    response = await requestFetch(new URL("/internal/v1/cloud-workspaces/engine/events", heartbeatEndpoint), {
      method: "POST", redirect: "error", cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
      headers: { "content-type": "application/json", authorization: `Bearer ${heartbeatToken}` },
      body: JSON.stringify({ ...scope, request }),
    });
  } catch { throw new CloudEventRuntimeError("event_service_unavailable"); }
  const limit = response.ok ? 2 * 1024 * 1024 : 1024;
  if (Number(response.headers.get("content-length")) > limit || !response.body) {
    await response.body?.cancel().catch(() => undefined); throw new CloudEventRuntimeError("event_response_invalid");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) throw new Error("oversized"); chunks.push(value);
    }
    const document: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("invalid");
    if (!response.ok) {
      const code = (document as { error?: unknown }).error;
      throw new CloudEventRuntimeError(typeof code === "string" && codes.has(code) ? code : "event_service_unavailable");
    }
    if (Object.keys(document).length !== 1 || !("result" in document)) throw new Error("invalid");
    return document.result;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CloudEventRuntimeError) throw error;
    throw new CloudEventRuntimeError("event_response_invalid");
  } finally { reader.releaseLock(); }
}
