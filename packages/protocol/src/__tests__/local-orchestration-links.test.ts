import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  extractLocalLinks,
  formatParsedLocalLink,
  formatWorkspaceLink,
  parseLocalLink,
  workspaceNumberLabel,
} from "../local-orchestration";

it("preserves Local link punctuation and distinct channel identities", () => {
  expect(extractLocalLinks(
    "zeros://chat/one... zeros://chat/one: zeros-dev://workspace/two---",
  )).toEqual([
    { scheme: "zeros", kind: "chat", id: "one" },
    { scheme: "zeros-dev", kind: "workspace", id: "two" },
  ]);
});

it("no longer recognizes the retired zeros-beta scheme as a Zeros link", () => {
  expect(parseLocalLink("zeros-beta://chat/one")).toBeNull();
  expect(parseLocalLink("zeros-beta://workspace/two")).toBeNull();
  expect(extractLocalLinks("zeros-beta://chat/one zeros-alpha://chat/two")).toEqual([
    { scheme: "zeros-alpha", kind: "chat", id: "two" },
  ]);
});

// Review A finding 10 / B10. Visits and supported results recorded from the
// pre-retirement implementation (origin/main) on the reviewers' inputs.
const MAIN = [
  {
    name: "64 retired links then 1,600 copies of one supported link",
    text: Array.from({ length: 64 }, (_, i) => `zeros-beta://chat/old${i}`).join(" ") + " " +
      Array(1_600).fill("zeros://chat/same").join(" ") + " zeros://chat/after",
    visited: 64,
    links: [],
  },
  {
    name: "256 copies of a link, then one more distinct link",
    text: Array(256).fill("zeros://chat/source").join(" ") + " zeros://workspace/legitimate",
    visited: 257,
    links: [{ scheme: "zeros", kind: "chat", id: "source" }, { scheme: "zeros", kind: "workspace", id: "legitimate" }],
  },
  {
    name: "256 copies of one chat, then the last one",
    text: Array(256).fill("zeros://chat/first").join(" ") + " zeros://chat/last",
    visited: 257,
    links: [{ scheme: "zeros", kind: "chat", id: "first" }, { scheme: "zeros", kind: "chat", id: "last" }],
  },
];

it.each(MAIN)("returns main's supported links and scans no further than main: $name", ({ text, visited, links }) => {
  const original = RegExp.prototype[Symbol.matchAll];
  let seen = 0;
  RegExp.prototype[Symbol.matchAll] = function (this: RegExp, input: string) {
    const iterator = original.call(this, input);
    return {
      [Symbol.iterator]() { return this; },
      next() { const step = iterator.next(); if (!step.done) seen++; return step; },
    } as RegExpStringIterator<RegExpExecArray>;
  };
  try {
    expect(extractLocalLinks(text)).toEqual(links);
  } finally {
    RegExp.prototype[Symbol.matchAll] = original;
  }
  expect(seen).toBeLessThanOrEqual(visited);
});

it("counts distinct retired links toward the limit as before, without returning them", () => {
  const text = Array.from({ length: 63 }, (_, i) => `zeros-beta://chat/old${i}`).join(" ") +
    " zeros-beta://chat/old0 zeros://chat/kept zeros://chat/past-the-limit";
  expect(extractLocalLinks(text)).toEqual([{ scheme: "zeros", kind: "chat", id: "kept" }]);
  expect(extractLocalLinks("zeros://chat/a zeros-alpha://chat/b zeros-dev://workspace/c")).toHaveLength(3);
});

it("degrades only a well-formed retired link, through the full parser", async () => {
  const { isRetiredLocalLink } = await import("../local-orchestration");
  expect(isRetiredLocalLink("zeros-beta://chat/child")).toBe(true);
  expect(isRetiredLocalLink("zeros-beta://acme/w/7?session=chat-1")).toBe(true);
  for (const text of ["zeros-beta://chat/", "zeros-beta://chat/a?x=1", "zeros-gamma://chat/a", "zeros://chat/a", "javascript:alert(1)"])
    expect(isRetiredLocalLink(text), text).toBe(false);
});

