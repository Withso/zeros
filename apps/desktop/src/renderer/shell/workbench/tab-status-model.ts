import {
  File,
  FileDiff,
  GitPullRequestArrow,
  Globe,
  PenTool,
  Terminal,
} from "lucide-react";
import { redactLogSecrets } from "@zeros/protocol/scrub";
import type { WorkbenchTab, WorkbenchTabType } from "./tab-model";
import {
  describeConnectionRejection,
  type ConnectionRejection,
  type ConnectionStatus,
} from "../../platform/bridge/ws-client";

type EmptyStateKind = "pending" | "retryable" | "unavailable";

/** Exhaustive: a new tab type must choose its copy and quiet empty state. */
export const WORKBENCH_STATUS_ADAPTERS = {
  files: {
    noun: "files",
    subject: "Files",
    empty: {
      pending: "Files appear when the workspace is ready.",
      retryable: "Retry to load files.",
      unavailable: "Files aren't available.",
    },
    icon: File,
  },
  changes: {
    noun: "changes",
    subject: "Changes",
    empty: {
      pending: "Changes appear when the workspace is ready.",
      retryable: "Choose another comparison or retry.",
      unavailable: "Changes aren't available.",
    },
    icon: FileDiff,
  },
  review: {
    noun: "the review",
    subject: "The review",
    empty: {
      pending: "The review appears when the workspace is ready.",
      retryable: "Retry to load the review.",
      unavailable: "The review isn't available.",
    },
    icon: GitPullRequestArrow,
  },
  design: {
    noun: "Design",
    subject: "Design",
    empty: {
      pending: "Design appears when the workspace is ready.",
      retryable: "Retry to load Design.",
      unavailable: "Design isn't available.",
    },
    icon: PenTool,
  },
  browser: {
    noun: "the preview",
    subject: "The preview",
    empty: {
      pending: "The preview appears when the workspace is ready.",
      retryable: "Retry to load the preview.",
      unavailable: "The preview isn't available.",
    },
    icon: Globe,
  },
  terminal: {
    noun: "the terminal",
    subject: "The terminal",
    empty: {
      pending: "The terminal opens when the workspace is ready.",
      retryable: "Retry to reconnect the terminal.",
      unavailable: "The terminal isn't available.",
    },
    icon: Terminal,
  },
} satisfies Record<
  WorkbenchTabType,
  {
    noun: string;
    subject: string;
    empty: Record<EmptyStateKind, string>;
    icon: typeof File;
  }
>;

export interface WorkbenchStatus {
  tone: "error" | "pending" | "neutral";
  message: string;
  diagnostic?: string;
  action?: "Retry" | "Open Setup";
  connectionPhase?: "connecting" | "reconnecting";
}

export interface WorkspaceAvailability {
  cloud: boolean;
  state?: string;
  connection: ConnectionStatus;
  since: number;
  previouslyConnected?: boolean;
  rejected?: boolean;
  rejection?: ConnectionRejection;
  setupFailed?: boolean;
}

// Transient gaps (<10s) keep the workbench quiet. Persistent gaps share one
// pending decision at 10s and actionable failure at 45s, for both placements.
export const WORKBENCH_RECONNECT_GRACE_MS = 10_000;
export const WORKBENCH_RECONNECT_ERROR_MS = 45_000;
export const WORKBENCH_SILENT_RETRY_MS = 1_500;
export const WORKBENCH_RETRY_LIMIT_MS = 30_000;

export function describeWorkbenchEmptyState(
  type: WorkbenchTabType,
  status: WorkbenchStatus | null,
  singleFile = false,
): string {
  const kind: EmptyStateKind =
    status?.tone === "pending"
      ? "pending"
      : !status || status.action === "Retry"
        ? "retryable"
        : "unavailable";
  if (type === "files" && singleFile) {
    return {
      pending: "This file appears when the workspace is ready.",
      retryable: "Retry to load this file.",
      unavailable: "This file isn't available.",
    }[kind];
  }
  if (
    type === "terminal" &&
    kind === "pending" &&
    status?.connectionPhase === "reconnecting"
  )
    return "Terminal reconnects automatically.";
  return WORKBENCH_STATUS_ADAPTERS[type].empty[kind];
}

