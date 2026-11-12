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

const keyOf = (workspacePath: string, file: string) => `${path.resolve(workspacePath)}\0${file}`;

export function rememberDesignComponentRender(workspacePath: string, file: string, html: string): void {
  const key = keyOf(workspacePath, file);
  const prior = entries.get(key);
  if (prior !== undefined) {
    bytes -= prior.length;
    entries.delete(key);
  }
  if (html.length > MAX_BYTES) return;
  entries.set(key, html);
  bytes += html.length;
  while (entries.size > MAX_FRAMES || bytes > MAX_BYTES) {
    const [oldest, value] = entries.entries().next().value!;
    entries.delete(oldest);
    bytes -= value.length;
  }
}

/** The frame's last good expansion, recorded so a read that used it stays in
 * memory and is redone once the entry changes or goes. */
export function lastGoodDesignComponentRender(workspacePath: string, file: string): string | undefined {
  const key = keyOf(workspacePath, file);
  const html = entries.get(key);
  if (html !== undefined) {
    observeDesignDependencyCheck(() => {
      if (entries.get(key) !== html) throw new Error("The frame's last good render changed.");
    });
  }
  return html;
}

export function forgetDesignComponentRender(workspacePath: string, file: string): void {
  const key = keyOf(workspacePath, file);
  const prior = entries.get(key);
  if (prior === undefined) return;
  bytes -= prior.length;
  entries.delete(key);
}

export function resetDesignComponentRendersForTests(): void {
  entries.clear();
  bytes = 0;
}

export function designComponentRenderBytesForTests(): { frames: number; bytes: number } {
  return { frames: entries.size, bytes };
}
