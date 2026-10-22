import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { dockerRuntimeInvocation, runtimeSourcePaths, stageRuntimeSource } from "../../apps/cloud-worker/scripts/package-runtime.mjs";

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
