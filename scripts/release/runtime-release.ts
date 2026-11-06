import { RuntimeReleaseSchema, type RuntimeRelease } from "../../apps/control-plane/src/cloud/runtime-release";
import { PromotionError, requireCheck } from "./contracts";
import { sleep } from "./io";
import { RuntimeManifest, assertRuntimeLive, type RuntimeReleaseConfig, type RuntimeLiveState, type RuntimePin, type RuntimeReleaseReceipt } from "./runtime-contracts";
import { boundRuntimeDrainLease, assertActiveRuntimeDrain, assertRuntimeDrainReleased,
  assertRuntimeDrainBudget, RUNTIME_STAGE_BUDGET_MS, RUNTIME_READINESS_BUDGET_MS, RUNTIME_CLEANUP_BUDGET_MS,
  type RuntimeDrainLease, type RuntimeDrainStatus, type RuntimeDrainEnd } from "./runtime-drain";

export { assertEmptyRuntimeDrain } from "./runtime-drain";
export type { RuntimeDrainLease, RuntimeDrainStatus, RuntimeDrainEnd } from "./runtime-drain";
export type { RuntimeReleaseReceipt } from "./runtime-contracts";
export type RuntimeReleaseDependencies = {
  source(): Promise<void>;
  current(staged?: RuntimePin): Promise<RuntimeLiveState>;
  prepare(digest?: string): Promise<RuntimeManifest>;
  qualify(manifest: RuntimeManifest): Promise<RuntimeRelease>;
  qualification(manifest: RuntimeManifest, origin: { runId: string; runAttempt: number }, pinnedPrevious?: RuntimeRelease): Promise<RuntimeRelease>;
  retain(current: RuntimePin): Promise<void>;
  beginDrain(): Promise<RuntimeDrainStatus>;
  inspectDrain(lease: RuntimeDrainLease): Promise<RuntimeDrainStatus>;
  endDrain(lease: RuntimeDrainLease): Promise<RuntimeDrainEnd>;
  pause?(ms: number): Promise<void>;
  stage(target: RuntimePin, previous: RuntimePin, lease: RuntimeDrainLease): Promise<void>;
  deploy(cpSha: string, lease: RuntimeDrainLease): Promise<string>;
  wait(deploymentId: string, target: RuntimePin, lease: RuntimeDrainLease): Promise<void>;
  recover(lease: RuntimeDrainLease): Promise<{ releaseDrain: boolean }>;
  record(receipt: RuntimeReleaseReceipt): Promise<void>;
};

