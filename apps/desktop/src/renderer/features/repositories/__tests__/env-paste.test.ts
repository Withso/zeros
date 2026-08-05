import { describe, expect, it } from "vitest";

import {
  envPasteAction,
  isPureEnvBlock,
  parseEnvBlock,
} from "../env-paste";

const pairsOf = (text: string) =>
  Object.fromEntries(parseEnvBlock(text).pairs.map((p) => [p.key, p.value]));

describe("parseEnvBlock", () => {
  it("extracts simple assignments", () => {
    expect(pairsOf("A=1\nB=2")).toEqual({ A: "1", B: "2" });
  });

  it("accepts export prefixes and spaces around =", () => {
    expect(pairsOf("export FOO=bar\n  BAZ = qux ")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("ignores comment lines, blank lines, and prose in between (.env paste)", () => {
    const text = [
      "# service credentials",
      "",
      "API_TOKEN=abc123",
      "these two lines are notes someone left",
      "in the middle of the file",
      "DEBUG=true",
    ].join("\n");
    expect(pairsOf(text)).toEqual({ API_TOKEN: "abc123", DEBUG: "true" });
  });

  it("only matches assignments at line starts", () => {
    // Mid-line `x=y` (prose, YAML-ish) is not an assignment.
    expect(pairsOf("set the value=high priority")).toEqual({});
    expect(pairsOf("A-B=x")).toEqual({}); // name shape breaks the whole line
    expect(pairsOf("FOO.BAR=x")).toEqual({}); // dotted keys aren't storable
  });

  it("strips surrounding quotes; \\n expands inside double quotes only", () => {
    expect(pairsOf('A="hello world"')).toEqual({ A: "hello world" });
    expect(pairsOf("B='single # not comment'")).toEqual({
      B: "single # not comment",
    });
    expect(pairsOf("C=`ticked`")).toEqual({ C: "ticked" });
    expect(pairsOf('D="line1\\nline2"')).toEqual({ D: "line1\nline2" });
    expect(pairsOf("E='line1\\nline2'")).toEqual({ E: "line1\\nline2" });
  });

  it("keeps a multi-line quoted value whole (PEM keys) — inner lines are not re-parsed", () => {
    const pem = 'KEY="-----BEGIN KEY-----\nINNER=looks_like_a_pair\n-----END KEY-----"';
    expect(pairsOf(pem)).toEqual({
      KEY: "-----BEGIN KEY-----\nINNER=looks_like_a_pair\n-----END KEY-----",
    });
  });

  it("tolerates trailing whitespace after a closing quote (copy artifact)", () => {
    expect(pairsOf('A="hello" ')).toEqual({ A: "hello" });
    // The multiline case is the dangerous one: without the trailing-space
    // allowance the quoted branch fails and a corrupting line parse leaks a
    // phantom INNER variable out of the key material.
    const pem = 'KEY="-----BEGIN-----\nINNER=abc\n-----END-----" ';
    expect(pairsOf(pem)).toEqual({
      KEY: "-----BEGIN-----\nINNER=abc\n-----END-----",
    });
  });

  it("strips a leading BOM so the first line's assignment still matches", () => {
    expect(pairsOf("\uFEFFFOO=bar\nBAZ=qux")).toEqual({
      FOO: "bar",
      BAZ: "qux",
    });
  });

  it("truncates unquoted values at an inline # comment and trims", () => {
    expect(pairsOf("A=value # comment")).toEqual({ A: "value" });
    expect(pairsOf("URL=http://x.test/#frag")).toEqual({
      URL: "http://x.test/",
    });
    expect(pairsOf('QUOTED="keeps # inside"')).toEqual({
      QUOTED: "keeps # inside",
    });
  });

  it("keeps an unbalanced quote as a literal value", () => {
    expect(pairsOf('A="unclosed')).toEqual({ A: '"unclosed' });
  });

  it("handles CRLF input", () => {
    expect(pairsOf("A=1\r\nB=2\r\n")).toEqual({ A: "1", B: "2" });
  });

  it("keeps empty values (FLAG=)", () => {
    expect(pairsOf("FLAG=")).toEqual({ FLAG: "" });
  });

  it("last value wins on a repeated name, keeping first position", () => {
    const { pairs } = parseEnvBlock("A=1\nB=2\nA=3");
    expect(pairs).toEqual([
      { key: "A", value: "3" },
      { key: "B", value: "2" },
    ]);
  });

  it("splits on the FIRST = so values may contain =", () => {
    expect(pairsOf("QUERY=a=b&c=d")).toEqual({ QUERY: "a=b&c=d" });
  });

  it("routes code-injection names to unsafe instead of pairs", () => {
    const { pairs, unsafe } = parseEnvBlock("NODE_OPTIONS=--inspect\nFOO=ok");
    expect(pairs).toEqual([{ key: "FOO", value: "ok" }]);
    expect(unsafe).toEqual(["NODE_OPTIONS"]);
  });
});

describe("isPureEnvBlock", () => {
  it("true for assignments plus comments/blank lines only", () => {
    expect(isPureEnvBlock("# creds\n\nFOO=bar")).toBe(true);
    expect(isPureEnvBlock("A=1\nB=2")).toBe(true);
  });

  it("false when prose sits between assignments, or nothing matches", () => {
    expect(isPureEnvBlock("some: yaml\nfoo=bar")).toBe(false);
    expect(isPureEnvBlock("just prose")).toBe(false);
    expect(isPureEnvBlock("")).toBe(false);
  });
});

describe("envPasteAction", () => {
  it("fills Name + Value from a single pasted assignment", () => {
    expect(envPasteAction("FOO=bar", "name")).toEqual({
      kind: "fill",
      key: "FOO",
      value: "bar",
    });
    expect(envPasteAction("export FOO=bar", "value")).toEqual({
      kind: "fill",
      key: "FOO",
      value: "bar",
    });
    expect(envPasteAction("FOO=", "block")).toEqual({
      kind: "fill",
      key: "FOO",
      value: "",
    });
  });

  it("goes bulk for multi-assignment pastes in any field", () => {
    const a = envPasteAction("A=1\nB=2", "value");
    expect(a.kind).toBe("bulk");
    if (a.kind === "bulk") expect(a.pairs).toHaveLength(2);
    expect(envPasteAction("A=1\nB=2", "name").kind).toBe("bulk");
    expect(envPasteAction("A=1\nB=2", "block").kind).toBe("bulk");
  });

  it("does NOT hijack the value field for base64-with-padding lookalikes", () => {
    expect(envPasteAction("dGVzdA==", "value").kind).toBe("none");
    expect(envPasteAction("Zm9vYmFy=", "value").kind).toBe("none");
    // …but a base64 chunk without = never parses as a pair anywhere.
    expect(envPasteAction("dGVzdA", "value").kind).toBe("none");
  });

  it("name/value fields take a single-pair block only when the text is purely an env block", () => {
    expect(envPasteAction("# comment\nFOO=bar", "value").kind).toBe("bulk");
    expect(envPasteAction("# comment\nFOO=bar", "name").kind).toBe("bulk");
    // A lone assignment buried in YAML/prose must not hijack either field.
    expect(envPasteAction("some: yaml\nfoo=bar\nmore: yaml", "value").kind).toBe(
      "none",
    );
    expect(envPasteAction("some: yaml\nfoo=bar\nmore: yaml", "name").kind).toBe(
      "none",
    );
  });

  it("reports unsafe names even when nothing is importable", () => {
    const a = envPasteAction("NODE_OPTIONS=--inspect", "block");
    expect(a.kind).toBe("none");
    expect(a.kind === "none" && a.unsafe).toEqual(["NODE_OPTIONS"]);
  });

  it("keeps importable pairs and reports unsafe ones alongside", () => {
    const a = envPasteAction("NODE_OPTIONS=x\nFOO=bar", "block");
    expect(a.kind).toBe("bulk");
    if (a.kind === "bulk") {
      expect(a.pairs).toEqual([{ key: "FOO", value: "bar" }]);
      expect(a.unsafe).toEqual(["NODE_OPTIONS"]);
    }
  });

  it("returns none for ordinary text", () => {
    expect(envPasteAction("hello world", "name").kind).toBe("none");
    expect(envPasteAction("", "block").kind).toBe("none");
  });
});
