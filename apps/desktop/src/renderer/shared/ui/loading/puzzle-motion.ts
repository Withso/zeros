// ──────────────────────────────────────────────────────────
// Puzzle motion — the agent loader's sliding-tile model
// ──────────────────────────────────────────────────────────
//
// A 4 × 4 square of tiles with six holes. The four corner tiles never move,
// so every arrangement still reads as a square; the other tiles live in the
// plus-shaped channel between them.
//
// Three "hands" work the square at once, each on its own loose clock (a move
// every 300–460ms), so two or three tiles are usually gliding. A hand owns one
// hole and walks it in short runs of 2–4 moves: each move pulls the
// neighbouring tile into the hole or, now and then, pushes two tiles in a line
// like a real 15-puzzle, and a hand never steps straight back the way it came.
//
// Every cell a move passes through is reserved until that move has landed
// (plus a grace period for the transition's slow tail), so tiles never cross,
// collide or chase each other. The model is pure: it only reports which tile
// moves where; the component turns that into transforms.
//
// A seed fixes the starting square (a workspace keeps its own square across
// launches); without one every board starts somewhere new. The board keeps
// its arrangement between start() calls, so stopping and resuming the hands
// carries on from wherever the tiles came to rest, and restore() lays out an
// arrangement an earlier board left behind.
// ──────────────────────────────────────────────────────────

import { LOADER_GRID as N } from "./loader-frame";

export const PUZZLE_CELLS = N * N;
/** The anchors: always filled, never moved. */
export const PUZZLE_CORNERS: readonly number[] = [0, N - 1, N * (N - 1), N * N - 1];
/** Cells that start empty — half the channel, an airy square. */
export const PUZZLE_HOLES = 6;
export const PUZZLE_HANDS = 3;
/** How long one slide takes. */
export const PUZZLE_MOVE_MS = 240;
/** Each hand waits a random beat in this range between its moves. */
export const PUZZLE_BEAT_MS: readonly [number, number] = [300, 460];
/** Chance a hand pushes two tiles in a line instead of pulling one. */
export const PUZZLE_PUSH_TWO = 0.3;
/** A reservation outlives its move by this much. */
export const PUZZLE_RESERVE_GRACE_MS = 80;
/** The first hand's wait after start: about a frame. */
export const PUZZLE_FIRST_MOVE_MS = 20;

const CHANNEL: readonly number[] = Array.from({ length: PUZZLE_CELLS }, (_, i) => i).filter(
  (i) => !PUZZLE_CORNERS.includes(i),
);
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** One tile's move: the tile (by id), where it leaves and lands, and which
 *  hand made it. */
export interface PuzzleMove {
  tile: number;
  from: number;
  to: number;
  hand: number;
}

interface Hand {
  hole: number | null;
  runLeft: number;
  /** The move that would undo this hand's last one: pulling from `cell` into
   *  `hole`. Keyed by the hole, so it holds however the hand re-picks. */
  back: { hole: number; cell: number } | null;
  next: number;
}

/** A seeded PRNG (cyrb128 → sfc32): the same seed always draws the same
 *  starting square. */
