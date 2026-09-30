import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureWorkspace } from "../dev-environment/state.mjs";
import { backendEnvironment, desktopEnvironment, publicDevProfile, webEnvironment } from "../dev-environment/profile.mjs";
import { validateDatabaseRequest } from "../dev-environment/database.mjs";
import { databaseUrl } from "../dev-environment/postgres.mjs";
import { ensureWorkosWebhook, deleteWorkosWebhook, WORKOS_DEV_EVENTS } from "../dev-environment/workos.mjs";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-dev-profile-")); roots.push(root);
  const workspace = ensureWorkspace({ repositoryRoot: root, homeDir: root, env: {} });
  const profile = { version: 1, cloudflare: { accountId: "a".repeat(32), zoneId: "b".repeat(32), domain: "example.test", apiToken: "cf-credential-sentinel" },
    workos: { environment: "alpha", webClientId: "client_web", desktopClientId: "client_desktop", apiKey: "workos-credential-sentinel" },
    github: { appId: 1, appSlug: "test-app", clientId: "public-client", clientSecret: "github-credential-sentinel", privateKeyBase64: Buffer.from("private-key-sentinel").toString("base64") } };
  return { workspace, profile };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("local Dev integration boundaries", () => {
  it("projects only public auth into the desktop/web while keeping migration and provider authority out", () => {
    const { workspace: w, profile: p } = fixture();
    w.state.workosWebhook = { secret: "webhook-credential-sentinel" };
    const desktop = desktopEnvironment(w, p), web = webEnvironment(w, p, 21001);
    for (const value of [p.cloudflare.apiToken, p.workos.apiKey, p.github.clientSecret, p.github.privateKeyBase64, w.state.database.runtimePassword, w.state.workosWebhook.secret]) {
      expect(JSON.stringify({ desktop, web })).not.toContain(value);
    }
    const api = backendEnvironment(w, p, { database: 21000, api: 21001 }, "fb87f8dd-6161-463b-981c-d039c675e0ca");
    expect(api.AUTH_AUDIENCE).toBe("https://api-alpha.zeros.build");
    expect(api.APP_ORIGIN).toBe(publicDevProfile(w, p).appOrigin);
    expect(api.DATABASE_URL).toContain("@127.0.0.1:21000/");
    expect(JSON.stringify(api)).not.toContain(w.state.database.migrationPassword);
    expect(JSON.stringify(api)).not.toContain(p.cloudflare.apiToken);
    expect(api.GITHUB_OAUTH_CALLBACK_URL).toBe(`${publicDevProfile(w, p).apiOrigin}/v1/github/oauth/callback`);
  });

  it("refuses cross-workspace, hosted, role-switched and malformed migration targets", () => {
    const { workspace: w } = fixture();
    const input = { action: "migrate", owner: w.state.owner, port: 21000,
      runtimeUrl: databaseUrl(w, 21000), migrationUrl: databaseUrl(w, 21000, "migration") };
    expect(validateDatabaseRequest(input)).toEqual(input);
    for (const migrationUrl of [input.migrationUrl.replace("127.0.0.1", "hosted.example.test"), input.runtimeUrl,
      input.migrationUrl + "?options=-crole=postgres", input.migrationUrl.replace(w.state.owner, "c".repeat(24))]) {
      expect(() => validateDatabaseRequest({ ...input, migrationUrl })).toThrow();
    }
  });

  it("recovers one owned webhook after a lost create response and preserves Alpha's endpoint", async () => {
    const { workspace: w, profile: p } = fixture();
    const foreign = { id: "we_ALPHA", endpoint_url: "https://api-alpha.zeros.build/auth/workos-webhook", secret: "alpha-credential-sentinel" };
    const hooks: any[] = [foreign]; let lose = true;
    const request = async (route: string, { method = "GET", body }: any = {}) => {
      if (method === "GET") return { data: hooks, list_metadata: {} };
      if (method === "POST") {
        const hook = { id: "we_DEV", ...body, secret: "dev-webhook-credential-sentinel", status: "enabled" }; hooks.push(hook);
        if (lose) { lose = false; throw new Error("lost create response"); } return hook;
      }
      if (method === "DELETE") { const i = hooks.findIndex(h => route.endsWith(h.id)); hooks.splice(i, 1); }
    };
    await expect(ensureWorkosWebhook(w, p, request)).rejects.toThrow("lost create response");
    await ensureWorkosWebhook(w, p, request); await ensureWorkosWebhook(w, p, request);
    expect(hooks).toHaveLength(2); expect(hooks[1].events).toEqual(WORKOS_DEV_EVENTS);
    w.state.status = "archiving"; await deleteWorkosWebhook(w, p, request);
    expect(hooks).toEqual([foreign]);
  });
});
