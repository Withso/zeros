import { describe, expect, it } from "vitest";

import {
  PUZZLE_CELLS,
  PUZZLE_CORNERS,
  PUZZLE_HOLES,
  PUZZLE_MOVE_MS,
  PUZZLE_RESERVE_GRACE_MS,
  PuzzleBoard,
  seededRandom,
  type PuzzleMove,
} from "../../shared/ui/loading/puzzle-motion";

/** Deterministic PRNG so a failing run can be replayed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Flight extends PuzzleMove {
  at: number;
}

/** Drive a board frame by frame (16ms) and record every move it makes. */
function simulate(seed: number, durationMs: number) {
  const rng = mulberry32(seed);
  const board = new PuzzleBoard(rng, rng);
  const flights: Flight[] = [];
  const snapshots: number[][] = [];
  board.start(0);
  for (let now = 0; now <= durationMs; now += 16) {
    for (const move of board.step(now)) flights.push({ ...move, at: now });
    snapshots.push(board.cellOf.slice());
  }
  return { board, flights, snapshots };
}

const adjacent = (a: number, b: number) => {
  const dx = Math.abs((a % 4) - (b % 4));
  const dy = Math.abs(Math.floor(a / 4) - Math.floor(b / 4));
  return dx + dy === 1;
};

describe("agent puzzle motion", () => {
  it("starts as an airy square with every corner filled", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const board = new PuzzleBoard(mulberry32(seed));
      expect(board.cellOf).toHaveLength(PUZZLE_CELLS - PUZZLE_HOLES);
      expect(new Set(board.cellOf).size).toBe(board.cellOf.length);
      for (const corner of PUZZLE_CORNERS) expect(board.cellOf).toContain(corner);
    }
  });

  it("draws the same starting square for the same seed", () => {
    const start = (seed: string) => new PuzzleBoard(seededRandom(seed)).cellOf.join(",");
    expect(start("zeros/zeros/palembang")).toBe(start("zeros/zeros/palembang"));
    // A workspace's square is its identity across launches (and matches
    // styles/Artifacts/loaders-preview.html): pin the hash and the shuffle.
    expect(start("zeros/zeros/palembang")).toBe("0,1,3,6,7,11,12,13,14,15");
    expect(start("zeros/zeros/boston")).toBe("0,1,3,5,6,8,10,12,14,15");
    const squares = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => start(`zeros/${id}`)));
    expect(squares.size).toBeGreaterThan(5);
  });

  it("resumes from where the tiles came to rest", () => {
    const rng = mulberry32(5);
    const board = new PuzzleBoard(rng, rng);
    board.start(0);
    for (let now = 0; now < 3000; now += 16) board.step(now);
    const rested = board.cellOf.slice();
    board.start(10_000);
    expect(board.cellOf).toEqual(rested);
    let moved = false;
    for (let now = 10_000; now < 12_000 && !moved; now += 16) moved = board.step(now).length > 0;
    expect(moved).toBe(true);
  });

  it("lays out an arrangement an earlier board rested in, and keeps playing fair from it", () => {
    const rng = mulberry32(8);
    const earlier = new PuzzleBoard(rng, rng);
    earlier.start(0);
    for (let now = 0; now < 4000; now += 16) earlier.step(now);
    const rested = earlier.cellOf.slice();

    const later = new PuzzleBoard(seededRandom("zeros/zeros/kyoto"), rng);
    later.restore(rested);
    expect(later.cellOf).toEqual(rested);
    later.start(0);
    for (let now = 0; now < 8000; now += 16) {
      for (const move of later.step(now)) {
        expect(PUZZLE_CORNERS).not.toContain(move.from);
        expect(Math.abs(move.to - move.from) === 1 || Math.abs(move.to - move.from) === 4).toBe(true);
      }
      expect(new Set(later.cellOf).size).toBe(later.cellOf.length);
    }
  });

  it("ignores an arrangement that isn't a whole, corner-anchored square", () => {
    const start = new PuzzleBoard(seededRandom("zeros/zeros/oslo")).cellOf.slice();
    const hole = Array.from({ length: PUZZLE_CELLS }, (_, cell) => cell).find((cell) => !start.includes(cell));
    for (const broken of [
      start.slice(1),
      start.map((cell, tile) => (tile === 1 ? start[2] : cell)),
      start.map((cell) => (cell === 0 ? hole! : cell)),
      start.map((cell, tile) => (tile === 1 ? PUZZLE_CELLS : cell)),
      start.map((cell, tile) => (tile === 1 ? 1.5 : cell)),
    ]) {
      const board = new PuzzleBoard(seededRandom("zeros/zeros/oslo"));
      board.restore(broken);
      expect(board.cellOf).toEqual(start);
    }
  });

  it("moves its first tile at once, so a loader never sits still after a send", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const board = new PuzzleBoard(mulberry32(seed), mulberry32(seed + 100));
      board.start(1_000);
      let first: number | null = null;
      for (let now = 1_000; now <= 1_200 && first === null; now += 16) {
        if (board.step(now).length > 0) first = now - 1_000;
      }
      // Within two frames: one to commit the tiles, one to glide.
      expect(first).not.toBeNull();
      expect(first!).toBeLessThanOrEqual(32);
    }
  });

  it("starts each mount from its own random square", () => {
    const starts = new Set(
      Array.from({ length: 40 }, (_, seed) =>
        new PuzzleBoard(mulberry32(seed + 1)).cellOf.slice().sort((a, b) => a - b).join(","),
      ),
    );
    expect(starts.size).toBeGreaterThan(30);
  });

  it("never moves a corner, stacks two tiles, or leaves the grid", () => {
    for (const seed of [3, 17, 91]) {
      const { snapshots, flights } = simulate(seed, 20_000);
      expect(flights.length).toBeGreaterThan(100);
      for (const cells of snapshots) {
        expect(new Set(cells).size).toBe(cells.length);
        for (const corner of PUZZLE_CORNERS) expect(cells).toContain(corner);
        for (const cell of cells) expect(cell >= 0 && cell < PUZZLE_CELLS).toBe(true);
      }
      for (const move of flights) {
        expect(PUZZLE_CORNERS).not.toContain(move.from);
        expect(adjacent(move.from, move.to)).toBe(true);
      }
    }
  });

  it("keeps moves in flight on separate cells until they land", () => {
    const window = PUZZLE_MOVE_MS + PUZZLE_RESERVE_GRACE_MS;
    const { flights } = simulate(7, 20_000);
    for (let i = 0; i < flights.length; i++) {
      for (let j = i + 1; j < flights.length && flights[j].at - flights[i].at < window; j++) {
        // Moves launched together are one push: the second tile steps into
        // the cell the first one is leaving, in the same direction.
        if (flights[j].at === flights[i].at && flights[j].to === flights[i].from) continue;
        const a = [flights[i].from, flights[i].to];
        const b = [flights[j].from, flights[j].to];
        expect(a.some((cell) => b.includes(cell))).toBe(false);
      }
    }
  });

  it("keeps two or three tiles moving at once", () => {
    const { flights } = simulate(11, 20_000);
    let overlapping = 0;
    for (let i = 0; i < flights.length; i++) {
      const concurrent = flights.filter(
        (other) => Math.abs(other.at - flights[i].at) < PUZZLE_MOVE_MS && other.tile !== flights[i].tile,
      ).length;
      if (concurrent >= 1) overlapping++;
    }
    expect(overlapping / flights.length).toBeGreaterThan(0.6);
  });

  it("never has a hand slide a tile straight back the way it came", () => {
    const { flights } = simulate(29, 20_000);
    const lastByHand = new Map<number, Flight[]>();
    for (const move of flights) {
      const previous = lastByHand.get(move.hand) ?? [];
      const launched = flights.filter((other) => other.hand === move.hand && other.at === move.at);
      if (previous.length && previous[0].at !== move.at) {
        const undone = previous.some((last) => last.tile === move.tile && last.from === move.to && last.to === move.from);
        expect(undone).toBe(false);
      }
      if (!previous.length || previous[0].at !== move.at) lastByHand.set(move.hand, launched);
    }
  });
});
