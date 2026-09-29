import { cloudWorkspaceKey, parseCloudWorkspaceKey, parseCloudScopedId } from "../platform/bridge/cloud-workspace-key";
import { CloudLatencySpans } from "../platform/observability/logging/cloud-latency";
import { logEvent } from "../platform/observability/logging/renderer-log";
import { canReadCloudWorkspace, cloudCatalogGeneration, cloudWorkspaceDocument } from "./cloud-workspace-catalog";

const spans = new CloudLatencySpans(sample => logEvent("cloud_renderer_latency", { ...sample }, ["cloud", "latency"]));
const paintListeners = new Set<() => void>();
function visible() { return typeof document === "undefined" || document.visibilityState !== "hidden"; }
function owner(folder: string): string | undefined {
  const target = parseCloudWorkspaceKey(folder);
  const doc = target ? cloudWorkspaceDocument(target) : undefined;
  return target && canReadCloudWorkspace(doc) && doc
    ? JSON.stringify([cloudCatalogGeneration(), folder, doc.generation.number]) : undefined;
}
export function startCloudNavigationSpan(folder: string, phase: "intent" | "click", chatId = ""): void {
  const key = owner(folder);
  if (!key || !visible()) return;
  spans.begin(key, phase === "intent" ? "intent_history_visible" : "click_transcript_paint", chatId, phase === "intent");
  for (const listener of paintListeners) listener();
}

/** Runs only for a committed, visible, hydrated transcript. Two animation
 * frames bracket its first paint; this is a renderer paint approximation,
 * never a measurement of catalog arrival or offscreen hydration. */
export function observeCloudTranscriptPaint(folder: string, chatId: string, hasHistory: boolean): () => void {
  const key = owner(folder);
  if (!key || !visible()) return () => {};
  let frame: number | undefined;
  let cancelled = false;
  const schedule = () => {
    if (cancelled || frame !== undefined || !visible() || owner(folder) !== key) return;
    const chats = ["", chatId];
    if (!chats.some(chat => spans.has(key, "click_transcript_paint", chat) || (hasHistory && spans.has(key, "intent_history_visible", chat)))) return;
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (cancelled || !visible() || owner(folder) !== key) return;
        for (const chat of chats) {
          spans.finish(key, "click_transcript_paint", chat);
          if (hasHistory) spans.finish(key, "intent_history_visible", chat);
        }
      });
    });
  };
  paintListeners.add(schedule);
  schedule();
  return () => { cancelled = true; paintListeners.delete(schedule); if (frame !== undefined) cancelAnimationFrame(frame); };
}

export function startCloudSubmitSpan(chatId: string): (() => void) | undefined {
  const target = parseCloudScopedId(chatId);
  const key = target && owner(cloudWorkspaceKey(target));
  if (!key) return;
  const id = spans.begin(key, "submit_first_text", chatId, true);
  return () => spans.cancel(key, "submit_first_text", chatId, id);
}
export function finishCloudFirstText(chatId: string, update: {
  sessionUpdate: string; content?: { type: string; text?: string }; parentToolId?: string | null;
}): void {
  // Thinking, tools, empty deltas, child output and history hydration cannot
  // masquerade as the first nonempty root assistant text.
  if (update.sessionUpdate !== "agent_message_chunk" || update.parentToolId ||
      update.content?.type !== "text" || !update.content.text?.trim()) return;
  const target = parseCloudScopedId(chatId);
  const key = target && owner(cloudWorkspaceKey(target));
  if (key) spans.finish(key, "submit_first_text", chatId);
}
export function pruneCloudLatencySpans(): void {
  spans.pruneOwners(value => {
    const [, folder] = JSON.parse(value) as [number, string, number];
    return owner(folder) === value;
  });
}
export function clearCloudLatencySpans(): void { spans.clear(); }
export const cloudLatencySnapshot = () => spans.snapshot();
