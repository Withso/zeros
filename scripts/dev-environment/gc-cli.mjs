#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadHostedProfile, hostedProfileIssues } from "./hosted-profile.mjs";
import { readPrivateJson, privateDirectory, withHostedMutation } from "./state.mjs";
import { r2Registry } from "./hosted-state.mjs";
import { planHostedGc, applyHostedGc } from "./hosted-gc.mjs";
import { hostedServices } from "./hosted-services.mjs";
import { inventoryHostedProviders } from "./hosted-inventory.mjs";
import { checkControlPlaneDependencies, DevEnvironmentError, devEnvironmentDiagnostic, devEnvironmentFailure } from "./dependency-preflight.mjs";

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function gcPlanSha256(plan) {
  // Observation time and provider listing order do not change the reviewed
  // scope. Eligibility, exact authenticated target digests and quarantine do.
  const sorted = rows => rows.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash("sha256").update(JSON.stringify(canonical({ version: plan.version,
    entries: sorted(plan.entries), quarantine: sorted(plan.quarantine) }))).digest("hex");
}

export function assertScheduledGcRuntime(env, version = process.versions.node) {
  if (!/^22\.(\d+)\.\d+$/.test(version) || Number(version.split(".")[1]) < 18) throw new Error("Scheduled GC requires qualified Node 22.18+ in the 22.x line");
  if (!env.ZEROS_DEV_GC_PROFILE_PATH || !path.isAbsolute(env.ZEROS_DEV_GC_PROFILE_PATH)) throw new Error("Scheduled GC requires an absolute private profile path");
}

export function gcOptions(args) {
  const result = { apply: false, json: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--apply", "--json", "--all"].includes(arg)) result[arg.slice(2)] = true;
    else if (["--owner", "--generation", "--expect-plan"].includes(arg) && args[index + 1] && !args[index + 1].startsWith("--")) {
      if (result[arg.slice(2)] !== undefined) throw new DevEnvironmentError("gc_input_invalid");
      result[arg.slice(2)] = args[++index];
    } else throw new DevEnvironmentError("gc_input_invalid");
  }
  if (result.all && result.owner || result.generation && !result.owner || result.owner && !/^[a-f0-9]{24}$/.test(result.owner) ||
      result.generation && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result.generation) ||
      result["expect-plan"] !== undefined && (!result.apply || !/^[a-f0-9]{64}$/.test(result["expect-plan"]))) throw new DevEnvironmentError("gc_input_invalid");
  return result;
}

export async function runHostedGcCli(args = process.argv.slice(2), env = process.env,
  { platform = process.platform, checkDependencies = checkControlPlaneDependencies } = {}) {
  const options = gcOptions(args), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  if (options.apply && platform !== "darwin") throw new DevEnvironmentError("gc_apply_requires_macos");
  if (options.apply && !options["expect-plan"]) throw new DevEnvironmentError("gc_plan_confirmation_required");
  checkDependencies(root);
  let profile, store;
  try {
    profile = env.ZEROS_DEV_GC_PROFILE_PATH ? readPrivateJson(env.ZEROS_DEV_GC_PROFILE_PATH) : loadHostedProfile(root, { env });
    if (hostedProfileIssues(profile).length) throw new DevEnvironmentError("gc_profile_invalid");
    store = r2Registry(profile.registry);
  } catch (error) { throw devEnvironmentFailure(error, "gc_profile_invalid"); }
  let directory;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-dev-gc-")); fs.chmodSync(directory, 0o700);
    let plan;
    try { plan = await planHostedGc(store, profile, { ...options, inventory: () => inventoryHostedProviders(profile) }); }
    catch (error) { throw devEnvironmentFailure(error, "gc_inventory_unavailable"); }
    const planSha256 = gcPlanSha256(plan), report = { mode: "read-only-plan", plan, planSha256 };
    console.log(JSON.stringify(report, null, options.json ? 0 : 2));
    let outcome;
    if (options.apply) {
      if (options["expect-plan"] !== planSha256) throw new DevEnvironmentError("gc_plan_changed");
      try {
        outcome = await applyHostedGc(store, profile, plan, async state => {
          const local = privateDirectory(directory, state.owner);
          return hostedServices(root, local, profile, () => {}, { registry: store });
        }, { mutation: (entry, operation) => withHostedMutation(privateDirectory(directory, entry.owner), entry, operation) });
      } catch (error) { throw devEnvironmentFailure(error, "gc_cleanup_unconfirmed"); }
      console.log(JSON.stringify({ ...report, mode: "apply", outcome }, null, options.json ? 0 : 2));
    }
    return !outcome || outcome.complete;
  } finally {
    try { store.close(); }
    finally { if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHostedGcCli().then(ok => { if (!ok) process.exitCode = 1; }).catch(error => {
    console.error(JSON.stringify(devEnvironmentDiagnostic(error))); process.exitCode = 1;
  });
}
