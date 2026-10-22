import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { dockerRuntimeInvocation, runtimeSourceIdentity, runtimeSourcePaths, stageRuntimeSource } from "../../apps/cloud-worker/scripts/package-runtime.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it("copies only build inputs, never private profiles, credentials, installed packages or git metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-worker-package-")); roots.push(root);
  const source = join(root, "source"), staged = join(root, "staged");
  const files = ["package.json", "pnpm-lock.yaml", "packages/design-core/package.json", "apps/cloud-worker/src/main.ts",
    "packages/protocol/src/messages.ts", "catalogs/models-v1.json", "LICENSE", "patches/example.patch",
    ".env.agent", "zeros-dev-env.json", "apps/cloud-worker/src/.env", "apps/cloud-worker/node_modules/example/index.js",
    "node_modules/.pnpm/data.json", ".git/config", "apps/control-plane/src/config.ts", "apps/cloud-worker/dist/worker.mjs"];
  for (const file of files) {
    await mkdir(join(source, file, ".."), { recursive: true });
    await writeFile(join(source, file), file);
  }
  const expected = files.slice(0, 8).sort();
  expect(runtimeSourcePaths(files)).toEqual(expected);
  const result = await stageRuntimeSource(source, staged, files);
  expect(result.files).toEqual(expected);
  expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  for (const file of expected) expect(await readFile(join(staged, file), "utf8")).toBe(file);
  for (const file of files.slice(8)) await expect(readFile(join(staged, file))).rejects.toMatchObject({ code: "ENOENT" });
});

it("refuses symlinked source inputs instead of following them into private host files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-worker-package-")); roots.push(root);
  await mkdir(join(root, "source/apps/cloud-worker/src"), { recursive: true });
  await writeFile(join(root, "private"), "private fixture");
  await symlink(join(root, "private"), join(root, "source/apps/cloud-worker/src/main.ts"));
  await expect(stageRuntimeSource(join(root, "source"), join(root, "staged"), ["apps/cloud-worker/src/main.ts"])).rejects.toThrow(/link/);
});

it("retains the TypeScript config chain used to bundle the staged protocol sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-worker-package-")); roots.push(root);
  const source = join(root, "source"), staged = join(root, "staged");
  const files = {
    "tsconfig.json": JSON.stringify({ extends: "./tsconfig.build.json" }),
    "tsconfig.build.json": JSON.stringify({ compilerOptions: { target: "ES2022" } }),
    "packages/protocol/tsconfig.json": JSON.stringify({ extends: "../../tsconfig.build.json" }),
    "packages/protocol/src/example.ts": "export const version: number = 1;",
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(source, file, ".."), { recursive: true });
    await writeFile(join(source, file), content);
  }
  await stageRuntimeSource(source, staged, Object.keys(files));
  const result = await build({ absWorkingDir: staged, entryPoints: ["packages/protocol/src/example.ts"], bundle: true, write: false, logLevel: "silent" });
  expect(result.warnings).toEqual([]);
  expect(await readFile(join(staged, "packages/protocol/tsconfig.json"), "utf8")).toBe(files["packages/protocol/tsconfig.json"]);
});

it("builds Linux amd64 Node 24 with only staging and output mounts and no inherited secrets", () => {
  const { command, args } = dockerRuntimeInvocation("/tmp/source", "/tmp/output", "zeros-runtime-test");
  expect(command).toBe("docker");
  expect(args).toContain("linux/amd64");
  expect(args).toContain("node:24-bookworm");
  expect(args.filter((_, i) => args[i - 1] === "--mount")).toEqual([
    "type=bind,src=/tmp/source,dst=/source,readonly", "type=bind,src=/tmp/output,dst=/out",
  ]);
  expect(args).not.toContain("--env");
  expect(args).not.toContain("--env-file");
  expect(args.at(-1)).toContain("--frozen-lockfile --ignore-scripts");
  expect(args.at(-1)).toContain("rebuild node-pty esbuild");
});

it("looks up exactly the packager's source hash, including uncommitted bytes and modes but excluding private and unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-runtime-source-")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "fixture");
  const file = "apps/cloud-worker/src/main.ts";
  await mkdir(join(root, file, ".."), { recursive: true }); await writeFile(join(root, file), "worker");
  const first = await runtimeSourceIdentity(root);
  expect(first.sourceSha256).toBe((await stageRuntimeSource(root, join(root, "staged"), [file])).sha256);
  expect(first.dirty).toBe(true);
  await writeFile(join(root, ".env.agent"), "PRIVATE=fixture"); await writeFile(join(root, "docs.md"), "unrelated");
  expect((await runtimeSourceIdentity(root)).sourceSha256).toBe(first.sourceSha256);
  await writeFile(join(root, file), "changed"); const changed = await runtimeSourceIdentity(root);
  expect(changed.sourceSha256).not.toBe(first.sourceSha256);
  await chmod(join(root, file), 0o755); expect((await runtimeSourceIdentity(root)).sourceSha256).not.toBe(changed.sourceSha256);
});

// A Mac checkout (umask 022: 0644) and a Linux sandbox (umask 0002: 0664)
// at the same commit must find the same published runtime. Only Git's file
// modes, regular or executable, describe the source.
it("hashes and stages Git's file modes, independent of the checkout's umask", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-runtime-umask-")); roots.push(root);
  const file = "apps/cloud-worker/src/main.ts";
  await mkdir(join(root, file, ".."), { recursive: true }); await writeFile(join(root, file), "worker");
  const hashAs = async (mode: number) => { await chmod(join(root, file), mode); return (await stageRuntimeSource(root, null, [file])).sha256; };
  const regular = await hashAs(0o644);
  expect(await hashAs(0o664)).toBe(regular);
  expect(await hashAs(0o600)).toBe(regular);
  const executable = await hashAs(0o755);
  expect(executable).not.toBe(regular);
  expect(await hashAs(0o775)).toBe(executable);
  await chmod(join(root, file), 0o664);
  await stageRuntimeSource(root, join(root, "staged"), [file]);
  expect((await stat(join(root, "staged", file))).mode & 0o777).toBe(0o644);
});
