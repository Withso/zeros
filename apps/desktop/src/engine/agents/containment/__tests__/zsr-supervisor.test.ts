import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SUPERVISOR = path.join(
  process.cwd(),
  "apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs",
);

describe("ZSR macOS credential authority", () => {
  it("removes every ambient Keychain Mach service from the patched profile", () => {
    const previous = process.env.ZEROS_ZSR_DENY_SECURITY_SERVER;
    process.env.ZEROS_ZSR_DENY_SECURITY_SERVER = "1";
    try {
      const command = wrapCommandWithSandboxMacOS({
        command: "true",
        needsNetworkRestriction: true,
        httpProxyPort: 41_001,
        socksProxyPort: 41_002,
        allowUnixSockets: [],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
        allowedLocalPorts: [],
        allowedBindPorts: [],
        deniedLocalPorts: [],
        readConfig: undefined,
        writeConfig: undefined,
        allowPty: true,
      });

      expect(command).not.toContain("com.apple.SecurityServer");
      expect(command).not.toContain("com.apple.securityd.xpc");
    } finally {
      if (previous === undefined) {
        delete process.env.ZEROS_ZSR_DENY_SECURITY_SERVER;
      } else {
        process.env.ZEROS_ZSR_DENY_SECURITY_SERVER = previous;
      }
    }
  });
});

