import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BASE_SIZE, findSuperLinear, regexesIn, superLinear } from "../zstack/linear-regex.mjs";

const dir = join(process.cwd(), "scripts/zstack");
const files = readdirSync(dir).filter((name) => name.endsWith(".mjs")).map((name) => join(dir, name));

// Super-linear expressions that reached #790's review or main, with the
// revision and line that held each one.
const ESCAPED = [
  { at: "d32b9784 scripts/zstack/transcript.mjs:33", flags: "g",
    source: String.raw`\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}` },
  { at: "d32b9784 scripts/zstack/transcript.mjs:24", flags: "g",
    source: String.raw`\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}` },
  { at: "3c8c0a54 scripts/zstack/transcript.mjs:33", flags: "g",
    source: String.raw`(\bcurl\b[^\n|;&]*?\s-u\s*)("[^"]*"|'[^']*'|[^\s"'` + "`" + String.raw`]+)` },
  { at: "e615da6f scripts/zstack/transcript.mjs:54", flags: "", source: `["' ]+$` },
  { at: "c156d14e scripts/zstack/comments.mjs:82", flags: "", source: " +$" },
  { at: "c156d14e scripts/zstack/history.mjs:120", flags: "", source: String.raw`(?:^|\n)\s*Cases:([\s\S]*)$` },
];

function noisyMeasurements(quadratic: boolean, noise: "base" | "large", positions = [0, 1, 2]) {
  const samples = new Map<string, { base: number; large: number }>();
  let outliers = 0;
  const measure = vi.fn((_source: string, _flags: string, input: string) => {
    const shape = input.slice(0, BASE_SIZE);
    const count = samples.get(shape) ?? { base: 0, large: 0 };
    samples.set(shape, count);
    const size = input.length === BASE_SIZE + 1 ? "base" : "large";
    const sample = count[size]++;
    const duration = size === "base" ? 4 : quadratic && input.startsWith("\n") ? 64 : 16;
    if (size === noise && positions.includes(sample)) {
      outliers++;
      return duration + 500;
    }
    return duration;
  });
  return { measure, samples, outliers: () => outliers };
}

describe("zstack linear regular expressions", () => {
  it("finds literal and constructed expressions with their lines", () => {
    const text = 'const a = /x+y/g;\nconst b = new RegExp("a+$", "m");\nconst c = new RegExp(`${a}`);\n';
    expect(regexesIn(text, "x.mjs")).toEqual([
      { file: "x.mjs", line: 1, source: "x+y", flags: "g" },
      { file: "x.mjs", line: 2, source: "a+$", flags: "m" },
    ]);
  });

  it("flags every super-linear expression that reached review or main", () => {
    for (const regex of ESCAPED) expect(superLinear(regex), regex.at).not.toBeNull();
  }, 180_000);

  it("detects escaped growth despite three noisy baseline measurements", () => {
    const timing = noisyMeasurements(true, "base");
    expect(superLinear(ESCAPED[5], BASE_SIZE, timing.measure)).toMatchObject({ unit: "\n" });
    expect(timing.outliers()).toBeGreaterThanOrEqual(3);
    for (const count of timing.samples.values()) {
      expect(count.base).toBeLessThanOrEqual(7);
      expect(count.large).toBeLessThanOrEqual(7);
    }
  });

  it("ignores three noisy large measurements of a linear scan", () => {
    const timing = noisyMeasurements(false, "large");
    expect(superLinear({ source: "^a+$", flags: "" }, BASE_SIZE, timing.measure)).toBeNull();
    expect(timing.outliers()).toBeGreaterThanOrEqual(3);
    for (const count of timing.samples.values()) {
      expect(count.base).toBeLessThanOrEqual(7);
      expect(count.large).toBeLessThanOrEqual(7);
    }
  });

  it("keeps the decision for every placement of up to three timing outliers", () => {
    for (let mask = 0; mask < 128; mask++) {
      const positions = Array.from({ length: 7 }, (_, index) => index).filter((index) => mask & (1 << index));
      if (positions.length > 3) continue;
      for (const quadratic of [false, true]) {
        const timing = noisyMeasurements(quadratic, quadratic ? "base" : "large", positions);
        const result = superLinear(ESCAPED[5], BASE_SIZE, timing.measure);
        expect(result !== null, `${quadratic ? "quadratic" : "linear"}: ${positions}`).toBe(quadratic);
        for (const count of timing.samples.values()) {
          expect(count.base).toBeLessThanOrEqual(7);
          expect(count.large).toBeLessThanOrEqual(7);
        }
      }
    }
  });

  it("rejects a timed-out scan without taking more measurements", () => {
    const measure = vi.fn(() => Infinity);
    expect(superLinear({ source: "(a+)+$", flags: "" }, BASE_SIZE, measure)).not.toBeNull();
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it("stops a catastrophic pattern instead of hanging", () => {
    expect(superLinear({ source: "(a+)+$", flags: "" })).toMatchObject({ unit: expect.any(String) });
  }, 60_000);

  it("keeps every expression in scripts/zstack linear", () => {
    const flagged = findSuperLinear(files).map(({ file, line, source, growth }) =>
      `${file.slice(dir.length + 1)}:${line} /${source}/ on ${JSON.stringify(growth.unit)}`);
    expect(flagged).toEqual([]);
  }, 180_000);
});
