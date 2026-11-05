import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { HybridTransport } from "../hybrid-transport";
import { InboundBridge } from "../inbound-bridge";
import { config } from "./worker-fixtures";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";
import type { CloudV2ControlFrame } from "@zeros/protocol/cloud-v2-relay";

afterEach(() => vi.restoreAllMocks());
const versionId = "44444444-4444-4444-8444-444444444444";
async function fixture(mode: "held" | "lost" | "refused") {
  const f = await repositoryFixture();
  await writeFile(join(f.root, ".gitignore"), ".env*\n");
  if (mode === "refused") await writeFile(join(f.root, ".env.local"), "existing-user-file");
  const tokenFile = join(f.directory, "token"); await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  let receive!: (frame: CloudV2ControlFrame) => Promise<void>, release!: () => void, reports = 0;
  const hold = new Promise<void>(done => { release = done; }), ready: string[] = [], requests: Array<{ path: string; body: any }> = [];
  const start = InboundBridge.prototype.start;
  vi.spyOn(InboundBridge.prototype, "start").mockImplementationOnce(async function (this: InboundBridge, handler) {
    receive = handler; return start.call(this, handler);
  });
  const keys = generateKeyPairSync("ed25519"), runner = vi.fn(async () => 0);
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: f.scope.workspace.id, runtimeSha256: "a".repeat(64),
    tokenFile, port: 0, publicKeys: [keys.publicKey.export({ type: "spki", format: "pem" }).toString()], retryBaseMs: 10, retryMaxMs: 10,
    onStatus: status => ready.push(status), fetch: async (url, options) => {
      const path = new URL(String(url)).pathname.split("/").at(-1)!, body = options?.body ? JSON.parse(String(options.body)) : null;
      requests.push({ path, body });
      if (path === "hello" || path === "config") return Response.json({ config: { ...config, agents: {}, workspace: { ...f.scope.workspace, setup: "synthetic setup" },
        environment: { versionId, repositoryId: "123", variables: { APP_SECRET: "synthetic-app-value" }, files: [{ path: ".env.local", content: "VALUE=synthetic-file-value\n" }] } } });
      if (path === "environment") {
        reports++;
        if (mode === "held") await Promise.race([hold, new Promise((_, reject) => {
          const abort = () => reject(new Error("Aborted environment report"));
          if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true });
        })]);
        if (mode === "lost" && reports === 1) throw new Error("Lost committed acknowledgement");
        return Response.json({ sequence: body.sequence });
      }
      if (path === "activity") return Response.json({ state: "running", loginRevision: "0" });
      if (path === "history") return Response.json({ sequence: body.sequence });
      return new Response(null, { status: 404 });
    } });
  const worker = new CloudWorker({ directory: f.state, homeDirectory: f.directory, transport, drivers: {}, workspaceServices: { watch: false },
    setupRunner: runner, prepareCheckout: async () => ({ createdBranch: true }) });
  worker.start();
  await expect.poll(() => requests.filter(row => row.path === "environment").length).toBeGreaterThan(0);
  return { ...f, worker, transport, runner, ready, requests, release, control: (frame: CloudV2ControlFrame) => receive(frame) };
}

it("retries the exact durable seed proof after a lost report, before reading config or starting setup", async () => {
  const f = await fixture("lost");
  try {
    await expect.poll(() => f.runner.mock.calls.length).toBe(1);
    const reports = f.requests.filter(row => row.path === "environment");
    expect(reports.length).toBeGreaterThanOrEqual(2);
    expect(reports.every(row => JSON.stringify(row.body) === JSON.stringify(reports[0]!.body))).toBe(true);
    expect(f.requests.filter(row => row.path !== "timing").slice(0, 4).map(row => row.path)).toEqual(["hello", "environment", "environment", "config"]);
    expect(await readFile(join(f.root, ".env.local"), "utf8")).toBe("VALUE=synthetic-file-value\n");
    expect(f.ready).toContain("connected");
  } finally { f.release(); await f.worker.dispose(); }
});

it.each(["stop", "dispose"] as const)("%s cancels a held seed acknowledgement before waiting on initial transport configuration", async mode => {
  const f = await fixture("held"); let settled = false;
  try {
    expect(f.runner).not.toHaveBeenCalled(); expect(f.ready).not.toContain("connected");
    const closing = mode === "stop" ? f.control({ t: "stop", id: randomUUID() }) : f.worker.dispose();
    void closing.then(() => { settled = true; });
    await expect.poll(() => settled, { timeout: 1000 }).toBe(true);
    expect(f.runner).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(f.state, "environment-seed/manifest.json"), "utf8")).complete).toBe(true);
  } finally { f.release(); await f.worker.dispose(); }
});

it("a refused seed reports only its closed code and never starts services or setup", async () => {
  const f = await fixture("refused");
  try {
    await expect.poll(() => f.ready.includes("stopped")).toBe(true);
    expect(f.requests.find(row => row.path === "environment")?.body).toEqual({ versionId, sequence: 1, state: "failed", errorCode: "cloud_environment_path_conflict" });
    expect(f.requests.filter(row => row.path === "config")).toHaveLength(0);
    expect(f.runner).not.toHaveBeenCalled();
    expect(await readFile(join(f.root, ".env.local"), "utf8")).toBe("existing-user-file");
  } finally { f.release(); await f.worker.dispose(); }
});
