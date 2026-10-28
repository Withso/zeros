import type { DesignSurfaceCost } from "@zeros/protocol/design-surface";

export const DESIGN_SOURCE_SURFACE_LIMITS = Object.freeze({ frames: 256, sourceBytes: 8 * 1024 * 1024, nodes: 32_768, imageBytes: 32 * 1024 * 1024 });

/** The caller orders by screen/interaction demand. Large or unknown documents
 * keep the bounded raster path; small visible frames need no screenshot host. */
export function selectDesignSourceSurfaces(frames: readonly { file: string; sourceVersion?: string; surfaceCost?: DesignSurfaceCost | null }[]): ReadonlySet<string> {
  const result = new Set<string>();
  const used = { sourceBytes: 0, nodes: 0, imageBytes: 0 };
  for (const frame of frames) {
    const cost = frame.surfaceCost;
    if (!frame.sourceVersion || !cost || result.has(frame.file) || result.size >= DESIGN_SOURCE_SURFACE_LIMITS.frames) continue;
    if ((Object.keys(used) as Array<keyof typeof used>).some(key => !Number.isSafeInteger(cost[key]) || cost[key] < 0 || used[key] + cost[key] > DESIGN_SOURCE_SURFACE_LIMITS[key])) continue;
    if (cost.nodes === 0 || cost.sourceBytes === 0) continue;
    result.add(frame.file);
    for (const key of Object.keys(used) as Array<keyof typeof used>) used[key] += cost[key];
  }
  return result;
}

/** Admission is global even if a future shell presents two active canvases.
 * Each source surface owns a reservation until its documents detach. One
 * incoming generation uses the existing global document-replacement slot. */
export class DesignSourceSurfaceBudget {
  private readonly entries = new Map<object, DesignSurfaceCost>();
  private readonly overlap = new Map<object, DesignSurfaceCost>();
  /** Owner changes can mount the destination before the outgoing layout
   * cleanups run. Retry once after that commit so transient overlap does not
   * permanently demote a destination frame to a preview. */
  request(cost: DesignSurfaceCost, onAdmit: () => void, onUnavailable: () => void): () => void {
    let cancelled = false;
    let release = this.acquire(cost);
    if (release) onAdmit();
    else queueMicrotask(() => {
      if (cancelled) return;
      release = this.acquire(cost);
      if (release) onAdmit();
      else onUnavailable();
    });
    return () => {
      if (cancelled) return;
      cancelled = true;
      release?.();
    };
  }
  acquire(cost: DesignSurfaceCost): (() => void) | null {
    const frames = [...this.entries.values(), cost].map((surfaceCost, index) => ({ file: String(index), sourceVersion: "a".repeat(24), surfaceCost }));
    if (selectDesignSourceSurfaces(frames).size !== frames.length) return null;
    const token = {};
    this.entries.set(token, cost);
    let released = false;
    return () => { if (!released) { released = true; this.entries.delete(token); } };
  }
  /** One incoming generation has its own charged reservation until promotion
   * or removal. It cannot conceal the still-mounted outgoing document's cost. */
  acquireOverlap(cost: DesignSurfaceCost): (() => void) | null {
    if (this.overlap.size || !selectDesignSourceSurfaces([{ file: "incoming", sourceVersion: "a".repeat(24), surfaceCost: cost }]).size) return null;
    const token = {};
    this.overlap.set(token, cost);
    return () => { this.overlap.delete(token); };
  }
  usage() {
    return [...this.entries.values(), ...this.overlap.values()].reduce<{ frames: number } & DesignSurfaceCost>((sum, cost) => ({ frames: sum.frames + 1,
      sourceBytes: sum.sourceBytes + cost.sourceBytes, nodes: sum.nodes + cost.nodes,
      imageBytes: sum.imageBytes + cost.imageBytes }), { frames: 0, sourceBytes: 0, nodes: 0, imageBytes: 0 });
  }
}

export const designSourceSurfaceBudget = new DesignSourceSurfaceBudget();
