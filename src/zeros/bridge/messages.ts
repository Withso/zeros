// ──────────────────────────────────────────────────────────
// Moved to @zeros/core (single source of truth for the wire contract).
// ──────────────────────────────────────────────────────────
//
// The browser↔engine protocol types (BridgeMessage union,
// BridgeRegistryAgent, createMessage/createMessageId, …) now live at
// packages/core/src/messages.ts so the engine, renderer, web, and mobile
// all share ONE copy. This file re-exports them so existing
// `./messages` / `../zeros/bridge/messages` imports keep resolving.
// ──────────────────────────────────────────────────────────

export * from "@zeros/core/messages";
