#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHostedProfile, hostedProfileIssues } from "./hosted-profile.mjs";
import { readPrivateJson, privateDirectory, withHostedMutation } from "./state.mjs";
import { r2Registry } from "./hosted-state.mjs";
import { planHostedGc, applyHostedGc } from "./hosted-gc.mjs";
import { hostedServices } from "./hosted-services.mjs";
import { inventoryHostedProviders } from "./hosted-inventory.mjs";

export function assertScheduledGcRuntime(env, version = process.versions.node) {
  if (!/^22\.(\d+)\.\d+$/.test(version) || Number(version.split(".")[1]) < 18) throw new Error("Scheduled GC requires qualified Node 22.18+ in the 22.x line");
  if (!env.ZEROS_DEV_GC_PROFILE_PATH || !path.isAbsolute(env.ZEROS_DEV_GC_PROFILE_PATH)) throw new Error("Scheduled GC requires an absolute private profile path");
}

export function gcOptions(args) {
  const result = { apply: false, json: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--apply", "--json", "--all"].includes(arg)) result[arg.slice(2)] = true;
    else if (["--owner", "--generation"].includes(arg) && args[index + 1] && !args[index + 1].startsWith("--")) result[arg.slice(2)] = args[++index];
    else throw new Error("Use dev:gc [--apply] [--all | --owner OWNER [--generation UUID]] [--json]");
  }
  if (result.all && result.owner || result.generation && !result.owner || result.owner && !/^[a-f0-9]{24}$/.test(result.owner) ||
      result.generation && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result.generation)) throw new Error("Invalid Dev GC scope");
  return result;
}

export async function runHostedGcCli(args = process.argv.slice(2), env = process.env) {
  const options = gcOptions(args), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const profile = env.ZEROS_DEV_GC_PROFILE_PATH ? readPrivateJson(env.ZEROS_DEV_GC_PROFILE_PATH) : loadHostedProfile(root, { env });
  const issues = hostedProfileIssues(profile); if (issues.length) throw new Error(issues.join("\n"));
  const store = r2Registry(profile.registry);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-dev-gc-")); fs.chmodSync(directory, 0o700);
  try {
    const plan = await planHostedGc(store, profile, { ...options, inventory: () => inventoryHostedProviders(profile) });
    let outcome;
    if (options.apply) outcome = await applyHostedGc(store, profile, plan, async state => {
      const local = privateDirectory(directory, state.owner);
      return hostedServices(root, local, profile, () => {}, { registry: store });
    }, { mutation: (entry, operation) => withHostedMutation(privateDirectory(directory, entry.owner), entry, operation) });
    const report = { mode: options.apply ? "apply" : "read-only-plan", plan, ...(outcome ? { outcome } : {}) };
    console.log(JSON.stringify(report, null, options.json ? 0 : 2));
    return !outcome || outcome.complete;
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHostedGcCli().then(ok => { if (!ok) process.exitCode = 1; }).catch(() => {
    console.error("Dev GC could not confirm its plan/cleanup; receipts and uncertain reservations were preserved."); process.exitCode = 1;
  });
}
