// The last expansion of each frame whose component options all applied, so
// a frame whose options stop applying keeps showing it ("The frame shows its
// last good render."). Held in memory for this session only, for the frames
// rendered most recently, within a byte cap; a frame's entry goes when the
// frame is deleted or renamed. A read served from it is never stored as a
// durable identity, so after a restart the frame shows the component's
// defaults instead and says so.

import path from "node:path";

import { observeDesignDependencyCheck } from "./dependency-read-set";

/** Frames kept: as many as the canvas shows live. */
const MAX_FRAMES = 12;
const MAX_BYTES = 16 * 1024 * 1024;

const entries = new Map<string, string>();
let bytes = 0;
/** When the engine last recorded or forgot each frame's entry, on one count,
 * for the most recent frames only. */
let recorded = 0;
const recordedAt = new Map<string, number>();
const MAX_STAMPS = 256;
/** The newest stamp dropped: a worker read older than it is not adopted, so
 * the cap can only cost an adoption, never let an older render replace a newer one. */
let droppedThrough = 0;

function stamp(key: string): void {
  recordedAt.delete(key);
  recordedAt.set(key, ++recorded);
  if (recordedAt.size <= MAX_STAMPS) return;
  const [oldest, at] = recordedAt.entries().next().value!;
  recordedAt.delete(oldest);
  droppedThrough = at;
}
/** Set on a preparation worker. The engine's thread serves every frame
 * document, so this store is the engine's alone: a worker showing a last
 * good render of its own would report a generation the engine never serves.
 * A worker instead hands each good render it makes to the engine, and leaves
 * a frame that needs one to the engine's thread. */
let handedToEngine: Map<string, string> | null = null;

/** Why a worker leaves a frame to the engine's thread: an expected handover,
 * not a worker fault. */
export const DESIGN_LAST_GOOD_ON_ENGINE = "A frame whose component options do not apply is prepared on the engine's thread.";

export function handDesignComponentRendersToEngine(): void {
  handedToEngine ??= new Map();
}

const keyOf = (workspacePath: string, file: string) => `${path.resolve(workspacePath)}\0${file}`;

export function rememberDesignComponentRender(workspacePath: string, file: string, html: string): void {
  const key = keyOf(workspacePath, file);
  if (handedToEngine) {
    handedToEngine.delete(key);
    if (html.length <= MAX_BYTES) handedToEngine.set(key, html);
    if (handedToEngine.size > MAX_FRAMES) handedToEngine.delete(handedToEngine.keys().next().value!);
    return;
  }
  const prior = entries.get(key);
  if (prior !== undefined) {
    bytes -= prior.length;
    entries.delete(key);
  }
  stamp(key);
  if (html.length > MAX_BYTES) return;
  entries.set(key, html);
  bytes += html.length;
  while (entries.size > MAX_FRAMES || bytes > MAX_BYTES) {
    const [oldest, value] = entries.entries().next().value!;
    entries.delete(oldest);
    bytes -= value.length;
  }
}

/** A point in the engine's record, taken before frames are sent to the workers. */
export function designComponentRenderMark(): number {
  return recorded;
}

/** A good render a worker made, kept unless the engine recorded or forgot
 * the frame's entry after `mark`: the engine serves documents while the
 * workers compose, and what it recorded then is newer than the worker's read. */
export function adoptDesignComponentRenderFromWorker(workspacePath: string, file: string, html: string, mark: number): void {
  if (droppedThrough > mark || (recordedAt.get(keyOf(workspacePath, file)) ?? 0) > mark) return;
  rememberDesignComponentRender(workspacePath, file, html);
}

/** The frame's last good expansion, recorded so a read that used it stays in
 * memory and is redone once the entry changes or goes. */
export function lastGoodDesignComponentRender(workspacePath: string, file: string): string | undefined {
  if (handedToEngine) throw new Error(DESIGN_LAST_GOOD_ON_ENGINE);
  const key = keyOf(workspacePath, file);
  const html = entries.get(key);
  if (html !== undefined) {
    observeDesignDependencyCheck(() => {
      if (entries.get(key) !== html) throw new Error("The frame's last good render changed.");
    });
  }
  return html;
}

/** On a worker: the good render it made of this frame, for the engine to keep. */
export function takeDesignComponentRenderForEngine(workspacePath: string, file: string): string | undefined {
  if (!handedToEngine) return undefined;
  const key = keyOf(workspacePath, file);
  const html = handedToEngine.get(key);
  handedToEngine.delete(key);
  return html;
}

export function forgetDesignComponentRender(workspacePath: string, file: string): void {
  const key = keyOf(workspacePath, file);
  const prior = entries.get(key);
  if (prior === undefined) return;
  stamp(key);
  bytes -= prior.length;
  entries.delete(key);
}

export function resetDesignComponentRendersForTests(): void {
  entries.clear();
  recordedAt.clear();
  droppedThrough = 0;
  bytes = 0;
}

export function designComponentRenderBytesForTests(): { frames: number; bytes: number; stamps: number } {
  return { frames: entries.size, bytes, stamps: recordedAt.size };
}
