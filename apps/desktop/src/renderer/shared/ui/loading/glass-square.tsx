// ──────────────────────────────────────────────────────────
// GlassTiles — the transcript's agent square, running in glass
// ──────────────────────────────────────────────────────────
//
// ZerosSpinner variant="glass": the active turn's rail and running tool and
// subagent rows. Each mount picks one of three running motions at random
// (weave, cascade or circuit: glass-motion.ts) and starts on a random combo
// (glass-combos.ts), so a turn and its tool rows rarely look alike.
//
// The glass is two layers, each a whole-square combo: its two crossing
// gradients, the light from the top, the sheen, and the glint that crosses as
// a new combo arrives. A layer is seen only through its mask, which holds the
// tiles showing it, so colour and light hold still while the tiles run
// through them. A faint glow in the combo's own colours rims the tiles.
//
// Each tile is a square in both masks, shown in the one for its layer, with a
// twin one square away: a tile running off an edge glides out while its twin
// glides in from the far side, and on landing the tile takes the twin's
// place. A gliding tile reaches half a device pixel further along its way, so
// tiles gliding side by side never show a seam; at rest it is exactly one
// cell, on whole pixels.
//
// Glides are Web Animations started from the shared loader loop, so hidden
// retained surfaces stay inert; React renders the starting square once and
// never re-renders for a move. prefers-reduced-motion keeps it at rest.
// ──────────────────────────────────────────────────────────

import React from "react";

import { useThemeVariant } from "@/renderer/shared/theme/use-theme-variant";

import {
  GLASS_COMBO_CROSS_OPACITY,
  GLASS_COMBO_FLOWS,
  GLASS_GLINT,
  GLASS_GLOW,
  GLASS_LIGHT,
  GLASS_SHEEN,
  glassComboStops,
  type GlassComboLayer,
} from "./glass-combos";
import {
  GLASS_EASE,
  GLASS_GLINT_MS,
  GLASS_MOVE_MS,
  GlassFlow,
  type GlassLayer,
  type GlassMotion,
  type GlassMove,
} from "./glass-motion";
import { LOADER_GRID as N } from "./loader-frame";
import { startLoaderRun } from "./loader-loop";

type GradientEnds = readonly [number, number, number, number];
type GradientStop = { offset: number; color: string };
const toStops = (stops: ReadonlyArray<readonly [number, string]>): GradientStop[] =>
  stops.map(([offset, color]) => ({ offset, color }));
const LIGHT_STOPS = toStops(GLASS_LIGHT);
const SHEEN_STOPS = toStops(GLASS_SHEEN);
const GLINT_STOPS = toStops(GLASS_GLINT);
const LAYERS: readonly GlassLayer[] = [0, 1];
/** How much further than its cell a gliding tile reaches, in device pixels. */
const REACH_DEVICE_PX = 0.5;
const at = (x: number, y: number) => `translate(${x}px, ${y}px)`;

function Gradient({
  id,
  ends,
  stops,
  hook,
}: {
  id: string;
  ends: GradientEnds;
  stops: GradientStop[];
  /** A data attribute the square finds it by, to repaint it. */
  hook?: Record<string, number>;
}) {
  const [x1, y1, x2, y2] = ends;
  return (
    <linearGradient {...hook} id={id} x1={x1} y1={y1} x2={x2} y2={y2}>
      {stops.map((stop, i) => (
        <stop key={i} offset={stop.offset} style={{ stopColor: stop.color }} />
      ))}
    </linearGradient>
  );
}

/** Repaint a gradient in place (every combo gradient keeps the same number
 *  of stops, so only attributes change). */
function repaint(gradient: SVGLinearGradientElement | null, ends: GradientEnds, stops: GradientStop[]) {
  if (!gradient) return;
  (["x1", "y1", "x2", "y2"] as const).forEach((axis, i) => gradient.setAttribute(axis, String(ends[i])));
  Array.from(gradient.children).forEach((stop, i) => {
    const next = stops[i];
    if (!next) return;
    stop.setAttribute("offset", String(next.offset));
    (stop as SVGElement).style.stopColor = next.color;
  });
}

/** The glass square's tiles, for an svg whose viewBox is the LOADER_GRID
 *  square. `cell` is one tile's side in CSS pixels. */
