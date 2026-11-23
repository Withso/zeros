// `pnpm --dir apps/control-plane cloud-v2:shared-base --plan|--execute`: this deployment's shared base for its pinned
// worker runtime, with the service's own configuration (loadConfig) and database. The builder makes it by itself;
// this is for operators and Dev. It prints names and closed codes only.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CloudV2SharedBaseOverride } from "../config.js";
import type { CloudV2Compute } from "./boat.js";
import { buildSharedBase, sharedBaseState, type CloudV2SharedBases, type SharedBaseBuildResult, type SharedBaseRuntime, type SharedBaseScope } from "./shared-base.js";

export const SHARED_BASE_CLI_USAGE = "cloud-v2:shared-base --plan | --execute";

export type SharedBaseCliDeps = {
  bases: CloudV2SharedBases; compute: CloudV2Compute; scope: SharedBaseScope; runtime: SharedBaseRuntime;
  override: CloudV2SharedBaseOverride | null; publicKeys?: readonly string[]; print(line: string): void;
};

/** Runs one invocation and returns its exit status: 0 when the base is ready (or, in plan mode, the plan was read). */
export async function runSharedBaseCli(args: readonly string[], deps: SharedBaseCliDeps): Promise<number> {
  let values: { plan?: boolean; execute?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({ args: [...args], options: { plan: { type: "boolean" }, execute: { type: "boolean" }, help: { type: "boolean" } }, strict: true }));
  } catch { deps.print(`usage: ${SHARED_BASE_CLI_USAGE}`); return 2; }
  if (values.help || values.plan === values.execute) { deps.print(`usage: ${SHARED_BASE_CLI_USAGE}`); return values.help ? 0 : 2; }
  const mode = values.plan ? "plan" : "execute";
  const state = await sharedBaseState(deps.bases, { ...deps.scope, runtimeSha256: deps.runtime.sha256, override: deps.override });
  deps.print(`shared base: configured ${state.state === "ready" ? state.name : "none"} (source ${
    state.state === "ready" ? state.source : state.state === "off" ? "override off" : "database"})`);
  deps.print(`runtime: ${deps.runtime.sha256.slice(0, 12)}`);
  const result = await buildSharedBase({ bases: deps.bases, compute: deps.compute, ...(deps.publicKeys ? { publicKeys: deps.publicKeys } : {}) },
    { ...deps.scope, runtime: deps.runtime, mode });
  for (const line of resultLines(result)) deps.print(line);
  return mode === "plan" ? 0 : result.code === "shared_base_ready" || result.code === "shared_base_exists" ? 0 : 1;
}

function resultLines(result: SharedBaseBuildResult): string[] {
  return [
    `code: ${result.code}`,
    ...(result.name ? [`name: ${result.name}`] : []),
    ...(result.exists !== undefined ? [`present at Boat: ${result.exists ? "yes" : "no"}`] : []),
    ...(result.nextAttemptAt ? [`next attempt: ${result.nextAttemptAt}`] : []),
    ...(result.steps ?? []).map((step, index) => `step ${index + 1}: ${step}`),
  ];
}

async function main(): Promise<void> {
  const [{ loadConfig }, { createPool }, { configureCloudPersonal }, { BoatApiClient }, { BoatCloudV2Compute }, { cloudV2Runtime }, { CloudV2WorkerSigner },
    { CloudV2SharedBases }] = await Promise.all([
    import("../config.js"), import("../db.js"), import("../db-context.js"), import("./boat-client.js"), import("./boat.js"), import("./runtime.js"),
    import("./worker-auth.js"), import("./shared-base.js")]);
  let config: ReturnType<typeof loadConfig>;
  try { config = loadConfig(process.env, { error: () => {}, warn: () => {} }); }
  catch { console.error("code: shared_base_configuration"); process.exitCode = 1; return; }
  const v2 = config.cloudV2;
  if (!v2) { console.error("code: shared_base_cloud_disabled"); process.exitCode = 1; return; }
  const localOwner = config.development && !("generation" in config.development) ? config.development.owner : undefined;
  const pool = createPool(config.databaseUrl, { workload: "worker", applicationName: "zeros-shared-base", maxConnections: 2 });
  configureCloudPersonal(pool, v2.personalCloud === true);
  try {
    const compute = new BoatCloudV2Compute(new BoatApiClient({ apiKey: v2.boat.apiKey, timeoutMs: 120_000, ...(v2.boat.billingOrg ? { billingOrg: v2.boat.billingOrg } : {}) }));
    process.exitCode = await runSharedBaseCli(process.argv.slice(2), {
      bases: new CloudV2SharedBases(pool), compute, scope: { channel: config.deploymentChannel, localOwner },
      runtime: cloudV2Runtime(v2.runtime.sha256, v2.runtime.store), override: v2.sharedBaseOverride ?? null,
      publicKeys: new CloudV2WorkerSigner(v2.workerSigningKey, v2.workerSigningKeyPrevious).publicKeys, print: line => console.log(line),
    });
  } finally { await pool.end(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error("code: shared_base_build_failed"); process.exitCode = 1; });
}
