import { describe, expect, it } from "vitest";
import { qualifiedWorkerMatrix } from "../../apps/control-plane/src/release-identity";
import { CloudAgentRuntimeEvidenceSchema, nativeCapabilitiesFromChecks } from "../../apps/control-plane/src/manage-cloud-agent-runtime";

const contract = "a".repeat(64);
const matrix = () => ["claude-setup-token", "codex-chatgpt", "cursor-api-key"].map(credential_kind => ({ credential_kind,
  runtime_contract_sha256: contract, enabled: true, mcp_qualified: true, profile: "zeros-cloud-worker-v3" }));
const evidence = () => ({ version: 3, qualificationProfile: "smoke", executionProfile: "zeros-cloud-native-v1", channel: "alpha", provider: "boat",
  runtimeClass: "linux-vm", imageRef: `boat:test-image@sha256:${"b".repeat(64)}`, profile: "zeros-cloud-worker-v3", runtimeContractSha256: contract,
  sourceCommit: "c".repeat(40), evidenceSha256: "d".repeat(64), qualifiedAt: new Date().toISOString(), credentials: [{ kind: "codex-chatgpt", renewal: true,
    checks: Object.fromEntries(["privateProviderHome", "engineAuthorityIsolation", "nativeWorkspaceTools", "actorAdmission", "stopAndRevocation", "nativeTurn", "nativeResume", "authentication", "nativeMcp"].map(check => [check, true])) }] });

describe("truthful release-qualified cloud modes", () => {
  it("requires every offered kind on one approved MCP-qualified native contract, not existential approval", () => {
    expect(qualifiedWorkerMatrix(matrix())).toBe(true);
    for (const rows of [matrix().slice(1), matrix().map((row, index) => ({ ...row, runtime_contract_sha256: index === 0 ? "b".repeat(64) : contract })),
      matrix().map(row => ({ ...row, mcp_qualified: false })), matrix().map(row => ({ ...row, enabled: false })),
      matrix().map(row => ({ ...row, profile: "zeros-cloud-native-v1" })), matrix().map(row => ({ ...row, credential_kind: "codex-api-key" }))]) {
      expect(qualifiedWorkerMatrix(rows)).toBe(false);
    }
  });
  it("never turns smoke proof into extended capabilities", () => {
    const result = CloudAgentRuntimeEvidenceSchema.parse(evidence());
    expect(Object.values(nativeCapabilitiesFromChecks(result.credentials[0]!)).filter(value => value === true)).toHaveLength(0);
    for (const extension of ["nativeGoals", "nativeFork", "transcriptFork", "nativeReview", "nativeApps", "nativeMultiAgent"]) {
      const value = evidence(); value.credentials[0]!.checks[extension] = true;
      expect(CloudAgentRuntimeEvidenceSchema.safeParse(value).success).toBe(false);
    }
  });
});
