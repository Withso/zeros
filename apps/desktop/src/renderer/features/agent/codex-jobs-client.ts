import type {
  BridgeMessage,
  CodexJobSnapshotMessage,
  CodexJobsListMessage,
  CodexJobStartMessage,
  CodexJobWire,
} from "@zeros/protocol/messages";

import { getActiveBridge } from "../../platform/bridge/active-bridge";

const JOB_CONTROL_TIMEOUT_MS = 10_000;

export type CodexJobStartInput = Pick<
  CodexJobStartMessage,
  | "cwd"
  | "prompt"
  | "model"
  | "reasoningEffort"
  | "sandboxMode"
  | "networkAccessEnabled"
  | "outputSchema"
  | "timeoutMs"
>;

export class CodexJobClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexJobClientError";
    this.code = code;
  }
}

function bridge() {
  const active = getActiveBridge();
  if (!active) {
    throw new CodexJobClientError(
      "DISCONNECTED",
      "The Zeros engine is not connected yet.",
    );
  }
  return active;
}

async function snapshotRequest(
  payload: Record<string, unknown> & { type: string },
): Promise<CodexJobSnapshotMessage> {
  const response = await bridge().request<CodexJobSnapshotMessage>(
    payload as Partial<BridgeMessage> & { type: string },
    JOB_CONTROL_TIMEOUT_MS,
  );
  if (response.type !== "CODEX_JOB_SNAPSHOT") {
    throw new CodexJobClientError(
      "PROTOCOL_ERROR",
      `Unexpected response to ${payload.type}: ${response.type}`,
    );
  }
  if (response.error) {
    throw new CodexJobClientError(response.error.code, response.error.message);
  }
  return response;
}

export async function startCodexJob(
  input: CodexJobStartInput,
): Promise<CodexJobWire> {
  const response = await snapshotRequest({ type: "CODEX_JOB_START", ...input });
  if (!response.job) {
    throw new CodexJobClientError(
      "PROTOCOL_ERROR",
      "The engine accepted the Codex job request without returning a job.",
    );
  }
  return response.job;
}

export async function getCodexJob(
  jobId: string,
): Promise<CodexJobWire | null> {
  return (await snapshotRequest({ type: "CODEX_JOB_GET", jobId })).job;
}

export async function cancelCodexJob(
  jobId: string,
): Promise<CodexJobWire | null> {
  return (await snapshotRequest({ type: "CODEX_JOB_CANCEL", jobId })).job;
}

export async function listCodexJobs(): Promise<CodexJobWire[]> {
  const response = await bridge().request<CodexJobsListMessage>(
    { type: "CODEX_JOB_LIST" },
    JOB_CONTROL_TIMEOUT_MS,
  );
  if (response.type !== "CODEX_JOBS_LIST") {
    throw new CodexJobClientError(
      "PROTOCOL_ERROR",
      `Unexpected response to CODEX_JOB_LIST: ${response.type}`,
    );
  }
  if (response.error) {
    throw new CodexJobClientError(response.error.code, response.error.message);
  }
  return response.jobs;
}
