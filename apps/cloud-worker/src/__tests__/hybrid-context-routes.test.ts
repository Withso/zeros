import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HybridTransport } from "../hybrid-transport";
import { config } from "./worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it("posts slice B context routes with the worker credential and boot, reads the closed refusal code, and refuses other paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hybrid-context-")), tokenFile = join(directory, "token");
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  const posts: Array<{ path: string; headers: Headers; body: unknown }> = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.replace("/v2/cloud/worker/", "");
    if (path === "hello" || path === "config") return Response.json({ config });
    if (path === "activity") return Response.json({ state: "running", loginRevision: "0" });
    if (path === "turn-lease") { posts.push({ path, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return Response.json({ error: { code: "agent_login_required", agent: "claude", message: "PRIVATE_DETAIL" } }, { status: 409 }); }
    if (path === "execution-leases/renew") return Response.json({ leases: [] });
    return Response.json({ prompts: [], stops: [] });
  };
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64), tokenFile,
    publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()], port: 0, fetch: fetcher, retryBaseMs: 10, retryMaxMs: 20 });
  transport.start({ open: async () => {}, close: () => {}, frame: async () => {} });
  cleanups.push(async () => { await transport.dispose(); await rm(directory, { recursive: true, force: true }); });
  const error = await transport.contextRequest("turn-lease", { contextId: "c" }).catch(value => value as { status: number; contextCode?: string; agent?: string; message: string });
  expect(error).toMatchObject({ status: 409, contextCode: "agent_login_required", agent: "claude" });
  expect(JSON.stringify(error)).not.toContain("PRIVATE_DETAIL");
  expect(posts[0]!.headers.get("authorization")).toBe("Bearer synthetic-worker-token");
  expect(posts[0]!.headers.get("x-zeros-worker-boot")).toBe(transport.bootId);
  expect(await transport.contextRequest("execution-leases/renew", { contextIds: [] })).toEqual({ leases: [] });
  await expect(transport.contextRequest("github-token", {})).rejects.toThrow(/context route/);
});

it("asks for an MCP authorization as the activated context's person, and keeps the legacy body without one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hybrid-context-")), tokenFile = join(directory, "token");
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  const bodies: unknown[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.replace("/v2/cloud/worker/", "");
    if (path === "hello" || path === "config") return Response.json({ config });
    if (path === "activity") return Response.json({ state: "running", loginRevision: "0" });
    if (path.endsWith("/authorization")) { bodies.push(JSON.parse(String(init?.body))); return Response.json({ headers: { authorization: "Bearer synthetic-mcp" } }); }
    return Response.json({ prompts: [], stops: [] });
  };
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64), tokenFile,
    publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()], port: 0, fetch: fetcher, retryBaseMs: 10, retryMaxMs: 20 });
  transport.start({ open: async () => {}, close: () => {}, frame: async () => {} });
  cleanups.push(async () => { await transport.dispose(); await rm(directory, { recursive: true, force: true }); });
  const server = "88888888-8888-4888-8888-888888888888", context = "66666666-6666-4666-8666-666666666666";
  await transport.mcpAuthorization(server);
  await transport.mcpAuthorization(server, true, undefined, context);
  expect(bodies).toEqual([{ force: false }, { force: true, contextId: context }]);
});

it("keeps prompts/begin's closed actor_busy code, so the worker can wait for the previous person's cleanup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hybrid-context-")), tokenFile = join(directory, "token");
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  const fetcher: typeof fetch = async url => {
    const path = new URL(String(url)).pathname.replace("/v2/cloud/worker/", "");
    if (path === "hello" || path === "config") return Response.json({ config });
    if (path === "activity") return Response.json({ state: "running", loginRevision: "0" });
    if (path === "prompts/begin") return Response.json({ error: { code: "actor_busy", message: "The preceding turn is still retiring" } }, { status: 409 });
    return Response.json({ prompts: [], stops: [] });
  };
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64), tokenFile,
    publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString()], port: 0, fetch: fetcher, retryBaseMs: 10, retryMaxMs: 20 });
  transport.start({ open: async () => {}, close: () => {}, frame: async () => {} });
  cleanups.push(async () => { await transport.dispose(); await rm(directory, { recursive: true, force: true }); });
  const error = await transport.promptRequest("begin", { userMessageId: "m", deliveryId: "d", dispatchId: "x" }).catch(value => value as { status: number; contextCode?: string });
  expect(error).toMatchObject({ status: 409, contextCode: "actor_busy" });
  await expect(transport.contextRequest("prompts/begin", {})).rejects.toThrow(/context route/);
});
