// ──────────────────────────────────────────────────────────
// Moved to @zeros/protocol (single source of truth for the wire contract).
// ──────────────────────────────────────────────────────────
//
// The agent-event vocabulary now lives at packages/protocol/src/agent-events.ts
// so the engine, Electron boundary, and renderer use one wire contract. This
// local boundary re-exports it for renderer call sites and future clients.
// ──────────────────────────────────────────────────────────

export * from "@zeros/protocol/agent-events";
