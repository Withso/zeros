import path from "node:path";
import { pathToFileURL } from "node:url";
import { runtimeSourceIdentity } from "../../apps/cloud-worker/scripts/package-runtime.mjs";
import { run } from "./processes.mjs";
import { saveWorkspace, systemEnvironment, writePrivateFile } from "./state.mjs";

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

/** Refresh cadence for a running checkout's runtime marker: well inside the week a runtime stays unmarked. */
export const RUNTIME_USE_REFRESH_MS = 24 * 60 * 60_000;
const checkout = workspace => ({ owner: workspace.state.owner, instance: workspace.state.instanceId });
const controlPlane = (root, options) => options.module ?? (name => import(pathToFileURL(path.join(root, "apps/control-plane/dist/cloud", name)).href));

async function withRuntimeStorage(profile, root, options, work) {
  const module = controlPlane(root, options);
  const [retention, source] = await Promise.all([module("runtime-retention.js"), module("runtime-source.js")]);
  const client = source.runtimeStorageClient(profile.storage);
  try { return await work(retention, client); } finally { client.destroy(); }
}

// The previous pin a wake may still start (ZEROS_CLOUD_V2_RUNTIME_PREVIOUS_SHA256) is in use too.
const runtimesInUse = (sha256, previous) => [sha256, ...(SHA.test(previous ?? "") && previous !== sha256 ? [previous] : [])];

/** Marks the runtimes this checkout runs, so other checkouts' cleanup keeps them. */
export function markLocalRuntime(workspace, profile, root, sha256, options = {}) {
  return withRuntimeStorage(profile, root, options, async (retention, client) => {
    for (const runtime of runtimesInUse(sha256, options.previous)) await retention.recordRuntimeUse(client, profile.storage.bucket, runtime, checkout(workspace));
  });
}

/** On start: mark this checkout's runtime, then plan (or, with ZEROS_DEV_RUNTIME_RETENTION=apply, run) Dev cleanup.
 * The plan is kept beside this checkout's state for review. */
export function maintainLocalRuntimes(workspace, profile, root, sha256, options = {}) {
  return withRuntimeStorage(profile, root, options, async (retention, client) => {
    const [current, previous = null] = runtimesInUse(sha256, options.previous);
    for (const runtime of [current, ...(previous ? [previous] : [])]) await retention.recordRuntimeUse(client, profile.storage.bucket, runtime, checkout(workspace));
    const mode = retention.devRuntimeRetentionMode((options.env ?? process.env).ZEROS_DEV_RUNTIME_RETENTION);
    const plan = await retention.retainDevRuntimes(client, profile.storage.bucket, { current, previous, mode });
    (options.write ?? writePrivateFile)(path.join(workspace.directory, "runtime-retention.json"), `${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  });
}

/** `--reset`: this checkout stops marking any runtime; other checkouts' cleanup removes what nobody uses. */
export function removeLocalRuntimeUses(workspace, profile, root, options = {}) {
  return withRuntimeStorage(profile, root, options, (retention, client) =>
    retention.removeRuntimeUses(client, profile.storage.bucket, workspace.state.instanceId));
}

export function runtimeRetentionSummary(plan) {
  const gb = (plan.bytes / 1e9).toFixed(1), count = `${plan.remove.length} unused runtime${plan.remove.length === 1 ? "" : "s"} (${gb} GB)`;
  if (plan.status === "managed") return "Worker runtime cleanup skipped: this store is release-managed.";
  const unmarked = plan.kept.filter(item => item.reason === "unmarked").length;
  const kept = unmarked ? ` ${unmarked} never-marked runtime${unmarked === 1 ? " is" : "s are"} kept.` : "";
  if (plan.status === "deleted") return `Worker runtime cleanup removed ${count}.${kept}`;
  return `Worker runtime cleanup (${plan.mode}) would remove ${count}${plan.mode === "dry-run" ? "; set ZEROS_DEV_RUNTIME_RETENTION=apply to remove them" : ""}.${kept}`;
}
