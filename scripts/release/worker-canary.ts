import { refuseRetiredWorkerPromotion } from "./worker-retirement";
import { z } from "zod";
import { CHECKS, NATIVE_EXTENSIONS } from "../dev-environment/native-agent-canary.mjs";
import type { WorkerCandidate } from "./worker";
import type { ReleaseCanaryConnection } from "./worker-broker";
import type { WorkerQualificationProfile } from "./worker-profile";
import { nativeQualificationDiagnostics } from "../cloud-workspace-validation/lib/native-qualification-diagnostics";

export function fixedCanaryOutcome(value: any, expected?: { kind: string; model: string; image: WorkerCandidate }) {
  const report = value?.report;
  const diagnostics = nativeQualificationDiagnostics(report);
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
      failureKind: report?.failureKind === "rate-limited" || report?.errorKind === "rate-limited" ? "rate-limited" : undefined,
      ...(diagnostics ? { diagnostics } : {}) },
    ...(value?.renewal ? { renewal: Object.fromEntries(["accountBinding", "accessChanged", "cachePublished", "consentPreserved"].map(check => [check, value.renewal[check] === true])) } : {}) };
}

export function releaseCanaryAdapter(lease: any, run: any, _credentials: Map<string, ReleaseCanaryConnection>, core: any, _options: {
  pause?: (ms: number) => Promise<void>; now?: () => number; qualificationProfile?: WorkerQualificationProfile;
} = {}) {
  const jobs = run.canaries ??= [];
  const finish = async (job: any) => {
    const row = lease.state.resources?.images?.find((value: any) => value.agentQualificationId === job.id);
    if (!job.retired || job.auditRetired?.version === 2 || row?.builder?.storageRetirement && row.builder.deleted !== true) {
      await core.retire(job); job.retired = true; await lease.save();
    }
  };
  return {
    async qualify(_image: WorkerCandidate, _kind: string): Promise<{ connection: ReleaseCanaryConnection; outcome: unknown; startedAt: number }> {
      refuseRetiredWorkerPromotion();
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
