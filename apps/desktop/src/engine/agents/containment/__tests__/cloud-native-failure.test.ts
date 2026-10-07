import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ attest: vi.fn(), mkdir: vi.fn(), release: vi.fn(), rm: vi.fn() }));
vi.mock("node:fs/promises", async original => ({ ...await original<typeof import("node:fs/promises")>(),
  mkdir: mocks.mkdir, writeFile: vi.fn(), chown: vi.fn(), rm: mocks.rm,
  lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o700 }),
  realpath: async () => "/run/zeros/coordinators", readlink: async () => "pid:[fixture]",
}));
vi.mock("../cloud-worker-config", () => ({ loadCloudWorkerConfiguration: () => ({ version: 4, uid: 10001, gid: 10001,
  toolchain: { node: "/fixture/runtime/bin/node" } }) }));
vi.mock("../cloud-coordinator-view.mjs", () => ({ CLOUD_COORDINATOR_HOME: "/home/zeros-agent",
  cloudCoordinatorEnvironment: () => ({ HOME: "/home/zeros-agent", PATH: "/fixture/runtime/bin" }) }));
vi.mock("../cloud-coordinator-attestation", () => ({ attestCloudCoordinator: mocks.attest }));
vi.mock("../cloud-native-history", () => ({ CLOUD_NATIVE_HISTORY_ROOT: "/fixture/history",
  acquireCloudNativeHistory: async () => ({ mount: { provider: "cursor", directory: "/fixture/history/cursor" }, release: mocks.release }) }));
vi.mock("../../../git/github-native-broker", () => ({ createNativeGithubBroker: async () => ({ env: {} }) }));
import { CloudNativeBoundary } from "../cloud-native-boundary";
import type { CloudAgentLease } from "../../cloud-agent-lease";
import type { PreparedBoundary } from "../types";

describe("closed native containment failures", () => {
  it.each(["attestation_failed", "canary_failed"] as const)("distinguishes %s and preserves cleanup", async category => {
    vi.clearAllMocks();
    mocks.attest.mockReset();
    const error = new Error("private containment diagnostic");
    const lease = { admission: { provider: "cursor", model: "test-model" }, assertLive: vi.fn(), attach: vi.fn(),
      signal: new AbortController().signal, takeMaterial: () => ({ kind: "cursor-api-key", apiKey: "synthetic-key" }),
      close: vi.fn(async () => {}), launch: async (launch: () => unknown) => launch(), validate: vi.fn() };
    const workload = { generation: "fixture", status: { backend: "cloud-worker" },
      attestation: category === "attestation_failed" ? Promise.reject(error) : Promise.resolve(),
      spawn: vi.fn(async () => ({ stderr: { resume() {} } })) };
    mocks.attest.mockRejectedValueOnce(error);
    await expect(CloudNativeBoundary.prepare(lease as unknown as CloudAgentLease, workload as unknown as PreparedBoundary, "conversation"))
      .rejects.toMatchObject({ code: `cloud_containment_${category}` });
    if (category === "attestation_failed") expect(mocks.mkdir).not.toHaveBeenCalled();
    else { expect(workload.spawn).toHaveBeenCalledOnce(); expect(lease.close).toHaveBeenCalledOnce(); }
  });
});
