import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { HarnessFailure } from "./assertions";
import { fixtureDescriptor, parseInstalledHarnessOperatorInventory } from "./runtime-contract";

const execute = promisify(execFile);

/** Compile private qualification operators only from the master's clean
 * snapshot, matching the strict candidate's exact source commit. This does
 * not build, copy or publish an installed runtime. Call only in the build lane. */
export async function buildInstalledHarnessOperators(sourceRoot: string, output: string, sourceCommit: string) {
  sourceRoot = await realpath(sourceRoot);
  output = path.resolve(output);
  output = path.join(await realpath(path.dirname(output)), path.basename(output));
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || contains(sourceRoot, output) || contains(output, sourceRoot))
    throw new HarnessFailure("operator_input_invalid");
  const gitOptions = { cwd: sourceRoot, env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 64 * 1024 };
  const assertSnapshot = async () => {
    const root = (await execute("git", ["rev-parse", "--show-toplevel"], gitOptions)).stdout.trim();
    const commit = (await execute("git", ["rev-parse", "HEAD"], gitOptions)).stdout.trim();
    const dirty = (await execute("git", ["status", "--porcelain", "--untracked-files=normal"], gitOptions)).stdout;
    if (root !== sourceRoot || commit !== sourceCommit || dirty) throw new HarnessFailure("fixture_contract_invalid");
  };
  await assertSnapshot();
  await mkdir(output, { mode: 0o700 });
  const { build } = await import("tsup");
  await build({ config: false, entry: {
    run: path.join(sourceRoot, "scripts/cloud-workspace-validation/cloud-agent-e2e/run.mts"),
    "namespace-entry": path.join(sourceRoot, "scripts/cloud-workspace-validation/cloud-agent-e2e/namespace-entry.ts"),
  }, outDir: output, format: ["esm"], outExtension: () => ({ js: ".mjs" }), platform: "node", target: "node24", splitting: false,
    noExternal: ["@zeros/protocol", "zod", "ws"], external: [/^node:/, "better-sqlite3", "tsup"], silent: true });
  await assertSnapshot();
  const files = await Promise.all((["run.mjs", "namespace-entry.mjs"] as const).map(async file => {
    const bytes = await readFile(path.join(output, file));
    await chmod(path.join(output, file), 0o500);
    return { path: file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
  const inventory = parseInstalledHarnessOperatorInventory({ schema: "zeros.installed-agent-e2e-operator/v1", sourceCommit, files }, sourceCommit);
  await writeFile(path.join(output, "operator-inventory.json"), `${JSON.stringify(inventory)}\n`, { mode: 0o444, flag: "wx" });
  return { output, inventory };
}

export async function buildSourceRuntime(sourceRoot: string, scratch: string) {
  sourceRoot = await realpath(sourceRoot);
  scratch = path.resolve(scratch);
  const relative = path.relative(path.join(sourceRoot, ".context/agents-fix/scratch/W5"), scratch);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new HarnessFailure("operator_input_invalid");
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  // The installed operator never loads a source builder or tsup configuration.
  const [{ build }, { default: engineConfiguration }, { stageSources, copyPayload }, { stageRipgrep }] = await Promise.all([
    import("tsup"), import("../../../tsup.config"), import("../runtime-bundle/closure"), import("../../stage-ripgrep.mjs"),
  ]);
  const stage = path.join(scratch, "runtime");
  await mkdir(stage, { mode: 0o755 });
  const dist = path.join(scratch, "dist-engine");
  // The production tsup configuration, current working tree, and external
  // dependency closure are reused; no clean checkout or publication claim.
  if (!Array.isArray(engineConfiguration)) throw new HarnessFailure("runtime_build_failed");
  await build({ ...engineConfiguration[0], config: false, outDir: dist, silent: true });
  await stageSources(sourceRoot, stage);
  await build({ config: false, entry: {
    "namespace-entry": path.join(sourceRoot, "scripts/cloud-workspace-validation/cloud-agent-e2e/namespace-entry.ts"),
    "stage-closure": path.join(sourceRoot, "scripts/cloud-workspace-validation/cloud-agent-e2e/stage-closure.mts"),
  }, outDir: path.join(scratch, "supervisor"), format: ["esm"], outExtension: () => ({ js: ".mjs" }), platform: "node", target: "node24", splitting: false,
    noExternal: ["@zeros/protocol", "zod"], external: [/^node:/], silent: true });
  const staged = await execute("sudo", ["unshare", "--mount", "--propagation", "private", process.execPath,
    path.join(scratch, "supervisor/stage-closure.mjs"), sourceRoot, stage, await readlink("/proc/self/ns/mnt"), String(process.getuid!())],
    { env: { PATH: process.env.PATH, LANG: "C.UTF-8" }, maxBuffer: 64 * 1024 });
  const packages = JSON.parse(staged.stdout) as { packageCount: number };
  await copyPayload(dist, path.join(stage, "worker/dist-engine"));
  await mkdir(path.join(stage, "worker/binaries"), { recursive: true });
  await stageRipgrep({output:path.join(stage,"worker/binaries/rg")});
  await copyPayload(await realpath(process.execPath), path.join(stage, "bin/node"));
  for (const [name, source, mode] of [
    ["cloud-engine-namespace", "scripts/cloud-workspace-validation/sandbox/cloud-engine-namespace.c", 0o500],
  ] as const) {
    await execute("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", path.join(sourceRoot, source), "-o", path.join(stage, "bin", name)],
      { maxBuffer: 64 * 1024 });
    await chmod(path.join(stage, "bin", name), mode);
  }
  // A fixture manifest is deliberately distinct from the release manifest.
  // v4 verifies its immutable digest; no registry/base qualification is implied.
  const manifest = { schema: "zeros.source-runtime-fixture/v1", mode: "SOURCE-MODE", qualified: false,
    engineSha256: createHash("sha256").update(await readFile(path.join(dist, "cli.js"))).digest("hex"),
    node: process.version, nodeAbi: process.versions.modules, packageCount: packages.packageCount,
    sqliteSource: "sandbox_napi_prebuild_fixture" };
  const bytes = `${JSON.stringify(manifest)}\n`;
  await writeFile(path.join(stage, "manifest.json"), bytes, { mode: 0o444 });
  const descriptor = fixtureDescriptor(createHash("sha256").update(bytes).digest("hex"),
    `/sys/fs/cgroup/zeros-agent-e2e-${path.basename(scratch)}/zeros-host.service`);
  return { stage, descriptor, entry: path.join(scratch, "supervisor/namespace-entry.mjs"), manifest };
}
export async function createFixtureTls(scratch: string) {
  const directory = path.join(scratch, "tls");
  await mkdir(directory, { mode: 0o700 });
  const caKey = path.join(directory, "ca.key"), ca = path.join(directory, "ca.pem"), key = path.join(directory, "server.key"), cert = path.join(directory, "server.pem");
  await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Zeros source fixture CA", "-keyout", caKey, "-out", ca], { maxBuffer: 64 * 1024 });
  await execute("openssl", ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-keyout", key, "-out", path.join(directory, "server.csr")], { maxBuffer: 64 * 1024 });
  await writeFile(path.join(directory, "extensions"), "subjectAltName=DNS:localhost,IP:127.0.0.1\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n", { mode: 0o600 });
  await execute("openssl", ["x509", "-req", "-in", path.join(directory, "server.csr"), "-CA", ca, "-CAkey", caKey, "-CAcreateserial", "-days", "1", "-extfile", path.join(directory, "extensions"), "-out", cert], { maxBuffer: 64 * 1024 });
  for (const file of [caKey, key]) await chmod(file, 0o600);
  return { ca, key: await readFile(key), cert: await readFile(cert) };
}
