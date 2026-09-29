// ──────────────────────────────────────────────────────────
// Glass motion — how the transcript's agent square runs
// ──────────────────────────────────────────────────────────
//
// The active turn's rail and running tool and subagent rows show the agent
// at work in glass (glass-square.tsx) with Stream's running feel: the tiles
// never stop travelling. Each square picks one of three motions when it
// mounts, so a turn and its tool rows rarely run alike:
//
//   • weave   — Stream's ripple (a row every beat, top to bottom, wrapping
//               round at the edge), but neighbouring rows run opposite ways,
//               so the square knits past itself.
//   • cascade — rows run right and columns run down, taking turns down the
//               diagonal (row 0, column 0, row 1, column 1, …), so the square
//               tumbles down and to the right, re-forming as it goes. A line
//               that is empty or full would show no change, so it passes.
//   • circuit — short trains of tiles run single file along one winding track
//               through all sixteen cells (GLASS_CIRCUIT). The front train
//               steps into the gap ahead as one piece, bending round the
//               track's turns, then the train behind it, and so on back round
//               the loop, so the trains never close up.
//
// A step starts every beat and glides for longer than a beat, so the next one
// always starts before the last lands. A tile in flight stays reserved until
// its glide ends, so no tile is asked to move twice at once.
//
// Colour: the glass has two layers, each a whole-square combo seen through
// the tiles in it (so colour holds still while the tiles run through it).
// Every few seconds the idle layer takes a new combo and goes live, and the
// tiles bring it in: in the weave as each one wraps round an edge (it
// re-enters in the new combo), in the cascade and circuit the moment each one
// moves. The next combo waits until every tile shows the last one.
//
// The model is pure: it reports which tiles move where; the component turns
// that into transforms.
// ──────────────────────────────────────────────────────────

import {
  GLASS_COMBO_MS,
  glassComboLayer,
  type GlassComboLayer,
} from "./glass-combos";
import { LOADER_GRID as N } from "./loader-frame";
import { PUZZLE_CORNERS, PUZZLE_HOLES } from "./puzzle-motion";

export type GlassMotion = "weave" | "cascade" | "circuit";
export const GLASS_MOTIONS: readonly GlassMotion[] = ["weave", "cascade", "circuit"];

/** A motion at random: every square picks its own when it mounts. */
export function pickGlassMotion(random: () => number = Math.random): GlassMotion {
  return GLASS_MOTIONS[Math.floor(random() * GLASS_MOTIONS.length)];
}

/** A new step starts every beat… */
export const GLASS_BEAT_MS = 100;
/** …and glides for longer, so the square is never still. */
export const GLASS_MOVE_MS = 150;
/** The first step's wait after start: about a frame, so the tiles have
 *  painted and the first glide still glides. */
export const GLASS_FIRST_STEP_MS = 20;
/** The glide: the same ease as Stream's. */
export const GLASS_EASE = "cubic-bezier(0.55, 0, 0.25, 1)";
/** How long the glint takes to cross the square as a new combo arrives. */
export const GLASS_GLINT_MS = 700;

/** Tiles in a square: the density of the agent puzzle. */
export const GLASS_TILES = N * N - PUZZLE_HOLES;

/** The circuit's track, one loop through every cell: right along the top,
 *  back along the second row, right along the third, left along the bottom,
 *  then up the left side. */
export const GLASS_CIRCUIT: readonly number[] = (
  [
    [0, 0], [1, 0], [2, 0], [3, 0], [3, 1], [2, 1], [1, 1], [1, 2],
    [2, 2], [3, 2], [3, 3], [2, 3], [1, 3], [0, 3], [0, 2], [0, 1],
  ] as const
).map(([x, y]) => y * N + x);
const ALONG = new Map(GLASS_CIRCUIT.map((cell, i) => [cell, i]));

export type GlassLayer = 0 | 1;

export interface GlassTile {
  x: number;
  y: number;
  /** The layer it shows (once landed, if it is in flight). */
  layer: GlassLayer;
}

/** One tile's step, one cell along (dx, dy) from `from`. A step off an edge
 *  wraps round: the tile glides out while its twin, one square away on the
 *  far side, glides in. In flight the tile shows `fromLayer` and its twin
 *  `toLayer`; it lands in `toLayer`. */
export interface GlassMove {
  tile: number;
  from: { x: number; y: number };
  dx: number;
  dy: number;
  wraps: boolean;
  fromLayer: GlassLayer;
  toLayer: GlassLayer;
}

