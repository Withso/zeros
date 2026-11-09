import path from "node:path";
import type { DurableDesignDependency } from "./dependency-read-set";
import type { RetainedFrameRender } from "./render-preparation";

/** A frame's identity read, kept for the capture that usually follows it.
 * The capture reuses it only for the same version, while the identity's
 * context holds and every file the read saw still has its fingerprint. */
export interface RetainedDesignFrame {
  context: string;
  render: RetainedFrameRender;
  durable: readonly DurableDesignDependency[];
}

/** Per thread. The recorder is slower than preparation, so a cold open's
 * captures trail its preparation by hundreds of frames; a read older than
 * any capture would follow is dropped. */
const BUDGET_BYTES = 64 * 1024 * 1024;
const MAX_AGE_MS = 60_000;
const frames = new Map<string, RetainedDesignFrame & { bytes: number; at: number }>();
let bytes = 0;
const testing: { budget: number | null; retained: number; reused: number } = { budget: null, retained: 0, reused: 0 };

/** Checkouts whose recorded canvas has asked for recordings: only their
 * frames are captured after preparing, so only their reads are kept. */
const recordedCanvases = new Map<string, number>();
const RECORDED_CANVAS_MS = 10 * 60_000;

export function noteDesignRecordedCanvas(root: string): void {
  const key = path.resolve(root);
  recordedCanvases.delete(key);
  recordedCanvases.set(key, Date.now());
  if (recordedCanvases.size > 64) recordedCanvases.delete(recordedCanvases.keys().next().value!);
}

export function designRecordedCanvasActive(root: string): boolean {
  const at = recordedCanvases.get(path.resolve(root));
  return at !== undefined && Date.now() - at < RECORDED_CANVAS_MS;
}

const keyOf = (root: string, directory: string, file: string) => `${path.resolve(root)}\0${directory}\0${file}`;

export function retainDesignFrame(root: string, directory: string, file: string, frame: RetainedDesignFrame): void {
  const key = keyOf(root, directory, file);
  drop(key);
  expire();
  const budget = testing.budget ?? BUDGET_BYTES;
  // Frame HTML is almost all one byte a character. Linked sheets are the
  // prepared stylesheet cache's own strings, shared rather than copied.
  const size = frame.render.skeleton.length + frame.render.expanded.length + 256 * frame.durable.length +
    32 * (frame.render.tailwindCandidates?.length ?? 0);
  if (size > budget / 8) return;
  frames.set(key, { ...frame, bytes: size, at: Date.now() });
  bytes += size;
  testing.retained++;
  for (const oldest of frames.keys()) {
    if (bytes <= budget) break;
    drop(oldest);
  }
}

/** The frame's retained read, which a capture uses once. */
export function takeDesignFrame(root: string, directory: string, file: string): RetainedDesignFrame | undefined {
  expire();
  const key = keyOf(root, directory, file);
  const frame = frames.get(key);
  drop(key);
  return frame;
}

function expire(): void {
  const oldest = Date.now() - MAX_AGE_MS;
  for (const [key, frame] of frames) {
    if (frame.at >= oldest) break;
    drop(key);
  }
}

export function noteDesignFrameReused(): void {
  testing.reused++;
}

function drop(key: string): void {
  const frame = frames.get(key);
  if (!frame) return;
  frames.delete(key);
  bytes -= frame.bytes;
}

export function configureRetainedDesignFramesForTests(options: { budget?: number | null } = {}): void {
  testing.budget = options.budget ?? null;
  frames.clear();
  recordedCanvases.clear();
  bytes = 0;
}

export function retainedDesignFrameStatsForTests(): { retained: number; reused: number; held: number } {
  return { retained: testing.retained, reused: testing.reused, held: frames.size };
}
