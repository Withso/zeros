import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LAUNCHER = path.join(
  process.cwd(),
  "apps/desktop/src/engine/agents/containment/cloud-container-worker.mjs",
);

describe.skipIf(process.platform !== "linux")("cloud container worker", () => {
  let root: string;
  let state: string;
  let socket: string;
  let engine: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "zeros-cloud-container-test-"));
    state = path.join(root, "state");
    socket = path.join(state, "podman.sock");
    engine = path.join(root, "podman");
    await mkdir(state, { mode: 0o700 });
    await writeFile(
      engine,
      `#!/usr/bin/env node
const { createServer } = require("node:net");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const socket = process.argv.find((value) => value.startsWith("unix://"))?.slice(7);
if (!socket) process.exit(91);
if (process.argv.some((value) => value.includes("ignore_chown_errors"))) process.exit(92);
writeFileSync(path.join(path.dirname(socket), "engine-env.json"), JSON.stringify({
  uid: process.getuid(),
  user: process.env.USER,
  logname: process.env.LOGNAME,
}));
const server = createServer((peer) => {
  peer.end("HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nOK");
});
server.listen(socket);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
`,
      { mode: 0o700 },
    );
    await chmod(engine, 0o700);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("starts the private API before the target and removes the endpoint", async () => {
    const marker = path.join(root, "target.json");
    const target = [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({docker: process.env.DOCKER_HOST, container: process.env.CONTAINER_HOST}))`,
    ];
    const result = spawnSync(
      process.execPath,
      [
        LAUNCHER,
        "--engine",
        engine,
        "--state",
        state,
        "--socket",
        socket,
        "--",
        ...target,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          // A privileged supervisor commonly retains these values after it
          // drops uid. Podman treats them as identity inputs and otherwise
          // attempts the wrong rootless namespace.
          USER: "root",
          LOGNAME: "root",
          DOCKER_HOST: `unix://${socket}`,
          CONTAINER_HOST: `unix://${socket}`,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
      docker: `unix://${socket}`,
      container: `unix://${socket}`,
    });
    const identity = os.userInfo();
    expect(
      JSON.parse(await readFile(path.join(state, "engine-env.json"), "utf8")),
    ).toEqual({
      uid: process.getuid?.(),
      user: identity.username,
      logname: identity.username,
    });
    expect(
      await readFile(path.join(state, "config", "storage.conf"), "utf8"),
    ).not.toContain("ignore_chown_errors");
    await expect(readFile(socket)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects option smuggling and a non-exact socket", () => {
    const result = spawnSync(
      process.execPath,
      [
        LAUNCHER,
        "--engine",
        engine,
        "--state",
        state,
        "--socket",
        path.join(state, "alternate.sock"),
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(125);
    expect(result.stderr).toMatch(/exact private endpoint/);
  });

  it("does not disclose private engine diagnostics", async () => {
    const secret = path.join(root, "credential-secret");
    await writeFile(
      engine,
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(secret)} >&2\nexit 92\n`,
      { mode: 0o700 },
    );
    const result = spawnSync(
      process.execPath,
      [
        LAUNCHER,
        "--engine",
        engine,
        "--state",
        state,
        "--socket",
        socket,
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("diagnostics");
    expect(result.stderr).not.toContain(secret);
  });
});
