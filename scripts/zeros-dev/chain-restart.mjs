// Owner-reviewed chain restart, approved with the fixture password reset and
// device re-enrollment. The private key that signed this exact receipt was lost
// with its host, so no successor can authenticate it. Crossing it starts a new
// signed chain; it is not cleanup authority, a pass or a generic reset. Its
// carried workspaces remain on the product account, where prior_cleanup still
// refuses allocation until none outside the new allowlist remain.
export const CHAIN_RESTART = Object.freeze({
  version: 1,
  workflowRunId: "38737559526",
  attempt: 1,
  sourceSha: "a57a361d35275279dea209f85f9df9aaec8805b2",
  artifactId: "11977255852",
  artifactDigest: "sha256:dedd838cf5e53c4a9146331f11a794a983153792d59350c3a173b5fe54e8bee4",
  receiptSha256: "2a2abb9eb07b460ae07a21719aaf4229b36e589f606a100746d7f5f5fef9c5c3",
  retiredDeviceId: "d5d457f9-86e6-4611-a757-88e0ad2df64a",
  approvedOn: "2026-10-16",
  reason: "fixture device key lost with its host; owner-approved restart",
});

// Any pinned identifier selects the record; every other one must then match.
export function reviewedChainRestart(run, artifact) {
  if (String(run.id) !== CHAIN_RESTART.workflowRunId && String(artifact.id) !== CHAIN_RESTART.artifactId &&
    artifact.digest !== CHAIN_RESTART.artifactDigest) return null;
  if (String(run.id) !== CHAIN_RESTART.workflowRunId || run.run_attempt !== CHAIN_RESTART.attempt ||
    run.head_sha !== CHAIN_RESTART.sourceSha || run.event !== "workflow_dispatch" || run.status !== "completed" ||
    run.conclusion !== "failure" || String(artifact.id) !== CHAIN_RESTART.artifactId ||
    artifact.name !== `zeros-dev-receipt-${CHAIN_RESTART.workflowRunId}-${CHAIN_RESTART.attempt}` ||
    artifact.digest !== CHAIN_RESTART.artifactDigest || String(artifact.workflow_run?.id) !== CHAIN_RESTART.workflowRunId ||
    artifact.workflow_run?.head_sha !== CHAIN_RESTART.sourceSha) throw new Error("zeros_dev_chain_restart_mismatch");
  return { ...CHAIN_RESTART };
}
