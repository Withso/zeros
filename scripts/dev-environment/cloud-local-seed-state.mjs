// electron:cloud seeds its isolated database once: the verified test
// organization, its Alpha GitHub connection and agent credentials. Only
// non-secret identifiers are kept in the instance's private state.
import path from "node:path";
import { readPrivateJson, writePrivateJson } from "./state.mjs";

// An explicit --seed runs in a separate process. Keep its binding and receipt
// together so a supervisor saving its process state cannot roll either back.
export function readLocalSeed(workspace) {
  let receipt;
  try { receipt = readPrivateJson(path.join(workspace.directory, "cloud-seed.json")); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { fixture: workspace.state.fixture, cloudSeed: workspace.state.cloudSeed };
  }
  if (receipt.instanceId !== workspace.state.instanceId || !receipt.fixture?.digest)
    throw new Error("Invalid seed binding for this development instance");
  return { fixture: receipt.fixture, cloudSeed: receipt.cloudSeed };
}

export function saveLocalSeed(workspace) {
  const { instanceId, fixture, cloudSeed } = workspace.state;
  writePrivateJson(path.join(workspace.directory, "cloud-seed.json"), { instanceId, fixture, cloudSeed });
}

export function cloudSeedNeeded(state, fixture) {
  if (state.cloudSeed?.seeded !== true) return true;
  return fixture?.staffAccess === false ? state.cloudSeed.staffRole !== null : !["developer", "platform_owner"].includes(state.cloudSeed.staffRole);
}

export function recordCloudSeed(state, result, now = new Date()) {
  if (result?.seeded === true && typeof result.organizationId === "string")
    state.cloudSeed = { seeded: true, organizationId: result.organizationId,
      ...([null, "developer", "platform_owner"].includes(result.staffRole) ? { staffRole: result.staffRole } : {}), at: now.toISOString() };
  return state;
}

export function cloudSeedMessage(result) {
  if (result?.seeded === true)
    return `Cloud test organization is ready with ${result.providers?.length ? result.providers.join(", ") : "no agent credentials"}`;
  if (result?.needsSignIn) return "Sign in to this Dev app, then run pnpm electron:cloud --seed";
  return "The cloud test organization seed did not complete; rerun pnpm electron:cloud --seed";
}