export async function releaseRuntime(config: RuntimeReleaseConfig, deps: RuntimeReleaseDependencies): Promise<RuntimeReleaseReceipt> {
  let stage = "source validation", lease: RuntimeDrainLease | undefined, releaseAttempted = false, pinAttempted = false;
  let receipt: RuntimeReleaseReceipt | undefined, failure: Error | undefined;
  try {
    await deps.source();
    stage = "live identity";
    const live = await deps.current(); assertRuntimeLive(config, live);
    const digest = config.action === "rollback" ? live.previous?.sha256 : config.runtimeSha256;
    if (config.action === "rollback") requireCheck(digest && digest !== live.current.sha256, "The channel has no distinct previous runtime pin");
    stage = "archive preparation";
    const manifest = RuntimeManifest.parse(await deps.prepare(digest));
    requireCheck(manifest.repository === config.repository &&
      (config.action === "publish" ? manifest.sourceSha === config.sourceSha : manifest.sha256 === digest), "Runtime archive does not match the selected immutable source or digest");
    requireCheck(manifest.sha256 !== live.current.sha256, "The selected runtime digest is already active; the previous rollback pin is preserved");
    stage = "runtime publication provenance";
    let release: RuntimeRelease;
    if (config.channel === "alpha") release = RuntimeReleaseSchema.parse(await deps.qualify(manifest));
    else {
      const origin = config.action === "rollback" ? live.previous?.release?.qualification
        : config.alphaRunId && config.alphaRunAttempt ? { runId: config.alphaRunId, runAttempt: config.alphaRunAttempt } : undefined;
      requireCheck(origin, "The selected runtime has no retained Alpha qualification");
      release = RuntimeReleaseSchema.parse(await (config.action === "rollback"
        ? deps.qualification(manifest, origin, live.previous!.release!) : deps.qualification(manifest, origin)));
    }
    requireCheck(release.sha256 === manifest.sha256 && release.sourceSha === manifest.sourceSha && release.sourceSha256 === manifest.sourceSha256,
      "Runtime qualification does not match the exact archive");
    requireCheck(config.channel !== "alpha" || release.qualification.runId === config.runId && release.qualification.runAttempt === config.runAttempt,
      "Alpha qualification does not belong to this exact release attempt");
    const target: RuntimePin = { sha256: release.sha256, release };
    stage = "previous runtime retention";
    await deps.retain(live.current);
    await deps.source();
    assertRuntimeLive(config, await deps.current());
    stage = "build drain";
    let beginning: RuntimeDrainStatus;
    try { beginning = await deps.beginDrain(); }
    catch (error) {
      try { lease = boundRuntimeDrainLease(config, (await deps.beginDrain()).lease); } catch { /* Unconfirmed ownership cannot release another run. */ }
      throw error;
    }
    lease = boundRuntimeDrainLease(config, beginning?.lease);
    let drain = assertActiveRuntimeDrain(config, lease, beginning);
    for (let attempts = 0; !drain.ready; attempts++) {
      requireCheck(attempts < 90, "Build drain did not become empty before its bound");
      await (deps.pause ?? sleep)(10_000);
      drain = assertActiveRuntimeDrain(config, lease, await deps.inspectDrain(lease));
    }
    stage = "pin staging";
    await deps.source();
    assertRuntimeLive(config, await deps.current());
    assertRuntimeDrainBudget(config, lease, await deps.inspectDrain(lease), RUNTIME_STAGE_BUDGET_MS);
    pinAttempted = true;
    await deps.stage(target, live.current, lease);
    stage = "unchanged control-plane deploy";
    assertRuntimeLive(config, await deps.current(target));
    assertRuntimeDrainBudget(config, lease, await deps.inspectDrain(lease), RUNTIME_READINESS_BUDGET_MS + RUNTIME_CLEANUP_BUDGET_MS);
    const deploymentId = await deps.deploy(config.expectedCpSha, lease);
    stage = "deployed runtime readiness";
    await deps.wait(deploymentId, target, lease);
    receipt = { version: 1, status: "success", channel: config.channel, action: config.action, repository: config.repository,
      workflowSha: config.workflowSha, runId: config.runId, runAttempt: config.runAttempt, cpSourceSha: config.expectedCpSha,
      previousRuntimeSha256: live.current.sha256, runtime: release, deploymentId, completedAt: new Date().toISOString() };
  } catch (error) {
    failure = new PromotionError(error instanceof PromotionError ? error.message : `Runtime release stopped at ${stage}; reconcile any unacknowledged operation before retrying.`);
  } finally {
    if (lease) {
      let safe = true;
      if (failure && pinAttempted) {
        try { safe = (await deps.recover(lease)).releaseDrain === true; } catch { safe = false; }
      }
      if (safe) {
        releaseAttempted = true;
        try { assertRuntimeDrainReleased(config, lease, await deps.endDrain(lease)); }
        catch { failure ??= new PromotionError("Runtime release stopped at build-drain release; expiry remains the recovery boundary"); }
      } else failure = new PromotionError("Runtime rollout or staged-pin recovery is unconfirmed; the drain remains held until expiry");
    }
  }
  if (failure) throw failure;
  requireCheck(receipt && releaseAttempted, "Runtime release did not produce confirmed authority");
  try { await deps.record(receipt); }
  catch { throw new PromotionError("Runtime release completed but its durable receipt is unconfirmed; reconcile before retrying"); }
  return receipt;
}
