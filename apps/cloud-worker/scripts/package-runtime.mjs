import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dirname, "../../..");
const ROOT_INPUTS = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.build.json", "LICENSE", "THIRD-PARTY-NOTICES.md", "THIRD-PARTY-LICENSES.txt"]);
const SOURCE_ROOTS = ["apps/cloud-worker/src/", "apps/cloud-worker/bin/", "apps/cloud-worker/scripts/", "packages/protocol/src/", "catalogs/", "patches/"];

/** Docker receives a source copy, never the checkout, its credentials, its
 * installed packages or a host package-manager config. Other workspace
 * manifests keep the frozen lockfile resolvable without copying their code. */
export function runtimeSourcePaths(files) {
  return [...new Set(files)].filter(file => typeof file === "string" && !file.includes("\\") &&
    file.split("/").every(part => part && !part.startsWith(".") && part !== "node_modules") &&
    (ROOT_INPUTS.has(file) || SOURCE_ROOTS.some(prefix => file.startsWith(prefix)) ||
      /^packages\/[^/]+\/package\.json$/.test(file) || file === "packages/protocol/tsconfig.json" || file === "apps/marketing/package.json" ||
      /^apps\/cloud-worker\/(package|tsconfig)\.json$/.test(file))).sort();
}

export async function stageRuntimeSource(repository, destination, files) {
  const base = await realpath(repository), hash = createHash("sha256"), copied = [];
  for (const file of runtimeSourcePaths(files)) {
    const source = join(base, file);
    // Check and read through one descriptor that refuses a final symlink, so
    // the hashed bytes are exactly the file that was checked.
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW).catch(error => {
      if (error.code === "ENOENT") return null;
      if (error.code === "ELOOP") throw new Error("Runtime source must be regular files without links");
      throw error;
    });
    if (!handle) continue; // A deliberately deleted tracked source in --allow-dirty mode.
    let bytes, mode;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || await realpath(source) !== source)
        throw new Error("Runtime source must be regular files without links");
      // Git records only regular or executable. The checkout's umask must not
      // change the source identity, or another machine never finds the runtime.
      mode = stat.mode & 0o111 ? 0o755 : 0o644;
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    if (destination) {
      const target = join(destination, file);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx", mode });
      await chmod(target, mode);
    }
    hash.update(`${file}\0${mode}\0`).update(bytes).update("\0");
    copied.push(file);
  }
  return { files: copied, sha256: hash.digest("hex") };
}

/** The same filtered paths, modes and bytes as BUILD.json, without building or
 * copying. Uncommitted worker edits participate; private/unrelated files do not. */
