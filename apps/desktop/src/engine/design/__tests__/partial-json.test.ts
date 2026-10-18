import { describe, expect, it } from "vitest";
import { readPartialJson } from "../partial-json";

describe("streamed tool input JSON", () => {
  it("reads complete and still-streaming strings with their completion state", () => {
    const text = '{"file_path":"/w/Design/page-1/card.html","content":"<main>\\n  <h1>Hi';
    const { value, complete } = readPartialJson(text);
    expect(value).toEqual({
      file_path: "/w/Design/page-1/card.html",
      content: "<main>\n  <h1>Hi",
    });
    expect(complete.has("file_path")).toBe(true);
    expect(complete.has("content")).toBe(false);
  });

  it("never exposes a half-received key, escape or surrogate pair", () => {
    expect(readPartialJson('{"file_pa').value).toEqual({});
    expect(readPartialJson('{"file_path"').value).toEqual({});
    expect(readPartialJson('{"file_path":').value).toEqual({});
    expect(readPartialJson('{"content":"a\\').value).toEqual({ content: "a" });
    expect(readPartialJson('{"content":"a\\u00').value).toEqual({ content: "a" });
    expect(readPartialJson('{"content":"\\ud83d').value).toEqual({ content: "" });
    expect(readPartialJson('{"content":"\\ud83d\\ude00"}').value).toEqual({
      content: "😀",
    });
  });

  it("reads nested edit arrays and literals, marking each completed string", () => {
    const text =
      '{"file_path":"/a.html","replace_all":true,"edits":[{"old_string":"one","new_string":"two"},{"old_string":"three","new_string":"fo';
    const { value, complete } = readPartialJson(text);
    expect(value).toEqual({
      file_path: "/a.html",
      replace_all: true,
      edits: [
        { old_string: "one", new_string: "two" },
        { old_string: "three", new_string: "fo" },
      ],
    });
    expect(complete.has("edits.0.new_string")).toBe(true);
    expect(complete.has("edits.1.old_string")).toBe(true);
    expect(complete.has("edits.1.new_string")).toBe(false);
  });

  it("ignores partial literals and numbers until they are unambiguous", () => {
    expect(readPartialJson('{"replace_all":tr').value).toEqual({});
    expect(readPartialJson('{"limit":12').value).toEqual({});
    expect(readPartialJson('{"limit":12,').value).toEqual({ limit: 12 });
    expect(readPartialJson('{"a":null,"b":false}').value).toEqual({
      a: null,
      b: false,
    });
  });

  it("returns nothing useful for non-object or malformed input", () => {
    expect(readPartialJson("").value).toBeUndefined();
    expect(readPartialJson("[1,").value).toEqual([1]);
    expect(readPartialJson('{"a":"b"} trailing').value).toEqual({ a: "b" });
    expect(readPartialJson("{oops").value).toEqual({});
  });
});
