import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DeviceHub } from "../devices/device-hub";
import { createSimulatorRuntime } from "../devices/simulator-runtime";

describe("createSimulatorRuntime", () => {
  it("quits without starting a device read", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-simulator-runtime-"));
    const refresh = vi
      .spyOn(DeviceHub.prototype, "refresh")
      .mockImplementation(function (this: DeviceHub) {
        return Promise.resolve(this.snapshot());
      });
    try {
      const runtime = createSimulatorRuntime({
        platform: "darwin",
        packaged: false,
        resourcesPath: root,
        repoRoot: root,
        dataDir: root,
        execPath: process.execPath,
        env: {},
        encodeJpeg: (pixels) => pixels,
        scaleScreen: () => Buffer.alloc(0),
        thumbnail: async () => null,
        downloadsDir: () => root,
        onSnapshot: () => undefined,
        onFrame: () => undefined,
        onRecordings: () => undefined,
        onRecordingEnd: () => undefined,
        log: () => undefined,
      });
      await runtime.dispose();
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
