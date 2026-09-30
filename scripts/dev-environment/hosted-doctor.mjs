/** A fixed projection keeps credentials and provider bodies out of diagnostics. */
export function hostedDiagnostic(state) {
  const resources = state.resources ?? {};
  const journals = [["database", resources.planetscale?.create], ["database-runtime", resources.planetscale?.roles?.runtime?.create],
    ["database-migration", resources.planetscale?.roles?.migration?.create], ["railway", resources.railway?.create],
    ["railway-service", resources.railway?.service?.create], ["railway-upload", resources.railway?.uploadCreate],
    ["railway-domain", resources.railway?.domain?.create], ["pages", resources.pages?.create], ["pages-domain", resources.pages?.domain?.create],
    ["webhook", resources.workos?.create], ["agent-ssh", resources.agentSsh?.create],
    ...(resources.dns ?? []).map((row, index) => [`dns:${index}`, row.create]),
    ...(resources.images ?? []).flatMap((row, index) => [[`builder:${index}`, row.builderCreate], [`snapshot:${index}`, row.snapshotCreate]])];
  return {
    owner: state.owner, generation: state.generation, status: state.status,
    source: state.source?.sourceSha256 ?? null, archiveRequestedAt: state.archiveRequestedAt ?? null,
    expiresAt: state.expiresAt ?? null, lastUserActivityAt: state.lastUserActivityAt ?? null,
    completedCleanupSteps: Object.keys(state.steps ?? {}).filter(key => state.steps[key]),
    cleanupFailures: state.cleanupFailures ?? {},
    createJournals: journals.filter(([, journal]) => journal).map(([resource, journal]) => ({ resource,
      phase: ["planned", "dispatching", "acknowledged", "rejected", "uncertain"].includes(journal.phase) ? journal.phase : "unknown",
      ...(Number.isSafeInteger(journal.attempt) && journal.attempt > 0 ? { attempt: journal.attempt } : {}),
      ...(Number.isInteger(journal.outcome) && journal.outcome >= 100 && journal.outcome < 600 ? { outcome: journal.outcome } : {}),
      ...(/^[A-Za-z0-9_-]{1,100}$/.test(journal.requestId ?? "") ? { requestId: journal.requestId } : {}),
    })),
    railwayEnvironmentId: state.resources.railway?.id ?? null,
    planetScaleBranch: state.resources.planetscale?.name ?? null,
    pagesProject: state.resources.pages?.name ?? null,
    images: (state.resources.images ?? []).map(r => ({ name: r.snapshotId, qualified: Boolean(r.qualified), retired: Boolean(r.snapshotDeleted) })),
    retiredImages: (state.retiredImages ?? []).map(r => ({ name: r.name, retiredAt: r.retiredAt, backingStorage: r.backingStorage })),
    pendingDeletions: [...(state.pendingBuilderDeletions ?? []), ...(state.pendingWorkerDeletions ?? [])]
      .map(r => ({ id: r.id, operation: r.deletionOperationId, stage: r.deletionStage, expectedBy: r.deletionExpectedBy ?? null,
        retiredAt: r.retiredAt, lastAttemptAt: r.lastReconcileAt ?? null, attempts: r.reconcileAttempts ?? 0,
        retryAfter: r.retryAfter ?? null, unconfirmed: Boolean(r.reconcileUnconfirmed),
        deadlineBreached: Number.isFinite(Date.parse(r.deletionExpectedBy)) && Date.parse(r.deletionExpectedBy) < Date.now() })),
    agentTests: (state.agentQualifications ?? []).map(job => ({ provider: job.connection.provider, kind: job.connection.kind,
      image: job.image.snapshotId, phase: job.phase, retired: Boolean(job.retired), failure: job.failure })),
  };
}

export async function inspectHostedLive(state, profile, dependencies = {}) {
  const { inspectRailwayEnvironment, railwayDevClient } = await import("./railway.mjs");
  const { verifyPlanetScaleRuntimeRole, planetScaleDevClient } = await import("./planetscale.mjs");
  const { hostedCloudflareClient } = await import("./hosted-cloudflare.mjs");
  const { devBoatClient } = await import("./hosted-image.mjs");
  const { providerJson } = await import("./provider-http.mjs");
  const { hostedPublicProfile } = await import("./hosted-profile.mjs");
  const lease = { state }, checks = [];
  const check = async (resource, verify) => {
    try { checks.push({ resource, status: await verify() ? "confirmed" : "missing-or-changed" }); }
    catch { checks.push({ resource, status: "unconfirmed" }); }
  };
  if (state.status === "ready" && state.source) {
    await check("backend-health", async () => {
      const publicProfile = hostedPublicProfile(state, profile);
      const result = await providerJson("Dev health", `${publicProfile.apiOrigin}/healthz`, { timeoutMs: 5000 }, dependencies.fetch ?? fetch);
      const value = result.body?.development;
      if (![200, 404].includes(result.status)) throw new Error("Dev health unavailable");
      return value?.owner === state.owner && value.generation === state.generation && value.runId === state.runId &&
        value.sourceSha256 === state.source.sourceSha256 && value.workerInputsSha256 === state.source.workerInputsSha256;
    });
  }
  if (state.resources.railway) await check("railway", () => inspectRailwayEnvironment(lease, profile.railway, dependencies.railway ?? railwayDevClient(profile.railway)));
  if (state.resources.planetscale) await check("database-role", async () => {
    await verifyPlanetScaleRuntimeRole(lease, profile.planetscale, dependencies.ps ?? planetScaleDevClient(profile.planetscale)); return true;
  });
  if (state.resources.pages) await check("pages", async () => {
    const current = await (dependencies.cf ?? hostedCloudflareClient(profile.cloudflare))(`/accounts/${profile.cloudflare.accountId}/pages/projects/${state.resources.pages.name}`, { absent: true });
    return current?.id === state.resources.pages.id && current?.deployment_configs?.production?.env_vars?.ZEROS_DEV_OWNER?.value === state.owner &&
      current?.deployment_configs?.production?.env_vars?.ZEROS_DEV_GENERATION?.value === state.generation;
  });
  for (const image of state.resources.images ?? []) {
    if (!image.snapshotId || image.snapshotDeleted) continue;
    await check(`snapshot:${image.snapshotId}`, async () => {
      const result = await (dependencies.boat ?? devBoatClient(profile.boat))("GET", `/named-snapshots/${image.snapshotId}`);
      if (![200, 404].includes(result.status)) throw new Error("Snapshot inventory is unconfirmed");
      return result.status === 200 && result.body?.snapshot?.name === image.snapshotId && result.body.snapshot.sourceSandboxId === image.builder?.id && result.body.snapshot.status === "ready";
    });
  }
  return checks;
}
