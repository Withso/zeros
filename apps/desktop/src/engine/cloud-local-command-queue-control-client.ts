import { z } from "zod";
import type { CloudRuntimeAuthority } from "./cloud-runtime-registration";
import { CloudAgentCredentialControlExchangeRequestSchema, CloudAgentCredentialControlExchangeResponseSchema,
  CloudCredentialControlError, type CloudAgentCredentialControlExchangeRequest,
  type CloudAgentCredentialControlExchangeResponse } from "./cloud-local-command-queue-start-fences";

const LIMIT = 256 * 1024;
/** An engine-authenticated background exchange. Neither Send nor a native
 * callback can choose its endpoint, writer or credential selectors. */
export async function requestCloudCredentialControls(authority: CloudRuntimeAuthority, input: CloudAgentCredentialControlExchangeRequest,
  signal: AbortSignal, requestFetch: typeof fetch = fetch): Promise<CloudAgentCredentialControlExchangeResponse> {
  const request = CloudAgentCredentialControlExchangeRequestSchema.safeParse(input);
  const failed = (authorityLost = false) => new CloudCredentialControlError(authorityLost
    ? "credential_control_authority_rejected" : "credential_control_storage_unavailable");
  if (!request.success || ["organizationId", "workspaceId", "generation", "engineInstanceId"].some(key =>
    request.data[key as keyof typeof request.data] !== authority[key as keyof CloudRuntimeAuthority])) throw failed(true);
  const body = JSON.stringify(request.data);
  if (Buffer.byteLength(body) > LIMIT || signal.aborted) throw failed(true);
  let endpoint: URL;
  try {
    const origin = new URL(authority.heartbeatEndpoint);
    if (origin.protocol !== "https:" || origin.username || origin.password) throw failed(true);
    endpoint = new URL("/internal/v2/cloud-workspaces/engine/agent-credential-controls", origin);
  } catch { throw failed(true); }
  let response: Response;
  try {
    response = await requestFetch(endpoint, {
      method: "POST", redirect: "error", credentials: "omit",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${authority.heartbeatToken}` },
      body, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
  } catch { throw failed(signal.aborted); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw failed(response.status === 401 || response.status === 403); }
  if (!response.body || Number(response.headers.get("content-length")) > LIMIT ||
      response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await response.body?.cancel().catch(() => {}); throw failed();
  }
  const reader = response.body.getReader();
  try {
    let bytes = 0; const chunks: Uint8Array[] = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > LIMIT) throw failed(); chunks.push(value); }
    const result = z.object({ result: CloudAgentCredentialControlExchangeResponseSchema }).strict()
      .safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
    if (signal.aborted || !result.success) throw failed(signal.aborted);
    if (result.data.result.controls.some(control => ["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch"].some(key =>
      control[key as keyof typeof control] !== request.data[key as keyof typeof request.data]))) throw failed(true);
    return result.data.result;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof CloudCredentialControlError ? error : failed();
  } finally { reader.releaseLock(); }
}
