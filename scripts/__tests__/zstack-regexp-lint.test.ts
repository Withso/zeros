import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd(), cache: false });
const regexpRules = async (code: string, filePath: string) => {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((message) => message.ruleId?.startsWith("regexp/")).map((message) => message.ruleId);
};

// Patterns that reached main or #790's review and that static analysis can
// see: their slow part starts at the match position or backtracks.
const STATIC = [
  { at: "e615da6f scripts/zstack/transcript.mjs:54", code: `export const key = (s) => s.replace(/["' ]+$/, "");\n` },
  { at: "c156d14e scripts/zstack/comments.mjs:82", code: `export const trim = (s) => s.replace(/ +$/, "");\n` },
  { at: "c156d14e scripts/zstack/history.mjs:120", code: String.raw`export const cases = (s) => /(?:^|\n)\s*Cases:([\s\S]*)$/.exec(s);` + "\n" },
  { at: "c156d14e scripts/zstack/render.mjs:24", code: String.raw`export const field = (s) => /^([a-z]+):\s*(.*)$/.exec(s);` + "\n" },
];

describe("zstack regexp lint", () => {
  it("reports each statically visible slow pattern under scripts/zstack", async () => {
    for (const { at, code } of STATIC)
      expect(await regexpRules(code, "scripts/zstack/fixture.mjs"), at).not.toEqual([]);
  });

  it("is scoped to scripts/zstack", async () => {
    expect(await regexpRules(STATIC[1].code, "scripts/other/fixture.mjs")).toEqual([]);
  });

  it("finds nothing in the current zstack scripts", async () => {
    const results = await eslint.lintFiles(["scripts/zstack"]);
    expect(results.flatMap((result) => result.messages.filter((message) => message.ruleId?.startsWith("regexp/"))
      .map((message) => `${result.filePath}:${message.line} ${message.ruleId}`))).toEqual([]);
  });
});
