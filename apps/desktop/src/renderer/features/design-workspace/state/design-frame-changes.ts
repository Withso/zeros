// PURPOSE: A frame's changes made by hand (a value a layer sets over one its
// class, component or another rule gave it, the Style panel's Changed here)
// and Tidy, which asks the agent to move them into tokens, classes or the
// component. Read once per frame generation while the frame is selected, by
// exact key; a Tidy follows its own chat's turn while it runs and nothing
// else. Local only: cloud workspaces have no Design surface.

import { DESIGN_RUNTIME_FRAME_CHANGE_LIMITS, type DesignRuntimeFrameChanges } from "@zeros/protocol/design-runtime";
import { create } from "zustand";

import { useSessionsStore } from "../../agent/sessions-store";
import { designFrameRuntime, waitForDesignFrameRuntime } from "../../../platform/bridge/design-frame-runtime";
import { designStyleShorthands } from "../design-style-provenance";
import { designStylePropertyLabel } from "../design-style-origins";

/** One field a layer changed by hand, named as the Style panel names it. */
export interface DesignFrameChange {
  oid: string;
  layer: string;
  field: string;
  /** The first property the layer declares for the field, and its value. */
  property: string;
  value: string;
  replaced: DesignRuntimeFrameChanges["layers"][number]["changes"][number]["replaced"];
}

/** Corner radius for border-top-left-radius, Gap for row-gap, Fill for
 * background-color: the field a property belongs to in the panel. */
function fieldOf(property: string): string {
  const shorthand = designStyleShorthands(property)[0];
  return designStylePropertyLabel(shorthand ?? property);
}

/** One entry per field on each layer; a shorthand and its sides count once. */
export function designFrameChangeList(frame: DesignRuntimeFrameChanges): DesignFrameChange[] {
  const list: DesignFrameChange[] = [];
  for (const layer of frame.layers) {
    const fields = new Set<string>();
    for (const change of layer.changes) {
      const field = fieldOf(change.property);
      if (fields.has(field)) continue;
      fields.add(field);
      list.push({ oid: layer.oid, layer: layer.name, field, property: change.property, value: change.value, replaced: change.replaced });
    }
  }
  return list;
}

