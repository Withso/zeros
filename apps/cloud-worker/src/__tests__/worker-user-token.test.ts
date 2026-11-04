import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { HybridTransport } from "../hybrid-transport";
import { askpass, gitCredential, runGh } from "../credentials/client";
import { githubTokenHash } from "../credentials/github";
import { config } from "./worker-fixtures";

it.each([true, false])("shares the human credential across git and gh with recovery-capable control plane=%s", async supported => {
  const directory = await mkdtemp(join(tmpdir(), "worker-user-token-")), tokenFile = join(directory, "worker-token");
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  const configuration = { ...config, githubPullRequests: 1 as const, ...(supported ? { githubUserTokens: 1 as const } : {}) };
  const requests: Record<string, unknown>[] = [];
  let token = "fixture-initial-human", socket = "", revoked = false;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.split("/").at(-1);
    if (path === "hello" || path === "config") return Response.json({ config: configuration });
    if (path === "github-token") {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      if (body.failedTokenSha256) {
        expect(supported).toBe(true);
        expect(body.failedTokenSha256).toBe(githubTokenHash(token));
        token = "fixture-refreshed-human"; revoked = false;
      }
      expect(body.purpose).toBe(supported ? "git" : "gh");
      return Response.json({ token, expiresAt: Date.now() + 120_000 });
    }
    return Response.json({ state: "running", loginRevision: "0" });
  };
  const githubFetch = vi.fn(async () => new Response(null, { status: revoked ? 401 : 200 }));
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64), tokenFile,
    publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()], port: 0, fetch: fetcher });
  const worker = new CloudWorker({ directory: join(directory, "state"), homeDirectory: directory, transport, githubFetch, drivers: {},
    prepareCheckout: async (_workspace, env) => { socket = env.GH_ZEROS_BROKER_SOCKET!; } });
  try {
    worker.start(); await vi.waitFor(() => expect(socket).not.toBe(""));
    expect(await askpass("Password for 'https://x-access-token@github.com': ", socket)).toBe(token);
    const execute = vi.fn(async (_args: string[], env: NodeJS.ProcessEnv) => { expect(env.GH_TOKEN).toBe(token); return 0; });
    await runGh(["pr", "create"], { GH_ZEROS_BROKER_SOCKET: socket }, execute);
    expect(requests).toHaveLength(1); expect(githubFetch).toHaveBeenCalledOnce();
    revoked = true;
    const report = gitCredential("erase", `protocol=https\nhost=github.com\npassword=${token}\n\n`, socket);
    if (supported) {
      expect(await report).toBe("");
      expect(await askpass("Password for 'https://github.com': ", socket)).toBe("fixture-refreshed-human");
    } else {
      await expect(report).rejects.toMatchObject({ reason: "connection-expired" });
      expect(requests.every(request => !("failedTokenSha256" in request))).toBe(true);
    }
    expect(requests).toHaveLength(2);
    expect(execute).toHaveBeenCalledOnce();
  } finally { await worker.dispose(); await rm(directory, { recursive: true, force: true }); }
});
