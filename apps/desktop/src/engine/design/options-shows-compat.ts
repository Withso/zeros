import { DESIGN_COMPONENT_BINDINGS_PARAM, DESIGN_INSTANCE_SLOT_TEXT_PARAM, DESIGN_OPTIONS_SHOW_NOTHING_PARAM } from "@zeros/protocol/design-catalog";

type Shown = { notApplied?: string; bindings?: unknown } | undefined;
type Hosts = Record<string, { text?: string; mixedText?: true } | undefined>;
type Components = Record<string, { bindings?: unknown } | undefined>;
type Instances = { notApplied?: string; hosts?: Hosts; components?: Components } | undefined;
type FrameRecord = { component?: Shown; instances?: Instances };

/** What a renderer asked for; one that predates both negotiated neither. */
export type DesignRendererNegotiation = { showsNothing: boolean; slotText: boolean; bindings: boolean };
const OLDER: DesignRendererNegotiation = { showsNothing: false, slotText: false, bindings: false };

/** Whether a renderer reads every reply as it is. */
export function designRendererNegotiatedAll(negotiated: DesignRendererNegotiation): boolean {
  return negotiated.showsNothing && negotiated.slotText && negotiated.bindings;
}

const showsNothing = (record: Shown) => record?.notApplied === "nothing";

/** Hosts as a renderer without slot text reads them: text only on a host that
 * holds nothing else, which it writes as the host's own text. */
function hostsWithoutMixedText(hosts: Hosts | undefined): Hosts | undefined {
  if (!hosts || !Object.values(hosts).some((host) => host?.mixedText)) return hosts;
  return Object.fromEntries(Object.entries(hosts).map(([id, host]) => {
    if (!host?.mixedText) return [id, host];
    const { text: _text, mixedText: _mixed, ...rest } = host;
    return [id, rest];
  }));
}

function frameForOlderRenderer(frame: unknown, negotiated: DesignRendererNegotiation): unknown {
  if (!frame || typeof frame !== "object") return frame;
  const { component, instances } = frame as FrameRecord;
  let next = frame as Record<string, unknown> & FrameRecord;
  if (!negotiated.showsNothing && (showsNothing(component) || showsNothing(instances)))
    next = { ...next,
      ...(showsNothing(component) ? { component: { ...component, notApplied: "defaults" } } : {}),
      ...(showsNothing(instances) ? { instances: { ...instances, notApplied: "defaults" } } : {}) };
  const hosts = next.instances?.hosts;
  const kept = negotiated.slotText ? hosts : hostsWithoutMixedText(hosts);
  if (kept !== hosts) next = { ...next, instances: { ...next.instances, hosts: kept } };
  if (!negotiated.bindings) {
    // Strict older schemas reject the key; `instances.key` stays as computed,
    // as for slot text, since only equality between replies is read from it.
    if (next.component?.bindings !== undefined) {
      const { bindings: _bindings, ...component } = next.component;
      next = { ...next, component };
    }
    const components = next.instances?.components;
    if (components && Object.values(components).some((entry) => entry?.bindings !== undefined))
      next = { ...next, instances: { ...next.instances, components: Object.fromEntries(Object.entries(components).map(([name, entry]) => {
        if (entry?.bindings === undefined) return [name, entry];
        const { bindings: _bindings, ...rest } = entry;
        return [name, rest];
      })) } };
  }
  return next;
}

/** Records rewritten for an older renderer; the array itself when none is. */
function framesForOlderRenderer(frames: unknown[], negotiated: DesignRendererNegotiation): unknown[] {
  const first = frames.findIndex((frame) => frameForOlderRenderer(frame, negotiated) !== frame);
  if (first < 0) return frames;
  const next = frames.slice();
  for (let index = first; index < next.length; index++) next[index] = frameForOlderRenderer(next[index], negotiated);
  return next;
}

/** A Design reply as a renderer reads it that did not negotiate everything:
 * its records are parsed strictly, so one without "nothing" knows only
 * "last-good" and "defaults", one without slot text gets no text beside a
 * host's children, and one without bindings gets no `bindings`. Frame records sit at `frame` (design.frame), `frames`
 * (preparation and snapshots), `prepared` (design.thumbnails.render, for
 * frames sent without a version) and under `snapshot` (write
 * acknowledgements, design.initialize, workspace.setMode). Unchanged replies
 * are returned as they are. */
export function designReplyForOlderRenderer(reply: unknown, negotiated: DesignRendererNegotiation = OLDER, depth = 0): unknown {
  if (!reply || typeof reply !== "object" || Array.isArray(reply) || depth > 2) return reply;
  const value = reply as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  const set = (key: string, replaced: unknown) => {
    if (replaced !== value[key]) (next ??= { ...value })[key] = replaced;
  };
  if ("frame" in value) set("frame", frameForOlderRenderer(value.frame, negotiated));
  for (const key of ["frames", "prepared"]) if (Array.isArray(value[key])) set(key, framesForOlderRenderer(value[key] as unknown[], negotiated));
  if ("snapshot" in value) set("snapshot", designReplyForOlderRenderer(value.snapshot, negotiated, depth + 1));
  return next ?? reply;
}

/** Operations whose replies carry Design frame records. */
export function designReplyCarriesFrames(op: string): boolean {
  return op.startsWith("design.") || op === "workspace.setMode";
}

/** Splits the negotiation parameter off a Design request, so operations that
 * check their parameters strictly never see it. */
export function takeDesignShowsNothing(params: Record<string, unknown>): { params: Record<string, unknown>; negotiated: boolean } {
  const request = takeDesignNegotiation(params);
  return { params: request.params, negotiated: request.negotiated.showsNothing };
}

/** Splits every negotiation parameter off a Design request, so operations
 * that check their parameters strictly never see them. */
export function takeDesignNegotiation(params: Record<string, unknown>): { params: Record<string, unknown>; negotiated: DesignRendererNegotiation } {
  if (!(DESIGN_OPTIONS_SHOW_NOTHING_PARAM in params) && !(DESIGN_INSTANCE_SLOT_TEXT_PARAM in params) && !(DESIGN_COMPONENT_BINDINGS_PARAM in params))
    return { params, negotiated: OLDER };
  const { [DESIGN_OPTIONS_SHOW_NOTHING_PARAM]: nothing, [DESIGN_INSTANCE_SLOT_TEXT_PARAM]: slotText, [DESIGN_COMPONENT_BINDINGS_PARAM]: bindings, ...rest } = params;
  return { params: rest, negotiated: { showsNothing: nothing === true, slotText: slotText === true, bindings: bindings === true } };
}