function listed(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "3 changes made by hand" and "Corner radius, Fill and Gap, on 2 layers.";
 * null with none. */
export function designFrameChangesSummary(
  changes: readonly DesignFrameChange[],
  truncated: boolean,
): { title: string; body: string } | null {
  if (changes.length === 0) return null;
  const fields = [...new Set(changes.map((change) => change.field))];
  const layers = new Set(changes.map((change) => change.oid)).size;
  const body = `${listed(fields)}, on ${layers} ${layers === 1 ? "layer" : "layers"}.`;
  return {
    title: `${changes.length} ${changes.length === 1 ? "change" : "changes"} made by hand`,
    body: truncated ? `${body} Not every layer was checked, so there may be more.` : body,
  };
}

const readsToken = (value: string | null | undefined) => Boolean(value && /var\(\s*--/.test(value));

/** What a Tidy left, from the changes before it, the changes after it, and
 * where each value no longer changed by hand comes from now. */
export function designTidyOutcome(
  before: readonly DesignFrameChange[],
  after: readonly DesignFrameChange[],
  follow: readonly { oid: string; property: string; own: boolean; value: string | null }[],
): string {
  const remaining = new Map(after.map((change) => [`${change.oid}\u0000${change.field}`, change]));
  const now = new Map(follow.map((entry) => [`${entry.oid}\u0000${entry.property}`, entry]));
  let tokens = 0;
  let source = 0;
  let stays = 0;
  let gone = 0;
  for (const change of before) {
    const still = remaining.get(`${change.oid}\u0000${change.field}`);
    if (still) {
      if (readsToken(still.value) && !readsToken(change.value)) tokens += 1;
      else stays += 1;
      continue;
    }
    // Not followed (past the follow limit, or its layer is gone), or nothing
    // gives it a value now: all that is known is that the layer no longer sets it.
    const current = now.get(`${change.oid}\u0000${change.property}`);
    if (!current || (!current.own && current.value === null)) gone += 1;
    else if (current.own) stays += 1;
    else if (readsToken(current.value)) tokens += 1;
    else source += 1;
  }
  const parts: string[] = [];
  if (tokens) parts.push(tokens === 1 ? "1 now uses a token" : `${tokens} now use tokens`);
  if (source) parts.push(source === 1 ? "1 now comes from its class or component" : `${source} now come from their class or component`);
  if (gone) parts.push(gone === 1 ? "1 is no longer on its layer" : `${gone} are no longer on their layer`);
  if (stays) parts.push(stays === 1 ? "1 stays on its layer" : `${stays} stay on their layer`);
  return `${parts.join(", ")}. Nothing is committed.`;
}

export function designFrameChangesKey(workspaceId: string, frame: string): string {
  return `${workspaceId}\u0000${frame}`;
}

export interface DesignFrameChangesEntry {
  sourceVersion: string;
  changes: DesignFrameChange[];
  truncated: boolean;
}

/** The last confirmed changes per frame; a newer generation replaces them
 * when its reply arrives, so the count stays up while it is read. */
export const useDesignFrameChangesStore = create<{ byKey: Record<string, DesignFrameChangesEntry> }>(() => ({ byKey: {} }));

const reading = new Set<string>();

/** How long a selected frame waits for its document to connect. */
const CONNECT_TIMEOUT_MS = 15_000;

/** Read the frame's changes for this generation, once. Never awaited by a
 * click: the reply publishes only while the same document still shows that
 * generation. A frame whose document has not connected yet (a selection
 * restored on open) is read when it connects, unless `signal` ends first. */
export function readDesignFrameChanges(workspaceId: string, frame: string, sourceVersion: string, signal?: AbortSignal): void {
  const runtime = designFrameRuntime(workspaceId, frame);
  if (!runtime || runtime.sourceVersion !== sourceVersion) {
    void waitForDesignFrameRuntime(workspaceId, frame, CONNECT_TIMEOUT_MS, { sourceVersion, signal }).then((connected) => {
      if (connected && !signal?.aborted) readDesignFrameChanges(workspaceId, frame, sourceVersion);
    });
    return;
  }
  if (!runtime.getFrameChanges || !runtime.supports("getFrameChanges")) return;
  const key = designFrameChangesKey(workspaceId, frame);
  const flight = `${key}\u0000${sourceVersion}`;
  if (reading.has(flight) || useDesignFrameChangesStore.getState().byKey[key]?.sourceVersion === sourceVersion) return;
  reading.add(flight);
  void runtime
    .getFrameChanges()
    .then((result) => {
      if (designFrameRuntime(workspaceId, frame) !== runtime || runtime.sourceVersion !== result.sourceVersion) return;
      const entry = { sourceVersion: result.sourceVersion, changes: designFrameChangeList(result), truncated: result.truncated };
      useDesignFrameChangesStore.setState((state) => ({ byKey: { ...state.byKey, [key]: entry } }));
    }, () => {})
    .finally(() => reading.delete(flight));
}

/** Where the values a Tidy started from come from now, for its outcome. */
export function readDesignTidyOutcome(
  workspaceId: string,
  frame: string,
  sourceVersion: string,
  before: readonly DesignFrameChange[],
  after: readonly DesignFrameChange[],
): Promise<string | null> {
  const runtime = designFrameRuntime(workspaceId, frame);
  if (!runtime?.getFrameChanges || !runtime.supports("getFrameChanges") || runtime.sourceVersion !== sourceVersion) return Promise.resolve(null);
  const remaining = new Set(after.map((change) => `${change.oid}\u0000${change.field}`));
  // The runtime answers for this many; the rest read as no longer on their layer.
  const follow = before
    .filter((change) => !remaining.has(`${change.oid}\u0000${change.field}`))
    .slice(0, DESIGN_RUNTIME_FRAME_CHANGE_LIMITS.follow)
    .map((change) => ({ oid: change.oid, property: change.property }));
  return runtime.getFrameChanges(follow).then(
    (result) =>
      designFrameRuntime(workspaceId, frame) === runtime && runtime.sourceVersion === result.sourceVersion
        ? designTidyOutcome(before, after, result.follow ?? [])
        : null,
    () => null,
  );
}

export interface DesignTidyEntry {
  /** running: from the click until the brief's turn ends. ended: that turn
   * ended and the outcome is being read. done: the outcome is shown. */
  phase: "running" | "ended" | "done";
  /** The chat the brief went to, once it was sent. */
  chatId: string | null;
  before: DesignFrameChange[];
  outcome?: string;
  /** The generation the outcome describes; a later one dismisses it. */
  doneVersion?: string;
}

export const useDesignTidyStore = create<{ byKey: Record<string, DesignTidyEntry> }>(() => ({ byKey: {} }));

/** Each running Tidy's one subscription to its chat's turn, by frame key. */
const following = new Map<string, () => void>();

function setTidy(key: string, entry: DesignTidyEntry | null): void {
  useDesignTidyStore.setState((state) => {
    const byKey = { ...state.byKey };
    if (entry) byKey[key] = entry;
    else delete byKey[key];
    return { byKey };
  });
}

function stopFollowing(key: string): void {
  following.get(key)?.();
  following.delete(key);
}

/** Send the brief and follow its chat's turn. `ask` sends it and reports the
 * chat it went to, or that it could not be sent. */
export function startDesignTidy(input: {
  workspaceId: string;
  frame: string;
  before: DesignFrameChange[];
  ask: (hooks: { onSent: (chatId: string) => void; onFailed: () => void }) => void;
}): void {
  const key = designFrameChangesKey(input.workspaceId, input.frame);
  stopFollowing(key);
  const entry: DesignTidyEntry = { phase: "running", chatId: null, before: input.before };
  setTidy(key, entry);
  input.ask({
    onSent: (chatId) => {
      if (useDesignTidyStore.getState().byKey[key] !== entry) return;
      const sent = { ...entry, chatId };
      setTidy(key, sent);
      // The turn ends when its chat stops streaming after it started.
      let started = useSessionsStore.getState().sessions[chatId]?.status === "streaming";
      following.set(
        key,
        useSessionsStore.subscribe((state) => {
          const streaming = state.sessions[chatId]?.status === "streaming";
          if (streaming) {
            started = true;
            return;
          }
          if (!started || useDesignTidyStore.getState().byKey[key] !== sent) return;
          stopFollowing(key);
          setTidy(key, { ...sent, phase: "ended" });
        }),
      );
    },
    onFailed: () => {
      if (useDesignTidyStore.getState().byKey[key] === entry) setTidy(key, null);
    },
  });
}

/** The outcome is read: show it for this generation. */
export function finishDesignTidy(workspaceId: string, frame: string, outcome: string, sourceVersion: string): void {
  const key = designFrameChangesKey(workspaceId, frame);
  const current = useDesignTidyStore.getState().byKey[key];
  if (current?.phase === "ended") setTidy(key, { ...current, phase: "done", outcome, doneVersion: sourceVersion });
}

/** Done goes once something else is selected or the frame changes again. */
export function dismissDesignTidy(workspaceId: string, frame: string): void {
  const key = designFrameChangesKey(workspaceId, frame);
  stopFollowing(key);
  if (useDesignTidyStore.getState().byKey[key]) setTidy(key, null);
}

export function resetDesignFrameChangesForTests(): void {
  for (const stop of following.values()) stop();
  following.clear();
  reading.clear();
  useDesignFrameChangesStore.setState({ byKey: {} });
  useDesignTidyStore.setState({ byKey: {} });
}
