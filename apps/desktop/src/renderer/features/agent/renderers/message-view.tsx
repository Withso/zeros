// ──────────────────────────────────────────────────────────
// MessageView — the single dispatch component
// ──────────────────────────────────────────────────────────
//
// Replaces the old inline MessageView that lived in agent-chat.
// Looks up the renderer for `message` in the registry and
// passes the shared `ctx`.
//
// Memoized at the dispatcher level so a parent render during streaming only
// re-renders the message whose content changed, not its siblings.
//
// ──────────────────────────────────────────────────────────

import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import { observeLiveAgentText, observeLiveToolOutput } from "../local-live-text";
import type { AgentMessage } from "../use-agent-session";
import type { RendererContext, RendererRegistry } from "./types";
import { defaultRegistry, resolveRenderer } from "./registry";

interface MessageViewProps {
  message: AgentMessage;
  ctx: RendererContext;
  registry?: RendererRegistry;
}

const noSubscription = () => () => {};

export const MessageView = memo(
  function MessageView({
    message: suppliedMessage,
    ctx,
    registry = defaultRegistry,
  }: MessageViewProps) {
    const source = ctx.attachmentImagesActive !== false && ctx.isStreaming &&
      ((ctx.lastMessageId === suppliedMessage.id && suppliedMessage.kind === "text" &&
        (suppliedMessage.role === "agent" || suppliedMessage.role === "thought")) ||
       (suppliedMessage.kind === "tool" && suppliedMessage.toolKind === "execute" &&
        suppliedMessage.status === "in_progress" && typeof suppliedMessage.rawOutput === "string"))
      ? ctx.liveTextSource : undefined;
    const observation = useMemo(() => {
      if (!source) return undefined;
      if (suppliedMessage.kind === "tool") return observeLiveToolOutput(source, suppliedMessage);
      if (suppliedMessage.kind === "text") return observeLiveAgentText(source, suppliedMessage,
        suppliedMessage.role === "thought" ? { reducedMotion: () => true } : undefined);
      return undefined;
    }, [source, suppliedMessage]);
    const fallback = useMemo(() => ({ message: suppliedMessage, pending: false }), [suppliedMessage]);
    const read = useCallback(() => observation?.getSnapshot() ?? fallback, [observation, fallback]);
    const snapshot = useSyncExternalStore(observation?.subscribe ?? noSubscription, read, read);
    const message = snapshot.message;
    const renderCtx = useMemo(() => observation && message.kind === "text"
      ? { ...ctx, liveTextPresentation: { text: message.text, pending: snapshot.pending } } : ctx,
    [ctx, observation, message, snapshot.pending]);
    const { Component } = resolveRenderer(message, registry);
    // 2026-07-02: the inline permission cluster was removed. Permissions now
    // render in ONE card that replaces the composer (see <PermissionCard>).
    // The "auto-allowed by policy" attribution chip is also omitted because
    // policy auto-allows are silent, with no extra timeline UI.
    return <Component message={message} ctx={renderCtx} />;
  },
  // Re-render only when the message itself or its slice of ctx changed.
  (prev, next) => {
    if (prev.message !== next.message) return false;
    if (prev.registry !== next.registry) return false;
    // Images and native artwork belong to the visible conversation/host.
    // Retained tool rows must receive deactivation even if their events did
    // not change, so hidden transcripts release decoded screenshots.
    if (
      prev.ctx.attachmentImagesActive !== next.ctx.attachmentImagesActive ||
      prev.ctx.transcriptReadOnly !== next.ctx.transcriptReadOnly ||
      prev.ctx.attachmentCwd !== next.ctx.attachmentCwd ||
      prev.ctx.chatId !== next.ctx.chatId
      || prev.ctx.liveTextSource !== next.ctx.liveTextSource
    )
      return false;
    if (prev.ctx.liveTextSource && prev.ctx.isStreaming !== next.ctx.isStreaming) return false;
    if (prev.message.kind === "text" && (prev.message.role === "agent" || prev.message.role === "thought")) {
      const wasStreaming = prev.ctx.isStreaming && prev.ctx.lastMessageId === prev.message.id;
      const isStreaming = next.ctx.isStreaming && next.ctx.lastMessageId === next.message.id;
      if (wasStreaming !== isStreaming) return false;
    }
    if (prev.message.kind === "tool") {
      const id = prev.message.toolCallId;
      // Re-render when this card's inline permission cluster
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
      // SubagentCard reads ctx.subagentChildren.get(id)
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
