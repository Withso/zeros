import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HybridTransport } from "../hybrid-transport";
import { config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const iso = "2026-11-10T12:00:00.000Z";

it("speaks the W local command routes with the worker credential, boot and features, and acknowledges a 204", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hybrid-local-")), tokenFile = join(directory, "token");
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  const seen: Array<{ method: string; path: string; body: unknown; headers: Headers }> = [];
  let polls = 0, requestId = "";
  const fetcher: typeof fetch = async (url, init) => {
    const target = new URL(String(url)), path = target.pathname.replace("/v2/cloud/worker/", "") + target.search;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method: init?.method ?? "GET", path, body, headers: new Headers(init?.headers) });
    if (path === "hello" || path === "config") return Response.json({ config });
    if (path === "activity") return Response.json({ state: "running", loginRevision: "0" });
    if (path === "local-commands") { requestId = body.requestId; return Response.json(receipt("pending"), { status: 201 }); }
    if (path.startsWith(`local-commands/${requestId}?waitMs=`)) return Response.json(++polls < 2 ? receipt("claimed") : receipt("terminal"));
    if (path === `local-commands/${requestId}/ack`) return new Response(null, { status: 204 });
    if (path === "local-commands/retire-sender") return Response.json({ ok: true });
    return Response.json({ prompts: [], stops: [] });
  };
  const receipt = (state: string) => ({ requestId, state, approvalDeadline: iso, runDeadline: null, mac: "Studio", outputAvailable: state === "terminal",
    result: state === "terminal" ? { outcome: "completed", code: 0, stdout: "ok", mac: "Studio" } : null });
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64), tokenFile,
    publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()], port: 0, fetch: fetcher, retryBaseMs: 10, retryMaxMs: 20 });
  transport.start({ open: async () => {}, close: () => {}, frame: async () => {} });
  cleanups.push(async () => { await transport.dispose(); await rm(directory, { recursive: true, force: true }); });

  const running = transport.localCommand({ chatId: "chat", executionId: "exec", input: { command: "ls" } }, new AbortController().signal);
  await expect.poll(() => transport.localCommandsPending).toBe(1);
  const done = await running;
  expect(transport.localCommandsPending).toBe(0);
  expect(done.result).toEqual({ outcome: "completed", code: 0, stdout: "ok", mac: "Studio" });
  await done.acknowledge();
  await transport.retireLocalCommandSender({ chatId: "chat", executionId: "exec" });
  const local = seen.filter(entry => entry.path.startsWith("local-commands"));
  expect(local.map(entry => `${entry.method} ${entry.path}`)).toEqual(["POST local-commands", `GET local-commands/${requestId}?waitMs=25000`,
    `GET local-commands/${requestId}?waitMs=25000`, `POST local-commands/${requestId}/ack`, "POST local-commands/retire-sender"]);
  expect(local[0]!.body).toEqual({ requestId, chatId: "chat", executionId: "exec", input: { command: "ls" } });
  expect(local.at(-1)!.body).toEqual({ chatId: "chat", executionId: "exec" });
  for (const entry of local) {
    expect(entry.headers.get("authorization")).toBe("Bearer synthetic-worker-token");
    expect(entry.headers.get("x-zeros-worker-boot")).toMatch(/^[0-9a-f-]{36}$/);
    expect(entry.headers.get("x-zeros-worker-features")).toContain("local-commands-v1");
  }
});
