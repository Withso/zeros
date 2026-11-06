import { describe, expect, it } from "vitest";
import {
  parseMergeConflicts,
  applyConflictChoices,
  conflictReplacement,
} from "../merge-conflicts";

describe("merge conflict previews", () => {
  const source =
    "prefix\n<<<<<<< HEAD\nours\n||||||| ancestor\nbase\n=======\ntheirs\n>>>>>>> topic\nsuffix\n";
  it("parses diff3 labels and previews each choice without touching other bytes", () => {
    const parsed = parseMergeConflicts(source);
    expect(parsed.errors).toEqual([]);
    expect(parsed.conflicts).toHaveLength(1);
    const conflict = parsed.conflicts[0];
    expect(conflict).toMatchObject({
      current: "ours\n",
      base: "base\n",
      incoming: "theirs\n",
      currentLabel: "HEAD",
      incomingLabel: "topic",
      startLine: 2,
      baseLine: 4,
      separatorLine: 6,
      endLine: 8,
    });
    for (const [choice, expected] of [
      ["current", "ours\n"],
      ["incoming", "theirs\n"],
      ["both", "ours\ntheirs\n"],
    ] as const) {
      expect(applyConflictChoices(source, { [conflict.id]: choice })).toEqual({
        content: `prefix\n${expected}suffix\n`,
        remaining: 0,
      });
    }
    expect(source).toContain("||||||| ancestor");
  });
  it("keeps unresolved blocks verbatim and resolves multiple blocks independently", () => {
    const second = "<<<<<<< current\nA\n=======\nB\n>>>>>>> incoming\n";
    const full = source + second;
    const blocks = parseMergeConflicts(full).conflicts;
    expect(applyConflictChoices(full, { [blocks[0].id]: "incoming" })).toEqual({
      content: "prefix\ntheirs\nsuffix\n" + second,
      remaining: 1,
    });
    expect(
      applyConflictChoices(full, {
        [blocks[0].id]: "current",
        [blocks[1].id]: "both",
      }).content,
    ).toBe("prefix\nours\nsuffix\nA\nB\n");
  });
  it("preserves CRLF, Unicode, empty sides, variable marker widths and no final newline", () => {
    const crlf =
      "α\r\n<<<<<<<<<< left\r\n=======oops\r\n==========\r\nβ\r\n>>>>>>>>>> right";
    const block = parseMergeConflicts(crlf).conflicts[0];
    expect(block.current).toBe("=======oops\r\n");
    expect(applyConflictChoices(crlf, { [block.id]: "incoming" }).content).toBe(
      "α\r\nβ",
    );
    const empty = "<<<<<<< left\n=======\nright\n>>>>>>> incoming\n";
    const id = parseMergeConflicts(empty).conflicts[0].id;
    expect(applyConflictChoices(empty, { [id]: "current" }).content).toBe("");
  });
  it.each([
    "<<<<<<< ours\na\n=======\nb\n",
    "<<<<<<< ours\n<<<<<<< nested\na\n=======\nb\n>>>>>>> theirs\n",
    "<<<<<<< ours\na\n||||||| base\nb\n>>>>>>> theirs\n",
    "<<<<<<< ours\na\n========\nb\n>>>>>>> theirs\n",
  ])(
    "refuses malformed or nested markers without producing a savable preview",
    (bad) => {
      expect(parseMergeConflicts(bad).errors.length).toBeGreaterThan(0);
      expect(() => applyConflictChoices(bad, {})).toThrow();
    },
  );
  it("replaces one block in place, keeping a last block's missing newline", () => {
    const tail = "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic";
    const [block] = parseMergeConflicts(tail).conflicts;
    expect(block).toMatchObject({ separatorLine: 4, endLine: 6 });
    expect(block.baseLine).toBeUndefined();
    expect(conflictReplacement(tail, block, "incoming")).toBe("theirs");
    expect(conflictReplacement(tail, block, "both")).toBe("ours\ntheirs");
    const [first] = parseMergeConflicts(source).conflicts;
    expect(conflictReplacement(source, first, "current")).toBe("ours\n");
    expect(() =>
      conflictReplacement(source, first, "neither" as never),
    ).toThrow("Invalid conflict choice.");
  });
  it.each([
    ["<<<<<<< ours\na\n=======\nb\n", "Line 1 has no separator or closing marker."],
    ["<<<<<<< ours\n<<<<<<< nested\na\n=======\nb\n>>>>>>> theirs\n", "Line 2 opens a conflict inside another."],
    ["a\n>>>>>>> theirs\n", "Line 2 has a conflict marker outside any conflict."],
    ["<<<<<<< ours\na\n========\nb\n>>>>>>> theirs\n", "Line 3 has a marker of a different length."],
    ["<<<<<<< ours\na\n>>>>>>> theirs\n=======\n", "Line 3 has conflict markers out of order."],
  ])("names the line of a marker it cannot pair", (bad, message) => {
    expect(parseMergeConflicts(bad).errors[0]?.message).toBe(message);
  });
  it("rejects choices from another content snapshot", () => {
    expect(() =>
      applyConflictChoices(source, { "unknown-block": "both" }),
    ).toThrow();
  });
});
