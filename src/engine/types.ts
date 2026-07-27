// ──────────────────────────────────────────────────────────
// Moved to @zeros/core (single source of truth for the wire contract).
// ──────────────────────────────────────────────────────────
//
// The engine↔renderer protocol types now live at
// packages/core/src/messages.ts. This file re-exports them and keeps the
// engine-facing `EngineMessage` name as an alias of the canonical
// `BridgeMessage` union, so existing `./types` / `../types` imports
// (EngineMessage, EnrichedRegistryAgent, RegistryAgent, createMessage,
// createMessageId, and every AGENT_* message interface) keep resolving.
// ──────────────────────────────────────────────────────────

export * from "@zeros/core/messages";
import type { BridgeMessage } from "@zeros/core/messages";

/** Canonical wire union, engine-facing name. Identical to BridgeMessage. */
export type EngineMessage = BridgeMessage;
