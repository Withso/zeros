// ──────────────────────────────────────────────────────────
// Moved to @zeros/protocol (single source of truth for the wire contract).
// ──────────────────────────────────────────────────────────
//
// The renderer/relay↔engine protocol types (BridgeMessage union,
// BridgeRegistryAgent, createMessage/createMessageId, …) now live at
// packages/protocol/src/messages.ts so the engine, renderer, and any optional
// remote client share one copy. This file re-exports them so existing
// `./messages` / `../zeros/bridge/messages` imports keep resolving.
// ──────────────────────────────────────────────────────────

export * from "@zeros/protocol/messages";
