// The migration suite (migrations.test-suite.ts) replays the whole ladder in most of its tests, which made its single file the
// longest CI database shard by far. Each src/migrations-N.test.ts selects one part: it registers every MIGRATION_PARTS-th
// test of the ladder suite, in registration order, and part 1 also takes the other (short) suites whole, because vitest
// fails a suite that registers no test. vitest.sequencer.ts pins part N to database shard N.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it as vitestIt } from "vitest";

export const MIGRATION_PARTS = 8;
export const MIGRATION_PART_FILE = /(?:^|\/)src\/migrations-(\d+)\.test\.ts$/;

let selected: number | undefined;
let registered = 0;
let partitioning = false;

export function selectMigrationPart(part: number): void {
  if (!Number.isInteger(part) || part < 1 || part > MIGRATION_PARTS) {
    throw new Error(`Migration part ${part} is outside 1..${MIGRATION_PARTS}.`);
  }
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const parts = readdirSync(directory)
    .map((file) => MIGRATION_PART_FILE.exec(`src/${file}`)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  const expected = Array.from({ length: MIGRATION_PARTS }, (_, index) => index + 1);
  if (parts.join(",") !== expected.join(",")) {
    throw new Error(`Expected src/migrations-1..${MIGRATION_PARTS}.test.ts, found parts ${parts.join(", ") || "none"}.`);
  }
  selected = part;
}

function part(): number {
  if (selected === undefined) {
    throw new Error("Load migrations.test-suite.ts through a src/migrations-N.test.ts part.");
  }
  return selected;
}

function take(): boolean {
  const current = part();
  return !partitioning || registered++ % MIGRATION_PARTS === current - 1;
}

type Register = (...args: unknown[]) => unknown;

/** Wraps `describe`: its tests are shared out across the parts. Its factory must register them synchronously. */
export function partitioned<D>(base: D): D {
  return ((...args: unknown[]) => {
    const index = args.findIndex((arg) => typeof arg === "function");
    const factory = args[index] as () => unknown;
    args[index] = () => {
      partitioning = true;
      try {
        return factory();
      } finally {
        partitioning = false;
      }
    };
    return (base as Register)(...args);
  }) as D;
}

/** Wraps `describe`: the whole suite runs in part 1 only. */
export function firstPart<D>(base: D): D {
  return ((...args: unknown[]) => (part() === 1 ? (base as Register)(...args) : undefined)) as D;
}

/** vitest's `it` and `it.each`; inside a `partitioned` suite they register only this part's share. */
export function it(...args: Parameters<typeof vitestIt>): void {
  if (take()) vitestIt(...args);
}

it.each = <T>(cases: readonly T[]) => {
  const kept = cases.filter(() => take());
  type Each = (name: string, body: (...args: never[]) => unknown, timeout?: number) => void;
  if (kept.length === 0) return (() => undefined) as Each;
  return vitestIt.each(kept as T[]) as unknown as Each;
};
