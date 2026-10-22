// electron:cloud seeds its isolated database once: the verified test
// organization, its Alpha GitHub connection and agent credentials. Only
// non-secret identifiers are kept in the instance's private state.

export function cloudSeedNeeded(state) {
  return state.cloudSeed?.seeded !== true;
}

export function recordCloudSeed(state, result, now = new Date()) {
  if (result?.seeded === true && typeof result.organizationId === "string")
    state.cloudSeed = { seeded: true, organizationId: result.organizationId, at: now.toISOString() };
  return state;
}

export function cloudSeedMessage(result) {
  if (result?.seeded === true)
    return `Cloud test organization is ready with ${result.providers?.length ? result.providers.join(", ") : "no agent credentials"}`;
  if (result?.needsSignIn) return "Sign in to this Dev app, then run pnpm electron:cloud --seed";
  return "The cloud test organization seed did not complete; rerun pnpm electron:cloud --seed";
}
