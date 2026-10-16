import { z } from "zod";
import type { CloudRuntimeAuthority } from "./cloud-runtime-registration";
import { CloudAgentCredentialControlExchangeRequestSchema, CloudAgentCredentialControlExchangeResponseSchema,
  CloudCredentialControlError, type CloudAgentCredentialControlExchangeRequest,
  type CloudAgentCredentialControlExchangeResponse } from "./cloud-local-command-queue-start-fences";

const LIMIT = 256 * 1024;
/** Local quiescence cancels background work without revoking the confirmed
 * writer needed for final replication. Registration still checks its current
 * authority after this request settles. This code is not a wire response. */
export class CloudCredentialControlCancelledError extends Error {
  readonly code = "credential_control_cancelled";
  constructor() { super("credential_control_cancelled"); this.name = "CloudCredentialControlCancelledError"; }
}
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
  if (Buffer.byteLength(body) > LIMIT) throw failed(true);
  let endpoint: URL;
  try {
    const origin = new URL(authority.heartbeatEndpoint);
    if (origin.protocol !== "https:" || origin.username || origin.password) throw failed(true);
    endpoint = new URL("/internal/v2/cloud-workspaces/engine/agent-credential-controls", origin);
  } catch { throw failed(true); }
  if (signal.aborted) throw new CloudCredentialControlCancelledError();
  let response: Response;
  try {
    response = await requestFetch(endpoint, {
      method: "POST", redirect: "error", credentials: "omit",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${authority.heartbeatToken}` },
      body, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
  } catch { throw signal.aborted ? new CloudCredentialControlCancelledError() : failed(); }
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
    if (!result.success) throw failed();
    if (result.data.result.controls.some(control => ["organizationId", "workspaceId", "generation", "engineInstanceId", "bootId", "writerEpoch"].some(key =>
      control[key as keyof typeof control] !== request.data[key as keyof typeof request.data]))) throw failed(true);
    if (signal.aborted) throw new CloudCredentialControlCancelledError();
    return result.data.result;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof CloudCredentialControlError || error instanceof CloudCredentialControlCancelledError) throw error;
    throw signal.aborted ? new CloudCredentialControlCancelledError() : failed();
  } finally { reader.releaseLock(); }
}
