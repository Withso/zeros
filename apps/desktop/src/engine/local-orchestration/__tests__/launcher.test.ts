import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLocalCliBinDir, localCliInvocation, localCliLauncher } from "../launcher";

const roots: string[] = [];
function temporary(): string {
  const root = mkdtempSync(path.join(tmpdir(), "zeros-local-cli-"));
  roots.push(root);
  return root;
}
function fakeRuntime(filename: string): void {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, '#!/bin/sh\nprintf "<%s>\\n" "$@"\n', { mode: 0o755 });
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Local CLI launcher", () => {
  it.each([undefined, "/Applications/Zeros.app/Contents/Resources/zeros-engine", "/$bunfs/root/cli.ts"])("uses the compiled executable directly for entry %s", (entry) => {
    const execPath = "/Applications/Zeros.app/Contents/Resources/zeros-engine";
    expect(localCliInvocation({ execPath, entry })).toEqual({ executable: execPath, args: ["local"] });
  });

  it.each(["/tools/bun", "/tools/node"])("keeps the source entry when running under %s", (execPath) => {
    expect(localCliInvocation({ execPath, entry: "apps/desktop/src/cli.ts", cwd: "/my checkout" }))
      .toEqual({ executable: execPath, args: ["/my checkout/apps/desktop/src/cli.ts", "local"] });
  });

  it("retains Node's source loader arguments", () => {
    const loader = pathToFileURL(createRequire(path.resolve("package.json")).resolve("tsx")).href;
    expect(localCliInvocation({ execPath: "/usr/bin/node", entry: "/checkout/cli.ts", execArgv: ["--import", "tsx"] }).args)
      .toEqual(["--import", loader, "/checkout/cli.ts", "local"]);
  });

  it("runs a Node source entry from a different working directory", async () => {
    const root = temporary();
    const entry = path.join(root, "cli.ts");
    writeFileSync(entry, 'const args: string[] = process.argv.slice(2); process.stdout.write(JSON.stringify(args));\n');
    const directory = await ensureLocalCliBinDir({ dataDir: root, execPath: process.execPath, entry, execArgv: ["--import", "tsx"], cwd: process.cwd() });
    const result = spawnSync(path.join(directory, "zeros"), ["local", "--help"], { cwd: temporary(), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["local", "--help"]);
  });

  it("prefers the bundled executable launcher without writing into app data", async () => {
    const root = temporary();
    const bin = path.join(root, "Resources", "bin");
    fakeRuntime(path.join(bin, "zeros"));
    const dataDir = path.join(root, "data");
    expect(await ensureLocalCliBinDir({ dataDir, execPath: path.join(root, "Resources", "zeros-engine") })).toBe(bin);
    expect(readdirSync(root)).toEqual(["Resources"]);
  });

  it("generates a private directory and atomically replaces an exact-runtime launcher", async () => {
    const root = temporary();
    const executable = path.join(root, "runtime with 'quotes' $HOME $(uname)");
    fakeRuntime(executable);
    const dataDir = path.join(root, "Application Support");
    const entry = path.join(root, "a 'quoted' checkout", "cli.ts");
    const directory = await ensureLocalCliBinDir({ dataDir, execPath: executable, entry });
    const file = path.join(directory, "zeros");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path.dirname(directory)).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o755);
    expect(readdirSync(directory)).toEqual(["zeros"]);
    const result = spawnSync(file, ["local", "message", "send", "a", "--message", "a 'quote' $(uname)"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe([entry, "local", "message", "send", "a", "--message", "a 'quote' $(uname)"].map((arg) => "<" + arg + ">\n").join(""));
    expect(result.stderr).toBe("");
    const replacement = path.join(root, "next runtime");
    fakeRuntime(replacement);
    await ensureLocalCliBinDir({ dataDir, execPath: replacement });
    expect(readFileSync(file, "utf8")).toContain(replacement);
    expect(readFileSync(file, "utf8")).not.toContain(executable);
    expect(readFileSync(file, "utf8")).not.toMatch(/TOKEN|Bearer/);
    expect(readdirSync(directory)).toEqual(["zeros"]);
  });

  it("refuses every namespace except local, including a missing argument", async () => {
    const root = temporary();
    const directory = await ensureLocalCliBinDir({ dataDir: root, execPath: "/not/invoked" });
    for (const argv of [[], ["serve"], ["design"], ["cloud"], ["--help"]]) {
      const result = spawnSync(path.join(directory, "zeros"), argv, { encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("Only `zeros local …` is available here.\n");
    }
  });

  it("does not follow a symlink for its writable launcher directory", async () => {
    const root = temporary();
    const outside = temporary();
    symlinkSync(outside, path.join(root, "local-cli"));
    await expect(ensureLocalCliBinDir({ dataDir: root, execPath: "/not/invoked" })).rejects.toThrow("symlink");
    expect(readdirSync(outside)).toEqual([]);
  });

  it("resolves relative and absolute symlinks to the packaged Resources directory", () => {
    const root = temporary();
    const resources = path.join(root, "Zeros Test.app", "Contents", "Resources");
    const bin = path.join(resources, "bin");
    mkdirSync(bin, { recursive: true });
    const packaged = path.join(bin, "zeros");
    copyFileSync("apps/desktop/resources/bin/zeros", packaged);
    chmodSync(packaged, 0o755);
    fakeRuntime(path.join(resources, "zeros-engine"));
    const links = path.join(root, "user bin");
    mkdirSync(links);
    symlinkSync(path.relative(links, packaged), path.join(links, "relative"));
    symlinkSync(path.join(links, "relative"), path.join(links, "zeros"));
    const result = spawnSync(path.join(links, "zeros"), ["local", "--message", "safe $(uname) 'text'"], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("<local>\n<--message>\n<safe $(uname) 'text'>\n");
    const refused = spawnSync(packaged, ["serve"], { encoding: "utf8" });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toBe("Only `zeros local …` is available here.\n");
  });

  it("rejects NUL instead of generating a broken shell script", () => {
    expect(() => localCliLauncher({ executable: "/bin/bad\0name", args: ["local"] })).toThrow("NUL");
  });
});
