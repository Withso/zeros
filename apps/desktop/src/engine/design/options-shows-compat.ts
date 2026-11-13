import { DESIGN_OPTIONS_SHOW_NOTHING_PARAM } from "@zeros/protocol/design-catalog";

type Shown = { notApplied?: string } | undefined;
type FrameRecord = { component?: Shown; instances?: Shown };

const showsNothing = (record: Shown) => record?.notApplied === "nothing";

function frameForOlderRenderer(frame: unknown): unknown {
  if (!frame || typeof frame !== "object") return frame;
  const { component, instances } = frame as FrameRecord;
  if (!showsNothing(component) && !showsNothing(instances)) return frame;
  return { ...frame,
    ...(showsNothing(component) ? { component: { ...component, notApplied: "defaults" } } : {}),
    ...(showsNothing(instances) ? { instances: { ...instances, notApplied: "defaults" } } : {}) };
}

/** Records rewritten for an older renderer; the array itself when none is. */
function framesForOlderRenderer(frames: unknown[]): unknown[] {
  const first = frames.findIndex((frame) => frameForOlderRenderer(frame) !== frame);
  if (first < 0) return frames;
  const next = frames.slice();
  for (let index = first; index < next.length; index++) next[index] = frameForOlderRenderer(next[index]);
  return next;
}

/** A Design reply as a renderer that never negotiated "nothing" reads it:
 * its records are parsed strictly and know only "last-good" and "defaults".
 * Frame records sit at `frame` (design.frame), `frames` (preparation and
 * snapshots), `prepared` (design.thumbnails.render, for frames sent without a
 * version) and under `snapshot` (write acknowledgements, design.initialize,
 * workspace.setMode). Unchanged replies are returned as they are. */
export function designReplyForOlderRenderer(reply: unknown, depth = 0): unknown {
  if (!reply || typeof reply !== "object" || Array.isArray(reply) || depth > 2) return reply;
  const value = reply as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  const set = (key: string, replaced: unknown) => {
    if (replaced !== value[key]) (next ??= { ...value })[key] = replaced;
  };
  if ("frame" in value) set("frame", frameForOlderRenderer(value.frame));
  for (const key of ["frames", "prepared"]) if (Array.isArray(value[key])) set(key, framesForOlderRenderer(value[key] as unknown[]));
  if ("snapshot" in value) set("snapshot", designReplyForOlderRenderer(value.snapshot, depth + 1));
  return next ?? reply;
}

/** Operations whose replies carry Design frame records. */
export function designReplyCarriesFrames(op: string): boolean {
  return op.startsWith("design.") || op === "workspace.setMode";
}

/** Splits the negotiation parameter off a Design request, so operations that
 * check their parameters strictly never see it. */
export function takeDesignShowsNothing(params: Record<string, unknown>): { params: Record<string, unknown>; negotiated: boolean } {
  if (!(DESIGN_OPTIONS_SHOW_NOTHING_PARAM in params)) return { params, negotiated: false };
  const { [DESIGN_OPTIONS_SHOW_NOTHING_PARAM]: flag, ...rest } = params;
  return { params: rest, negotiated: flag === true };
}