export interface GlassStep {
  moves: GlassMove[];
  /** Cells a bending train holds while it turns the corner (circuit): the
   *  tile leaving them and the one following into them move different ways,
   *  so the corner is kept filled until the follower lands. */
  joints: number[];
  /** A new combo went live (in `live`): repaint that layer and glint. */
  swapped: boolean;
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const CHANNEL = Array.from({ length: N * N }, (_, i) => i).filter((i) => !PUZZLE_CORNERS.includes(i));

/** Every row and column holds one to three tiles: every line visibly moves. */
function linesFit(cells: readonly number[]): boolean {
  for (let i = 0; i < N; i++) {
    const row = cells.filter((c) => Math.floor(c / N) === i).length;
    const column = cells.filter((c) => c % N === i).length;
    if (row < 1 || row > N - 1 || column < 1 || column > N - 1) return false;
  }
  return true;
}

/** The weave's and cascade's starting square: the corners filled, like the
 *  agent puzzle, and one to three tiles in every row and column. */
export function glassFlowPattern(random: () => number = Math.random): number[] {
  for (let attempt = 0; attempt < 200; attempt++) {
    const cells = [...PUZZLE_CORNERS, ...shuffled(CHANNEL, random).slice(0, GLASS_TILES - PUZZLE_CORNERS.length)];
    if (linesFit(cells)) return cells.sort((a, b) => a - b);
  }
  return [0, 1, 3, 4, 6, 9, 11, 12, 14, 15];
}

/** The runs of tiles along the circuit's track (positions on it): its
 *  trains, front to back round the loop, each listed tail first. */
export function glassCircuitTrains(positions: readonly number[]): number[][] {
  const on = new Set(positions);
  const hole = GLASS_CIRCUIT.findIndex((_, i) => !on.has(i));
  if (hole < 0) return [positions.slice().sort((a, b) => a - b)];
  const trains: number[][] = [];
  let train: number[] | null = null;
  for (let k = 1; k <= GLASS_CIRCUIT.length; k++) {
    const i = (hole + k) % GLASS_CIRCUIT.length;
    if (!on.has(i)) {
      train = null;
      continue;
    }
    if (!train) trains.push((train = []));
    train.push(i);
  }
  return trains;
}

/** The circuit's starting square: its tiles in three to five trains of at
 *  most four, so a step moves a few tiles, like a row of Stream. */
export function glassCircuitPattern(random: () => number = Math.random): number[] {
  const positions = GLASS_CIRCUIT.map((_, i) => i);
  for (let attempt = 0; attempt < 200; attempt++) {
    const picked = shuffled(positions, random).slice(0, GLASS_TILES);
    const trains = glassCircuitTrains(picked);
    if (trains.length >= 3 && trains.length <= 5 && trains.every((train) => train.length <= 4)) {
      return picked.map((i) => GLASS_CIRCUIT[i]).sort((a, b) => a - b);
    }
  }
  return [0, 1, 2, 4, 5, 8, 9, 10, 12, 13].map((i) => GLASS_CIRCUIT[i]).sort((a, b) => a - b);
}

const cellOf = (tile: GlassTile) => tile.y * N + tile.x;

export class GlassFlow {
  readonly tiles: GlassTile[];
  /** The layer new colour comes from; the other one is idle. */
  live: GlassLayer = 0;
  /** Each layer's combo. */
  readonly layers: [GlassComboLayer, GlassComboLayer];
  private readonly busyUntil: number[];
  /** The layer a tile in flight still shows until it lands. */
  private readonly flying: GlassLayer[];
  private readonly way: 1 | -1;
  /** Circuit: its trains, as tile ids, tail first, front to back. */
  private readonly trains: number[][];
  private turn = 0;
  private next = Infinity;
  private swapAt = Infinity;

  constructor(
    readonly motion: GlassMotion,
    private readonly random: () => number = Math.random,
  ) {
    const cells = motion === "circuit" ? glassCircuitPattern(random) : glassFlowPattern(random);
    this.tiles = cells.map((cell) => ({ x: cell % N, y: Math.floor(cell / N), layer: 0 }));
    this.busyUntil = cells.map(() => 0);
    this.flying = cells.map(() => 0);
    const first = glassComboLayer(null, random);
    this.layers = [first, glassComboLayer(first.combo, random)];
    this.way = random() < 0.5 ? 1 : -1;
    const byPosition = new Map(this.tiles.map((tile, id) => [ALONG.get(cellOf(tile)) ?? -1, id]));
    this.trains =
      motion === "circuit"
        ? glassCircuitTrains(this.tiles.map((tile) => ALONG.get(cellOf(tile)) ?? -1)).map((train) =>
            train.map((position) => byPosition.get(position) ?? -1),
          )
        : [];
    if (this.trains.length) this.turn = Math.floor(random() * this.trains.length);
  }

  /** Arm the steps (the first a frame from now) and, the first time, the
   *  first new combo, part-way into a combo's time so squares mounted
   *  together never change in step. Calling it again resumes. */
  start(now: number): void {
    this.next = now + GLASS_FIRST_STEP_MS;
    if (this.swapAt === Infinity) this.swapAt = now + GLASS_COMBO_MS * (0.5 + this.random() * 0.5);
  }

