import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "tsup";
import engineConfiguration from "../../../tsup.config";
import { stageSources, copyPayload } from "../runtime-bundle/closure";
import { HarnessFailure } from "./assertions";
import { fixtureDescriptor } from "./runtime-contract";

const execute = promisify(execFile);
export async function buildSourceRuntime(sourceRoot: string, scratch: string) {
  sourceRoot = await realpath(sourceRoot);
  scratch = path.resolve(scratch);
  const relative = path.relative(path.join(sourceRoot, ".context/agents-fix/scratch/W5"), scratch);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new HarnessFailure("operator_input_invalid");
  await mkdir(scratch, { recursive: true, mode: 0o700 });
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
  await copyPayload(path.join(sourceRoot, "apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs"), path.join(stage, "worker/binaries/zsr-supervisor.mjs"));
  const rg = (await execute("which", ["rg"])).stdout.trim();
  await copyPayload(await realpath(rg), path.join(stage, "worker/binaries/zsr-rg"));
  await copyPayload(await realpath(process.execPath), path.join(stage, "bin/node"));
  for (const [name, source, mode] of [
    ["cloud-engine-namespace", "scripts/cloud-workspace-validation/sandbox/cloud-engine-namespace.c", 0o500],
    ["cloud-process-supervisor", "apps/desktop/src/engine/agents/containment/cloud-process-supervisor.c", 0o555],
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