export async function runtimeSourceIdentity(repository = root) {
  const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
  const files = runtimeSourcePaths(git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0"));
  return { sourceSha256: (await stageRuntimeSource(repository, null, files)).sha256,
    commit: git("rev-parse", "HEAD"), dirty: Boolean(git("status", "--porcelain", "--untracked-files=all", "--", ...files)) };
}

const CONTAINER_BUILD = [
  "set -eu", "mkdir /work", "cp -a /source/. /work/", "cd /work", "corepack enable",
  "pnpm --filter @zeros/cloud-worker... install --frozen-lockfile --ignore-scripts",
  "pnpm --filter @zeros/cloud-worker rebuild node-pty esbuild",
  "node apps/cloud-worker/scripts/build.mjs --outdir /runtime",
  "cp /source/build-metadata.json /runtime/BUILD.json",
  "tar --sort=name --owner=0 --group=0 --numeric-owner -czf /out/runtime.tar.gz -C /runtime .",
].join("\n");

export function dockerRuntimeInvocation(source, output, name) {
  if ([source, output].some(value => !value.startsWith("/") || /[,\r\n]/.test(value)) || !/^zeros-runtime-[a-z0-9-]+$/.test(name))
    throw new Error("Invalid runtime container paths");
  return { command: "docker", args: ["run", "--rm", "--name", name, "--platform", "linux/amd64",
    "--mount", `type=bind,src=${source},dst=/source,readonly`, "--mount", `type=bind,src=${output},dst=/out`,
    "node:24-bookworm", "timeout", "1200s", "bash", "-lc", CONTAINER_BUILD] };
}

export async function packageRuntime({ output, allowDirty = false, docker = false, repository = root, env, execute = execFileSync }) {
  const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
  const files = runtimeSourcePaths(git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0"));
  const dirty = Boolean(git("status", "--porcelain", "--untracked-files=all", "--", ...files));
  if (dirty && !allowDirty) throw new Error("Runtime build inputs have uncommitted changes; commit them or pass --allow-dirty");
  const destination = resolve(output);
  if (destination === resolve(repository) || destination.startsWith(join(resolve(repository), "apps/cloud-worker") + sep))
    throw new Error("Write the runtime archive outside the worker source directory");
  if (await lstat(destination).catch(error => { if (error.code === "ENOENT") return null; throw error; }))
    throw new Error("The runtime archive output already exists");
  const work = await mkdtemp(join(tmpdir(), "zeros-runtime-package-"));
  const container = `zeros-runtime-${randomUUID()}`;
  let usedDocker = false;
  try {
    const source = join(work, "source"), out = join(work, "out"), dist = join(work, "runtime");
    const inputs = await stageRuntimeSource(repository, source, files);
    const metadata = { commit: git("rev-parse", "HEAD"), sourceSha256: inputs.sha256, dirty, builtAt: new Date().toISOString() };
    await writeFile(join(source, "build-metadata.json"), `${JSON.stringify(metadata)}\n`);
    await mkdir(out);
    const archive = join(out, "runtime.tar.gz");
    usedDocker = docker || process.platform !== "linux" || process.arch !== "x64" || Number(process.versions.node.split(".")[0]) !== 24;
    if (usedDocker) {
      const invocation = dockerRuntimeInvocation(source, out, container);
      await execute(invocation.command, invocation.args, { stdio: "inherit", timeout: 21 * 60_000, env });
    } else {
      // Native Linux uses the already installed dependencies. It does not
      // install or mutate the checkout's shared node_modules or dist folder.
      await execute(process.execPath, [join(repository, "apps/cloud-worker/scripts/build.mjs"), "--outdir", dist], { cwd: repository, stdio: "inherit", timeout: 10 * 60_000, env });
      if ((await runtimeSourceIdentity(repository)).sourceSha256 !== metadata.sourceSha256)
        throw new Error("Worker sources changed during packaging; retry the build");
      await copyFile(join(source, "build-metadata.json"), join(dist, "BUILD.json"));
      await execute("tar", ["--sort=name", "--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", dist, "."], { timeout: 10 * 60_000, env });
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(archive)) hash.update(chunk);
    const sha256 = hash.digest("hex");
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(archive, destination, constants.COPYFILE_EXCL);
    return { archive: destination, sha256, ...metadata };
  } finally {
    if (usedDocker) {
      try { execFileSync("docker", ["rm", "--force", container], { stdio: "ignore", timeout: 30_000 }); } catch { /* --rm normally already removed it. */ }
    }
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { out: { type: "string" }, docker: { type: "boolean" }, "allow-dirty": { type: "boolean" }, help: { type: "boolean" } } });
    if (values.help) console.log("node apps/cloud-worker/scripts/package-runtime.mjs --out <new archive.tar.gz> [--docker] [--allow-dirty]\nBuilds for Linux amd64 / Node 24. Mac and other hosts require Docker. Packaging does not publish or create Boat resources.");
    else {
      if (!values.out) throw new Error("--out is required");
      console.log(JSON.stringify(await packageRuntime({ output: values.out, docker: values.docker, allowDirty: values["allow-dirty"] })));
    }
  } catch (error) { console.error(error instanceof Error ? error.message : "Runtime packaging failed"); process.exitCode = 1; }
}
