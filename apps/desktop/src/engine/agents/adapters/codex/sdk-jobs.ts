import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

import {
  Codex,
  type RunResult,
  type ThreadItem,
  type TurnOptions,
  type Usage,
} from "@openai/codex-sdk";

const MAX_PROMPT_CHARS = 100_000;
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const MAX_RETAINED_JOBS = 100;

export type CodexSdkJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface CodexSdkJobRequest {
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  sandboxMode?: "read-only" | "workspace-write";
  networkAccessEnabled?: boolean;
  outputSchema?: unknown;
  timeoutMs?: number;
}

export interface CodexSdkJobResult {
  finalResponse: string;
  items: ThreadItem[];
  usage: Usage | null;
}

export interface CodexSdkJobSnapshot {
  id: string;
  status: CodexSdkJobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  threadId?: string;
  result?: CodexSdkJobResult;
  error?: string;
}

interface RunnableThread {
  readonly id: string | null;
  run(input: string, options?: TurnOptions): Promise<RunResult>;
}

interface JobRecord {
  request: CodexSdkJobRequest;
  snapshot: CodexSdkJobSnapshot;
  abort: AbortController;
  done: Promise<void>;
  settle: () => void;
}

export interface CodexSdkJobManagerOptions {
  codexPath?: string;
  env?: Record<string, string>;
  maxConcurrent?: number;
  createThread?: (request: CodexSdkJobRequest) => RunnableThread;
}

/** Bounded non-interactive Codex SDK runner for CI/server automation. Desktop
 * chat deliberately stays on app-server; this queue owns only one-shot jobs,
 * explicit cancellation, and serializable polling snapshots. */
export class CodexSdkJobManager {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly queue: string[] = [];
  private readonly maxConcurrent: number;
  private readonly createThread: (
    request: CodexSdkJobRequest,
  ) => RunnableThread;
  private running = 0;
  private pumpScheduled = false;

  constructor(options: CodexSdkJobManagerOptions) {
    this.maxConcurrent = boundedConcurrency(options.maxConcurrent ?? 2);
    this.createThread =
      options.createThread ??
      createSdkThreadFactory(options.codexPath, options.env);
  }

  start(input: CodexSdkJobRequest): CodexSdkJobSnapshot {
    const request = validateJobRequest(input);
    const id = randomUUID();
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const record: JobRecord = {
      request,
      snapshot: { id, status: "queued", createdAt: Date.now() },
      abort: new AbortController(),
      done,
      settle,
    };
    this.jobs.set(id, record);
    this.queue.push(id);
    this.schedulePump();
    this.prune();
    return cloneSnapshot(record.snapshot);
  }

  get(id: string): CodexSdkJobSnapshot | null {
    const snapshot = this.jobs.get(id)?.snapshot;
    return snapshot ? cloneSnapshot(snapshot) : null;
  }

  list(): CodexSdkJobSnapshot[] {
    return [...this.jobs.values()]
      .map((record) => cloneSnapshot(record.snapshot))
      .sort((left, right) => right.createdAt - left.createdAt);
  }

  cancel(id: string): boolean {
    const record = this.jobs.get(id);
    if (!record || !["queued", "running"].includes(record.snapshot.status)) {
      return false;
    }
    record.abort.abort();
    if (record.snapshot.status === "queued") {
      record.snapshot = {
        ...record.snapshot,
        status: "cancelled",
        completedAt: Date.now(),
      };
      record.settle();
      this.schedulePump();
    }
    return true;
  }

  /** Abort all work owned by this manager. Used when the engine shuts down so
   * a headless job cannot outlive the authenticated local runtime that
   * accepted it. Returns the number of jobs for which cancellation began. */
  cancelAll(): number {
    let cancelled = 0;
    for (const id of this.jobs.keys()) {
      if (this.cancel(id)) cancelled += 1;
    }
    return cancelled;
  }

