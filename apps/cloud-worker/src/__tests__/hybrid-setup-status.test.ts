import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HybridTransport } from "../hybrid-transport";
import { FakeRelay, config } from "./worker-fixtures";
import { CloudWorker } from "../worker";
import type { CloudV2SetupStatus } from "@zeros/protocol/cloud-v2-relay";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("posts setup-status-v1 to the W setup route with the worker credential and accepts a 204", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hybrid-setup-")), tokenFile = join(directory, "token");
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  const seen: Array<{ method: string; path: string; body: unknown; headers: Headers }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.replace("/v2/cloud/worker/", "");
    seen.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) });
    if (path === "hello" || path === "config") return Response.json({ config });
    if (path === "activity") return Response.json({ state: "running", loginRevision: "0" });
    if (path === "setup") return new Response(null, { status: 204 });
    return Response.json({ prompts: [], stops: [] });
  };
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64), tokenFile,
    publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()], port: 0, fetch: fetcher, retryBaseMs: 10, retryMaxMs: 20 });
  transport.start({ open: async () => {}, close: () => {}, frame: async () => {} });
  cleanups.push(async () => { await transport.dispose(); await rm(directory, { recursive: true, force: true }); });
  const status = { state: "failed", startedAt: 1, finishedAt: 2, exitCode: 3 } as const;
  await transport.reportSetup(status);
  await expect(transport.reportSetup({ ...status, path: "/home/user/x" } as unknown as CloudV2SetupStatus)).rejects.toThrow();
  const posts = seen.filter(entry => entry.path === "setup");
  expect(posts.map(entry => [entry.method, entry.body])).toEqual([["POST", status]]);
  expect(posts[0]!.headers.get("authorization")).toBe("Bearer synthetic-worker-token");
  expect(posts[0]!.headers.get("x-zeros-worker-features")).toContain("setup-status-v1");
});

it("reports setup from the status file after configuration and after every reconnect hello", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-setup-report-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const reports: CloudV2SetupStatus[] = [];
  const relay = Object.assign(new FakeRelay(), { reportSetup: async (status: CloudV2SetupStatus) => { reports.push(status); } });
  const worker = new CloudWorker({ directory, homeDirectory: directory, transport: relay, drivers: {}, workspaceServices: { watch: false },
    setupRunner: async () => 0, prepareCheckout: async () => ({ createdBranch: true }) });
  cleanups.push(() => worker.dispose());
  worker.start();
  await relay.receive({ ...config, agents: {}, workspace: { ...config.workspace, checkoutPath: directory, setup: "true" } });
  await expect.poll(() => reports.map(report => report.state)).toContain("succeeded");
  const before = reports.length;
  relay.disconnect(); await relay.reconnect();
  await expect.poll(() => reports.length).toBe(before + 1);
  expect(reports.at(-1)).toMatchObject({ state: "succeeded", exitCode: 0 });
});