export function describeWorkspaceAvailability(
  input: WorkspaceAvailability,
  now: number,
): WorkbenchStatus | null {
  const workspace = input.cloud ? "cloud workspace" : "Zeros engine";
  switch (input.state) {
    case "creating":
    case "provisioning":
    case "setting_up":
      return {
        tone: "pending",
        message: `This ${workspace} is still setting up.`,
      };
    case "starting":
    case "waking":
    case "restoring":
      return { tone: "pending", message: `Starting the ${workspace}…` };
    case "stopped":
    case "sleeping":
      return { tone: "pending", message: `This ${workspace} is stopped.` };
    case "stopping":
      return { tone: "pending", message: `Stopping the ${workspace}…` };
    case "archived":
      return { tone: "neutral", message: `This ${workspace} is archived.` };
    case "failed":
    case "error":
      return {
        tone: "error",
        message: input.setupFailed
          ? "Setup failed."
          : `Can't reach the ${workspace}.`,
        action: input.setupFailed ? "Open Setup" : "Retry",
      };
  }
  if (input.setupFailed)
    return { tone: "error", message: "Setup failed.", action: "Open Setup" };
  if (input.rejection) {
    const copy = describeConnectionRejection(input.rejection);
    return {
      tone: "error",
      message: copy.headline,
      diagnostic: workbenchFailureDiagnostic(copy.description),
      action: "Retry",
    };
  }
  const elapsed = now - input.since;
  if (
    input.rejected ||
    (input.connection !== "connected" &&
      elapsed >= WORKBENCH_RECONNECT_ERROR_MS)
  )
    return {
      tone: "error",
      message: `Can't reach the ${input.cloud ? "workspace" : "Zeros engine"}.`,
      action: "Retry",
    };
  if (input.connection === "connected") return null;
  if (elapsed < WORKBENCH_RECONNECT_GRACE_MS) return null;
  return {
    tone: "pending",
    message: !input.previouslyConnected
      ? "Connecting…"
      : input.cloud
        ? "Reconnecting to the workspace…"
        : "Reconnecting to the Zeros engine…",
    connectionPhase: input.previouslyConnected ? "reconnecting" : "connecting",
  };
}