  async wait(id: string): Promise<CodexSdkJobSnapshot | null> {
    const record = this.jobs.get(id);
    if (!record) return null;
    await record.done;
    return this.get(id);
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.maxConcurrent) {
      const id = this.queue.shift();
      if (!id) return;
      const record = this.jobs.get(id);
      if (!record || record.snapshot.status !== "queued") continue;
      this.running += 1;
      record.snapshot = {
        ...record.snapshot,
        status: "running",
        startedAt: Date.now(),
      };
      void this.run(record).finally(() => {
        this.running -= 1;
        record.settle();
        this.schedulePump();
      });
    }
  }

  private async run(record: JobRecord): Promise<void> {
    const timeoutMs = record.request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => record.abort.abort(), timeoutMs);
    timer.unref?.();
    try {
      const thread = this.createThread(record.request);
      const result = await thread.run(record.request.prompt, {
        signal: record.abort.signal,
        ...(record.request.outputSchema !== undefined
          ? { outputSchema: record.request.outputSchema }
          : {}),
      });
      record.snapshot = {
        ...record.snapshot,
        status: "completed",
        completedAt: Date.now(),
        ...(thread.id ? { threadId: thread.id } : {}),
        result: {
          finalResponse: result.finalResponse,
          items: result.items,
          usage: result.usage,
        },
      };
    } catch (error) {
      const cancelled = record.abort.signal.aborted;
      record.snapshot = {
        ...record.snapshot,
        status: cancelled ? "cancelled" : "failed",
        completedAt: Date.now(),
        ...(!cancelled
          ? { error: error instanceof Error ? error.message : String(error) }
          : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private prune(): void {
    if (this.jobs.size <= MAX_RETAINED_JOBS) return;
    const terminal = [...this.jobs.values()]
      .filter(
        (record) => !["queued", "running"].includes(record.snapshot.status),
      )
      .sort(
        (left, right) => left.snapshot.createdAt - right.snapshot.createdAt,
      );
    while (this.jobs.size > MAX_RETAINED_JOBS && terminal.length > 0) {
      const expired = terminal.shift();
      if (expired) this.jobs.delete(expired.snapshot.id);
    }
  }
}

function createSdkThreadFactory(
  codexPath: string | undefined,
  env: Record<string, string> | undefined,
): (request: CodexSdkJobRequest) => RunnableThread {
  if (!codexPath || !isAbsolute(codexPath)) {
    throw new Error("Codex SDK jobs require an absolute packaged Codex path.");
  }
  const codex = new Codex({
    codexPathOverride: codexPath,
    ...(env ? { env } : {}),
  });
  return (request) =>
    codex.startThread({
      workingDirectory: request.cwd,
      sandboxMode: request.sandboxMode ?? "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: request.networkAccessEnabled ?? false,
      ...(request.model ? { model: request.model } : {}),
      ...(request.reasoningEffort
        ? { modelReasoningEffort: request.reasoningEffort }
        : {}),
    });
}

function validateJobRequest(input: CodexSdkJobRequest): CodexSdkJobRequest {
  if (!isAbsolute(input.cwd))
    throw new Error("Codex job cwd must be absolute.");
  if (!statSync(input.cwd).isDirectory()) {
    throw new Error("Codex job cwd must be an existing directory.");
  }
  if (!input.prompt.trim()) throw new Error("Codex job prompt is required.");
  if (input.prompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`Codex job prompt exceeds ${MAX_PROMPT_CHARS} characters.`);
  }
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs < 1_000 ||
      input.timeoutMs > DEFAULT_TIMEOUT_MS)
  ) {
    throw new Error(
      `Codex job timeout must be between 1000 and ${DEFAULT_TIMEOUT_MS} ms.`,
    );
  }
  return { ...input, prompt: input.prompt.trim() };
}

function boundedConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) {
    throw new Error("Codex SDK job concurrency must be between 1 and 4.");
  }
  return value;
}

function cloneSnapshot(snapshot: CodexSdkJobSnapshot): CodexSdkJobSnapshot {
  return structuredClone(snapshot);
}
