import { describe, expect, it } from "vitest";

import { GLASS_COMBO_MS } from "../../shared/ui/loading/glass-combos";
import {
  GLASS_BEAT_MS,
  GLASS_CIRCUIT,
  GLASS_FIRST_STEP_MS,
  GLASS_MOTIONS,
  GLASS_MOVE_MS,
  GLASS_TILES,
  GlassFlow,
  glassCircuitPattern,
  glassCircuitTrains,
  glassFlowPattern,
  pickGlassMotion,
  type GlassMotion,
  type GlassMove,
} from "../../shared/ui/loading/glass-motion";
import { PUZZLE_CORNERS } from "../../shared/ui/loading/puzzle-motion";

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

const FRAME = 16;
const FLOWS = GLASS_MOTIONS;
const cellOf = (x: number, y: number) => y * 4 + x;

interface Flight extends GlassMove {
  at: number;
}

/** Drive a square frame by frame and record everything it does. */
function simulate(motion: GlassMotion, seed: number, durationMs: number) {
  const flow = new GlassFlow(motion, mulberry32(seed));
  const start = flow.tiles.map((tile) => cellOf(tile.x, tile.y));
  const flights: Flight[] = [];
  const joints: Array<{ cell: number; at: number }> = [];
  const swaps: Array<{ at: number; live: number }> = [];
  const frames: Array<{ at: number; cells: number[]; layers: number[] }> = [];
  flow.start(0);
  for (let now = 0; now <= durationMs; now += FRAME) {
    const step = flow.step(now);
    for (const move of step.moves) flights.push({ ...move, at: now });
    for (const cell of step.joints) joints.push({ cell, at: now });
    if (step.swapped) swaps.push({ at: now, live: flow.live });
    frames.push({
      at: now,
      cells: flow.tiles.map((tile) => cellOf(tile.x, tile.y)),
      layers: flow.tiles.map((tile) => tile.layer),
    });
  }
  return { flow, start, flights, joints, swaps, frames };
}

/** The steps, each a group of moves made on the same frame. */
function steps(flights: readonly Flight[]): Flight[][] {
  const byTime = new Map<number, Flight[]>();
  for (const flight of flights) byTime.set(flight.at, [...(byTime.get(flight.at) ?? []), flight]);
  return [...byTime.values()];
}

describe("the glass square's motions", () => {
  it("picks one of three at random", () => {
    expect(GLASS_MOTIONS).toEqual(["weave", "cascade", "circuit"]);
    const random = mulberry32(1);
    const picked = new Set(Array.from({ length: 200 }, () => pickGlassMotion(random)));
    expect([...picked].sort()).toEqual([...GLASS_MOTIONS].sort());
  });

  it("start the weave and cascade from an airy square with every corner filled", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const cells = glassFlowPattern(mulberry32(seed));
      expect(cells).toHaveLength(GLASS_TILES);
      expect(new Set(cells).size).toBe(GLASS_TILES);
      for (const corner of PUZZLE_CORNERS) expect(cells).toContain(corner);
      for (let i = 0; i < 4; i++) {
        const row = cells.filter((cell) => Math.floor(cell / 4) === i).length;
        const column = cells.filter((cell) => cell % 4 === i).length;
        // Every line holds one to three tiles, so every line visibly moves.
        expect(row).toBeGreaterThanOrEqual(1);
        expect(row).toBeLessThanOrEqual(3);
        expect(column).toBeGreaterThanOrEqual(1);
        expect(column).toBeLessThanOrEqual(3);
      }
    }
  });

  it("start the circuit as three to five short trains on its track", () => {
    // The track visits every cell once and each step is to a neighbour.
    expect(new Set(GLASS_CIRCUIT).size).toBe(16);
    GLASS_CIRCUIT.forEach((cell, i) => {
      const next = GLASS_CIRCUIT[(i + 1) % 16];
      expect(Math.abs((cell % 4) - (next % 4)) + Math.abs(Math.floor(cell / 4) - Math.floor(next / 4))).toBe(1);
    });
    for (let seed = 1; seed <= 60; seed++) {
      const cells = glassCircuitPattern(mulberry32(seed));
      expect(new Set(cells).size).toBe(GLASS_TILES);
      const trains = glassCircuitTrains(cells.map((cell) => GLASS_CIRCUIT.indexOf(cell)));
      expect(trains.length).toBeGreaterThanOrEqual(3);
      expect(trains.length).toBeLessThanOrEqual(5);
      for (const train of trains) expect(train.length).toBeLessThanOrEqual(4);
    }
  });
});

