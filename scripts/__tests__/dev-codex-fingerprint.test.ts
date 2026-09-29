import { describe, expect, it } from "vitest";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import { hostedBackendEnvironment, hostedPublicProfile, hostedWebEnvironment } from "../dev-environment/hosted-profile.mjs";
import { loadCodexFingerprintKeys } from "../../apps/control-plane/src/cloud-workspaces/codex-fingerprint-keys";

describe("hosted Dev Codex account import", () => {
  it("supplies a stable, separate refresh fingerprint keyring only to the backend", () => {
    const state: any = newHostedGeneration({ owner: "a".repeat(24), identity: "test" });
    state.runId = "11111111-1111-4111-8111-111111111111";
    state.resources = { planetscale: { roles: { runtime: { url: "postgresql://app:fixture@db.example.test/postgres" } } },
      workos: { secret: "webhook-fixture" }, railway: { id: "dev-environment" } };
    const profile: any = { cloudflare: { domain: "example.test", accountId: "account", zoneId: "zone", apiToken: "fixture" }, workos: { environment: "dev", webClientId: "client_web", desktopClientId: "client_desktop", apiKey: "workos-private-fixture" },
      railway: { projectId: "test" }, github: { appId: 1, privateKeyBase64: Buffer.from("fixture").toString("base64") }, boat: { secondsPerDollar: 10 }, storage: {} };
    const source = { workerInputsSha256: "b".repeat(64), sourceSha256: "c".repeat(64) };
    const worker = { inputsSha256: source.workerInputsSha256, buildSha256: "d".repeat(64), storageMiB: 10000 };
    const first = hostedBackendEnvironment(state, profile, source, worker);
    const keys = loadCodexFingerprintKeys(first);
    expect(keys).toEqual({ currentKeyVersion: 1, keys: { 1: Buffer.from(state.keys.agent, "hex").toString("base64url") } });
    expect(keys!.keys[1]).not.toBe(first.CLOUD_WORKSPACE_PROVIDER_CREDENTIAL_KEY_V1);
    const restarted = hostedBackendEnvironment(structuredClone(state), profile, source, worker);
    expect(loadCodexFingerprintKeys(restarted)).toEqual(keys);
    const publicValues = JSON.stringify([hostedPublicProfile(state, profile), hostedWebEnvironment(state, profile)]);
    expect(publicValues).not.toContain(keys!.keys[1]);
    const replacement = newHostedGeneration({ owner: state.owner, identity: "test" });
    expect(replacement.keys.agent).not.toBe(state.keys.agent);
  });
});
