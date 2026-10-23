import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { newHostedGeneration } from "../dev-environment/hosted-state.mjs";
import { hostedBackendEnvironment, hostedDesktopEnvironment, hostedPublicProfile, hostedWebEnvironment } from "../dev-environment/hosted-profile.mjs";

function fixture() {
  const state: any = newHostedGeneration({ owner: "a".repeat(24), identity: "test" });
  state.runId = "11111111-1111-4111-8111-111111111111";
  state.resources = { planetscale: { roles: { runtime: { url: "postgresql://app:fixture@db.example.test/postgres" } } },
    workos: { secret: "webhook-fixture" }, railway: { id: "dev-environment" } };
  const profile: any = { cloudflare: { domain: "example.test", accountId: "account", zoneId: "zone", apiToken: "fixture" }, workos: { environment: "dev", webClientId: "client_web", desktopClientId: "client_desktop", apiKey: "workos-private-fixture" },
    railway: { projectId: "test" }, github: { appId: 1, privateKeyBase64: Buffer.from("fixture").toString("base64") }, boat: { secondsPerDollar: 10 }, storage: {} };
  const source = { workerInputsSha256: "b".repeat(64), sourceSha256: "c".repeat(64) };
  const env = { ZEROS_CLOUD_V2_RUNTIME_SHA256: "d".repeat(64) };
  return { state, profile, source, env };
}

describe("hosted Dev cloud v2 worker signing key", () => {
  it("supplies one stable Ed25519 PKCS8 key per generation, only to the backend", () => {
    const { state, profile, source, env } = fixture();
    const first = hostedBackendEnvironment(state, profile, source, undefined, env).CLOUD_V2_WORKER_SIGNING_KEY;
    expect(first).toMatch(/^[A-Za-z0-9+/]+=*$/);
    const key = createPrivateKey({ key: Buffer.from(first, "base64"), format: "der", type: "pkcs8" });
    expect(key.asymmetricKeyType).toBe("ed25519");
    const signature = sign(null, Buffer.from("grant"), key);
    expect(verify(null, Buffer.from("grant"), createPublicKey(key), signature)).toBe(true);
    // Redeploys keep the VM trust root; a new generation does not inherit it.
    expect(hostedBackendEnvironment(structuredClone(state), profile, source, undefined, env).CLOUD_V2_WORKER_SIGNING_KEY).toBe(first);
    const replacement = fixture();
    expect(hostedBackendEnvironment(replacement.state, profile, source, undefined, env).CLOUD_V2_WORKER_SIGNING_KEY).not.toBe(first);
    // Distinct from every other backend secret and absent from public surfaces.
    const backend = hostedBackendEnvironment(state, profile, source, undefined, env);
    expect(Object.entries(backend).filter(([name, value]) => name !== "CLOUD_V2_WORKER_SIGNING_KEY" && value === first)).toEqual([]);
    const directory = mkdtempSync(path.join(tmpdir(), "zeros-dev-signing-"));
    try {
      const publicValues = JSON.stringify([hostedPublicProfile(state, profile), hostedWebEnvironment(state, profile),
        hostedDesktopEnvironment(state, profile, directory)]);
      expect(publicValues).not.toContain(first);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
