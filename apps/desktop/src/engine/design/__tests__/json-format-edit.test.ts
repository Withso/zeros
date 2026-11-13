import { describe, expect, it } from "vitest";
import { editJsonPreservingFormat } from "../json-format-edit";

const BEFORE = `{
  "version": 2,
  "pages": [
    { "id": "p", "title": "Page", "frames": ["a", "b"], "folder": "page-1" }
  ],
  "frames": {
    "b": { "title": "B \\u2014 second", "x": 0, "width": 10 },
    "a": {
      "title": "A",
      "x": 0,
      "width": 10
    }
  }
}
`;
const edit = (change: (value: any) => void, before = BEFORE) => {
  const value = JSON.parse(before);
  change(value);
  return editJsonPreservingFormat(before, `${JSON.stringify(value, null, 2)}\n`);
};

describe("editing JSON while keeping its format", () => {
  it("rewrites only a changed value and keeps order, escapes and inline layout", () => {
    expect(edit((value) => (value.frames.a.x = 50))).toBe(BEFORE.replace('"x": 0,\n      "width"', '"x": 50,\n      "width"'));
    expect(edit((value) => (value.frames.b.width = 12))).toBe(BEFORE.replace('"width": 10 }', '"width": 12 }'));
  });

  it("appends a new member after the existing ones in the file's indentation and removes it again exactly", () => {
    const added = edit((value) => (value.foundation = { components: [{ id: "c" }] }));
    expect(added).toBe(`${BEFORE.slice(0, -3)},\n  "foundation": {\n    "components": [\n      {\n        "id": "c"\n      }\n    ]\n  }\n}\n`);
    expect(edit((value) => delete value.foundation, added)).toBe(BEFORE);
  });

  it("puts a member back where it was when the new order places it there", () => {
    const document = '{\n  "a": 1,\n  "b": { "x": 2 },\n  "c": 3\n}\n';
    const removed = edit((value) => delete value.b, document);
    expect(removed).toBe('{\n  "a": 1,\n  "c": 3\n}\n');
    expect(editJsonPreservingFormat(removed, '{"a":1,"b":{"x":2},"c":3}')).toBe('{\n  "a": 1,\n  "b": {\n    "x": 2\n  },\n  "c": 3\n}\n');
    expect(editJsonPreservingFormat('{\n  "a": 1,\n  "c": 3\n}\n', '{"a":1,"b":2,"c":3}')).toBe('{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n');
  });

  it("adds and removes array items without touching their neighbors", () => {
    const added = edit((value) => value.pages[0].frames.push("c"));
    expect(added).toBe(BEFORE.replace('["a", "b"]', '["a", "b", "c"]'));
    expect(edit((value) => value.pages[0].frames.pop(), added)).toBe(BEFORE);
    expect(edit((value) => value.pages[0].frames.shift())).toBe(BEFORE.replace('["a", "b"]', '["b"]'));
  });

  it("removes a member from either end of an object", () => {
    expect(edit((value) => delete value.version)).toBe(BEFORE.replace('  "version": 2,\n', ""));
    expect(edit((value) => delete value.frames.a)).toBe(BEFORE.replace(/,\n {4}"a": \{[^}]*\}/, ""));
  });

  it("finds members whose keys or strings hold escapes, quotes or backslashes", () => {
    const document = String.raw`{
  "a\"b": { "x": 1, "note": "say \"hi\" \\ there" },
  "c\\d": "va\"l\\",
  "\u0065": [1, "s\"]", "\\"],
  "z": 0
}
`;
    expect(edit((value) => {
      value['a"b'].x = 2;
      value.z = 5;
    }, document)).toBe(document.replace('"x": 1', '"x": 2').replace('"z": 0', '"z": 5'));
    expect(edit((value) => (value["c\\d"] = "new"), document)).toBe(document.replace(String.raw`"va\"l\\"`, '"new"'));
    expect(edit((value) => value.e.push(2), document)).toBe(document.replace(String.raw`"\\"]`, String.raw`"\\", 2]`));
    expect(edit((value) => delete value['a"b'], document)).toBe(document.replace(/ {2}"a\\"b".*\n/, ""));
  });

  it("follows the file's own indentation and CRLF line endings", () => {
    const tabs = '{\n\t"a": 1\n}\n';
    expect(edit((value) => (value.b = { c: 1 }), tabs)).toBe('{\n\t"a": 1,\n\t"b": {\n\t\t"c": 1\n\t}\n}\n');
    const crlf = '{\r\n    "a": 1,\r\n    "list": [\r\n        "x"\r\n    ]\r\n}\r\n';
    expect(edit((value) => (value.a = 2), crlf)).toBe(crlf.replace('"a": 1', '"a": 2'));
    const grown = edit((value) => {
      value.list.push("y");
      value.b = { c: 1 };
    }, crlf);
    expect(grown).toBe('{\r\n    "a": 1,\r\n    "list": [\r\n        "x",\r\n        "y"\r\n    ],\r\n    "b": {\r\n        "c": 1\r\n    }\r\n}\r\n');
    expect(grown).not.toMatch(/(^|[^\r])\n/);
    expect(edit((value) => {
      value.list.pop();
      delete value.b;
    }, grown)).toBe(crlf);
  });

  it("returns the given encoding when the existing text is not JSON or the edit cannot reproduce it", () => {
    expect(editJsonPreservingFormat("{ nope", '{"a":1}')).toBe('{"a":1}');
    expect(editJsonPreservingFormat('{"a":1,"a":2}', '{"a":3}')).toBe('{"a":3}');
    expect(editJsonPreservingFormat(BEFORE, `${JSON.stringify(JSON.parse(BEFORE), null, 2)}\n`)).toBe(BEFORE);
  });
});
