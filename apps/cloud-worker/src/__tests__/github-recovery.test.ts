import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CloudWorker } from "../worker";
import { HybridTransport } from "../hybrid-transport";
import { brokerRequest } from "../credentials/client";
import { config } from "./worker-fixtures";

it("finishes a broker request held across failed activity and same-revision HTTPS recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "github-heartbeat-recovery-")), tokenFile = join(directory, "worker-token");
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  const { publicKey } = generateKeyPairSync("ed25519");
  let release!: () => void, tokenRequests = 0, configReads = 0, failActivity = false, activityCalls = 0;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const fetcher: typeof fetch = async url => {
    const path = new URL(String(url)).pathname.split("/").at(-1);
    if (path === "hello" || path === "config") { configReads++; return Response.json({ config }); }
    if (path === "github-token") { tokenRequests++; await hold; return Response.json({ token: "fixture-recovered-token", expiresAt: Date.now() + 120_000 }); }
    if (path === "activity") {
      activityCalls++;
      if (failActivity) { failActivity = false; return new Response(null, { status: 503 }); }
      return Response.json({ state: "running", loginRevision: config.loginRevision });
    }
    return Response.json({ sequence: 1 });
  };
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64),
    tokenFile, publicKeys: [publicKey.export({ type: "spki", format: "pem" }).toString()], port: 0, fetch: fetcher, retryBaseMs: 1 });
  const worker = new CloudWorker({ directory: join(directory, "state"), transport, prepareCheckout: async () => {}, drivers: {} });
  try {
    worker.start();
    await expect.poll(() => activityCalls).toBeGreaterThan(0);
    const pending = brokerRequest(join(directory, "state", "github.sock"), "token").then(value => ({ value }), error => ({ error }));
    await expect.poll(() => tokenRequests).toBe(1);
    failActivity = true;
    await transport.send({ t: "idle", idle: false });
    await expect.poll(() => configReads).toBe(2);
    await worker.flush();
    release();
    expect(await pending).toMatchObject({ value: { token: "fixture-recovered-token" } });
    expect(await brokerRequest(join(directory, "state", "github.sock"), "token")).toMatchObject({ token: "fixture-recovered-token" });
    expect(tokenRequests).toBe(1);
  } finally { release(); await worker.dispose(); await rm(directory, { recursive: true, force: true }); }
});
