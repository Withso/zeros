import { generateKeyPairSync, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { CloudV2WorkerSigner } from "./worker-auth.js";
import { createGate0TransportProbe, createGate0TimingReader } from "./gate0-transport.js";

const worker = (address: string, pid = 18330) => `LISTEN 0 511 ${address} 0.0.0.0:* users:(("MainThread",pid=${pid},fd=21))\n`;
// Boat's in-VM port agent forwards the protected route from the VM's own
// interface addresses to the loopback-only worker.
const boatAgent = 'LISTEN 0 512 192.168.122.56:41783 0.0.0.0:* users:(("ascii-agents-se",pid=18271,fd=6))\n' +
  'LISTEN 0 512 [2001:db8::38]:41783 [::]:* users:(("ascii-agents-se",pid=18271,fd=8))\n';
const LOOPBACK = "worker-pid=18330\n" + boatAgent + worker("127.0.0.1:41783");

function fixture(output = LOOPBACK) {
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
  expect(f.compute.exec).toHaveBeenCalledWith(f.workspace.boatSandboxId,
    "echo \"worker-pid=$(systemctl show -p MainPID --value zeros-worker.service)\"; sudo -n ss -H -ltnp 'sport = :41783'", 10);
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

it.each([
  ["no output", ""],
  ["a stopped worker service", "worker-pid=0\n" + boatAgent],
  ["no worker listener", "worker-pid=18330\n" + boatAgent],
  ["a worker on every IPv4 address", "worker-pid=18330\n" + worker("0.0.0.0:41783")],
  ["a worker on every IPv6 address", "worker-pid=18330\n" + worker("[::]:41783")],
  ["a worker on loopback and an interface", LOOPBACK + worker("192.168.122.56:41783")],
  ["a worker listing without its process", "worker-pid=18330\nLISTEN 0 511 127.0.0.1:41783 0.0.0.0:*\n"],
  ["any other process on a wildcard address", LOOPBACK + 'LISTEN 0 511 *:41783 *:* users:(("other",pid=99,fd=3))\n'],
])("fails closed for %s", async (_name, output) => {
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

it("reads a bounded journal and returns only closed, content-free timing records", async () => {
  const valid = { agent: "codex", chat: "89abcdef", phase: "turn", stage: "turn_sent", elapsedMs: 42 };
  const line = (record: unknown) => `cloud-worker timing ${JSON.stringify(record)}\n`;
  const f = fixture("unrelated-private-output\n" + line(valid) + line({ ...valid, prompt: "private-prompt" }) +
    line({ ...valid, chat: "too-long-private-identity" }) + line({ ...valid, stage: "private-output" }) + line({ ...valid, elapsedMs: -1 }));
  const read = createGate0TimingReader({ compute: f.compute });
  expect(await read(f.workspace)).toEqual([valid]);
  expect(f.compute.exec).toHaveBeenCalledWith(f.workspace.boatSandboxId, "sudo -n journalctl -u zeros-worker.service -n 256 -o cat --no-pager", 10);
  expect(f.compute.hostPort).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
});

it.each(["failed", "timed-out", "oversize"])("withholds raw journal data when timing inspection is %s", async fault => {
  const f = fixture();
  f.compute.exec.mockResolvedValue({ stdout: fault === "oversize" ? "x".repeat(131073) : "private-output", stderr: "private-error",
    exitCode: fault === "failed" ? 1 : 0, timedOut: fault === "timed-out" });
  await expect(createGate0TimingReader({ compute: f.compute })(f.workspace)).rejects.toThrow(/^Cloud v2 gate0 failed: worker_timings$/);
});
