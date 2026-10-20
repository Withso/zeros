import { z } from "zod";
import {
  CloudAcceptedWorkEnrollRequestSchema, CloudAcceptedWorkReceiptSchema,
  CloudAcceptedWorkContextRequestSchema, CloudAcceptedWorkContextResponseSchema, CloudAcceptedWorkCloseRequestSchema,
  type CloudAcceptedWorkEnrollRequest, type CloudAcceptedWorkReceipt, type CloudAcceptedWorkContextRequest,
  type CloudAcceptedWorkContextResponse, type CloudAcceptedWorkCloseRequest,
} from "@zeros/protocol/cloud-accepted-work";
import type { CloudRuntimeAuthority } from "./cloud-runtime-registration";
import { CloudAgentExecutionError } from "./cloud-agent-execution-client";
import { CloudExecutionEnrollRequestSchema, CloudExecutionAuthorityReceiptSchema, CloudExecutionAuthorityOperationSchema,
  CloudExecutionAuthorityCheckSchema, type CloudExecutionEnrollRequest, type CloudExecutionAuthorityReceipt,
  type CloudExecutionAuthorityOperation, type CloudExecutionAuthorityCheck } from "@zeros/protocol/cloud-execution-authority";

export type AcceptedWorkRequests = { enroll: CloudAcceptedWorkEnrollRequest; context: CloudAcceptedWorkContextRequest; close: CloudAcceptedWorkCloseRequest;
  "execution-enroll": CloudExecutionEnrollRequest; "execution-check": CloudExecutionAuthorityOperation; "execution-close": CloudExecutionAuthorityOperation };
export type AcceptedWorkResponses = { enroll: CloudAcceptedWorkReceipt; context: CloudAcceptedWorkContextResponse; close: { closed: true };
  "execution-enroll": CloudExecutionAuthorityReceipt; "execution-check": CloudExecutionAuthorityCheck; "execution-close": { closed: true } };
const contracts = {
  enroll: { path: "accepted-work", request: CloudAcceptedWorkEnrollRequestSchema, response: CloudAcceptedWorkReceiptSchema, limit: 32 * 1024 },
  context: { path: "accepted-work/context", request: CloudAcceptedWorkContextRequestSchema, response: CloudAcceptedWorkContextResponseSchema, limit: 3 * 1024 * 1024 },
  close: { path: "accepted-work/close", request: CloudAcceptedWorkCloseRequestSchema, response: z.object({ closed: z.literal(true) }).strict(), limit: 1024 },
  "execution-enroll": { path: "execution-authority/enroll", request: CloudExecutionEnrollRequestSchema, response: CloudExecutionAuthorityReceiptSchema, limit: 32 * 1024 },
  "execution-check": { path: "execution-authority/check", request: CloudExecutionAuthorityOperationSchema, response: CloudExecutionAuthorityCheckSchema, limit: 1024 },
  "execution-close": { path: "execution-authority/close", request: CloudExecutionAuthorityOperationSchema, response: z.object({ closed: z.literal(true) }).strict(), limit: 1024 },
} as const;

/** Fixed engine-authenticated routes. Responses never renew client or push
 * authority; the caller rechecks its exact writer and local monotonic budget. */
export async function requestCloudAcceptedWork<Operation extends keyof AcceptedWorkRequests>(authority: CloudRuntimeAuthority,
  operation: Operation, request: AcceptedWorkRequests[Operation], signal: AbortSignal, requestFetch: typeof fetch = fetch,
): Promise<AcceptedWorkResponses[Operation]> {
  const contract = contracts[operation], parsed = contract?.request.safeParse(request);
  if (!parsed?.success || (["organizationId", "workspaceId", "generation", "engineInstanceId"] as const)
    .some(key => parsed.data.scope[key] !== authority[key])) throw new CloudAgentExecutionError("authority_response_invalid");
  const body = JSON.stringify(parsed.data);
  if (Buffer.byteLength(body) > (operation === "context" ? 1024 * 1024 : 64 * 1024)) throw new CloudAgentExecutionError("authority_response_invalid");
  const origin = new URL(authority.heartbeatEndpoint);
  if (origin.username || origin.password || origin.protocol !== "https:" &&
    !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new CloudAgentExecutionError();
  const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(), 10_000); timer.unref?.();
  const bounded = AbortSignal.any([signal, timeout.signal]);
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new CloudAgentExecutionError(signal.aborted ? "lifecycle_superseded" : "authority_timeout"));
    bounded.addEventListener("abort", onAbort, { once: true });
  });
  const within = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (bounded.aborted) throw bounded.reason;
    const response = await within(requestFetch(new URL(`/internal/v2/cloud-workspaces/engine/${contract.path}`, origin), {
      method: "POST", redirect: "error", signal: bounded,
      headers: { "content-type": "application/json", authorization: `Bearer ${authority.heartbeatToken}` }, body }).then(response => {
      if (bounded.aborted) { void response.body?.cancel().catch(() => {}); throw bounded.reason; }
      return response;
    }));
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new CloudAgentExecutionError(response.status === 429 ? "rate_limited" : response.status >= 500 ? "authority_http_5xx" : "authority_http_4xx");
    }
    if (!response.body || Number(response.headers.get("content-length")) > contract.limit) {
      void response.body?.cancel().catch(() => {}); throw new CloudAgentExecutionError("authority_response_invalid");
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const item = await within(reader.read());
      if (item.done) break;
      if ((size += item.value.byteLength) > contract.limit) throw new CloudAgentExecutionError("authority_response_invalid");
      chunks.push(item.value);
    }
    if (bounded.aborted) throw bounded.reason;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new CloudAgentExecutionError("authority_response_invalid"); }
    const result = contract.response.safeParse(value);
    if (!result.success) throw new CloudAgentExecutionError("authority_response_invalid");
    return result.data as AcceptedWorkResponses[Operation];
  } catch (error) {
    void reader?.cancel().catch(() => {});
    if (error instanceof CloudAgentExecutionError) throw error;
    throw new CloudAgentExecutionError(signal.aborted ? "lifecycle_superseded" : bounded.aborted ? "authority_timeout" : "authority_transport");
  } finally { clearTimeout(timer); bounded.removeEventListener("abort", onAbort); reader?.releaseLock(); }
}
