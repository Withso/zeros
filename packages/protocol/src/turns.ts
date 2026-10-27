// Recorded file deltas and metadata shared by Local, cloud and the renderer.
// Optional transcript summaries let sleeping cloud history render without a VM read.

export type TurnFileStatus = "added" | "modified" | "deleted" | "renamed";

export interface TurnFile {
  path: string;
  oldPath?: string;
  status: TurnFileStatus;
  additions: number;
  deletions: number;
}

export type TurnStatus = "running" | "completed" | "failed" | "cancelled";

/** One model's share retained for accounting and serialized compatibility. */
export interface TurnModelUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/** Per-turn token/cost usage (mirrors engine db/turns.TurnUsageJson).
 *  reasoningTokens is never rendered (2026-07-13 decision). */
export interface TurnUsageInfo {
  accountingVersion?: 1;
  revision?: number;
  costKind?: "estimated" | "reported";
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalCostUsd?: number;
  perModel?: TurnModelUsage[];
}

/** One agent request→response cycle. `turnId` = the opening user message id. */
export interface TurnInfo {
  chatId: string;
  turnId: string;
  workspaceId: string | null;
  folder: string | null;
  agentId: string | null;
  ord: number;
  summary: string | null;
  startedAt: number;
  endedAt: number | null;
  stopReason: string | null;
  status: TurnStatus;
  preSnapshot: string | null;
  postSnapshot: string | null;
  files: TurnFile[];
  /** Tokens/cost this turn billed (null when none was reported). */
  usage?: TurnUsageInfo | null;
}

/** Mirrored on the opening prompt; identities come from its owning chat/row. */
export type TurnSummary = Omit<TurnInfo,
  "chatId" | "turnId" | "workspaceId" | "folder" | "preSnapshot" | "postSnapshot">;
