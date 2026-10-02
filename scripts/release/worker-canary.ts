import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CHECKS, NATIVE_EXTENSIONS, QUALIFICATION_DEADLINE_MS } from "../dev-environment/native-agent-canary.mjs";
import { PromotionError, requireCheck } from "./contracts";
import { sleep } from "./io";
import type { WorkerCandidate } from "./worker";
import { ReleaseCanaryPrelaunchError, type ReleaseCanaryConnection } from "./worker-broker";
import { ReleaseCanaryPrelaunchFailureSchema } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";
import type { WorkerQualificationProfile } from "./worker-profile";

export function fixedCanaryOutcome(value: any, expected?: { kind: string; model: string; image: WorkerCandidate }) {
  const report = value?.report;
  const checks = [...CHECKS, ...NATIVE_EXTENSIONS, "nativePermissionSelection", "nativeAccessRefresh", "nativeGitAuthor", "nativeMcpRotation", "nativeMcpRemoval", "nativeMcpOwnerHandoff"];
  const integer = (number: unknown) => Number.isInteger(number) && Math.abs(number as number) <= 256 ? number : null;
  return { code: integer(value?.code), retirement: integer(value?.retirement), ...(value?.errorKind === "rate-limited" ? { errorKind: "rate-limited" } : {}),
    report: { version: report?.version === 3 ? 3 : null, qualified: report?.qualified === true,
      qualificationProfile: ["smoke", "full"].includes(report?.qualificationProfile) ? report.qualificationProfile : undefined,
      executionProfile: report?.executionProfile === "zeros-cloud-native-v1" ? "zeros-cloud-native-v1" : undefined,
      authority: report?.authority === "isolated-image-canary" ? "isolated-image-canary" : undefined,
      qualifiedAt: typeof report?.qualifiedAt === "string" && z.string().datetime().safeParse(report.qualifiedAt).success ? report.qualifiedAt : undefined,
      identity: { sourceCommit: /^[a-f0-9]{40}$/.test(report?.identity?.sourceCommit ?? "") ? report.identity.sourceCommit : undefined,
        buildSha256: /^[a-f0-9]{64}$/.test(report?.identity?.buildSha256 ?? "") ? report.identity.buildSha256 : undefined,
        contractSha256: /^[a-f0-9]{64}$/.test(report?.identity?.contractSha256 ?? "") ? report.identity.contractSha256 : undefined,
        kind: ["claude-setup-token", "codex-chatgpt", "cursor-api-key"].includes(report?.identity?.kind) && (!expected || report.identity.kind === expected.kind) ? report.identity.kind : undefined,
        model: expected && report?.identity?.model === expected.model ? expected.model : undefined },
      checks: Array.isArray(report?.checks) ? checks.filter(check => report.checks.includes(check)) : [],
      failureKind: report?.failureKind === "rate-limited" || report?.errorKind === "rate-limited" ? "rate-limited" : undefined },
    ...(value?.renewal ? { renewal: Object.fromEntries(["accountBinding", "accessChanged", "cachePublished", "consentPreserved"].map(check => [check, value.renewal[check] === true])) } : {}) };
}

export function releaseCanaryAdapter(lease: any, run: any, credentials: Map<string, ReleaseCanaryConnection>, core: any, options: {
  pause?: (ms: number) => Promise<void>; now?: () => number; qualificationProfile?: WorkerQualificationProfile;
} = {}) {
  const now = options.now ?? Date.now, pause = options.pause ?? sleep;
  const qualificationProfile = options.qualificationProfile ?? "full";
  const jobs = run.canaries ??= [];
  const finish = async (job: any) => { if (!job.retired) { await core.retire(job); job.retired = true; await lease.save(); } };
  return {
    async qualify(image: WorkerCandidate, kind: string) {
      const credential = credentials.get(kind);
      requireCheck(credential, "Dedicated canary credential kind is missing");
      let job = jobs.find((row: any) => row.kind === kind);
      if (!job) {
        requireCheck(jobs.length < 3, "Release native canary history exceeds its three-kind matrix");
        job = { id: randomUUID(), ...credential, qualificationProfile, phase: "allocating", startedAt: now(), image: { snapshotId: image.snapshotId, sourceCommit: image.sourceCommit, buildSha256: image.buildSha256 } };
        jobs.push(job); await lease.save();
      }
      requireCheck(job.image.snapshotId === image.snapshotId && job.image.sourceCommit === image.sourceCommit && job.image.buildSha256 === image.buildSha256,
        "Release canary belongs to a different immutable worker image");
      requireCheck((job.model ?? credential.model) === credential.model && (job.qualificationProfile ?? "full") === qualificationProfile, "Release canary profile or model changed during recovery");
      requireCheck(job.credentialId === credential.credentialId && job.credentialRevision === credential.credentialRevision && job.designationId === credential.designationId,
        "Release canary credential designation binding changed during recovery");
      if (job.prelaunchFailure !== undefined) {
        requireCheck(ReleaseCanaryPrelaunchFailureSchema.safeParse(job.prelaunchFailure).success, "Release canary prelaunch diagnostic is invalid; reconcile before retrying");
        throw new ReleaseCanaryPrelaunchError();
      }
      requireCheck(!job.auditRetired || job.outcome, "Release canary operation is physically retired; a fresh release operation is required");
      if (job.phase === "allocating") {
        await lease.fence(); await core.allocate(job, image);
        let attested = false;
        for (let attempt = 0; attempt < 60 && now() - job.startedAt < 5 * 60_000; attempt++) {
          const ready = await core.ready(job);
          requireCheck(ready !== "failed", "Release canary clone failed machine attestation; no account material was dispatched");
          if (ready === true) { attested = true; break; }
          await pause(5000);
        }
        requireCheck(attested, "Release canary clone attestation timed out; no account material was dispatched");
        job.phase = "starting"; await lease.save(); await lease.fence();
        try {
          await core.start(job, { version: 1, qualificationProfile, sourceCommit: image.sourceCommit, buildSha256: image.buildSha256, model: credential.model, kind });
          job.phase = "running"; await lease.save();
        } catch (error) {
          await lease.fence();
          if (error instanceof ReleaseCanaryPrelaunchError) { job.prelaunchFailure = error.failure; await lease.save(); throw error; }
          throw new PromotionError("Release canary admission is unconfirmed; reconcile the channel audit and disposable VM before retrying");
        }
      }
      if (!job.outcome) {
        for (let attempt = 0; attempt < 240 && now() - job.startedAt < QUALIFICATION_DEADLINE_MS; attempt++) {
          let result;
          try { result = await core.poll(job); }
          catch { throw new PromotionError("Release canary dispatch observation is unconfirmed; retain its audit and never redispatch credentials"); }
          if (!result.running) { job.outcome = fixedCanaryOutcome(result, { kind, model: credential.model, image }); job.phase = "completed"; await lease.save(); break; }
          await pause(10_000);
        }
        requireCheck(job.outcome, "Release native canary deadline reached; reconcile its persisted dispatch before any retry");
      }
      await finish(job);
      return { connection: credential, outcome: job.outcome, startedAt: job.startedAt };
    },
    async cleanup() {
      let deleted = true;
      for (const job of jobs) {
        try { await finish(job); } catch { deleted = false; }
      }
      return deleted;
    },
  };
}
