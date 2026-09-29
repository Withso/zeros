import { describe, expect, it } from "vitest";
import { CloudAgentRuntimeEvidenceSchema } from "../manage-cloud-agent-runtime.js";

describe("exact-image customization qualification", () => {
  const evidence = {
    version: 3, executionProfile: "zeros-cloud-native-v1", channel: "development", provider: "boat", runtimeClass: "linux-vm",
    imageRef: `boat:zeros-test-runtime@sha256:${"a".repeat(64)}`, profile: "zeros-cloud-worker-v3",
    runtimeContractSha256: "b".repeat(64), sourceCommit: "c".repeat(40), evidenceSha256: "d".repeat(64), qualifiedAt: new Date().toISOString(),
    credentials: [{ kind: "cursor-api-key", renewal: false, checks: {
      privateProviderHome: true, engineAuthorityIsolation: true, nativeWorkspaceTools: true, nativeMcp: true,
      actorAdmission: true, stopAndRevocation: true, nativeTurn: true, nativeResume: true, authentication: true,
    } }],
  };
  it("requires a successful MCP proof for every version-3 credential and retains version-2 compatibility", () => {
    expect(CloudAgentRuntimeEvidenceSchema.safeParse(evidence).success).toBe(true);
    const previous = structuredClone(evidence) as Record<string, any>;
    delete previous.credentials[0].checks.nativeMcp;
    expect(CloudAgentRuntimeEvidenceSchema.safeParse(previous).success).toBe(false);
    expect(CloudAgentRuntimeEvidenceSchema.safeParse({ ...previous, version: 2 }).success).toBe(true);
    previous.credentials[0].checks.nativeMcp = false;
    expect(CloudAgentRuntimeEvidenceSchema.safeParse(previous).success).toBe(false);
  });
});
