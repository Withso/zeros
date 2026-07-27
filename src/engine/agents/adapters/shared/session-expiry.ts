// ──────────────────────────────────────────────────────────
// Session-expired stderr classifier (shared)
// ──────────────────────────────────────────────────────────
//
// Matches the "your prior session/thread/rollout is gone" family of
// errors that surface when an agent is asked to resume a session the
// backend no longer has (engine restart, server-side GC, expiry). The
// engine maps a match to a recoverable SESSION_EXPIRED failure so the
// renderer can transparently start a fresh session instead of showing a
// hard error.
//
// Consumed by the Claude (Agent SDK), Codex (app-server), and Cursor
// (@cursor/sdk) adapters. Keep in sync with STALE_THREAD_RX
// (codex/app-server-adapter.ts) and SESSION_EXPIRED_RX
// (zeros/bridge/failure.ts) — add new fixtures to the parity test.
// ──────────────────────────────────────────────────────────

export const SESSION_EXPIRED_KEYWORDS =
  /\b(?:no\s+rollout\s+(?:found|exists?|available)|no\s+longer\s+has\s+(?:a\s+)?rollout|lost\s+the\s+rollout|rollout\s+not\s+found|thread\s+(?:not\s+found|does\s+not\s+exist)|unknown\s+thread|missing\s+thread|no\s+such\s+thread|thread\/resume\s+failed|resume\s+failed|session\s+(?:not\s+found|does\s+not\s+exist|expired)|chat\s+(?:not\s+found|does\s+not\s+exist)|conversation\s+(?:not\s+found|expired)|no\s+conversation\s+found|agent\s+(?:\S+\s+){0,3}(?:not\s+found|does\s+not\s+exist|no\s+longer\s+exists)|no\s+such\s+agent)\b/i;