it("bounds link extraction for long internal punctuation runs", () => {
  // Isolate the adversarial input so a quadratic matcher cannot hang the suite.
  // The budget includes Node/tsx startup and is far above the linear scan cost.
  const source = new URL("../local-orchestration.ts", import.meta.url).href;
  const code = `import assert from 'node:assert/strict';
    import { extractLocalLinks } from ${JSON.stringify(source)};
    assert.deepEqual(extractLocalLinks('zeros://chat/a' + '-'.repeat(250_000) + 'z zeros://chat/valid.'),
      [{ scheme: 'zeros', kind: 'chat', id: 'valid' }]);`;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    { timeout: 4_000, encoding: "utf8", maxBuffer: 64 * 1024 },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 10_000);

describe("numbered workspace links", () => {
  const session = "7e2b720c-ab56-441d-b189-6e7d1eb7a628";

  it("formats and parses a workspace and a chat in it", () => {
    const workspace = formatWorkspaceLink("zeros-alpha", { owner: "local", number: 310 });
    expect(workspace).toBe("zeros-alpha://local/w/310");
    expect(parseLocalLink(workspace)).toEqual({
      scheme: "zeros-alpha",
      kind: "workspace",
      id: "local/w/310",
      address: { owner: "local", number: 310 },
    });
    const chat = formatWorkspaceLink("zeros-alpha", { owner: "local", number: 310 }, session);
    expect(chat).toBe(`zeros-alpha://local/w/310?session=${session}`);
    expect(parseLocalLink(chat)).toEqual({
      scheme: "zeros-alpha",
      kind: "chat",
      id: session,
      address: { owner: "local", number: 310 },
    });
    for (const link of [workspace, chat]) expect(formatParsedLocalLink(parseLocalLink(link)!)).toBe(link);
  });

  it("names a workspace w-<number>", () => {
    expect(workspaceNumberLabel(1)).toBe("w-1");
    expect(workspaceNumberLabel(310)).toBe("w-310");
    expect(() => workspaceNumberLabel(0)).toThrow();
    expect(() => workspaceNumberLabel(1.5)).toThrow();
  });

  it("accepts an organization slug and normalizes its case", () => {
    expect(parseLocalLink("zeros://Acme-Labs/w/3")).toMatchObject({ address: { owner: "acme-labs", number: 3 } });
    // An organization named after a legacy link kind still has numbered links.
    expect(parseLocalLink("zeros://chat/w/3")).toMatchObject({ kind: "workspace", address: { owner: "chat", number: 3 } });
  });

  it.each([
    "zeros://local/w/0",
    "zeros://local/w/007",
    "zeros://local/w/2147483648",
    "zeros://local/w/3/",
    "zeros://local/w/3#chat",
    "zeros://local/w/3?session=",
    "zeros://local/w/3?session=a&x=1",
    "zeros://local/w/3?chat=abc",
    "zeros://local/w/3?session=a%2Fb",
    "zeros://-local/w/3",
    "zeros://user@local/w/3",
    "zeros://local:44/w/3",
    "zeros-prod://local/w/3",
    "zeros-beta://local/w/3",
    "https://local/w/3",
    "zeros://local/x/3",
  ])("refuses %s", (text) => {
    expect(parseLocalLink(text)).toBeNull();
  });

  it("keeps parsing legacy chat and workspace links", () => {
    expect(parseLocalLink("zeros://chat/abc")).toEqual({ scheme: "zeros", kind: "chat", id: "abc" });
    expect(parseLocalLink("zeros://workspace/ws_43d08e-watchet")).toEqual({
      scheme: "zeros",
      kind: "workspace",
      id: "ws_43d08e-watchet",
    });
    expect(parseLocalLink("zeros://workspace/folder%3Aproj_1")).toEqual({ scheme: "zeros", kind: "workspace", id: "folder:proj_1" });
  });

  it("refuses to format an invalid owner, number or chat id", () => {
    expect(() => formatWorkspaceLink("zeros", { owner: "Local", number: 3 })).toThrow();
    expect(() => formatWorkspaceLink("zeros", { owner: "local", number: 0 })).toThrow();
    expect(() => formatWorkspaceLink("zeros", { owner: "local", number: 3 }, "a/b")).toThrow();
    expect(() => formatWorkspaceLink("zeros-prod" as never, { owner: "local", number: 3 })).toThrow();
  });

  it("extracts numbered links from text without truncating a number", () => {
    expect(extractLocalLinks(
      `See zeros://local/w/12. Then zeros://local/w/12?session=${session}, zeros://local/w/31a and zeros://chat/legacy.`,
    )).toEqual([
      { scheme: "zeros", kind: "workspace", id: "local/w/12", address: { owner: "local", number: 12 } },
      { scheme: "zeros", kind: "chat", id: session, address: { owner: "local", number: 12 } },
      { scheme: "zeros", kind: "chat", id: "legacy" },
    ]);
  });
});

it("never formats a link its own parser rejects", async () => {
  const { formatLocalLink } = await import("../local-orchestration");
  expect(() => formatLocalLink("zeros-beta" as "zeros", "chat", "child")).toThrow(/scheme/);
  expect(parseLocalLink(formatLocalLink("zeros-alpha", "chat", "child"))).toEqual({ scheme: "zeros-alpha", kind: "chat", id: "child" });
});
