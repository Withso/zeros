import { expect, it, vi } from "vitest";
import { workerReroute } from "./worker-reroute.js";
import type { WorkerRoute } from "./worker-connection.js";

const route = (state = "running"): WorkerRoute => ({
  workspace: { id: "00000000-0000-4000-8000-000000000001", boatSandboxId: "bx_fixture1234", state } as WorkerRoute["workspace"],
  accessEpoch: "1", bootId: "00000000-0000-4000-8000-000000000002", url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token",
});
const fixture = (hosted: { url: string; token: string }) => {
  const deps = { compute: { hostPort: vi.fn(async () => hosted) }, store: { replaceWorkerRoute: vi.fn(async () => true) },
    sealPortToken: vi.fn((token: string) => ({ sealed: token })) };
  return { deps, reroute: workerReroute(deps) };
};

it("asks for the route as the create does, and stores nothing when the same one comes back", async () => {
  const f = fixture({ url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token" });
  await expect(f.reroute(route())).resolves.toBe(true);
  expect(f.deps.compute.hostPort).toHaveBeenCalledExactlyOnceWith("bx_fixture1234", { port: 41783, localhost: true, title: "Zeros worker" });
  expect(f.deps.store.replaceWorkerRoute).not.toHaveBeenCalled();
});

it("keeps a different route, sealed, for the workspace on that machine", async () => {
  const f = fixture({ url: "https://other-41783.on.boat.dev", token: "synthetic-other-token" });
  await expect(f.reroute(route())).resolves.toBe(true);
  expect(f.deps.store.replaceWorkerRoute).toHaveBeenCalledExactlyOnceWith(route().workspace.id, "bx_fixture1234",
    "https://other-41783.on.boat.dev", { sealed: "synthetic-other-token" });
});

it("never asks for the route of a workspace that is not running", async () => {
  const f = fixture({ url: "https://fixture-41783.on.boat.dev", token: "synthetic-port-token" });
  await expect(f.reroute(route("stopping"))).resolves.toBe(false);
  expect(f.deps.compute.hostPort).not.toHaveBeenCalled();
});
