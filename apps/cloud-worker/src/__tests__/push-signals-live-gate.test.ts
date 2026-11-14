import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { HybridTransport } from "../hybrid-transport";
import { CloudWorker } from "../worker";
import { config } from "./worker-fixtures";

// PR3a live gate (dev VM, 40 ms/query): worker_configure took 60.178 s after a cold wake with push-signals-v1. The
// production pairing (HybridTransport + CloudWorker) must finish its first configuration while a 60 s pull is held.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("the first configuration over HybridTransport completes within seconds while the negotiated 60 s pull is held", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-live-gate-")), tokenFile = join(directory, "token");
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  const calls: Array<{ path: string; at: number; waitMs?: number }> = [];
  const configured = { ...config, pushSignals: 1, promptOutbox: 1, runtimeUpdate: 1 };
  let historySequence = 0;
  const fetcher: typeof fetch = vi.fn(async (url, init) => {
    const path = new URL(String(url)).pathname.replace("/v2/cloud/worker/", "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, at: Date.now(), ...(body && typeof body.waitMs === "number" ? { waitMs: body.waitMs } : {}) });
    if (path === "hello" || path === "config") return Response.json({ config: configured });
    if (path === "activity") return Response.json({ state: "running", loginRevision: "0" });
    if (path === "prompts/pull") {
      if (!body.waitMs) return Response.json({ prompts: [], stops: [] });
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }
    if (path === "history") { historySequence = body.sequence; return Response.json({ sequence: historySequence }); }
    if (path === "runtime") return Response.json({ status: "current" });
    if (path === "execution-leases/boot-clean") return Response.json({ ok: true });
    return Response.json({ ok: true });
  });
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64),
    tokenFile, publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()], port: 0, fetch: fetcher, retryBaseMs: 10, retryMaxMs: 20, heartbeatPhase: Date.now() });
  const worker = new CloudWorker({ directory: join(directory, "state"), transport, workspaceId: config.workspace.id, prepareCheckout: async () => {}, drivers: {} });
  cleanups.push(async () => { await worker.dispose(); await transport.dispose(); await rm(directory, { recursive: true, force: true }); });
  const started = Date.now();
  worker.start();
  // configure ends with its forced idle report (POST activity); the 60 s pull must neither precede it as a gate nor delay it.
  await vi.waitFor(() => expect(calls.some(call => call.path === "prompts/pull" && call.waitMs === 60_000)).toBe(true), { timeout: 5_000 });
  await vi.waitFor(() => expect(calls.some(call => call.path === "activity")).toBe(true), { timeout: 5_000 });
  expect(calls.find(call => call.path === "activity")!.at - started).toBeLessThan(3_000);
  // While that pull is still held, other worker requests go straight through (no shared queue or connection gate).
  const before = calls.length;
  await (transport as unknown as { activity(): Promise<void> }).activity();
  expect(calls.slice(before).some(call => call.path === "activity")).toBe(true);
  expect(calls.filter(call => call.path === "prompts/pull" && call.waitMs === 60_000)).toHaveLength(1);
}, 20_000);
