import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readyCopySearchResult, readyCopySecretLocation, readyCopySecretSearchScript } from "./ready-copies.js";

// Runs the search exactly as a ready copy build does, without sudo, on a temporary tree.
const tools = ["bash", "find", "xargs", "grep", "du", "timeout", "nproc"].every(tool => spawnSync("which", [tool]).status === 0) && existsSync("/dev/shm");
const d = tools ? describe : describe.skip;
const secret = "npm_fixture_secret_e5f1";
let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function tree(files: Record<string, string>) {
  root = mkdtempSync(path.join(tmpdir(), "zeros-search-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
}
const search = (paths: string[], patterns = `${secret}\n`) => {
  const before = readdirSync("/dev/shm").filter(name => name.startsWith("zeros-secret-patterns."));
  const run = spawnSync("bash", ["-c", readyCopySecretSearchScript(paths, { bytesPerSecond: 64 * 1024 * 1024, floorSeconds: 30, ceilingSeconds: 60 })],
    { input: patterns, encoding: "utf8" });
  // The patterns file never outlives the search.
  expect(readdirSync("/dev/shm").filter(name => name.startsWith("zeros-secret-patterns."))).toEqual(before);
  return { ...readyCopySearchResult(run.stdout), stdout: run.stdout, status: run.status };
};

d("the leftover-secret search, for real", () => {
  it("finds a value in a plain file anywhere it may be, reading its patterns from standard input", () => {
    const base = tree({ "home/repo/.npmrc": `//registry.npmjs.org/:_authToken=${secret}\n`, "home/repo/src/a.ts": "export const a = 1;\n",
      "etc/profile.d/x.sh": "export X=1\n" });
    const result = search([path.join(base, "home"), path.join(base, "etc")]);
    expect(result).toMatchObject({ found: path.join(base, "home/repo/.npmrc"), status: 0 });
    expect(result.stdout).toMatch(/zeros-search-bytes=\d+ zeros-search-limit=30/);
  });

  it("searches Git's plain files but not its compressed object store, and finishes clean when nothing is left", () => {
    const base = tree({ "repo/.git/objects/ab/cdef": secret, "repo/.git/objects/pack/p.pack": secret, "repo/src/a.ts": "x\n" });
    expect(search([path.join(base, "repo")])).toMatchObject({ found: null, complete: true });
    writeFileSync(path.join(base, "repo/.git/config"), `[http]\n\textraHeader = Authorization: Basic ${secret}\n`);
    expect(search([path.join(base, "repo")]).found).toBe(path.join(base, "repo/.git/config"));
  });

  it("handles names with spaces and quotes, many files, and a missing path", () => {
    const files: Record<string, string> = { "it's here/a file.txt": `token ${secret}` };
    for (let index = 0; index < 600; index++) files[`many/f${index}.txt`] = `line ${index}\n`;
    const base = tree(files);
    const result = search([path.join(base, "many"), path.join(base, "it's here"), path.join(base, "absent")]);
    expect(result.found).toBe(path.join(base, "it's here/a file.txt"));
    expect(readyCopySecretLocation(result.found!, [secret])).toBe(path.join(base, "it's here/a file.txt"));
    expect(search([path.join(base, "many")])).toMatchObject({ found: null, complete: true });
  });
});

describe("reading the search's answer", () => {
  it("fails closed unless find and xargs both finished", () => {
    expect(readyCopySearchResult("zeros-search-bytes=1 zeros-search-limit=300\nzeros-search-status=0,0\n")).toEqual({ found: null, complete: true });
    expect(readyCopySearchResult("zeros-search-status=1,0\n")).toEqual({ found: null, complete: true });
    for (const status of ["124,0", "0,124", "137,0", "2,0", "0,1"])
      expect(readyCopySearchResult(`zeros-search-status=${status}\n`).complete).toBe(false);
    expect(readyCopySearchResult("no status at all").complete).toBe(false);
    expect(readyCopySearchResult("zeros-search-bytes=1\n/tmp/x\nzeros-search-status=141,141\n")).toMatchObject({ found: "/tmp/x" });
  });
});
