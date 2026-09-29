import { CHANNELS, HostedReceipt, ReleaseIdentity, WorkerIdentity, requireCheck, type Channel, type Surface } from "./contracts";

type Candidate = { channel: Channel; sourceSha: string; branch: string; repository: string; runId: string; cloudRequired: boolean; provider?: string };
export async function publicationGate(config: Candidate, deps: {
  receipt(): Promise<unknown>; identity(): Promise<unknown>; page(surface: Surface): Promise<unknown>;
}) {
  // The adapter authenticates artifact/job provenance; repeat source/run
  // binding here so a caller cannot accidentally pass another release's proof.
  const parsed = HostedReceipt.safeParse(await deps.receipt());
  requireCheck(parsed.success, "Hosted publication receipt is invalid");
  const receipt = parsed.data;
  requireCheck(receipt.channel === config.channel && receipt.sourceSha === config.sourceSha && receipt.branch === config.branch &&
    receipt.repository === config.repository && receipt.runId === config.runId, "Hosted publication receipt belongs to another candidate");
  const current = ReleaseIdentity.safeParse(await deps.identity());
  requireCheck(current.success, "Current channel readiness is unavailable; desktop publication refused");
  const identity = current.data, expected = receipt.backend;
  requireCheck(identity.channel === config.channel && identity.sourceSha === config.sourceSha && expected.sourceSha === config.sourceSha &&
    identity.migrations.head === expected.migrations.head && identity.migrations.expectedHead === expected.migrations.expectedHead &&
    identity.migrations.manifestSha256 === expected.migrations.manifestSha256 && identity.cloud.enabled === expected.cloud.enabled &&
    JSON.stringify(identity.worker) === JSON.stringify(expected.worker), "Channel state superseded the hosted receipt; desktop publication refused");
  if (config.cloudRequired) requireCheck(identity.cloud.enabled && identity.cloud.state === "healthy" && identity.workerQualified === true &&
    WorkerIdentity.safeParse(expected.worker).success && identity.worker?.provider === config.provider,
  "Current cloud qualification does not authorize desktop publication");
  const surfaces: Surface[] = CHANNELS[config.channel].ops ? ["app", "ops"] : ["app"];
  requireCheck(receipt.pages.length === surfaces.length && surfaces.every(surface => receipt.pages.some(page => page.surface === surface)), "Hosted receipt lacks a Pages surface");
  for (const surface of surfaces) {
    const page = await deps.page(surface) as { version?: unknown; commitSha?: unknown; surface?: unknown } | null;
    requireCheck(page?.version === 1 && page.commitSha === config.sourceSha && page.surface === surface,
      "Current Pages source superseded the hosted receipt; desktop publication refused");
  }
}
