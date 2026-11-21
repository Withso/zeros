import { useMemo } from "react";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import type { AgentMessage, AgentSessionState, AgentTextMessage, AgentToolMessage } from "./use-agent-session";
import { useSessionsStore } from "./sessions-store";

/** A leaf may observe growing prose without invalidating the chat's composer,
 * transcript structure or finished turns. No transport or durable state moves. */
export interface LiveAgentTextSource {
  subscribe(notify: () => void): () => void;
  read(message: AgentTextMessage): AgentTextMessage;
  readTool?(message: AgentToolMessage): AgentToolMessage;
}

export interface LiveAgentTextSnapshot {
  message: AgentTextMessage;
  pending: boolean;
}

export interface LiveTextObservationOptions {
  requestFrame?: (callback: (now: number) => void) => number;
  cancelFrame?: (handle: number) => void;
  visible?: () => boolean;
  watch?: (listener: () => void) => () => void;
}

/** Publish the growing text as it arrives, at most once per frame (several
 * provider deltas in one frame lay out once). The message itself paces what
 * the reader sees (render first, then reveal: renderers/use-text-reveal.ts),
 * so nothing here holds text back. Hidden surfaces publish nothing until
 * they are shown again, then the full native text at once. */
export function observeLiveAgentText(
  source: LiveAgentTextSource,
  initial: AgentTextMessage,
  options: LiveTextObservationOptions = {},
) {
  const visible =
    options.visible ?? (() => document.visibilityState !== "hidden");
  const requestFrame = options.requestFrame ?? requestAnimationFrame;
  const cancelFrame = options.cancelFrame ?? cancelAnimationFrame;
  const watch =
    options.watch ??
    ((listener: () => void) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    });
  let snapshot: LiveAgentTextSnapshot = { message: source.read(initial), pending: false };
  let frame: number | null = null;
  let release: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = () => {
    frame = null;
    const message = source.read(initial);
    if (message === snapshot.message) return;
    snapshot = { message, pending: false };
    if (visible()) for (const listener of listeners) listener();
  };
  const disarm = () => {
    if (frame !== null) cancelFrame(frame);
    frame = null;
  };
  const push = () => {
    if (!visible()) return;
    if (frame === null) frame = requestFrame(publish);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        // Reveal/remount starts from the full native text, never a queue.
        snapshot = { message: source.read(initial), pending: false };
        const unsubscribe = source.subscribe(push);
        const unwatch = watch(() => {
          if (!visible()) return;
          disarm();
          const before = snapshot;
          publish();
          // Shown again: one render with the full text, published or not.
          if (snapshot === before) for (const notify of listeners) notify();
        });
        release = () => {
          unsubscribe();
          unwatch();
          disarm();
        };
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          release?.();
          release = undefined;
        }
      };
    },
  };
}

/** Command logs and reasoning are never animated. The provider has already
 * grouped their native deltas; this observer only keeps hidden rows inert. */
export function observeLiveToolOutput(
  source: LiveAgentTextSource,
  initial: AgentToolMessage,
  options: Pick<LiveTextObservationOptions, "visible" | "watch"> = {},
) {
  const visible = options.visible ?? (() => document.visibilityState !== "hidden");
  const watch = options.watch ?? ((changed: () => void) => {
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  });
  let snapshot = { message: source.readTool?.(initial) ?? initial, pending: false };
  return {
    getSnapshot: () => snapshot,
    subscribe(changed: () => void) {
      const update = () => {
        const message = source.readTool?.(initial) ?? initial;
        if (message === snapshot.message) return;
        snapshot = { message, pending: false };
        if (visible()) changed();
      };
      const unsubscribe = source.subscribe(update);
      const unwatch = watch(() => { update(); if (visible()) changed(); });
      update();
      return () => { unsubscribe(); unwatch(); };
    },
  };
}

function sameFieldsExcept<T extends object>(
  left: T,
  right: T,
  omitted: ReadonlySet<keyof T>,
): boolean {
  const keys = new Set([
    ...Object.keys(left),
    ...Object.keys(right),
  ] as (keyof T)[]);
  for (const key of keys)
    if (!omitted.has(key) && left[key] !== right[key]) return false;
  return true;
}
const TEXT_FIELDS = new Set<keyof AgentTextMessage>(["text", "updatedAt"]);
const SESSION_FIELDS = new Set<keyof AgentSessionState>(["messages"]);

