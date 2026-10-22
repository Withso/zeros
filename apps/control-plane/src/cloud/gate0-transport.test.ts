import { generateKeyPairSync, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { CloudV2WorkerSigner } from "./worker-auth.js";
import { createGate0TransportProbe } from "./gate0-transport.js";

function fixture(output = "LISTEN 0 511 127.0.0.1:41783 0.0.0.0:*\n") {
  const signer = new CloudV2WorkerSigner(generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
  const compute = {
    exec: vi.fn(async () => ({ stdout: output, stderr: "", exitCode: 0, timedOut: false })),
    hostPort: vi.fn(async () => ({ url: "https://fixture-41783.on.boat.dev", token: "synthetic-private-port-token" })),
  };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValueOnce(new Response(null, { status: 401 }));
  const probe = createGate0TransportProbe({ compute, signer, fetch: fetcher });
  return { compute, fetcher, probe, workspace: { id: randomUUID(), boatSandboxId: "bx_23456789" } };
}

it("checks the loopback binding and both private-route credentials without allocating a sandbox", async () => {
  const f = fixture();
  await f.probe(f.workspace);
  expect(f.compute.exec).toHaveBeenCalledWith(f.workspace.boatSandboxId, "ss -H -ltn 'sport = :41783'", 10);
  expect(f.compute.hostPort).toHaveBeenCalledWith(f.workspace.boatSandboxId, { port: 41783, localhost: true, title: "Zeros worker" });
  expect(f.fetcher).toHaveBeenCalledTimes(3);
  for (const [url, options] of f.fetcher.mock.calls) {
    expect(String(url)).toBe("https://fixture-41783.on.boat.dev/v2/worker/health");
    expect(options?.redirect).toBe("error");
  }
  const headers = f.fetcher.mock.calls.map(([, options]) => new Headers(options?.headers));
  expect(headers[0]!.has("cookie")).toBe(false);
  expect(headers[1]!.get("cookie")).toBe("_port_auth=synthetic-private-port-token");
  expect(headers[1]!.has("x-zeros-worker-auth")).toBe(false);
  const grant = headers[2]!.get("x-zeros-worker-auth")!;
  expect(JSON.parse(Buffer.from(grant.split(".")[1]!, "base64url").toString())).toMatchObject({ aud: f.workspace.id, boot: expect.any(String) });
});

it.each(["", "LISTEN 0 511 0.0.0.0:41783 0.0.0.0:*\n", "LISTEN 0 511 [::]:41783 [::]:*\n",
  "LISTEN 0 511 127.0.0.1:41783 0.0.0.0:*\nLISTEN 0 511 [::]:41783 [::]:*\n"])("fails closed for an absent or exposed listener", async output => {
  const f = fixture(output);
  await expect(f.probe(f.workspace)).rejects.toThrow("worker_loopback");
  expect(f.compute.hostPort).not.toHaveBeenCalled();
});

it.each(["worker_port_cookie", "worker_port_auth", "worker_stale_boot"])("requires the exact denial at %s", async stage => {
  const f = fixture(); const index = ["worker_port_cookie", "worker_port_auth", "worker_stale_boot"].indexOf(stage);
  f.fetcher.mockReset();
  for (let i = 0; i < 3; i++) f.fetcher.mockResolvedValueOnce(new Response(null, { status: i === index ? 200 : i === 0 ? 403 : 401 }));
  await expect(f.probe(f.workspace)).rejects.toThrow(stage);
});

it("never reflects Boat routes, cookies or errors into probe diagnostics", async () => {
  const f = fixture();
  f.fetcher.mockReset().mockRejectedValue(new Error("synthetic-private-port-token"));
  await expect(f.probe(f.workspace)).rejects.toThrow(/^Cloud v2 gate0 failed: worker_port_cookie$/);
});