export function seededRandom(seed: string): () => number {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  let a = h1 >>> 0;
  let b = h2 >>> 0;
  let c = h3 >>> 0;
  let d = h4 >>> 0;
  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

function stepFrom(cell: number, [dx, dy]: readonly [number, number]): number | null {
  const x = (cell % N) + dx;
  const y = Math.floor(cell / N) + dy;
  return x < 0 || y < 0 || x >= N || y >= N ? null : y * N + x;
}

export class PuzzleBoard {
  /** tile id → the cell it sits in. */
  readonly cellOf: number[] = [];
  /** cell → the tile id in it, or -1 for a hole. */
  private readonly tileAt: number[] = new Array(PUZZLE_CELLS).fill(-1);
  private readonly holes = new Set<number>();
  private readonly busyUntil: number[] = new Array(PUZZLE_CELLS).fill(0);
  private readonly hands: Hand[] = [];

  /** `start` draws the starting square; `random` drives the hands. */
  constructor(start: () => number = Math.random, private readonly random: () => number = Math.random) {
    const channel = CHANNEL.slice();
    for (let i = channel.length - 1; i > 0; i--) {
      const j = Math.floor(start() * (i + 1));
      [channel[i], channel[j]] = [channel[j], channel[i]];
    }
    channel.slice(0, PUZZLE_HOLES).forEach((cell) => this.holes.add(cell));
    for (let cell = 0; cell < PUZZLE_CELLS; cell++) {
      if (this.holes.has(cell)) continue;
      this.tileAt[cell] = this.cellOf.length;
      this.cellOf.push(cell);
    }
  }

  /** Lay the tiles out as `cells` (tile id → cell), such as where an earlier
   *  board of the same square came to rest. Anything that is not a complete,
   *  corner-anchored arrangement is ignored. */
  restore(cells: readonly number[]): void {
    const valid =
      cells.length === this.cellOf.length &&
      new Set(cells).size === cells.length &&
      cells.every((cell) => Number.isInteger(cell) && cell >= 0 && cell < PUZZLE_CELLS) &&
      PUZZLE_CORNERS.every((corner) => cells.includes(corner));
    if (!valid) return;
    this.tileAt.fill(-1);
    this.busyUntil.fill(0);
    this.holes.clear();
    cells.forEach((cell, tile) => {
      this.cellOf[tile] = cell;
      this.tileAt[cell] = tile;
    });
    for (let cell = 0; cell < PUZZLE_CELLS; cell++) if (this.tileAt[cell] < 0) this.holes.add(cell);
    this.hands.length = 0;
  }

  /** Arm the hands, staggered so they never fall into lockstep. The first
   *  hand moves a frame after start (once the tiles have painted, so its
   *  slide still glides), so a loader is visibly working the moment it
   *  appears. Calling it again resumes from the current arrangement. */
  start(now: number): void {
    this.hands.length = 0;
    for (let i = 0; i < PUZZLE_HANDS; i++) {
      const stagger = i === 0 ? 0 : i * 120 + this.random() * 60;
      this.hands.push({ hole: null, runLeft: 0, back: null, next: now + PUZZLE_FIRST_MOVE_MS + stagger });
    }
  }

  /** Run every hand that is due at `now`; returns the tile moves to draw. */
  step(now: number): PuzzleMove[] {
    const moves: PuzzleMove[] = [];
    this.hands.forEach((hand, index) => {
      if (now < hand.next) return;
      this.slide(hand, index, now, moves);
      const [lo, hi] = PUZZLE_BEAT_MS;
      hand.next = now + lo + this.random() * (hi - lo);
    });
    return moves;
  }

  private isBusy(cell: number, now: number): boolean {
    return this.busyUntil[cell] > now;
  }

  private movable(cell: number | null, now: number): cell is number {
    return cell !== null && this.tileAt[cell] >= 0 && !PUZZLE_CORNERS.includes(cell) && !this.isBusy(cell, now);
  }

  private slide(hand: Hand, index: number, now: number, moves: PuzzleMove[]): void {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (hand.hole === null || hand.runLeft <= 0 || !this.holes.has(hand.hole) || this.isBusy(hand.hole, now)) {
        const free = [...this.holes].filter(
          (hole) => !this.isBusy(hole, now) && !this.hands.some((other) => other !== hand && other.hole === hole),
        );
        if (!free.length) return;
        hand.hole = free[Math.floor(this.random() * free.length)];
        hand.runLeft = 2 + Math.floor(this.random() * 3);
      }
      const hole = hand.hole;
      const lines: number[][] = [];
      for (const direction of DIRECTIONS) {
        const first = stepFrom(hole, direction);
        if (!this.movable(first, now)) continue;
        if (hand.back && hand.back.hole === hole && hand.back.cell === first) continue;
        const second = stepFrom(first, direction);
        lines.push(this.movable(second, now) && this.random() < PUZZLE_PUSH_TWO ? [first, second] : [first]);
      }
      if (!lines.length) {
        hand.runLeft = 0;
        continue;
      }
      // Tiles in the line all shift one cell toward the hole, together.
      const line = lines[Math.floor(this.random() * lines.length)];
      const targets = [hole, ...line.slice(0, -1)];
      const reservedUntil = now + PUZZLE_MOVE_MS + PUZZLE_RESERVE_GRACE_MS;
      [hole, ...line].forEach((cell) => { this.busyUntil[cell] = reservedUntil; });
      const tiles = line.map((cell) => this.tileAt[cell]);
      line.forEach((cell) => { this.tileAt[cell] = -1; });
      tiles.forEach((tile, k) => {
        const to = targets[k];
        this.tileAt[to] = tile;
        moves.push({ tile, from: this.cellOf[tile], to, hand: index });
        this.cellOf[tile] = to;
      });
      this.holes.delete(hole);
      this.holes.add(line[line.length - 1]);
      hand.hole = line[line.length - 1];
      hand.back = { hole: hand.hole, cell: targets[targets.length - 1] };
      hand.runLeft -= 1;
      return;
    }
  }
}
