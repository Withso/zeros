import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prunable, releaseClientContract } from "../client-contract-release.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function workspace(existing: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), "zeros-client-contract-"));
  roots.push(root);
  const released = path.join(root, "apps/control-plane/src/client-contracts/released");
  mkdirSync(released, { recursive: true });
  for (const name of existing) writeFileSync(path.join(released, name), "{}");
  return { root, released };
}
const contract = (client: string) => `{"version":1,"client":"${client}","entries":[]}\n`;
const tagFiles = (files: Record<string, string>) => (args: string[]) => {
  const file = args[1]!.split(":")[1]!;
  if (!(file in files)) throw new Error("fatal: path does not exist");
  return files[file]!;
};
const DIR = "apps/control-plane/src/client-contracts";

describe("keeping released client contracts", () => {
  it("prunes each client by version, not by name order", () => {
    const names = ["desktop-0.1.9.json", "desktop-0.1.10.json", "desktop-0.1.31.json", "worker-0.1.31.json", ".gitkeep"];
    expect(prunable(names, "desktop")).toEqual(["desktop-0.1.9.json"]);
    expect(prunable(names, "worker")).toEqual([]);
  });

  it("copies the tag's own desktop and worker contracts and keeps the newest two of each", () => {
    const { root, released } = workspace(["desktop-0.1.29.json", "desktop-0.1.30.json", "worker-0.1.29.json", "worker-0.1.30.json"]);
    const asked: string[] = [];
    const git = (args: string[]) => { asked.push(args.join(" ")); return tagFiles({ [`${DIR}/desktop-next.json`]: contract("desktop"), [`${DIR}/worker-next.json`]: contract("worker") })(args); };
    expect(releaseClientContract("0.1.31", { root, git })).toEqual({ written: ["desktop-0.1.31.json", "worker-0.1.31.json"], skipped: [],
      removed: ["desktop-0.1.29.json", "worker-0.1.29.json"] });
    expect(asked).toEqual([`show v0.1.31:${DIR}/desktop-next.json`, `show v0.1.31:${DIR}/worker-next.json`]);
    expect(readdirSync(released).sort()).toEqual(["desktop-0.1.30.json", "desktop-0.1.31.json", "worker-0.1.30.json", "worker-0.1.31.json"]);
  });

  it("keeps a desktop contract from a tag cut before the worker declared one", () => {
    const { root } = workspace([]);
    expect(releaseClientContract("0.1.30", { root, git: tagFiles({ [`${DIR}/desktop-next.json`]: contract("desktop") }) }))
      .toEqual({ written: ["desktop-0.1.30.json"], skipped: ["worker"], removed: [] });
  });

  it("refuses a malformed version, a tag without a desktop contract, or a mislabelled file", () => {
    expect(() => releaseClientContract("v0.1.31")).toThrow(/Usage/);
    expect(() => releaseClientContract("0.1.29", { root: workspace([]).root, git: tagFiles({}) })).toThrow(/no desktop client contract/);
    expect(() => releaseClientContract("0.1.31", { root: workspace([]).root,
      git: tagFiles({ [`${DIR}/desktop-next.json`]: contract("desktop"), [`${DIR}/worker-next.json`]: contract("desktop") }) })).toThrow(/no worker client contract/);
  });
});
