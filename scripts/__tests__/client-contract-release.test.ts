import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prunable, releaseClientContract } from "../client-contract-release.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("keeping released desktop client contracts", () => {
  it("prunes by version, not by name order", () => {
    expect(prunable(["desktop-0.1.9.json", "desktop-0.1.10.json", "desktop-0.1.31.json", ".gitkeep"])).toEqual(["desktop-0.1.9.json"]);
    expect(prunable(["desktop-0.1.31.json"])).toEqual([]);
  });

  it("copies the tag's own contract and keeps the newest two", () => {
    const root = mkdtempSync(path.join(tmpdir(), "zeros-client-contract-"));
    roots.push(root);
    const released = path.join(root, "apps/control-plane/src/client-contracts/released");
    mkdirSync(released, { recursive: true });
    for (const v of ["0.1.29", "0.1.30"]) writeFileSync(path.join(released, `desktop-${v}.json`), "{}");
    const asked: string[][] = [];
    const result = releaseClientContract("0.1.31", { root, git: args => { asked.push(args); return '{"version":1,"client":"desktop","entries":[]}\n'; } });
    expect(asked).toEqual([["show", "v0.1.31:apps/control-plane/src/client-contracts/desktop-next.json"]]);
    expect(result).toEqual({ written: "desktop-0.1.31.json", removed: ["desktop-0.1.29.json"] });
    expect(readdirSync(released).sort()).toEqual(["desktop-0.1.30.json", "desktop-0.1.31.json"]);
  });

  it("refuses a malformed version or a tag without a contract", () => {
    expect(() => releaseClientContract("v0.1.31")).toThrow(/Usage/);
    expect(() => releaseClientContract("0.1.29", { git: () => '{"unrelated":true}' })).toThrow(/no desktop client contract/);
  });
});
