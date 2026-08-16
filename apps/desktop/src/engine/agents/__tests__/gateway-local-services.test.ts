import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import {
  deriveLoopbackServiceCapabilities,
  deriveContainerWorker,
  deriveToolchainReadRoots,
  expectsContainerWorkflow,
} from "../gateway";

describe("agent local-service discovery", () => {
  it("rewrites standard loopback URLs without dropping credentials or paths", () => {
    expect(
      deriveLoopbackServiceCapabilities({
        DATABASE_URL:
          "postgresql://alice:s%40fe@localhost:5544/app?sslmode=disable",
        DOCKER_HOST: "tcp://[::1]:2376",
      }),
    ).toEqual([
      {
        serviceId: "env-database-url",
        kind: "database",
        transport: "tcp",
        targetHost: "127.0.0.1",
        targetPort: 5544,
        adapter: "environment-only",
        environment: {
          DATABASE_URL:
            "postgresql://alice:s%40fe@{host}:{port}/app?sslmode=disable",
        },
      },
    ]);
  });

  it("discovers exact Unix SSH and Nix endpoints without exposing container control sockets", () => {
    expect(
      deriveLoopbackServiceCapabilities({
        SSH_AUTH_SOCK: "/private/tmp/launchd/Listeners",
        DOCKER_HOST: "unix:///run/user/501/docker.sock",
        CONTAINER_HOST: "unix:///run/user/501/podman.sock",
        NIX_REMOTE: "unix:///nix/var/nix/daemon-socket/socket",
      }),
    ).toEqual([
      {
        serviceId: "env-ssh-auth-sock",
        kind: "ssh-agent",
        transport: "unix",
        targetPath: "/private/tmp/launchd/Listeners",
        adapter: "ssh-agent",
      },
      {
        serviceId: "env-nix-remote",
        kind: "nix",
        transport: "unix",
        targetPath: "/nix/var/nix/daemon-socket/socket",
        adapter: "nix-daemon",
      },
    ]);
  });

  it("discovers a physical GPG agent with its client-state source and ignores stale sockets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "zeros-gpg-discovery-"));
    const home = path.join(root, "home");
    const gpgHome = path.join(home, ".gnupg");
    const agentSocket = path.join(gpgHome, "S.gpg-agent");
    await mkdir(gpgHome, { recursive: true, mode: 0o700 });
    await chmod(gpgHome, 0o700);
    const agent = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        agent.once("error", reject);
        agent.listen(agentSocket, resolve);
      });

      expect(
        deriveLoopbackServiceCapabilities({
          HOME: home,
          GNUPGHOME: gpgHome,
          GPG_AGENT_INFO: `${path.join(root, "stale.sock")}:123:1`,
        }),
      ).toContainEqual({
        serviceId: "env-gpg-agent",
        kind: "gpg-agent",
        transport: "unix",
        targetPath: agentSocket,
        adapter: "gpg-agent",
        sourceHome: gpgHome,
      });
    } finally {
      await new Promise<void>((resolve) => agent.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }

    expect(
      deriveLoopbackServiceCapabilities({
        HOME: home,
        GNUPGHOME: gpgHome,
        GPG_AGENT_INFO: `${path.join(root, "stale.sock")}:123:1`,
      }),
    ).not.toContainEqual(expect.objectContaining({ kind: "gpg-agent" }));
  });

  it("does not broker remote hosts, wildcard addresses, malformed ports, or relative sockets", () => {
    expect(
      deriveLoopbackServiceCapabilities({
        DATABASE_URL: "postgres://db.example.com:5432/app",
        REDIS_URL: "redis://0.0.0.0:6379",
        DOCKER_HOST: "unix://relative.sock",
        PGHOST: "/var/run/postgresql",
        MYSQL_HOST: "localhost",
        MYSQL_TCP_PORT: "not-a-port",
      }),
    ).toEqual([]);
  });

  it("retains exact PATH and known user toolchain roots for Linux root isolation", () => {
    expect(
      deriveToolchainReadRoots({
        HOME: "/home/alice",
        PATH: "/usr/bin:/home/alice/.nvm/versions/node/v22/bin:/home/alice/.local/bin:relative",
        VOLTA_HOME: "/home/alice/.volta",
      }),
    ).toEqual([
      "/home/alice/.local/bin",
      "/home/alice/.nvm",
      "/home/alice/.nvm/versions/node/v22/bin",
      "/home/alice/.volta",
      "/usr/bin",
    ]);
  });

  it("selects a physical Podman binary instead of an ambient daemon", async () => {
    if (process.platform !== "linux") return;
    const root = await mkdtemp(path.join(tmpdir(), "zeros-podman-discovery-"));
    const podman = path.join(root, "podman");
    try {
      await writeFile(podman, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      expect(
        deriveContainerWorker({
          PATH: root,
          DOCKER_HOST: "unix:///var/run/docker.sock",
        }),
      ).toEqual({
        runtime: "podman",
        backend: "embedded-linux",
        executable: podman,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      expect(expectsContainerWorkflow({ PATH: root + "-missing" })).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
