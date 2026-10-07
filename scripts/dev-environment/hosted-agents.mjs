import { refuseRetiredDevNativeCanary } from "./native-agent-retirement.mjs";
export { QUALIFICATION_DEADLINE_MS, nativeRuntimeEvidence, qualificationRateLimited } from "./native-agent-canary.mjs";

/** Retire recorded attempts without dispatching or approving new native work. */
export async function retireUnfinishedHostedAgents(lease, deps) {
  let retired = 0;
  for (const job of (lease.state.agentQualifications ?? []).filter(row => !row.retired)) {
    if (job.phase !== "failed" && job.phase !== "enabled") { job.phase = "failed"; job.failure ??= { stage: "superseded" }; await lease.save(); }
    await deps.retire(job); job.retired = true; await lease.save(); retired++;
  }
  return retired;
}

export async function advanceHostedAgents(lease, profile) {
  if (lease.state.status !== "ready" || !profile.fixture) return { state: "inactive" };
  refuseRetiredDevNativeCanary();
}
