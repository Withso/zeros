import { designFrameFileSchema } from "@zeros/protocol/design-path";
import {
  MAX_DESIGN_AGENT_DRAFT_REGISTRATIONS,
  type DesignAgentDraftRegistration,
} from "@zeros/protocol/design-agent-drafts";
import { readPartialJson } from "./partial-json";

// ──────────────────────────────────────────────────────────
// Frames an in-flight meta/canvas.json registers
// ──────────────────────────────────────────────────────────
//
// An agent adds a frame by writing its HTML and registering it in
// `meta/canvas.json` (legacy layouts: the root `canvas.json`). Until that file
// saves, the canvas only knows the HTML draft, so its ghost would sit at a
// guessed spot and jump when the registration lands. Reading the canvas text
// received so far gives the frame's real position, size and title earlier. A
// frame counts once its source path and all four numbers have fully arrived.

/** Design-root-relative canvas files an agent may write. */
export function isDesignAgentCanvasFile(file: string): boolean {
  return file === "meta/canvas.json" || file === "canvas.json";
}

const COORDINATE = 1_000_000;
const SIZE = 16_384;

function finiteIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** The frames a (possibly partial) canvas document registers, in document
 * order; null when the text is not a canvas object yet. */
export function designAgentCanvasRegistrations(
  text: string,
): DesignAgentDraftRegistration[] | null {
  const { value, complete } = readPartialJson(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const frames = (value as Record<string, unknown>).frames;
  if (!frames || typeof frames !== "object" || Array.isArray(frames)) return [];
  const registrations: DesignAgentDraftRegistration[] = [];
  const files = new Set<string>();
  for (const [frameId, frame] of Object.entries(frames)) {
    if (registrations.length >= MAX_DESIGN_AGENT_DRAFT_REGISTRATIONS) break;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) continue;
    const { source, title, x, y, width, height } = frame as Record<string, unknown>;
    if (typeof source !== "string" || !complete.has(`frames.${frameId}.source`)) continue;
    if (!designFrameFileSchema.safeParse(source).success || files.has(source)) continue;
    if (
      !finiteIn(x, -COORDINATE, COORDINATE) ||
      !finiteIn(y, -COORDINATE, COORDINATE) ||
      !finiteIn(width, 1, SIZE) ||
      !finiteIn(height, 1, SIZE)
    )
      continue;
    files.add(source);
    registrations.push({
      file: source,
      x,
      y,
      width,
      height,
      ...(typeof title === "string" && complete.has(`frames.${frameId}.title`)
        ? { title: title.slice(0, 120) }
        : {}),
    });
  }
  return registrations;
}
