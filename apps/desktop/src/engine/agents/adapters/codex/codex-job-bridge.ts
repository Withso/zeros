import type {
  CodexJobCancelMessage,
  CodexJobGetMessage,
  CodexJobListMessage,
  CodexJobStartMessage,
} from "@zeros/protocol/messages";

import { createMessage, type EngineMessage } from "../../../types";
import type { TransportClient } from "../../../transport/types";
import type {
  CodexSdkJobManager,
  CodexSdkJobRequest,
  CodexSdkJobSnapshot,
} from "./sdk-jobs";

export type CodexJobRequestMessage =
  | CodexJobStartMessage
  | CodexJobGetMessage
  | CodexJobListMessage
  | CodexJobCancelMessage;

export interface CodexJobManagerLike {
  start(input: CodexSdkJobRequest): CodexSdkJobSnapshot;
  get(id: string): CodexSdkJobSnapshot | null;
  list(): CodexSdkJobSnapshot[];
  cancel(id: string): boolean;
}

const REQUEST_TYPES = new Set<EngineMessage["type"]>([
  "CODEX_JOB_START",
  "CODEX_JOB_GET",
  "CODEX_JOB_LIST",
  "CODEX_JOB_CANCEL",
]);

export function isCodexJobRequest(
  msg: EngineMessage,
): msg is CodexJobRequestMessage {
  return REQUEST_TYPES.has(msg.type);
}

/** Trusted-desktop bridge for bounded, non-interactive SDK jobs. Interactive
 * chat stays on app-server. Cloud/relay clients receive a correlated, fixed
 * local-only error and never cause SDK construction or host-path lookup. */
export class CodexJobBridge {
  constructor(
    private readonly getManager: () =>
      | Promise<CodexJobManagerLike>
      | CodexJobManagerLike,
  ) {}

  async handle(
    msg: CodexJobRequestMessage,
    client: TransportClient,
  ): Promise<void> {
    if (client.kind !== "local") {
      this.sendLocalOnly(msg, client);
      return;
    }

    let manager: CodexJobManagerLike;
    try {
      manager = await this.getManager();
    } catch (error) {
      this.sendUnavailable(msg, client, error);
      return;
    }

    try {
      switch (msg.type) {
        case "CODEX_JOB_START": {
          const job = manager.start(toJobRequest(msg));
          client.send(
            createMessage({
              type: "CODEX_JOB_SNAPSHOT",
              source: "engine",
              requestId: msg.id,
              job,
            }),
          );
          break;
        }
        case "CODEX_JOB_GET":
          client.send(
            createMessage({
              type: "CODEX_JOB_SNAPSHOT",
              source: "engine",
              requestId: msg.id,
              job: manager.get(msg.jobId),
            }),
          );
          break;
        case "CODEX_JOB_LIST":
          client.send(
            createMessage({
              type: "CODEX_JOBS_LIST",
              source: "engine",
              requestId: msg.id,
              jobs: manager.list(),
            }),
          );
          break;
        case "CODEX_JOB_CANCEL":
          manager.cancel(msg.jobId);
          client.send(
            createMessage({
              type: "CODEX_JOB_SNAPSHOT",
              source: "engine",
              requestId: msg.id,
              job: manager.get(msg.jobId),
            }),
          );
          break;
      }
    } catch (error) {
      client.send(
        createMessage({
          type: "CODEX_JOB_SNAPSHOT",
          source: "engine",
          requestId: msg.id,
          job: null,
          error: {
            code: "INVALID_REQUEST",
            message: errorMessage(error),
          },
        }),
      );
    }
  }

  private sendLocalOnly(
    msg: CodexJobRequestMessage,
    client: TransportClient,
  ): void {
    const error = {
      code: "LOCAL_ONLY" as const,
      message: "Codex SDK jobs are available only on the trusted desktop.",
    };
    if (msg.type === "CODEX_JOB_LIST") {
      client.send(
        createMessage({
          type: "CODEX_JOBS_LIST",
          source: "engine",
          requestId: msg.id,
          jobs: [],
          error,
        }),
      );
      return;
    }
    client.send(
      createMessage({
        type: "CODEX_JOB_SNAPSHOT",
        source: "engine",
        requestId: msg.id,
        job: null,
        error,
      }),
    );
  }

  private sendUnavailable(
    msg: CodexJobRequestMessage,
    client: TransportClient,
    cause: unknown,
  ): void {
    const error = {
      code: "UNAVAILABLE" as const,
      message: errorMessage(cause),
    };
    if (msg.type === "CODEX_JOB_LIST") {
      client.send(
        createMessage({
          type: "CODEX_JOBS_LIST",
          source: "engine",
          requestId: msg.id,
          jobs: [],
          error,
        }),
      );
      return;
    }
    client.send(
      createMessage({
        type: "CODEX_JOB_SNAPSHOT",
        source: "engine",
        requestId: msg.id,
        job: null,
        error,
      }),
    );
  }
}

function toJobRequest(msg: CodexJobStartMessage): CodexSdkJobRequest {
  return {
    cwd: msg.cwd,
    prompt: msg.prompt,
    ...(msg.model !== undefined ? { model: msg.model } : {}),
    ...(msg.reasoningEffort !== undefined
      ? { reasoningEffort: msg.reasoningEffort }
      : {}),
    ...(msg.sandboxMode !== undefined
      ? { sandboxMode: msg.sandboxMode }
      : {}),
    ...(msg.networkAccessEnabled !== undefined
      ? { networkAccessEnabled: msg.networkAccessEnabled }
      : {}),
    ...(msg.outputSchema !== undefined
      ? { outputSchema: msg.outputSchema }
      : {}),
    ...(msg.timeoutMs !== undefined ? { timeoutMs: msg.timeoutMs } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Compile-time assertion that the concrete manager remains assignable to the
 * deliberately small bridge contract when the SDK wrapper evolves. */
const _managerCompatibility: CodexJobManagerLike | null =
  null as CodexSdkJobManager | null;
void _managerCompatibility;
