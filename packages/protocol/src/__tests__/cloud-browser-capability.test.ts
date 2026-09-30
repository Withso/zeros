import { describe, expect, it } from "vitest";
import { CloudBrowserCapabilitySchema, CloudNativeCapabilitiesSchema } from "../cloud-agent-execution";
import { cloudBrowserUnavailable, resolveCloudBrowserCapability, CLOUD_NATIVE_PROVIDER_RESTRICTIONS } from "../containment";

const scope = { version: 1, provider: "codex", runtimeProfile: "zeros-cloud-worker-v3", credentialKind: "codex-chatgpt" } as const;
describe("versioned cloud native browser diagnostic", () => {
  it("does not infer browser readiness from older workers or generic native qualification", () => {
    expect(resolveCloudBrowserCapability("codex", undefined)).toMatchObject({ state: "unavailable", reason: "not-reported", credentialKind: "unknown" });
    const old = { version: 1, goals: true, nativeFork: true, transcriptFork: true, nativeReview: true, connectedApps: true, multiAgent: true };
    expect(CloudNativeCapabilitiesSchema.parse(old)).toEqual(old);
    expect(resolveCloudBrowserCapability("codex", old).state).toBe("unavailable");
    expect(CLOUD_NATIVE_PROVIDER_RESTRICTIONS.codex).toEqual(["additional-directories-disabled", "mcp-oauth-unavailable", "native-session-fork-disabled", "provider-native-extensions-restricted"]);
  });
  it("requires a versioned, qualified, credential-scoped ready report", () => {
    const ready = { ...scope, state: "ready", qualifiedVersion: "native-browser-v1" };
    expect(CloudBrowserCapabilitySchema.safeParse(ready).success).toBe(true);
    expect(resolveCloudBrowserCapability("codex", ready, "codex-chatgpt")).toEqual(ready);
    for (const invalid of [{ ...ready, version: 2 }, { ...ready, qualifiedVersion: undefined }, { ...ready, credentialKind: "unknown" }, { ...ready, runtimeProfile: "local-mac" }, { ...ready, credentialKind: "claude-api-key" }]) {
      expect(resolveCloudBrowserCapability("codex", invalid).state).toBe("unavailable");
    }
    expect(resolveCloudBrowserCapability("claude", ready).state).toBe("unavailable");
    expect(resolveCloudBrowserCapability("codex", ready, "codex-api-key").state).toBe("unavailable");
  });
  it("keeps disabled distinct from unavailable and the v1 native profile unchanged", () => {
    expect(resolveCloudBrowserCapability("codex", { ...scope, state: "disabled" })).toEqual({ ...scope, state: "disabled" });
    expect(cloudBrowserUnavailable("claude", "claude-setup-token")).toEqual({ version: 1, provider: "claude", runtimeProfile: "zeros-cloud-worker-v3", credentialKind: "claude-setup-token", state: "unavailable", reason: "claude-direct-login-required" });
  });
});
