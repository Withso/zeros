import { describe, expect, it, vi } from "vitest";
import { BoatCloudV2Compute } from "./boat.js";
import { BoatApiClient } from "./boat-client.js";

describe("cloud v2 Boat compute", () => {
  const client = () => ({ request: vi.fn() });

  it("delivers bounded command input separately from every executable argument", async () => {
    const boat = client();
    boat.request.mockImplementation(async (route: string) => route.endsWith("/files")
      ? { ok: true, success: true, type: "file.written" }
      : { exitCode: 0, stdout: "done" });
    const compute = new BoatCloudV2Compute(boat);
    const input = "synthetic-command-input-canary\n";
    await compute.execLong("bx_abc12345", "bash -c 'cat >/dev/null'", 60, input);
    expect(boat.request.mock.calls.find(([route]) => route.endsWith("/files"))?.[1].body.content).toBe(input);
    const commands = boat.request.mock.calls.filter(([route]) => route.endsWith("/commands")).map(([, args]) => args.body.command);
    expect(commands.length).toBeGreaterThanOrEqual(3);
    expect(commands.join("\n")).not.toContain(input.trim());
    expect(commands.join("\n")).not.toContain(Buffer.from(input).toString("base64"));
    expect(commands[0]).toContain("umask 077");
    expect(commands[1]).toMatch(/exec 3<.*rm -f.*<&3/s);
    expect(commands.at(-1)).toContain("rmdir");
  });

  it("renews the existing sandbox lease with a bounded TTL and never allocates another VM", async () => {
    const boat = client(), compute = new BoatCloudV2Compute(boat);
    await compute.extendLease("bx_abc12345", 86_400);
    expect(boat.request).toHaveBeenCalledExactlyOnceWith("/sandboxes/bx_abc12345", { method: "PATCH", body: { ttlSeconds: 86_400 } });
    for (const ttl of [0, -1, 1.5, NaN, 86_401]) await expect(compute.extendLease("bx_abc12345", ttl)).rejects.toThrow("Invalid Boat lease");
    expect(boat.request).toHaveBeenCalledTimes(1);
  });

  it("hosts only a protected localhost port and splits its token from the saved URL", async () => {
    const fetcher = vi.fn(async () => Response.json({ type: "sandbox.host", url: "https://fixture-41783.on.boat.dev/?_token=synthetic-port-token", access: "private", isProtected: true, localhost: true }));
    const compute = new BoatCloudV2Compute(new BoatApiClient({ apiKey: "synthetic-unused-key", timeoutMs: 1000, fetch: fetcher }));
    for (let i = 0; i < 2; i++) expect(await compute.hostPort("bx_abc12345", { port: 41783, localhost: true, title: "Zeros worker" }))
      .toEqual({ url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token" });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ port: 41783, localhost: true, title: "Zeros worker" });
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("idempotency-key")).toBe(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("idempotency-key"));
  });

  it("refuses an unprotected or foreign host URL without exposing the token in its error", async () => {
    for (const response of [
      { url: "https://fixture-41783.on.boat.dev/?_token=synthetic-port-token", access: "public", isProtected: false, localhost: true },
      { url: "https://foreign.example.test/?_token=synthetic-port-token", access: "private", isProtected: true, localhost: true },
      { url: "https://fixture-41783.on.boat.dev/", access: "private", isProtected: true, localhost: true },
    ]) {
      const boat = client(); boat.request.mockResolvedValue(response);
      await expect(new BoatCloudV2Compute(boat).hostPort("bx_abc12345", { port: 41783, localhost: true, title: "Zeros worker" })).rejects.toThrow("Invalid private worker route");
    }
  });

  it("forks a stopped VM under the attempt's key, with no environment and no process tracer, and names only the new VM", async () => {
    for (const reply of [{ sandbox: { id: "bx_fork1234" } }, { sandboxId: "bx_fork1234" }, { sandbox: { id: "bx_fork1234" }, sandboxId: "bx_fork1234" }]) {
      const boat = client(); boat.request.mockResolvedValue(reply);
      expect(await new BoatCloudV2Compute(boat).fork("bx_abc12345", { key: "checkpoint:w:a", name: "zeros-alpha-ws-c1", ttlSeconds: 3600 }))
        .toEqual({ sandboxId: "bx_fork1234" });
      expect(boat.request).toHaveBeenCalledExactlyOnceWith("/sandboxes/bx_abc12345/fork", { method: "POST", idempotencyKey: "checkpoint:w:a",
        body: { type: "default", name: "zeros-alpha-ws-c1", ttlSeconds: 3600, env: {}, monitoring: false } });
    }
    for (const reply of [{}, { sandbox: { id: "bx_abc12345" } }, { sandbox: { id: "bx_fork1234" }, sandboxId: "bx_other123" }, { sandboxId: "not-a-vm" }]) {
      const boat = client(); boat.request.mockResolvedValue(reply);
      await expect(new BoatCloudV2Compute(boat).fork("bx_abc12345", { key: "k", name: "n", ttlSeconds: 3600 })).rejects.toThrow();
    }
    const boat = client();
    for (const ttl of [0, 86_401]) await expect(new BoatCloudV2Compute(boat).fork("bx_abc12345", { key: "k", name: "n", ttlSeconds: ttl })).rejects.toThrow("Invalid Boat lease");
    await expect(new BoatCloudV2Compute(boat).fork("../x", { key: "k", name: "n", ttlSeconds: 60 })).rejects.toThrow("Invalid Boat sandbox id");
    expect(boat.request).not.toHaveBeenCalled();
  });

  it("leaves the name out when none is given, and reads a VM's name and state", async () => {
    const boat = client(); boat.request.mockResolvedValue({ sandbox: { id: "bx_fork1234" } });
    await new BoatCloudV2Compute(boat).fork("bx_abc12345", { key: "k", ttlSeconds: 60 });
    expect(boat.request.mock.calls[0]![1].body).not.toHaveProperty("name");
    const inspect = client();
    inspect.request.mockResolvedValueOnce({ ok: true, sandbox: { id: "bx_abc12345", name: "zeros-alpha-ws-6f2b7c1e", state: "archived", extra: 1 } })
      .mockResolvedValueOnce({ ok: true, sandbox: { id: "bx_abc12345", state: "archiving" } })
      .mockResolvedValueOnce({ ok: true, sandbox: { id: "bx_abc12345" } });
    const compute = new BoatCloudV2Compute(inspect);
    expect(await compute.inspect("bx_abc12345")).toEqual({ name: "zeros-alpha-ws-6f2b7c1e", state: "archived" });
    expect(await compute.inspect("bx_abc12345")).toEqual({ name: null, state: "archiving" });
    await expect(compute.inspect("bx_abc12345")).rejects.toThrow();
    expect(inspect.request).toHaveBeenCalledWith("/sandboxes/bx_abc12345", { method: "GET" });
  });

  it("reports Boat's refusal to fork a VM that is still being archived as nothing created", async () => {
    const { BoatForkRefusedError } = await import("./boat-client.js");
    const fetcher = vi.fn(async () => Response.json({ ok: false, type: "sandbox.error", status: 409, code: "fork_failed" }, { status: 409 }));
    const compute = new BoatCloudV2Compute(new BoatApiClient({ apiKey: "synthetic-unused-key", timeoutMs: 1000, fetch: fetcher }));
    await expect(compute.fork("bx_abc12345", { key: "k", name: "n fork", ttlSeconds: 60 })).rejects.toBeInstanceOf(BoatForkRefusedError);
    // The same code on another route is not a fork refusal.
    await expect(compute.resume("bx_abc12345")).rejects.not.toBeInstanceOf(BoatForkRefusedError);
  });

  it("returns from a snapshot save only once Boat can deploy it", async () => {
    const boat = client();
    boat.request.mockResolvedValueOnce({ snapshot: { status: "saving" } })
      .mockResolvedValueOnce({ snapshot: { status: "saving" } })
      .mockResolvedValueOnce({ snapshot: { status: "ready" } });
    await new BoatCloudV2Compute(boat, "default", async () => {}).saveSnapshot("bx_abc12345", "zeros-alpha-org-v1");
    expect(boat.request).toHaveBeenNthCalledWith(1, "/named-snapshots", expect.objectContaining({ method: "POST", body: { sandboxId: "bx_abc12345", name: "zeros-alpha-org-v1" } }));
    expect(boat.request).toHaveBeenNthCalledWith(3, "/named-snapshots/zeros-alpha-org-v1", { method: "GET" });
  });

  it("always submits the current disk, never an earlier save that reused the name", async () => {
    const boat = client();
    boat.request.mockImplementation(async (_path, input) => {
      if (input.method === "POST") throw Object.assign(new Error("name already exists"), { code: "snapshot_name_exists", httpStatus: 409 });
      return { snapshot: { status: "ready" } };
    });
    await expect(new BoatCloudV2Compute(boat).saveSnapshot("bx_newbuild", "zeros-alpha-org-v1")).rejects.toMatchObject({ code: "snapshot_name_exists" });
    expect(boat.request).toHaveBeenCalledExactlyOnceWith("/named-snapshots", { method: "POST", body: { sandboxId: "bx_newbuild", name: "zeros-alpha-org-v1" } });
  });

  it("finds a sandbox by exact name, newest first, without reading past its creation window", async () => {
    const boat = client();
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 24, 12, minutes)).toISOString();
    boat.request
      .mockResolvedValueOnce({ sandboxes: [{ id: "bx_other111", name: "zeros-alpha-ws-x", createdAt: at(50) }], pageInfo: { hasMore: true, nextCursor: "c/2" } })
      .mockResolvedValueOnce({ sandboxes: [{ id: "bx_found111", name: "zeros-alpha-ws-r1", createdAt: at(40) }], pageInfo: { hasMore: false, nextCursor: null } });
    const compute = new BoatCloudV2Compute(boat);
    expect(await compute.findSandbox("zeros-alpha-ws-r1", new Date(at(30)))).toBe("bx_found111");
    expect(boat.request.mock.calls.map(([path]) => path)).toEqual(["/sandboxes?limit=200&sort=desc", "/sandboxes?limit=200&sort=desc&cursor=c%2F2"]);
    boat.request.mockReset().mockResolvedValueOnce({ sandboxes: [{ id: "bx_same111", name: "zeros-alpha-ws-r1", createdAt: at(10) }], pageInfo: { hasMore: true, nextCursor: "c" } });
    // Older than the attempt: never another attempt's VM, and no further pages.
    expect(await compute.findSandbox("zeros-alpha-ws-r1", new Date(at(30)))).toBeNull();
    expect(boat.request).toHaveBeenCalledTimes(1);
  });

  it("reports a failed save", async () => {
    const boat = client();
    boat.request.mockResolvedValueOnce({ snapshot: { status: "saving" } }).mockResolvedValueOnce({ snapshot: { status: "failed" } });
    await expect(new BoatCloudV2Compute(boat, "default", async () => {}).saveSnapshot("bx_abc12345", "zeros-alpha-org-v1"))
      .rejects.toMatchObject({ code: "computer_snapshot_failed" });
  });
});
