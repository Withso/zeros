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