export function GlassTiles({
  motion,
  reducedMotion,
  cell,
}: {
  motion: GlassMotion;
  reducedMotion: boolean;
  cell: number;
}) {
  // The model outlives every effect run; React draws its starting square.
  const [flow] = React.useState(() => new GlassFlow(motion));
  const [start] = React.useState(() => ({
    tiles: flow.tiles.map((tile) => ({ ...tile })),
    layers: flow.layers.map((layer) => ({ ...layer })) as GlassComboLayer[],
  }));
  const scope = React.useId().replace(/[^\w-]/g, "");
  const ids = React.useMemo(
    () => ({
      run: (k: number) => `${scope}-glass-run-${k}`,
      cross: (k: number) => `${scope}-glass-cross-${k}`,
      mask: (k: number) => `${scope}-glass-mask-${k}`,
      light: `${scope}-glass-light`,
      sheen: `${scope}-glass-sheen`,
      glint: `${scope}-glass-glint`,
      glow: `${scope}-glass-glow`,
    }),
    [scope],
  );
  const glow = GLASS_GLOW[useThemeVariant()];
  const defsRef = React.useRef<SVGDefsElement | null>(null);
  const glassRef = React.useRef<SVGGElement | null>(null);

  React.useEffect(() => {
    const defs = defsRef.current;
    const host = glassRef.current;
    if (reducedMotion || !defs || !host) return;
    const find = <T extends Element>(selector: string) => defs.querySelector<T>(selector);
    // Per layer, per tile: its group, holding the tile and its twin.
    const groups = LAYERS.map((k) => Array.from(find(`[data-glass-tiles="${k}"]`)?.children ?? []) as SVGGElement[]);
    const joints = LAYERS.map((k) => find<SVGGElement>(`[data-glass-joints="${k}"]`));
    const runs = LAYERS.map((k) => find<SVGLinearGradientElement>(`[data-glass-run="${k}"]`));
    const crosses = LAYERS.map((k) => find<SVGLinearGradientElement>(`[data-glass-cross="${k}"]`));
    const glints = Array.from(host.querySelectorAll<SVGRectElement>("[data-glass-glint]"));
    const reach = REACH_DEVICE_PX / ((window.devicePixelRatio || 1) * cell);
    const flights = new Map<number, { runs: Animation[]; land: () => void }>();
    const timers = new Set<number>();

    /** Size the tile and put its twin one square back along (dx, dy); a
     *  gliding tile reaches a little further along its way. */
    const shape = (tile: number, dx: number, dy: number, gliding: boolean) => {
      const ox = gliding && dx ? reach : 0;
      const oy = gliding && dy ? reach : 0;
      for (const k of LAYERS) {
        const rects = Array.from(groups[k][tile]?.children ?? []);
        rects.forEach((rect, twin) => {
          rect.setAttribute("x", String((twin ? -dx * N : 0) - ox));
          rect.setAttribute("y", String((twin ? -dy * N : 0) - oy));
          rect.setAttribute("width", String(1 + 2 * ox));
          rect.setAttribute("height", String(1 + 2 * oy));
        });
      }
    };
    const show = (tile: number, main: GlassLayer, twin: GlassLayer) => {
      for (const k of LAYERS) {
        const [mainRect, twinRect] = Array.from(groups[k][tile]?.children ?? []) as SVGElement[];
        mainRect?.style.setProperty("opacity", main === k ? "1" : "0");
        twinRect?.style.setProperty("opacity", twin === k ? "1" : "0");
      }
    };

    const glide = (move: GlassMove) => {
      const { tile, from, dx, dy } = move;
      // A glide still finishing on this tile lands first.
      flights.get(tile)?.land();
      shape(tile, dx, dy, true);
      show(tile, move.fromLayer, move.toLayer);
      const frames = [{ transform: at(from.x, from.y) }, { transform: at(from.x + dx, from.y + dy) }];
      const animations = groups.flatMap((layer) => {
        const group = layer[tile];
        return group ? [group.animate(frames, { duration: GLASS_MOVE_MS, easing: GLASS_EASE, fill: "forwards" })] : [];
      });
      const land = () => {
        if (flights.get(tile)?.runs !== animations) return;
        flights.delete(tile);
        // Where it landed (a wrapped tile takes its twin's place): exactly
        // one cell again, in the layer it landed in.
        const landed = at((from.x + dx + N) % N, (from.y + dy + N) % N);
        for (const layer of groups) layer[tile]?.style.setProperty("transform", landed);
        shape(tile, dx, dy, false);
        show(tile, move.toLayer, move.toLayer);
        animations.forEach((animation) => animation.cancel());
      };
      flights.set(tile, { runs: animations, land });
      if (animations[0]) animations[0].onfinish = land;
      else land();
    };

    /** Hold a corner cell a bending train turns (in the live layer) until
     *  its follower has landed there. */
    const joint = (cell: number) => {
      const holder = joints[flow.live];
      if (!holder) return;
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(cell % N));
      rect.setAttribute("y", String(Math.floor(cell / N)));
      rect.setAttribute("width", "1");
      rect.setAttribute("height", "1");
      rect.setAttribute("fill", "white");
      holder.appendChild(rect);
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        rect.remove();
      }, GLASS_MOVE_MS);
      timers.add(timer);
    };

    /** A new combo went live: paint it, and let the glint cross. */
    const swap = () => {
      const layer = flow.layers[flow.live];
      const ends = GLASS_COMBO_FLOWS[layer.flow];
      repaint(runs[flow.live], ends.run, glassComboStops(layer.combo));
      repaint(crosses[flow.live], ends.cross, glassComboStops(layer.combo, true));
      for (const glint of glints) {
        glint.animate([{ transform: `translateX(${-N}px)` }, { transform: `translateX(${N}px)` }], {
          duration: GLASS_GLINT_MS,
          easing: "cubic-bezier(0.45, 0, 0.25, 1)",
        });
      }
    };

    flow.start(performance.now());
    const stop = startLoaderRun({
      host,
      tick: (now) => {
        const step = flow.step(now);
        if (step.swapped) swap();
        step.joints.forEach(joint);
        step.moves.forEach(glide);
      },
    });
    return () => {
      stop();
      // Land every tile where the model has it, so a later run resumes.
      flights.forEach(({ land }) => land());
      timers.forEach((timer) => window.clearTimeout(timer));
      joints.forEach((holder) => holder?.replaceChildren());
    };
  }, [flow, reducedMotion, cell]);

  return (
    <>
      <defs ref={defsRef}>
        {start.layers.map((layer, k) => (
          <React.Fragment key={k}>
            <Gradient
              id={ids.run(k)}
              hook={{ "data-glass-run": k }}
              ends={GLASS_COMBO_FLOWS[layer.flow].run}
              stops={glassComboStops(layer.combo)}
            />
            <Gradient
              id={ids.cross(k)}
              hook={{ "data-glass-cross": k }}
              ends={GLASS_COMBO_FLOWS[layer.flow].cross}
              stops={glassComboStops(layer.combo, true)}
            />
            <mask id={ids.mask(k)} maskUnits="userSpaceOnUse" x={0} y={0} width={N} height={N}>
              <g data-glass-tiles={k}>
                {start.tiles.map((tile, i) => (
                  <g key={i} style={{ transform: at(tile.x, tile.y) }}>
                    <rect width={1} height={1} fill="white" style={{ opacity: tile.layer === k ? 1 : 0 }} />
                    <rect x={-N} width={1} height={1} fill="white" style={{ opacity: tile.layer === k ? 1 : 0 }} />
                  </g>
                ))}
              </g>
              <g data-glass-joints={k} />
            </mask>
          </React.Fragment>
        ))}
        <Gradient id={ids.light} ends={[0, 0, 0, 1]} stops={LIGHT_STOPS} />
        <Gradient id={ids.sheen} ends={[0, 0, 1, 1]} stops={SHEEN_STOPS} />
        <Gradient id={ids.glint} ends={[0, 0, 1, 0.6]} stops={GLINT_STOPS} />
        {/* In the square's own units, so twins waiting outside it never
            change the glow. */}
        <filter
          id={ids.glow}
          filterUnits="userSpaceOnUse"
          primitiveUnits="userSpaceOnUse"
          x={-0.3 * N}
          y={-0.3 * N}
          width={1.6 * N}
          height={1.6 * N}
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation={glow.blur * N} result="blur" />
          <feComponentTransfer in="blur" result="soft">
            <feFuncA type="linear" slope={glow.strength} />
          </feComponentTransfer>
          <feMerge>
            <feMergeNode in="soft" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g ref={glassRef} className="zeros-glass" filter={`url(#${ids.glow})`}>
        {LAYERS.map((k) => (
          <g key={k} mask={`url(#${ids.mask(k)})`}>
            {[ids.run(k), ids.cross(k), ids.light, ids.sheen].map((id, i) => (
              <rect
                key={id}
                width={N}
                height={N}
                style={{ fill: `url(#${id})`, opacity: i === 1 ? GLASS_COMBO_CROSS_OPACITY : undefined }}
              />
            ))}
            <rect
              data-glass-glint=""
              width={N}
              height={N}
              style={{ fill: `url(#${ids.glint})`, transform: `translateX(${-N}px)` }}
            />
          </g>
        ))}
      </g>
    </>
  );
}
