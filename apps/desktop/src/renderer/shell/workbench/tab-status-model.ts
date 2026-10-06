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
import type { ConnectionStatus } from "../../platform/bridge/ws-client";

/** Exhaustive: a new tab type must choose its copy and quiet empty state. */
export const WORKBENCH_STATUS_ADAPTERS = {
  files: {
    noun: "files",
    subject: "Files",
    empty: "Retry to load files.",
    icon: File,
  },
  changes: {
    noun: "changes",
    subject: "Changes",
    empty: "Choose another comparison or retry.",
    icon: FileDiff,
  },
  review: {
    noun: "the review",
    subject: "The review",
    empty: "Retry to load the review.",
    icon: GitPullRequestArrow,
  },
  design: {
    noun: "Design",
    subject: "Design",
    empty: "Retry to load Design.",
    icon: PenTool,
  },
  browser: {
    noun: "the preview",
    subject: "The preview",
    empty: "Retry to load the preview.",
    icon: Globe,
  },
  terminal: {
    noun: "the terminal",
    subject: "The terminal",
    empty: "Terminal reconnects automatically.",
    icon: Terminal,
  },
} satisfies Record<
  WorkbenchTabType,
  { noun: string; subject: string; empty: string; icon: typeof File }
>;

export interface WorkbenchStatus {
  tone: "error" | "pending" | "neutral";
  message: string;
  diagnostic?: string;
  action?: "Retry" | "Open Setup";
}

export interface WorkspaceAvailability {
  cloud: boolean;
  state?: string;
  connection: ConnectionStatus;
  since: number;
  previouslyConnected?: boolean;
  rejected?: boolean;
  setupFailed?: boolean;
}

export const WORKBENCH_RECONNECT_GRACE_MS = 2_000;
export const WORKBENCH_RECONNECT_ERROR_MS = 20_000;

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
    case "stopping":
      return { tone: "pending", message: `This ${workspace} is stopped.` };
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
  if (input.connection === "connected") return null;
  const elapsed = now - input.since;
  if (input.rejected || elapsed >= WORKBENCH_RECONNECT_ERROR_MS)
    return {
      tone: "error",
      message: `Can't reach the ${input.cloud ? "workspace" : "Zeros engine"}.`,
      action: "Retry",
    };
  if (input.previouslyConnected && elapsed < WORKBENCH_RECONNECT_GRACE_MS)
    return null;
  return {
    tone: "pending",
    message: input.cloud
      ? "Reconnecting to the workspace…"
      : "Reconnecting to the Zeros engine…",
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
): WorkbenchStatus {
  const diagnostic = workbenchFailureDiagnostic(error);
  const state =
    /(?:cloud workspace|Zeros engine) (?:is )?(creating|setting_up|starting|waking|stopped|sleeping|archived)\b/i
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
  return {
    tone: "error",
    message:
      /time[ -]?out|timed out|took too long|didn't respond in time/i.test(
        diagnostic,
      )
        ? `${adapter.subject} took too long to load.`
        : `Couldn't load ${adapter.noun}.`,
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

export interface WorkbenchSource {
  error?: unknown;
  pending: boolean;
  primary?: boolean;
  hasContent?: boolean;
  retry?: () => void | Promise<unknown>;
  active?: boolean;
}

interface StatusSnapshot {
  failure: unknown | null;
  hasContent: boolean;
  busy: boolean;
  pending: boolean;
}

/** One frame owns its exact target's sources. Old callbacks hold the old
 * instance, so late results cannot set or clear a new owner's banner. */
export class WorkbenchStatusSources {
  private sources = new Map<string, WorkbenchSource>();
  private listeners = new Set<() => void>();
  private flight: Promise<void> | null = null;
  private value: StatusSnapshot = {
    failure: null,
    hasContent: false,
    busy: false,
    pending: false,
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
    this.sources.set(id, {
      ...source,
      error: source.error || (source.pending ? previous?.error : null),
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
    const failure =
      sources.find((source) => source.primary && source.error)?.error ??
      sources.find((source) => source.error)?.error ??
      null;
    const hasContent = sources.some(
      (source) => source.primary && source.hasContent,
    );
    const busy = this.flight !== null;
    const pending = sources.some(
      (source) => source.active !== false && source.pending,
    );
    if (
      this.value.failure === failure &&
      this.value.hasContent === hasContent &&
      this.value.busy === busy &&
      this.value.pending === pending
    )
      return;
    this.value = { failure, hasContent, busy, pending };
    for (const listener of this.listeners) listener();
  }
  retry(reconnect?: () => Promise<unknown>): Promise<void> {
    if (this.flight) return this.flight;
    // Snapshot the current sources. Navigating during retry cannot start reads
    // against another key through a caller's newly installed closure.
    const callbacks = [
      ...new Set(
        [...this.sources.values()]
          .filter(
            (source) => source.active !== false && (reconnect || source.error),
          )
          .flatMap((source) => (source.retry ? [source.retry] : [])),
      ),
    ];
    const flight = Promise.resolve()
      .then(async () => {
        if (reconnect) await reconnect();
        await Promise.allSettled(
          callbacks.map((callback) => Promise.resolve().then(callback)),
        );
        if (this.value.pending)
          await new Promise<void>((resolve) => {
            const stop = this.subscribe(() => {
              if (!this.value.pending) {
                stop();
                resolve();
              }
            });
          });
      })
      .catch(() => {})
      .finally(() => {
        if (this.flight === flight) {
          this.flight = null;
          this.publish();
        }
      });
    this.flight = flight;
    this.publish();
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