describe.each(FLOWS)("the %s", (motion) => {
  it("never stands still: a new glide starts before the last one lands", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { flights } = simulate(motion, seed, 12_000);
      const starts = [...new Set(flights.map((flight) => flight.at))];
      expect(starts[0]).toBeLessThanOrEqual(GLASS_FIRST_STEP_MS + FRAME);
      let longest = 0;
      for (let i = 1; i < starts.length; i++) longest = Math.max(longest, starts[i] - starts[i - 1]);
      // At most one frame between a glide ending and the next starting.
      expect(longest).toBeLessThanOrEqual(GLASS_MOVE_MS + FRAME);
      // A step at least every glide; the weave and circuit keep Stream's
      // pace (a step a beat), the cascade's lines cross, so each waits for
      // the last to land.
      expect(starts.length).toBeGreaterThan(12_000 / (GLASS_MOVE_MS + 2 * FRAME));
      if (motion !== "cascade") expect(starts.length).toBeGreaterThan(12_000 / (GLASS_BEAT_MS + 2 * FRAME));
    }
  });

  it("moves tiles a cell at a time, never onto one another or twice at once", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { flights, frames } = simulate(motion, seed, 8_000);
      for (const flight of flights) expect(Math.abs(flight.dx) + Math.abs(flight.dy)).toBe(1);
      for (const frame of frames) expect(new Set(frame.cells).size).toBe(GLASS_TILES);
      const last = new Map<number, number>();
      for (const flight of flights) {
        const before = last.get(flight.tile);
        if (before !== undefined) expect(flight.at - before).toBeGreaterThanOrEqual(GLASS_MOVE_MS);
        last.set(flight.tile, flight.at);
      }
    }
  });

  it("brings each new combo in with the moving tiles, never mid-flight", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { flights, swaps, frames } = simulate(motion, seed, 20_000);
      expect(swaps.length).toBeGreaterThanOrEqual(3);
      expect(swaps[0].at).toBeGreaterThanOrEqual(GLASS_COMBO_MS / 2);
      expect(swaps[0].at).toBeLessThanOrEqual(GLASS_COMBO_MS + FRAME);
      for (let i = 1; i < swaps.length; i++) expect(swaps[i].at - swaps[i - 1].at).toBeGreaterThanOrEqual(GLASS_COMBO_MS);
      for (const swap of swaps) {
        // Before a swap every tile showed the last combo, in flight or not…
        const before = frames.find((frame) => frame.at === swap.at - FRAME);
        expect(before?.layers.every((layer) => layer !== swap.live)).toBe(true);
        const flying = flights.filter((flight) => flight.at > swap.at - GLASS_MOVE_MS && flight.at < swap.at);
        for (const flight of flying) expect(flight.fromLayer).not.toBe(swap.live);
        // …and within a few seconds every tile shows the new one.
        const settled = frames.find((frame) => frame.at >= swap.at + 3_000);
        if (settled && settled.at < swap.at + GLASS_COMBO_MS) {
          expect(settled.layers.every((layer) => layer === swap.live)).toBe(true);
        }
      }
      for (const flight of flights) {
        if (motion === "weave") {
          // The weave takes new colour in only at the edges.
          if (!flight.wraps) expect(flight.toLayer).toBe(flight.fromLayer);
        } else {
          expect(flight.toLayer).toBe(flight.fromLayer);
        }
      }
    }
  });
});

describe("the weave", () => {
  it("ripples down the rows like Stream, neighbouring rows running opposite ways", () => {
    const { flights, frames, start } = simulate("weave", 3, 6_000);
    const byStep = steps(flights);
    byStep.forEach((step, i) => {
      const rows = new Set(step.map((flight) => flight.from.y));
      expect(rows.size).toBe(1);
      expect([...rows][0]).toBe(i % 4);
      expect(new Set(step.map((flight) => flight.dx)).size).toBe(1);
      expect(step.every((flight) => flight.dy === 0)).toBe(true);
    });
    const way = (row: number) => byStep.find((step) => step[0].from.y === row)?.[0].dx;
    expect(way(0)).toBe(-(way(1) ?? 0));
    expect(way(1)).toBe(-(way(2) ?? 0));
    expect(way(2)).toBe(-(way(3) ?? 0));
    // Tiles keep their rows, and a full lap looks like none.
    const rowsAtStart = start.map((cell) => Math.floor(cell / 4));
    for (const frame of frames) expect(frame.cells.map((cell) => Math.floor(cell / 4))).toEqual(rowsAtStart);
    const lap = byStep[15];
    const afterLap = frames.find((frame) => frame.at === lap[0].at);
    expect(afterLap?.cells).toEqual(start);
  });
});

describe("the cascade", () => {
  it("runs rows right and columns down, a whole line at a time", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { flights, frames } = simulate("cascade", seed, 6_000);
      for (const step of steps(flights)) {
        const across = step[0].dy === 0;
        for (const flight of step) {
          expect([flight.dx, flight.dy]).toEqual(across ? [1, 0] : [0, 1]);
        }
        const index = across ? step[0].from.y : step[0].from.x;
        const line = step.map((flight) => (across ? flight.from.y : flight.from.x));
        expect(new Set(line)).toEqual(new Set([index]));
        // The whole line moved: every tile that was in it.
        const before = frames.find((frame) => frame.at === step[0].at - FRAME);
        if (before) {
          const inLine = before.cells.filter((cell) => (across ? Math.floor(cell / 4) : cell % 4) === index).length;
          expect(step).toHaveLength(inLine);
          expect(inLine).toBeGreaterThan(0);
          expect(inLine).toBeLessThan(4);
        }
      }
    }
  });
});

describe("the circuit", () => {
  it("runs its trains along the track, holding the corners they bend round", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { flights, joints } = simulate("circuit", seed, 8_000);
      for (const flight of flights) {
        const from = cellOf(flight.from.x, flight.from.y);
        const to = cellOf(flight.from.x + flight.dx, flight.from.y + flight.dy);
        expect(flight.wraps).toBe(false);
        expect(GLASS_CIRCUIT[(GLASS_CIRCUIT.indexOf(from) + 1) % 16]).toBe(to);
      }
      expect(joints.length).toBeGreaterThan(0);
      for (const joint of joints) {
        const i = GLASS_CIRCUIT.indexOf(joint.cell);
        const before = GLASS_CIRCUIT[(i + 15) % 16];
        const after = GLASS_CIRCUIT[(i + 1) % 16];
        // A joint sits where the track turns.
        expect(joint.cell - before).not.toBe(after - joint.cell);
      }
    }
  });
});