/** Structural/semantic changes always reach the whole chat. Only append-only
 * text in its existing live tail can stay within that message's subscriber. */
export function isLocalLiveTextAppend(
  previous: AgentSessionState,
  next: AgentSessionState,
): boolean {
  if (
    !next.cwd ||
    isCloudWorkspace(next.cwd) ||
    next.status !== "streaming" ||
    next.transcriptState !== "resident" ||
    next.transcriptPresentation ||
    !sameFieldsExcept(previous, next, SESSION_FIELDS)
  )
    return false;
  const before = previous.messages,
    after = next.messages;
  if (!before.length || before.length !== after.length) return false;
  for (let index = 0; index < before.length - 1; index++)
    if (before[index] !== after[index]) return false;
  const left = before.at(-1)!,
    right = after.at(-1)!;
  return (
    left.kind === "text" &&
    right.kind === "text" &&
    (left.role === "agent" || left.role === "thought") &&
    left.role === right.role &&
    !left.retracted &&
    !left.modelFallback &&
    !left.wakeupNotice &&
    !!left.text.trim() &&
    right.text.startsWith(left.text) &&
    sameFieldsExcept(left, right, TEXT_FIELDS)
  );
}

const TOOL_OUTPUT_FIELDS = new Set<keyof AgentToolMessage>(["rawOutput", "updatedAt"]);
function isLocalLiveToolOutput(previous: AgentSessionState, next: AgentSessionState): boolean {
  if (!next.cwd || isCloudWorkspace(next.cwd) || next.status !== "streaming" ||
      next.transcriptState !== "resident" || next.transcriptPresentation ||
      !sameFieldsExcept(previous, next, SESSION_FIELDS) ||
      previous.messages.length !== next.messages.length) return false;
  let changed = false;
  for (let index = 0; index < previous.messages.length; index++) {
    const left = previous.messages[index], right = next.messages[index];
    if (left === right) continue;
    if (left.kind !== "tool" || right.kind !== "tool" || left.toolKind !== "execute" ||
        left.status !== "in_progress" || typeof left.rawOutput !== "string" ||
        typeof right.rawOutput !== "string" || !right.rawOutput.startsWith(left.rawOutput) ||
        !sameFieldsExcept(left, right, TOOL_OUTPUT_FIELDS)) return false;
    changed = true;
  }
  return changed;
}

export function createChatRenderSnapshot(): (
  slot: AgentSessionState,
) => AgentSessionState {
  let seen: AgentSessionState | undefined;
  let rendered: AgentSessionState;
  return (slot) => {
    if (slot === seen) return rendered;
    if (!seen || (!isLocalLiveTextAppend(seen, slot) && !isLocalLiveToolOutput(seen, slot))) rendered = slot;
    seen = slot;
    return rendered;
  };
}

export function useLocalLiveTextSource(
  enabled: boolean,
  chatId: string | undefined,
  cwd: string | null | undefined,
  executionId: string | null,
): LiveAgentTextSource | undefined {
  return useMemo(() => {
    if (!enabled || !chatId || !cwd || isCloudWorkspace(cwd)) return undefined;
    return localLiveTextSource(chatId, cwd, executionId);
  }, [enabled, chatId, cwd, executionId]);
}

export function localLiveTextSource(
  chatId: string,
  cwd: string,
  executionId: string | null,
): LiveAgentTextSource {
  const readMessage = <T extends AgentMessage>(message: T): T => {
    const slot = useSessionsStore.getState().sessions[chatId];
    if (isCloudWorkspace(cwd) || slot?.cwd !== cwd || (slot.executionId ?? slot.sessionId) !== executionId ||
        slot.transcriptState !== "resident") return message;
    const current = slot.messages.at(-1);
    if (current?.kind === message.kind && current.id === message.id) return current as T;
    return slot.messages.find((entry) => entry.kind === message.kind && entry.id === message.id) as T ?? message;
  };
  return {
    subscribe: (notify) =>
      useSessionsStore.subscribe((state, previous) => {
        if (state.sessions[chatId] !== previous.sessions[chatId]) notify();
      }),
    read: readMessage,
    readTool: readMessage,
  };
}
