import { requireCheck, SHA, type Channel } from "./contracts";
import { REQUIRED_CI, requiredCIEvidence, waitForRequiredCI } from "./ci";
import { RuntimeLiveIdentity, type RuntimeReleaseConfig } from "./runtime-contracts";
import { identityPin } from "./runtime-identity";
import { runtimeJson } from "./runtime-proof";
import type { RuntimeRelease } from "../../apps/control-plane/src/cloud/runtime-release";

export type RuntimeAutoPlan = { action: "skip"; reason: "cloud_disabled" | "unchanged" | "current" } | {
  action: "publish" | "promote"; reason: "unqualified" | "inputs_changed" | "qualification_changed" | "promotion";
  expected_cp_sha: string; expected_runtime_sha256: string; source_sha?: string; runtime_sha256?: string;
  alpha_run_id?: string; alpha_run_attempt?: string;
};
export type RuntimeAutoDependencies = {
  identity(channel: Channel): Promise<unknown>;
  ancestor(before: string, after: string): Promise<boolean>;
  changes(before: string, after: string): Promise<string[]>;
  published(proof: RuntimeRelease["qualification"]): Promise<boolean>;
};
const qualificationChanged = (files: string[]) => files.some(file => file.startsWith("apps/control-plane/") || file.startsWith("packages/protocol/"));

export async function resolveRuntimeRelease(input: { channel: Channel; sourceSha: string; cloudEnabled: boolean }, deps: RuntimeAutoDependencies): Promise<RuntimeAutoPlan> {
  requireCheck(SHA.test(input.sourceSha), "Automatic runtime source must be immutable");
  if (!input.cloudEnabled) return { action: "skip", reason: "cloud_disabled" };
  const { runtimeSourcePaths } = await import("../../apps/cloud-worker/scripts/package-runtime.mjs");
  const raw = await deps.identity(input.channel), identity = RuntimeLiveIdentity.parse(raw), current = identityPin(raw);
  requireCheck(identity.channel === input.channel && identity.sourceSha === input.sourceSha,
    "Hosted destination differs from this release; runtime resolution refused");
  const expected = { expected_cp_sha: input.sourceSha, expected_runtime_sha256: current.sha256 };
  if (input.channel === "alpha") {
    const publish = (reason: "unqualified" | "inputs_changed" | "qualification_changed"): RuntimeAutoPlan =>
      ({ action: "publish", reason, ...expected, source_sha: input.sourceSha });
    if (!current.release) return publish("unqualified");
    requireCheck(await deps.ancestor(current.release.sourceSha, input.sourceSha), "Alpha runtime is newer than or unrelated to this release");
    const files = await deps.changes(current.release.sourceSha, input.sourceSha);
    if (runtimeSourcePaths(files).length) return publish("inputs_changed");
    // Promotion compares the entire CP/protocol trees with the qualifying source.
    if (qualificationChanged(files)) return publish("qualification_changed");
    if (!await deps.published(current.release.qualification)) return publish("unqualified");
    return { action: "skip", reason: "unchanged" };
  }
  const alphaRaw = await deps.identity("alpha"), alphaIdentity = RuntimeLiveIdentity.parse(alphaRaw), alpha = identityPin(alphaRaw);
  requireCheck(alphaIdentity.channel === "alpha" && alpha.release, "Alpha has no qualified runtime; publish and qualify Alpha before releasing");
  requireCheck(await deps.ancestor(alpha.release.sourceSha, input.sourceSha), "Alpha runtime is newer than or unrelated to this release");
  const files = await deps.changes(alpha.release.sourceSha, input.sourceSha);
  requireCheck(!runtimeSourcePaths(files).length && !qualificationChanged(files),
    "Alpha runtime inputs or qualifying code differ from this release; publish and qualify the matching Alpha source");
  requireCheck(await deps.published(alpha.release.qualification), "Alpha publication has not succeeded; qualify Alpha before releasing");
  if (current.release && runtimeJson(current.release) === runtimeJson(alpha.release)) return { action: "skip", reason: "current" };
  const proof = alpha.release.qualification;
  return { action: "promote", reason: "promotion", ...expected, runtime_sha256: alpha.sha256,
    alpha_run_id: proof.runId, alpha_run_attempt: String(proof.runAttempt) };
}

export async function waitForRuntimeCI(config: Pick<RuntimeReleaseConfig, "repository" | "workflowSha" | "sourceSha">,
  read: (path: string) => Promise<unknown>, options: Parameters<typeof waitForRequiredCI>[1] = {}) {
  const sources = [...new Set([config.workflowSha, config.sourceSha].filter((sha): sha is string => !!sha))];
  requireCheck(sources.every(sha => SHA.test(sha)), "Runtime CI source is invalid");
  const checks = sources.flatMap(sourceSha => REQUIRED_CI.map(workflow => ({ sourceSha, workflow, name: `${sourceSha}/${workflow.name}`, file: workflow.file })));
  return waitForRequiredCI(() => Promise.all(checks.map(async check => ({
    ...requiredCIEvidence({ repository: config.repository, sourceSha: check.sourceSha }, check.workflow.file, check.workflow.name,
      await read(`/actions/workflows/${check.file}/runs?head_sha=${check.sourceSha}&per_page=100`)), workflow: check.name,
  }))), options, checks);
}
