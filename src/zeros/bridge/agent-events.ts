// ──────────────────────────────────────────────────────────
// Moved to @zeros/core (single source of truth for the wire contract).
// ──────────────────────────────────────────────────────────
//
// The agent-event vocabulary now lives at packages/core/src/agent-events.ts
// so the engine, renderer, web app, and mobile app all share ONE copy.
// This file re-exports it so existing `./agent-events` and
// `../zeros/bridge/agent-events` import sites keep resolving unchanged.
// ──────────────────────────────────────────────────────────

export * from "@zeros/core/agent-events";
