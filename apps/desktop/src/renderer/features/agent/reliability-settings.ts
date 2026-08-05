// ──────────────────────────────────────────────────────────
// reliability-settings — Claude fallback, budget cap, and idle lifetime
// ──────────────────────────────────────────────────────────
//
// Three global Claude Code knobs from Settings → Models:
//
//   • Fallback model — used automatically when the primary model is
//     overloaded / unavailable (SDK `Options.fallbackModel`). Defaults to
//     Sonnet 5 (the sensible family fallback); "None" restores the old
//     fail-fast behavior. The transcript shows a "Model switched" record
//     whenever it kicks in.
//   • Budget cap — a per-turn USD ceiling (SDK `Options.maxBudgetUsd`).
//     OFF by default (null); enabling writes the default $5.00. When hit,
//     the turn ends cleanly with a "Turn stopped · BUDGET" record.
//   • Idle timeout — how long an otherwise-idle persistent Claude query stays
//     warm between turns. Defaults to 30 minutes and is deliberately bounded
//     to the four UI choices (30/60/120/300) so a corrupt or hand-edited value
//     can never keep every loaded chat alive indefinitely.
//
// Claude-only for now — Codex/Cursor expose no fallback/budget hook.
// Persistence + pub/sub mirror new-chat-defaults.ts: getSetting/setSetting
// (synchronous, read at env-build time) with hooks for the Settings page.
// new-chat-defaults mirrors both into the settings.toml [models] table.
// This module deliberately imports ONLY native/settings so model-catalog
// (envForChatSettings) can read it without an import cycle.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";

import { getSetting, setSetting } from "../../platform/settings";

/** Fallback model for Claude chats. Stored value: a model id, or the
 *  sentinel "none" (explicit fail-fast). Unset = the default (Sonnet 5). */
const CLAUDE_FALLBACK_KEY = "claude-fallback-model";
/** Per-turn budget cap in USD for Claude chats. Unset/null = off. */
const CLAUDE_BUDGET_KEY = "claude-budget-cap-usd";
/** Idle query lifetime in minutes. */
const CLAUDE_IDLE_TIMEOUT_KEY = "claude-idle-timeout-minutes";

/** The sensible default fallback for the Claude family. */
export const DEFAULT_CLAUDE_FALLBACK = "claude-sonnet-5[1m]";
/** The amount the budget toggle enables with. */
export const DEFAULT_BUDGET_CAP_USD = 5;
/** The default balances quick follow-up turns with bounded process memory. */
export const DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES = 30;

/** The complete, intentionally bounded set shown in Settings. */
export const CLAUDE_IDLE_TIMEOUT_OPTIONS = [
  { minutes: 30, label: "30 minutes (default)" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: 300, label: "5 hours" },
] as const;

export type ClaudeIdleTimeoutMinutes =
  (typeof CLAUDE_IDLE_TIMEOUT_OPTIONS)[number]["minutes"];

const CLAUDE_IDLE_TIMEOUT_VALUES = new Set<number>(
  CLAUDE_IDLE_TIMEOUT_OPTIONS.map((option) => option.minutes),
);

export function isClaudeIdleTimeoutMinutes(
  value: unknown,
): value is ClaudeIdleTimeoutMinutes {
  return typeof value === "number" && CLAUDE_IDLE_TIMEOUT_VALUES.has(value);
}

/** The configured fallback model id, or null for "None" (fail-fast). */
export function getClaudeFallbackModel(): string | null {
  const v = getSetting<string | null>(CLAUDE_FALLBACK_KEY, null);
  if (v === "none") return null;
  return typeof v === "string" && v.trim().length > 0
    ? v.trim()
    : DEFAULT_CLAUDE_FALLBACK;
}

/** Set the fallback model (null = "None" — stored as an explicit sentinel so
 *  it's distinguishable from "never picked" = the default). */
export function setClaudeFallbackModel(model: string | null): void {
  setSetting(CLAUDE_FALLBACK_KEY, model ?? "none");
  notify();
}

/** The per-turn budget cap in USD, or null when the cap is off. */
export function getClaudeBudgetCapUsd(): number | null {
  const v = getSetting<number | null>(CLAUDE_BUDGET_KEY, null);
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** Set (a positive number) or clear (null) the per-turn budget cap. */
export function setClaudeBudgetCapUsd(cap: number | null): void {
  setSetting(
    CLAUDE_BUDGET_KEY,
    typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : null,
  );
  notify();
}

/** The configured idle query lifetime. Invalid storage always fails closed to
 * the 30-minute default rather than extending process lifetime. */
export function getClaudeIdleTimeoutMinutes(): ClaudeIdleTimeoutMinutes {
  const value = getSetting<unknown>(CLAUDE_IDLE_TIMEOUT_KEY, null);
  return isClaudeIdleTimeoutMinutes(value)
    ? value
    : DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES;
}

export function setClaudeIdleTimeoutMinutes(
  minutes: ClaudeIdleTimeoutMinutes,
): void {
  setSetting(
    CLAUDE_IDLE_TIMEOUT_KEY,
    isClaudeIdleTimeoutMinutes(minutes)
      ? minutes
      : DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES,
  );
  notify();
}

/** True only when a real future wake-up lies strictly after the keep-alive
 * window. Equality is safe: the process is still alive at that instant. */
export function isClaudeWakeupBeyondIdleTimeout(
  scheduledFor: number,
  timeoutMinutes: ClaudeIdleTimeoutMinutes,
  now = Date.now(),
): boolean {
  return (
    Number.isFinite(scheduledFor) &&
    scheduledFor > now + timeoutMinutes * 60_000
  );
}

// ── Pub/sub bus (mirrors new-chat-defaults.ts) ───────────

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* listeners shouldn't throw; keep going */
    }
  }
}

/** Hook: `[modelOrNull, set]` for the Claude fallback model. */
export function useClaudeFallbackModel(): [
  string | null,
  (model: string | null) => void,
] {
  const [value, setValue] = useState<string | null>(getClaudeFallbackModel);
  useEffect(() => {
    const sync = () => setValue(getClaudeFallbackModel());
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  const set = useCallback((next: string | null) => {
    setClaudeFallbackModel(next);
  }, []);
  return [value, set];
}

/** Hook: `[capOrNull, set]` for the per-turn budget cap. */
export function useClaudeBudgetCap(): [
  number | null,
  (cap: number | null) => void,
] {
  const [value, setValue] = useState<number | null>(getClaudeBudgetCapUsd);
  useEffect(() => {
    const sync = () => setValue(getClaudeBudgetCapUsd());
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  const set = useCallback((next: number | null) => {
    setClaudeBudgetCapUsd(next);
  }, []);
  return [value, set];
}

/** Hook: `[minutes, set]` for Claude's idle query lifetime. */
export function useClaudeIdleTimeoutMinutes(): [
  ClaudeIdleTimeoutMinutes,
  (minutes: ClaudeIdleTimeoutMinutes) => void,
] {
  const [value, setValue] = useState<ClaudeIdleTimeoutMinutes>(
    getClaudeIdleTimeoutMinutes,
  );
  useEffect(() => {
    const sync = () => setValue(getClaudeIdleTimeoutMinutes());
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  const set = useCallback((next: ClaudeIdleTimeoutMinutes) => {
    setClaudeIdleTimeoutMinutes(next);
  }, []);
  return [value, set];
}