describe("ZSR supervisor projection authority", () => {
  let root: string;
  let workspace: string;
  let privateRoot: string;
  let policyPath: string;
  let commandPath: string;
  const generation = "00000000-0000-4000-8000-000000000001";

  beforeEach(async () => {
    root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-supervisor-test-")),
    );
    workspace = path.join(root, "workspace");
    privateRoot = path.join(root, "private");
    policyPath = path.join(privateRoot, "policy.json");
    commandPath = path.join(privateRoot, "command.json");
    await Promise.all([
      mkdir(path.join(workspace, ".git"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(workspace, "Zeros Design"), {
        recursive: true,
        mode: 0o700,
      }),
      mkdir(path.join(privateRoot, "git"), { recursive: true, mode: 0o700 }),
      mkdir(path.join(privateRoot, "attacker"), {
        recursive: true,
        mode: 0o700,
      }),
      mkdir(path.join(privateRoot, "tools"), { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      chmod(path.join(privateRoot, "git"), 0o700),
      chmod(path.join(privateRoot, "attacker"), 0o700),
      chmod(path.join(privateRoot, "tools"), 0o700),
    ]);
    await writeFile(
      policyPath,
      `${JSON.stringify({
        version: 1,
        executionId: "projection-validation",
        generation,
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
        filesystem: {
          allowRead: [
            path.join(privateRoot, "git"),
            path.join(privateRoot, "tools"),
          ],
          allowWrite: [workspace, path.join(privateRoot, "git")],
          denyWrite: [path.join(workspace, ".git")],
          denyRead: [path.join(workspace, ".git")],
        },
        runtime: {
          normalNetwork: true,
          allowPty: true,
          allowedUnixSockets: [],
          allowedLocalPorts: [],
          deniedLocalPorts: [],
        },
      })}\n`,
      { mode: 0o600, flag: "wx" },
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function rejectionFor(
    source: string,
    destination: string,
    extra: Record<string, unknown> = {},
  ) {
    await writeFile(
      commandPath,
      `${JSON.stringify({
        version: 5,
        generation,
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: workspace,
        env: {},
        internalProxyPorts: { http: 41_001, socks: 41_002 },
        portPolicy: {
          version: 1,
          generation,
          token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          socketPath: path.join(privateRoot, "port-policy.sock"),
          initialPorts: [],
          bindPorts: [],
        },
        filesystemProjections: [{ source, destination, readOnly: false }],
        ...extra,
      })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return spawnSync(
      process.execPath,
      [SUPERVISOR, "--policy", policyPath, "--command", commandPath],
      {
        cwd: workspace,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        encoding: "utf8",
      },
    );
  }

  it("rejects a private source that is not the session shadow Git root", async () => {
    const result = await rejectionFor(
      path.join(privateRoot, "attacker"),
      path.join(workspace, ".git"),
    );
    expect(result.status).toBe(125);
    expect(result.stderr).toMatch(/source is outside private session state/);
  });

  it("rejects projection of private state over Design", async () => {
    const result = await rejectionFor(
      path.join(privateRoot, "git"),
      path.join(workspace, "Zeros Design"),
    );
    expect(result.status).toBe(125);
    expect(result.stderr).toMatch(/outside an exact denied control path/);
  });

  it("rejects duplicate destinations across a multi-repository projection set", async () => {
    const secondSource = path.join(privateRoot, "git", "second");
    await mkdir(secondSource, { recursive: true, mode: 0o700 });
    await chmod(secondSource, 0o700);
    const destination = path.join(workspace, ".git");
    const result = await rejectionFor(
      path.join(privateRoot, "git"),
      destination,
      {
        filesystemProjections: [
          {
            source: path.join(privateRoot, "git"),
            destination,
            readOnly: false,
          },
          { source: secondSource, destination, readOnly: false },
        ],
      },
    );
    expect(result.status).toBe(125);
    expect(result.stderr).toMatch(
      /invalid or duplicate Git filesystem projection/,
    );
  });

  it("rejects a container-worker launcher outside immutable private tools", async () => {
    const result = await rejectionFor(
      path.join(privateRoot, "git"),
      path.join(workspace, ".git"),
      {
        containerWorker: {
          version: 1,
          runtime: "podman",
          node: process.execPath,
          engine: process.execPath,
          launcher: path.join(privateRoot, "attacker", "worker.mjs"),
          state: path.join(privateRoot, "attacker"),
          socket: path.join(privateRoot, "attacker", "podman.sock"),
        },
      },
    );
    expect(result.status).toBe(125);
    expect(result.stderr).toMatch(/launcher is outside private tools/);
  });

  it("rejects undeclared dynamic-port fields instead of widening the launch protocol", async () => {
    const result = await rejectionFor(
      path.join(privateRoot, "git"),
      path.join(workspace, ".git"),
      {
        portPolicy: {
          version: 1,
          generation,
          token: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          socketPath: path.join(privateRoot, "port-policy.sock"),
          initialPorts: [],
          bindPorts: [],
          futureAuthority: true,
        },
      },
    );
    expect(result.status).toBe(125);
    expect(result.stderr).toMatch(/invalid dynamic port-policy descriptor/);
  });

  it("rejects wildcard or value-less credential authority grants", async () => {
    const wildcard = await rejectionFor(
      path.join(privateRoot, "git"),
      path.join(workspace, ".git"),
      {
        env: { OPENAI_API_KEY: "secret" },
        credentialCapabilities: [
          {
            name: "OPENAI_API_KEY",
            injectAuthorities: ["*.example.test:443"],
            allowPlaintext: false,
          },
        ],
      },
    );
    expect(wildcard.status).toBe(125);
    expect(wildcard.stderr).toMatch(/invalid provider credential capability/);

    commandPath = path.join(privateRoot, "command-missing.json");
    const missing = await rejectionFor(
      path.join(privateRoot, "git"),
      path.join(workspace, ".git"),
      {
        credentialCapabilities: [
          {
            name: "OPENAI_API_KEY",
            injectAuthorities: ["api.openai.com:443"],
            allowPlaintext: false,
          },
        ],
      },
    );
    expect(missing.status).toBe(125);
    expect(missing.stderr).toMatch(/has no bounded value/);
  });

  it("fails closed on an unavailable provider CA without disclosing its path", async () => {
    const missingCa = path.join(root, "sensitive", "missing-provider-ca.pem");
    const result = await rejectionFor(
      path.join(privateRoot, "git"),
      path.join(workspace, ".git"),
      {
        env: {
          OPENAI_API_KEY: "secret",
          NODE_EXTRA_CA_CERTS: missingCa,
        },
        credentialCapabilities: [
          {
            name: "OPENAI_API_KEY",
            injectAuthorities: ["api.openai.com:443"],
            allowPlaintext: false,
          },
        ],
      },
    );
    expect(result.status).toBe(125);
    expect(result.stderr).toMatch(
      /configured CA trust file from NODE_EXTRA_CA_CERTS is unavailable/,
    );
    expect(result.stderr).not.toContain(missingCa);
  });
});
