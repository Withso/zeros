import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadCloudWorkerConfiguration,
  parseCloudWorkerConfiguration,
} from "../cloud-worker-config";

const roots: string[] = [];
const toolchain = {
  node: "/usr/local/bin/node",
  supervisor: "/opt/zeros/zsr-supervisor.mjs",
  networkBridge: "/opt/zeros/zsr-network-bridge.mjs",
  containerWorker: "/opt/zeros/zsr-container-worker.mjs",
  bwrap: "/usr/bin/bwrap",
  socat: "/usr/bin/socat",
  setpriv: "/usr/bin/setpriv",
};
const cgroupParent = "/sys/fs/cgroup/zeros-agents";
const resources = {
  memoryBytes: 3 * 1024 * 1024 * 1024,
  cpuQuotaMicros: 200_000,
  cpuPeriodMicros: 100_000,
  processes: 2_048,
};

describe("cloud worker deployment configuration", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("accepts only the exact versioned deployment contract", () => {
    expect(
      parseCloudWorkerConfiguration(
        JSON.stringify({
          version: 1,
          backend: "cloud-worker",
          profile: "zeros-cloud-worker-v1",
          uid: 10_001,
          gid: 10_001,
          cgroupParent,
          resources,
          toolchain,
        }),
      ),
    ).toEqual({
      version: 1,
      backend: "cloud-worker",
      profile: "zeros-cloud-worker-v1",
      uid: 10_001,
      gid: 10_001,
      cgroupParent,
      resources,
      toolchain,
    });

    for (const value of [
      {
        version: 1,
        backend: "cloud-worker",
        profile: "zeros-cloud-worker-v1",
        uid: 10_001,
        gid: 10_001,
        cgroupParent,
        resources,
        toolchain,
        permissive: true,
      },
      {
        version: 1,
        backend: "cloud-worker",
        profile: "zeros-cloud-worker-v1",
        uid: 0,
        gid: 10_001,
        cgroupParent,
        resources,
        toolchain,
      },
      {
        version: 2,
        backend: "cloud-worker",
        profile: "zeros-cloud-worker-v1",
        uid: 10_001,
        gid: 10_001,
        cgroupParent,
        resources,
        toolchain,
      },
    ]) {
      expect(() =>
        parseCloudWorkerConfiguration(JSON.stringify(value)),
      ).toThrow(/unsupported contract/);
    }
  });

  it("treats an absent marker as a normal local runtime", () => {
    expect(
      loadCloudWorkerConfiguration(
        path.join(os.tmpdir(), "zeros-cloud-marker-does-not-exist.json"),
      ),
    ).toBeNull();
  });

  it("rejects a marker reachable through an untrusted writable ancestor", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(
      path.join(os.tmpdir(), "zeros-cloud-marker-untrusted-"),
    );
    roots.push(root);
    const marker = path.join(root, "cloud-worker.json");
    await writeFile(
      marker,
      `${JSON.stringify({
        version: 1,
        backend: "cloud-worker",
        profile: "zeros-cloud-worker-v1",
        uid: 10_001,
        gid: 10_001,
        cgroupParent,
        resources,
        toolchain,
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(root, 0o777);
    vi.spyOn(
      process as unknown as { geteuid: () => number },
      "geteuid",
    ).mockReturnValue(0);

    expect(() => loadCloudWorkerConfiguration(marker)).toThrow(
      /not root-controlled/,
    );
  });
});
