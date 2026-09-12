import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { expectsContainerWorkflow } from "../gateway";

describe("agent container-workflow detection", () => {
  it("detects normal container workflows independently from safe worker availability", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-docker-discovery-"));
    const docker = path.join(root, "docker");
    try {
      await writeFile(docker, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      expect(expectsContainerWorkflow({ PATH: root })).toBe(true);
      expect(
        expectsContainerWorkflow({
          PATH: "",
          DOCKER_HOST: "unix:///var/run/docker.sock",
        }),
      ).toBe(true);
      expect(
        expectsContainerWorkflow({
          PATH: "",
          PODMAN_HOST: "unix:///run/user/501/podman/podman.sock",
        }),
      ).toBe(true);
      expect(
        expectsContainerWorkflow({
          PATH: "",
          CONTAINER_CONNECTION: "local-podman",
        }),
      ).toBe(true);
      expect(expectsContainerWorkflow({ PATH: root + "-missing" })).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