  step(now: number): GlassStep {
    const result: GlassStep = { moves: [], joints: [], swapped: false };
    if (now >= this.swapAt && this.showsOnly(this.live, now)) {
      const showing = this.layers[this.live].combo;
      this.live = this.live === 0 ? 1 : 0;
      this.layers[this.live] = glassComboLayer(showing, this.random);
      this.swapAt = now + GLASS_COMBO_MS;
      result.swapped = true;
    }
    if (now < this.next) return result;
    const moved =
      this.motion === "weave"
        ? this.weave(now, result)
        : this.motion === "cascade"
          ? this.cascade(now, result)
          : this.circuit(now, result);
    // A blocked step tries again next frame; a taken one keeps the beat.
    if (moved) this.next = Math.max(this.next + GLASS_BEAT_MS, now + GLASS_BEAT_MS / 2);
    return result;
  }

  private busy(tile: number, now: number): boolean {
    return this.busyUntil[tile] > now;
  }

  /** Every tile shows `layer`, including any still in flight. */
  private showsOnly(layer: GlassLayer, now: number): boolean {
    return this.tiles.every(
      (tile, id) => tile.layer === layer && (!this.busy(id, now) || this.flying[id] === layer),
    );
  }

  private line(has: (tile: GlassTile) => boolean): number[] {
    return this.tiles.flatMap((tile, id) => (has(tile) ? [id] : []));
  }

  private move(id: number, dx: number, dy: number, now: number, result: GlassStep): void {
    const tile = this.tiles[id];
    const tx = tile.x + dx;
    const ty = tile.y + dy;
    const wraps = tx < 0 || ty < 0 || tx >= N || ty >= N;
    // The weave takes new colour in at the edges; the others as they move.
    const fromLayer = this.motion === "weave" ? tile.layer : this.live;
    const toLayer = this.motion === "weave" && !wraps ? tile.layer : this.live;
    result.moves.push({ tile: id, from: { x: tile.x, y: tile.y }, dx, dy, wraps, fromLayer, toLayer });
    tile.x = (tx + N) % N;
    tile.y = (ty + N) % N;
    tile.layer = toLayer;
    this.flying[id] = fromLayer;
    this.busyUntil[id] = now + GLASS_MOVE_MS;
  }

  private weave(now: number, result: GlassStep): boolean {
    const row = this.turn;
    const line = this.line((tile) => tile.y === row);
    if (line.some((id) => this.busy(id, now))) return false;
    const dx = row % 2 === 0 ? this.way : -this.way;
    for (const id of line) this.move(id, dx, 0, now, result);
    this.turn = (row + 1) % N;
    return true;
  }

  private cascade(now: number, result: GlassStep): boolean {
    for (let tries = 0; tries < 2 * N; tries++) {
      const index = Math.floor(this.turn / 2);
      const across = this.turn % 2 === 0;
      const line = this.line((tile) => (across ? tile.y : tile.x) === index);
      if (line.length > 0 && line.length < N) {
        if (line.some((id) => this.busy(id, now))) return false;
        for (const id of line) this.move(id, across ? 1 : 0, across ? 0 : 1, now, result);
        this.turn = (this.turn + 1) % (2 * N);
        return true;
      }
      this.turn = (this.turn + 1) % (2 * N);
    }
    return false;
  }

  private circuit(now: number, result: GlassStep): boolean {
    const L = GLASS_CIRCUIT.length;
    for (let tries = 0; tries < this.trains.length; tries++) {
      const train = this.trains[this.turn];
      if (train.some((id) => this.busy(id, now))) return false;
      const head = this.tiles[train[train.length - 1]];
      const ahead = GLASS_CIRCUIT[((ALONG.get(cellOf(head)) ?? 0) + 1) % L];
      this.turn = (this.turn - 1 + this.trains.length) % this.trains.length;
      if (this.tiles.some((tile) => cellOf(tile) === ahead)) continue;
      const ways = train.map((id) => {
        const tile = this.tiles[id];
        const next = GLASS_CIRCUIT[((ALONG.get(cellOf(tile)) ?? 0) + 1) % L];
        return [(next % N) - tile.x, Math.floor(next / N) - tile.y] as const;
      });
      train.forEach((id, k) => {
        if (k > 0 && (ways[k][0] !== ways[k - 1][0] || ways[k][1] !== ways[k - 1][1])) {
          result.joints.push(cellOf(this.tiles[id]));
        }
      });
      train.forEach((id, k) => this.move(id, ways[k][0], ways[k][1], now, result));
      return true;
    }
    return false;
  }
}
