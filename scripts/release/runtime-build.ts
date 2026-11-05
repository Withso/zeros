import { resolve } from "node:path";
import type { runtimeSourceIdentity as sourceIdentity } from "../../apps/cloud-worker/scripts/package-runtime.mjs";
import { inspectRuntimeArchive } from "../../apps/control-plane/src/cloud/runtime-artifact";
import { RuntimeBuildSchema, RuntimeManifest, type RuntimeBuild, type RuntimeReleaseConfig } from "./runtime-contracts";
import { command, type Command } from "./io";
import { requireCheck } from "./contracts";
import { runtimeGithub } from "./runtime-github";
import { assertRuntimeBuildProducer, runtimeJson } from "./runtime-proof";

export { RuntimeBuildSchema, type RuntimeBuild } from "./runtime-contracts";
type Packager = (input: { output: string; repository: string; docker: boolean; env: NodeJS.ProcessEnv;
  execute: Command }) => Promise<unknown>;

export async function buildRuntime(config: RuntimeReleaseConfig, env: NodeJS.ProcessEnv, paths: { candidate: string; archive: string }, options: {
  source?: () => Promise<void>; command?: Command; identity?: typeof sourceIdentity;
  build?: Packager; inspect?: typeof inspectRuntimeArchive;
} = {}): Promise<RuntimeBuild> {
  requireCheck(config.channel === "alpha" && config.action === "publish" && config.sourceSha, "Runtime build requires an exact Alpha source");
  const execute = options.command ?? command, source = options.source ?? runtimeGithub(config, env, { command: execute }).source;
  const candidate = resolve(paths.candidate), archive = resolve(paths.archive);
  await source();
  const clean = async () => requireCheck((await execute("git", ["rev-parse", "HEAD"], { cwd: candidate })).trim() === config.sourceSha &&
    !(await execute("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: candidate })).trim(), "Runtime candidate checkout changed or is dirty");
  await clean();
  const { packageRuntime, runtimeSourceIdentity } = await import("../../apps/cloud-worker/scripts/package-runtime.mjs");
  const before = await (options.identity ?? runtimeSourceIdentity)(candidate);
  requireCheck(before.commit === config.sourceSha && !before.dirty, "Runtime candidate source differs");
  const buildEnv = { PATH: env.PATH, HOME: env.HOME, TMPDIR: env.TMPDIR };
  const pack = options.build ?? packageRuntime as unknown as Packager;
  await pack({ output: archive, repository: candidate, docker: true, env: buildEnv,
    execute: (file, args, supplied = {}) => execute(file, args, { cwd: supplied.cwd, timeout: supplied.timeout, env: buildEnv }) });
  await clean(); await source();
  const after = await (options.identity ?? runtimeSourceIdentity)(candidate);
  requireCheck(runtimeJson(before) === runtimeJson(after), "Runtime source changed during its build");
  const inspected = await (options.inspect ?? inspectRuntimeArchive)(archive);
  requireCheck(inspected.commit === config.sourceSha && inspected.sourceSha256 === before.sourceSha256, "Runtime archive does not match the exact checked source");
  const manifest = RuntimeManifest.parse({ version: 1, repository: config.repository, sha256: inspected.sha256,
    sourceSha: inspected.commit, sourceSha256: inspected.sourceSha256, bytes: inspected.bytes });
  return RuntimeBuildSchema.parse({ version: 1, repository: config.repository, workflowSha: config.workflowSha, runId: config.runId, runAttempt: config.runAttempt, manifest });
}

export async function verifyRuntimeBuild(config: RuntimeReleaseConfig, value: unknown, read: (path: string) => Promise<unknown>): Promise<RuntimeBuild> {
  const checked = RuntimeBuildSchema.safeParse(value);
  requireCheck(config.action === "publish" && config.channel === "alpha" && checked.success, "Runtime build metadata is invalid");
  const build = checked.data;
  requireCheck(build.repository === config.repository && build.manifest.repository === config.repository && build.workflowSha === config.workflowSha &&
    build.runId === config.runId && build.runAttempt === config.runAttempt && build.manifest.sourceSha === config.sourceSha,
    "Runtime archive came from another source or workflow attempt");
  assertRuntimeBuildProducer(config, await read(`/actions/runs/${config.runId}/attempts/${config.runAttempt}/jobs?per_page=100`));
  return build;
}
