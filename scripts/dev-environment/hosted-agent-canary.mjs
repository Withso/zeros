import { nativeAgentCanary } from "./native-agent-canary.mjs";
export { canaryBudgetHours } from "./native-agent-canary.mjs";

export function hostedAgentRequest(state, profile, image) {
  const { workosUserId, workosOrganizationId, expectedEmail, expectedOrganizationSlug } = profile.fixture;
  const base = image.id ? state.resources.images?.find(row => row.qualified && !row.deleted && !row.snapshotDeleted &&
    row.inputsSha256 === state.source?.workerInputsSha256) : image;
  if (!base) throw new Error("Dev organization image requires the current worker base");
  const identity = value => ({ snapshotId: value.snapshotId, sourceCommit: value.sourceCommit, buildSha256: value.buildSha256 });
  return { owner: state.owner, generation: state.generation,
    fixture: { workosUserId, workosOrganizationId, expectedEmail, expectedOrganizationSlug },
    image: identity(base),
    ...(profile.boat?.accountScope ? { accountScope: profile.boat.accountScope } : {}),
    ...(profile.connections?.enabled ? { referenceMode: true } : {}),
    ...(image.id ? { organizationImage: { id: image.id, ...identity(image) } } : {}) };
}

export const hostedAgentCanary = nativeAgentCanary;
