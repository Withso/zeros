// ──────────────────────────────────────────────────────────
// MessageView — the single dispatch component
// ──────────────────────────────────────────────────────────
//
// Replaces the old inline MessageView that lived in agent-chat.
// Looks up the renderer for `message` in the registry and
// passes the shared `ctx`.
//
// Memoized at the dispatcher level so the parent re-rendering
// — which it does on every streaming chunk until Phase 0 step
// 4 (Zustand slicing) lands — only re-renders the message
// whose content changed, not its siblings.
//
// ──────────────────────────────────────────────────────────

import { memo } from "react";
import type { AgentMessage } from "../use-agent-session";
import type { RendererContext, RendererRegistry } from "./types";
import { defaultRegistry, resolveRenderer } from "./registry";

interface MessageViewProps {
  message: AgentMessage;
  ctx: RendererContext;
  registry?: RendererRegistry;
}

export const MessageView = memo(
  function MessageView({ message, ctx, registry = defaultRegistry }: MessageViewProps) {
    const { Component } = resolveRenderer(message, registry);
    // 2026-07-02: the inline permission cluster was removed. Permissions now
    // render in ONE card that replaces the composer (see <PermissionCard>).
    // 2026-07-06: the "auto-allowed by policy" attribution chip was removed
    // too (user spec — policy auto-allows are silent; no extra timeline UI).
    return <Component message={message} ctx={ctx} />;
  },
  // Re-render only when the message itself or its slice of ctx changed.
  (prev, next) => {
    if (prev.message !== next.message) return false;
    if (prev.registry !== next.registry) return false;
    if (prev.message.kind === "tool") {
      const id = prev.message.toolCallId;
      // Stage 6.1 — re-render when this card's inline permission cluster
      // appears or disappears. Match the toolCallId against pendingPermission
      // on both sides.
      const prevMatched =
        prev.ctx.pendingPermission?.request.toolCall.toolCallId === id;
      const nextMatched =
        next.ctx.pendingPermission?.request.toolCall.toolCallId === id;
      if (prevMatched !== nextMatched) return false;
      // Permission request object identity changes ≈ a new permission
      // arrived for the same toolCallId (rare). Bail and re-render.
      if (
        nextMatched &&
        prev.ctx.pendingPermission !== next.ctx.pendingPermission
      ) {
        return false;
      }
      // Roadmap §2.4.7 — SubagentCard reads ctx.subagentChildren.get(id)
      // to render its nested transcript. New child events arriving while
      // the subagent is in flight need to re-render the card. Compare
      // the bucket arrays by reference; subagentChildren is rebuilt
      // only when session.messages changes, so reference equality is safe.
      if (
        prev.ctx.subagentChildren.get(id) !== next.ctx.subagentChildren.get(id)
      ) {
        return false;
      }
      return true;
    }
    return true;
  },
);
