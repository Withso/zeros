import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPrivateKey } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspace } from "../dev-environment/state.mjs";
import { backendEnvironment, desktopEnvironment, publicDevProfile, webEnvironment } from "../dev-environment/profile.mjs";

const RUNTIME = "d".repeat(64);
const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-local-")); roots.push(root);
  const workspace = ensureWorkspace({ repositoryRoot: root, homeDir: root, env: {} });
  workspace.state.workosWebhook = { secret: "webhook-credential-sentinel" };
  const profile = { version: 1,
    cloudflare: { accountId: "a".repeat(32), zoneId: "b".repeat(32), domain: "example.test", apiToken: "cf-credential-sentinel" },
    workos: { environment: "alpha", webClientId: "client_web", desktopClientId: "client_desktop", apiKey: "workos-credential-sentinel" },
    github: { appId: 1, appSlug: "test-app", clientId: "public-client", clientSecret: "github-credential-sentinel", privateKeyBase64: Buffer.from("private-key-sentinel").toString("base64") },
    boat: { apiKey: "boat-credential-sentinel", billingOrg: "org_boat" },
    storage: { endpoint: "https://storage.example.test", bucket: "runtimes", accessKeyId: "storage-id-sentinel", secretAccessKey: "storage-credential-sentinel" } };
  return { workspace, profile };
}
const ports = { database: 21000, api: 21001 };
const run = "fb87f8dd-6161-463b-981c-d039c675e0ca";
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("electron:cloud control plane", () => {
  it("runs cloud v2 on this workspace's tunnel origin with its own stable keys", () => {
    const { workspace: w, profile: p } = fixture();
    const api = backendEnvironment(w, p, ports, run, { ZEROS_CLOUD_V2_RUNTIME_SHA256: RUNTIME });
    const origin = publicDevProfile(w, p).apiOrigin;
    expect(api).toMatchObject({
      CLOUD_V2_ENABLED: "true", CLOUD_V2_API_URL: origin, CLOUD_V2_REALTIME_URL: origin.replace(/^https:/, "wss:"),
      CLOUD_V2_RUNTIME_SHA256: RUNTIME, CLOUD_V2_RUNTIME_STORE_ENDPOINT: p.storage.endpoint,
      CLOUD_V2_RUNTIME_STORE_BUCKET: p.storage.bucket, CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID: p.storage.accessKeyId,
      CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY: p.storage.secretAccessKey,
      BOAT_API_KEY: p.boat.apiKey, BOAT_BILLING_ORG: p.boat.billingOrg,
      CLOUD_CODEX_REFRESH_FINGERPRINT_CURRENT_KEY_VERSION: "1",
    });
    const key = createPrivateKey({ key: Buffer.from(api.CLOUD_V2_WORKER_SIGNING_KEY, "base64"), format: "der", type: "pkcs8" });
    expect(key.asymmetricKeyType).toBe("ed25519");
    // Restarts keep the VM trust root, the vault key and the Codex keyring.
    const again = backendEnvironment(structuredClone(w), p, ports, run, { ZEROS_CLOUD_V2_RUNTIME_SHA256: RUNTIME });
    for (const name of ["CLOUD_V2_WORKER_SIGNING_KEY", "CLOUD_WORKSPACE_SECRET_KEY_V1", "CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON"])
      expect(again[name]).toBe(api[name]);
    const other = fixture();
    expect(backendEnvironment(other.workspace, other.profile, ports, run, { ZEROS_CLOUD_V2_RUNTIME_SHA256: RUNTIME }).CLOUD_V2_WORKER_SIGNING_KEY)
      .not.toBe(api.CLOUD_V2_WORKER_SIGNING_KEY);
    // The vault key, worker trust root and Codex keyring are distinct secrets.
    expect(new Set([api.CLOUD_V2_WORKER_SIGNING_KEY, api.CLOUD_WORKSPACE_SECRET_KEY_V1,
      JSON.parse(api.CLOUD_CODEX_REFRESH_FINGERPRINT_KEYS_JSON)["1"]]).size).toBe(3);
  });

  it("opens cloud workspaces in the desktop without giving it any backend credential", () => {
    const { workspace: w, profile: p } = fixture();
    const api = backendEnvironment(w, p, ports, run, { ZEROS_CLOUD_V2_RUNTIME_SHA256: RUNTIME });
    const desktop = desktopEnvironment(w, p), web = webEnvironment(w, p, ports.api);
    expect(desktop.ZEROS_CLOUD_WORKSPACES_ENABLED).toBe("true");
    for (const value of [p.boat.apiKey, p.storage.secretAccessKey, api.CLOUD_V2_WORKER_SIGNING_KEY, api.CLOUD_WORKSPACE_SECRET_KEY_V1])
      expect(JSON.stringify({ desktop, web })).not.toContain(value);
  });

  it("names what is missing instead of starting a control plane without cloud", () => {
    const { workspace: w, profile: p } = fixture();
    expect(() => backendEnvironment(w, p, ports, run, {})).toThrow(/ZEROS_CLOUD_V2_RUNTIME_SHA256/);
    const { boat: _boat, ...withoutBoat } = p;
    expect(() => backendEnvironment(w, withoutBoat, ports, run, { ZEROS_CLOUD_V2_RUNTIME_SHA256: RUNTIME })).toThrow(/boat/i);
    const { storage: _storage, ...withoutStorage } = p;
    expect(() => backendEnvironment(w, withoutStorage, ports, run, { ZEROS_CLOUD_V2_RUNTIME_SHA256: RUNTIME })).toThrow(/storage/i);
  });
});

describe("electron:cloud profile", () => {
  it("reads the repository's hosted profile and keeps only what a local stack needs", async () => {
    const { loadProfile } = await import("../dev-environment/profile.mjs");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-local-profile-")); roots.push(root);
    const hosted = { version: 2, mode: "hosted", registry: { bucket: "registry" },
      railway: { projectId: "p", serviceId: "s", apiToken: "railway-credential-sentinel" },
      planetscale: { token: "planetscale-credential-sentinel" },
      cloudflare: { accountId: "a".repeat(32), zoneId: "b".repeat(32), domain: "example.test", apiToken: "cf" },
      workos: { environment: "alpha", webClientId: "client_web", desktopClientId: "client_desktop", apiKey: "w".repeat(20) },
      github: { appId: 1 }, boat: { apiKey: "boat" }, storage: { endpoint: "https://s.example.test" }, fixture: { workosUserId: "user_1" } };
    fs.writeFileSync(path.join(root, "zeros-dev-env.json"), JSON.stringify(hosted), { mode: 0o600 });
    const profile = loadProfile(root, { env: {}, root });
    expect(Object.keys(profile).sort()).toEqual(["boat", "cloudflare", "fixture", "github", "storage", "version", "workos"]);
    expect(JSON.stringify(profile)).not.toMatch(/railway-credential|planetscale-credential/);
    fs.writeFileSync(path.join(root, "zeros-dev-env.json"), JSON.stringify({ ...hosted, version: 3 }), { mode: 0o600 });
    expect(() => loadProfile(root, { env: {}, root })).toThrow(/version/);
  });
});
