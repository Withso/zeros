import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:https";
import type { ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Duplex } from "node:stream";
import { createFixtureTls } from "../cloud-workspace-validation/cloud-agent-e2e/runtime";
import { createRendererGrant } from "../cloud-workspace-validation/cloud-agent-e2e/renderer-grant";

const actor = "11111111-1111-4111-8111-111111111111";
const workspace = "22222222-2222-4222-8222-222222222222";
const grant = "33333333-3333-4333-8333-333333333333";
const metadata = () => ({ compute: { fingerprint: "a".repeat(64), trust: "zeros-managed" }, delegations: [{
  id: grant, ownerUserId: actor, kind: "codex-api-key", models: ["fixture-model"],
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}] });
let root: string, tls: Awaited<ReturnType<typeof createFixtureTls>>, ca: Buffer;
const servers: Server[] = [];
const sockets = new Set<Duplex>();
beforeAll(async () => {
  const parent = path.join(process.cwd(), ".context/agents-fix/scratch/W5/p3");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  root = await mkdtemp(path.join(parent, "renderer-tls-"));
  tls = await createFixtureTls(root); ca = await readFile(tls.ca);
});
afterEach(async () => {
  for (const socket of sockets) socket.destroy(); sockets.clear();
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
});
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function endpoint(handler: (response: ServerResponse) => void) {
  const server = createServer({ key: tls.key, cert: tls.cert }, (_request, response) => handler(response));
  servers.push(server);
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_listener_invalid");
  const options = { baseUrl: `https://127.0.0.1:${address.port}/`, workspaceId: workspace, actorUserId: actor,
    bearerToken: "fixture-renderer-authority", ca, timeoutMs: 500 };
  return { options };
}
describe("private renderer prepare TLS transport", () => {
  it("performs a real CA-verified HTTPS metadata request", async () => {
    const f = await endpoint(response => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(metadata())); });
    await expect(createRendererGrant(f.options)("codex", "fixture-model")).resolves.toBe(grant);
  });
  it("refuses an untrusted certificate without printing a transport message", async () => {
    const f = await endpoint(response => response.end(JSON.stringify(metadata())));
    await expect(createRendererGrant({ ...f.options, ca: Buffer.from("invalid-fixture-ca") })("codex", "fixture-model"))
      .rejects.toThrow("renderer_prepare_transport_failed");
  });
  it("refuses redirect responses rather than following a private route", async () => {
    let received = 0;
    const f = await endpoint(response => { received++; response.writeHead(302, { location: "https://provider.example.test/private-sentinel" }); response.end("{}"); });
    await expect(createRendererGrant(f.options)("codex", "fixture-model")).rejects.toThrow("renderer_prepare_denied");
    expect(received).toBe(1);
  });
  it("bounds an oversized response before JSON projection", async () => {
    const f = await endpoint(response => response.end(JSON.stringify({ message: "private-sentinel".repeat(300_000) })));
    await expect(createRendererGrant(f.options)("codex", "fixture-model")).rejects.toThrow("renderer_prepare_response_invalid");
  });
  it("rejects malformed JSON with a closed response code", async () => {
    const f = await endpoint(response => response.end("private-sentinel"));
    await expect(createRendererGrant(f.options)("codex", "fixture-model")).rejects.toThrow("renderer_prepare_response_invalid");
  });
  it("times out an in-flight prepare request and closes its observation", async () => {
    const f = await endpoint(() => {});
    await expect(createRendererGrant({ ...f.options, timeoutMs: 40 })("codex", "fixture-model"))
      .rejects.toThrow("renderer_prepare_timeout");
  });
  it("cancels a prepare without retaining the caller's abort reason", async () => {
    let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const f = await endpoint(() => entered());
    const abort = new AbortController();
    const flight = createRendererGrant(f.options)("codex", "fixture-model", abort.signal);
    const rejection = expect(flight).rejects.toThrow("renderer_prepare_cancelled");
    await reached; abort.abort(new Error("private-sentinel")); await rejection;
  });
});
