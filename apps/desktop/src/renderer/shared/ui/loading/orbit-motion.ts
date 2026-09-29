// ──────────────────────────────────────────────────────────
// Orbit motion — the loading loader's ring and comet
// ──────────────────────────────────────────────────────────
//
// A snake laps the 4 × 4 ring over a faint track, one lap every 1200ms. Both
// are drawn as continuous bands along the ring's centre line (12 tiles long),
// never as separate blocks, so no size turns the loop into a grey mosaic.
//
// The snake is a solid head of 3.5 tiles and a tail that fades over the next
// 2.75. SVG cannot run a gradient along a path, so the tail is a stack of
// dashes, longest first: each layer's opacity is solved so the layers
// compound into an even ramp. Every layer ends at the same head, and they all
// run the same keyframe, so the whole snake moves as one piece.
// ──────────────────────────────────────────────────────────

/** The ring's centre line: clockwise from the top-left tile, 12 tiles long. */
export const ORBIT_RING_PATH = "M0.5 0.5H3.5V3.5H0.5Z";
export const ORBIT_RING_LENGTH = 12;
export const ORBIT_LAP_MS = 1200;
export const ORBIT_HEAD = 3.5;
export const ORBIT_TAIL = 2.75;
/** Tail layers; 12 keeps the ramp's steps well under a pixel at 24px. */
export const ORBIT_TAIL_STEPS = 12;
/** Reduced motion rests the head a little past the top-right corner. */
export const ORBIT_REST_HEAD = 5;

export interface OrbitLayer {
  /** Dash length along the ring, in tiles. */
  length: number;
  /** Opacity of this layer on its own. */
  alpha: number;
}

/** Tail layers longest-first, then the solid head. */
export const ORBIT_LAYERS: readonly OrbitLayer[] = (() => {
  const layers: OrbitLayer[] = [];
  let through = 1;   // light the longer layers still let through
  for (let i = ORBIT_TAIL_STEPS - 1; i >= 0; i--) {
    const level = 1 - (i + 1) / (ORBIT_TAIL_STEPS + 1);
    const alpha = Math.max(0, 1 - (1 - level) / through);
    through *= 1 - alpha;
    layers.push({ length: ORBIT_HEAD + ((i + 1) * ORBIT_TAIL) / ORBIT_TAIL_STEPS, alpha });
  }
  layers.push({ length: ORBIT_HEAD, alpha: 1 });
  return layers;
})();

/** A dash that ends at the head: every layer shares one dash offset. With
 *  this pattern the head sits at `ORBIT_RING_LENGTH - offset`, so animating
 *  the offset from the full length down to 0 laps the ring once. */
export function orbitDashArray(length: number): string {
  return `0 ${ORBIT_RING_LENGTH - length} ${length} 0`;
}
