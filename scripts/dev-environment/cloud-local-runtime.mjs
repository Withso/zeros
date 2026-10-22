import path from "node:path";
import { pathToFileURL } from "node:url";
import { runtimeSourceIdentity } from "../../apps/cloud-worker/scripts/package-runtime.mjs";
import { run } from "./processes.mjs";
import { saveWorkspace, systemEnvironment } from "./state.mjs";

const SHA = /^[a-f0-9]{64}$/;
const noDocker = "No matching worker runtime is published; start Docker or publish this checkout from Linux with pnpm --dir apps/control-plane cloud-v2:publish-runtime --local.";

export async function runtimeBuildMode({ platform = process.platform, arch = process.arch, node = process.versions.node, run: command = run, signal } = {}) {
  if (platform === "linux" && arch === "x64" && Number(node.split(".")[0]) === 24) return { docker: false };
  try { await command("docker", ["info", "--format", "{{.ServerVersion}}"], { env: systemEnvironment(), signal, timeout: 10_000, label: "Docker check" }); }
  catch { signal?.throwIfAborted(); throw new Error(noDocker); }
  return { docker: true };
}

/** Called under the launcher's instance lock, after the control-plane build.
 * A cached receipt is diagnostic only; every automatic start checks storage's
 * exact source index. Explicit pins preserve the operator override contract. */
export async function resolveLocalRuntime(workspace, profile, root, options = {}) {
  const save = options.save ?? saveWorkspace, override = options.override ?? process.env.ZEROS_CLOUD_V2_RUNTIME_SHA256;
  if (override) {
    if (!SHA.test(override)) throw new Error("Invalid worker runtime override");
    workspace.state.cloudRuntime = { sha256: override, override: true, at: new Date().toISOString() }; save(workspace); return override;
  }
  const source = options.source ?? runtimeSourceIdentity, initial = await source(root);
  const module = name => import(pathToFileURL(path.join(root, "apps/control-plane/dist/cloud", name)).href);
  const lookup = options.lookup ?? ((sha, storage) => module("runtime-source.js").then(m => m.lookupRuntimeSource(sha, storage, undefined, options.signal)));
  let record;
  try { record = await lookup(initial.sourceSha256, profile.storage); }
  catch { options.signal?.throwIfAborted(); throw new Error("Worker runtime lookup failed; check the private runtime storage configuration"); }
  options.signal?.throwIfAborted();
  if (!record) {
    const mode = await (options.buildMode ?? runtimeBuildMode)({ signal: options.signal });
    const publish = options.publish ?? (input => module("publish-runtime.js").then(m => m.publishRuntime(input)));
    const env = systemEnvironment();
    try {
      record = await publish({ storage: profile.storage, repository: root, expectedSourceSha256: initial.sourceSha256,
        allowDirty: true, ...mode, env, signal: options.signal,
        execute: (command, args, settings) => run(command, args, { cwd: settings.cwd ?? root, env,
          signal: options.signal, timeout: settings.timeout, inherit: true, label: "Worker runtime build" }) });
    } catch { options.signal?.throwIfAborted(); throw new Error("Worker runtime publication failed; check the build and private runtime storage configuration"); }
  }
  if (!record || record.sourceSha256 !== initial.sourceSha256 || !SHA.test(record.sha256) || !/^[a-f0-9]{40}$/.test(record.commit))
    throw new Error("Published runtime does not match this worker source");
  if ((await source(root)).sourceSha256 !== initial.sourceSha256) throw new Error("Worker sources changed during runtime selection; restart electron:cloud");
  options.signal?.throwIfAborted();
  workspace.state.cloudRuntime = { sha256: record.sha256, sourceSha256: record.sourceSha256, commit: record.commit, at: new Date().toISOString() };
  save(workspace); return record.sha256;
}
