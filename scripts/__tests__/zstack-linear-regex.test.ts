import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findSuperLinear, regexesIn, superLinear } from "../zstack/linear-regex.mjs";

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

  it("stops a catastrophic pattern instead of hanging", () => {
    expect(superLinear({ source: "(a+)+$", flags: "" })).toMatchObject({ unit: expect.any(String) });
  }, 60_000);

  it("keeps every expression in scripts/zstack linear", () => {
    const flagged = findSuperLinear(files).map(({ file, line, source, growth }) =>
      `${file.slice(dir.length + 1)}:${line} /${source}/ on ${JSON.stringify(growth.unit)}`);
    expect(flagged).toEqual([]);
  }, 180_000);
});
