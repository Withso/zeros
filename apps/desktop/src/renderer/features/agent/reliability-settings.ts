// Claude process lifetime and native memory preferences.
// Retired app fallback/budget keys are ignored; native model routing remains.

import { useCallback, useEffect, useState } from "react";

import { getSetting, setSetting } from "../../platform/settings";

/** Idle query lifetime in minutes. */
const CLAUDE_IDLE_TIMEOUT_KEY = "claude-idle-timeout-minutes";
/** Claude Code's repository-scoped native auto-memory switch. */
const CLAUDE_AUTO_MEMORY_KEY = "claude-auto-memory-enabled";

/** The default balances quick follow-up turns with bounded process memory. */
export const DEFAULT_CLAUDE_IDLE_TIMEOUT_MINUTES = 30;
/** Claude Code enables auto memory natively unless the user turns it off. */
export const DEFAULT_CLAUDE_AUTO_MEMORY_ENABLED = true;

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

export function getClaudeAutoMemoryEnabled(): boolean {
  return (
    getSetting<boolean>(
      CLAUDE_AUTO_MEMORY_KEY,
      DEFAULT_CLAUDE_AUTO_MEMORY_ENABLED,
    ) !== false
  );
}

export function setClaudeAutoMemoryEnabled(enabled: boolean): void {
  setSetting(CLAUDE_AUTO_MEMORY_KEY, enabled === true);
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

/** Hook: native Claude auto-memory toggle. */
export function useClaudeAutoMemoryEnabled(): [
  boolean,
  (enabled: boolean) => void,
] {
  const [value, setValue] = useState<boolean>(getClaudeAutoMemoryEnabled);
  useEffect(() => {
    const sync = () => setValue(getClaudeAutoMemoryEnabled());
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);
  const set = useCallback((enabled: boolean) => {
    setClaudeAutoMemoryEnabled(enabled);
  }, []);
  return [value, set];
}