export function workbenchFailureDiagnostic(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Workspace read failed";
  return Array.from(
    redactLogSecrets(raw).replace(
      /\bBearer\s+[^\s"'<>]+/gi,
      "Bearer [redacted]",
    ),
  )
    .map((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        ? " "
        : character,
    )
    .join("")
    .replace(/\s+at\s+.*/s, "")
    .slice(0, 1024);
}

/** Raw transport text is diagnostic only; visible copy belongs to the tab. */
export function describeWorkbenchFailure(
  type: WorkbenchTabType,
  error: unknown,
  singleFile = false,
): WorkbenchStatus {
  const diagnostic = workbenchFailureDiagnostic(error);
  const state =
    /(?:cloud workspace|Zeros engine) (?:is )?(creating|setting_up|starting|waking|stopping|stopped|sleeping|archived)\b/i
      .exec(diagnostic)?.[1]
      ?.toLowerCase();
  if (state) {
    const status = describeWorkspaceAvailability(
      {
        cloud: /cloud/i.test(diagnostic),
        state,
        connection: "disconnected",
        since: 0,
      },
      0,
    )!;
    return { ...status, diagnostic };
  }
  const adapter = WORKBENCH_STATUS_ADAPTERS[type];
  const subject =
    type === "files" && singleFile ? "This file" : adapter.subject;
  const noun = type === "files" && singleFile ? "this file" : adapter.noun;
  return {
    tone: "error",
    message:
      /time[ -]?out|timed out|took too long|didn't respond in time/i.test(
        diagnostic,
      )
        ? `${subject} took too long to load.`
        : `Couldn't load ${noun}.`,
    diagnostic,
    action: "Retry",
  };
}

export function workbenchStatusKey(
  folder: string,
  tab: WorkbenchTab,
  target?: string,
): string {
  return JSON.stringify([
    folder,
    tab.type,
    tab.type === "files" ? tab.filePath : undefined,
    tab.diffScope,
    tab.diffSha,
    tab.diffHistory,
    tab.turnChatId,
    tab.turnId,
    tab.reviewSubtab,
    tab.terminalId,
    tab.url,
    tab.browserConversationId,
    target,
  ]);
}

export interface WorkbenchNotice {
  tone: "neutral";
  message: string;
  action?: {
    label: string;
    busyLabel: string;
    busy: boolean;
    run: () => void | Promise<unknown>;
  };
}

export interface WorkbenchSource {
  error?: unknown;
  pending: boolean;
  primary?: boolean;
  hasContent?: boolean;
  retry?: () => void | Promise<unknown>;
  /** Equivalent mounted consumers identify the same exact read, even when
   * their retry closures or failure publication times differ. */
  retryKey?: string;
  active?: boolean;
  /** Informational state, below every availability/read failure. */
  notice?: WorkbenchNotice;
}

interface StatusSnapshot {
  failure: unknown | null;
  hasContent: boolean;
  busy: boolean;
  pending: boolean;
  notice: WorkbenchNotice | null;
}

interface StatusSource extends WorkbenchSource {
  failurePhase?: "waiting" | "retrying" | "persistent";
  failedAt?: number;
}

/** One frame owns its exact target's sources. Old callbacks hold the old
 * instance, so late results cannot set or clear a new owner's banner. */
export class WorkbenchStatusSources {
  private sources = new Map<string, StatusSource>();
  private listeners = new Set<() => void>();
  private flight: Promise<void> | null = null;
  private flightSettled: (() => void) | null = null;
  private silentFlight = false;
  private automaticTimer: ReturnType<typeof setTimeout> | undefined;
  private value: StatusSnapshot = {
    failure: null,
    hasContent: false,
    busy: false,
    pending: false,
    notice: null,
  };
  snapshot = (): StatusSnapshot => this.value;
  get unused(): boolean {
    return this.listeners.size === 0 && this.sources.size === 0 && !this.flight;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update(id: string, source: WorkbenchSource): void {
    const previous = this.sources.get(id);
    const error = source.error || (source.pending ? previous?.error : null);
    // One failed read is transient until its single silent, exact-key retry
    // settles. Successful revalidation ends that episode; recurring failures
    // get a new allowance. Explicit states/rejections bypass this in availability.
    this.sources.set(id, {
      ...source,
      error,
      failurePhase: error
        ? !source.retry && previous?.failurePhase === "waiting"
          ? "persistent"
          : previous?.failurePhase ?? (source.retry ? "waiting" : "persistent")
        : undefined,
      failedAt: error ? previous?.failedAt ?? Date.now() : undefined,
    });
    this.publish();
  }
  remove(id: string): void {
    this.sources.delete(id);
    this.publish();
  }
  private publish(): void {
    const sources = [...this.sources.values()].filter(
      (source) => source.active !== false,
    );
    const failures = sources.filter(
      (source) => source.failurePhase === "persistent",
    );
    const failure =
      failures.find((source) => source.primary && source.error)?.error ??
      failures.find((source) => source.error)?.error ??
      null;
    const hasContent = sources.some(
      (source) => source.primary && source.hasContent,
    );
    const busy = this.flight !== null && !this.silentFlight;
    const pending = sources.some(
      (source) => source.pending ||
        source.failurePhase === "waiting" || source.failurePhase === "retrying",
    );
    const notice = failure ? null : sources.find(source => source.notice)?.notice ?? null;
    this.scheduleAutomaticRetry();
    if (
      this.value.failure === failure &&
      this.value.hasContent === hasContent &&
      this.value.busy === busy &&
      this.value.pending === pending &&
      this.value.notice === notice
    ) {
      this.flightSettled?.();
      return;
    }
    this.value = { failure, hasContent, busy, pending, notice };
    for (const listener of this.listeners) listener();
    this.flightSettled?.();
  }
  private scheduleAutomaticRetry(): void {
    clearTimeout(this.automaticTimer);
    this.automaticTimer = undefined;
    if (this.flight) return;
    const waiting = [...this.sources.values()].filter((source) =>
      source.active !== false && !source.pending && source.retry && source.failurePhase === "waiting",
    );
    if (!waiting.length) return;
    const deadline = Math.min(
      ...waiting.map((source) => source.failedAt! + WORKBENCH_SILENT_RETRY_MS),
    );
    this.automaticTimer = setTimeout(() => {
      this.automaticTimer = undefined;
      const elapsed = waiting.filter(
        (source) => source.failedAt! + WORKBENCH_SILENT_RETRY_MS <= Date.now(),
      );
      const due = waiting.filter((source) => elapsed.some((ready) =>
        source === ready || source.retry === ready.retry ||
        (source.retryKey !== undefined && source.retryKey === ready.retryKey),
      ));
      for (const source of due) source.failurePhase = "retrying";
      void this.startRetry(due, undefined, true);
    }, Math.max(0, deadline - Date.now()));
  }
  retry(reconnect?: () => Promise<unknown>): Promise<void> {
    if (this.flight) return this.flight;
    const selected = [...this.sources.values()].filter(
      (source) => source.active !== false && (reconnect || source.error),
    );
    for (const source of selected)
      if (source.error) source.failurePhase = "persistent";
    return this.startRetry(selected, reconnect, false);
  }
  private startRetry(
    selected: StatusSource[],
    reconnect: (() => Promise<unknown>) | undefined,
    silent: boolean,
  ): Promise<void> {
    if (this.flight) return this.flight;
    clearTimeout(this.automaticTimer);
    this.automaticTimer = undefined;
    const hadSources = this.sources.size > 0;
    // Snapshot the current sources. Navigating during retry cannot start reads
    // against another key through a caller's newly installed closure.
    const callbacks: NonNullable<WorkbenchSource["retry"]>[] = [];
    const seen = new Set<string | WorkbenchSource["retry"]>();
    for (const source of selected) {
      if (!source.retry) continue;
      const key = source.retryKey ?? source.retry;
      if (seen.has(key)) continue;
      seen.add(key);
      callbacks.push(source.retry);
    }
    let resolve!: () => void;
    const flight = new Promise<void>((done) => {
      resolve = done;
    });
    let ended = false;
    let completed = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      if (this.flight === flight) {
        this.flight = null;
        this.flightSettled = null;
        for (const source of this.sources.values())
          if (source.failurePhase === "retrying") source.failurePhase = "persistent";
        this.publish();
      }
      resolve();
    };
    const timer = setTimeout(finish, WORKBENCH_RETRY_LIMIT_MS);
    const settled = () => {
      if (
        (completed && ![...this.sources.values()].some(
          (source) => source.active !== false && source.pending,
        )) ||
        (hadSources &&
          ![...this.sources.values()].some((source) => source.active !== false))
      )
        finish();
    };
    this.flightSettled = settled;
    this.flight = flight;
    this.silentFlight = silent;
    this.publish();
    void Promise.resolve()
      .then(async () => {
        if (ended) return;
        if (reconnect) await reconnect();
        if (ended) return;
        await Promise.allSettled(
          callbacks.map((callback) => Promise.resolve().then(callback)),
        );
        completed = true;
        settled();
      })
      .catch(finish);
    return flight;
  }
}

const sourceStores = new Map<string, WorkbenchStatusSources>();
/** Frames and portal-owned terminal sources share one bounded exact-key store. */
export function workbenchSourcesFor(key: string): WorkbenchStatusSources {
  let source = sourceStores.get(key);
  if (!source) {
    source = new WorkbenchStatusSources();
    sourceStores.set(key, source);
  }
  for (const [oldKey, old] of sourceStores) {
    if (sourceStores.size <= 64) break;
    if (oldKey !== key && old.unused) sourceStores.delete(oldKey);
  }
  return source;
}
