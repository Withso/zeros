import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  credentialInjectionAuthorities,
  schemaIssueSummary,
} from "../zsr-credential-authority.mjs";
import { CA_TRUST_ENV_NAMES } from "../zsr-boundary";

const SUPERVISOR = path.join(
  process.cwd(),
  "apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs",
);

describe("ZSR TLS-trust environment", () => {
  it("keeps the engine's canary list identical to the supervisor's rewrite list", async () => {
    const source = await readFile(SUPERVISOR, "utf8");
    const declaration = /const CA_TRUST_VARS = \[([^\]]*)\]/.exec(source);
    expect(declaration).not.toBeNull();
    const supervisorNames = [
      ...declaration![1]!.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g),
    ].map((match) => match[1]!);
    expect(supervisorNames.length).toBeGreaterThan(0);
    // The canary can only prove a name was left alone if it knows the name. A
    // variable added to the supervisor's rewrite list and forgotten here would
    // regress host parity invisibly, which is exactly how 15 of them once
    // reached every local session as the literal string `undefined`.
    expect([...CA_TRUST_ENV_NAMES]).toEqual(supervisorNames);
  });

  it("injects a trust bundle only when one was actually snapshotted", async () => {
    const source = await readFile(SUPERVISOR, "utf8");
    // Local host parity takes no snapshot (`path: undefined`), and the child
    // environment is rendered by interpolation, so this guard is what stands
    // between "the host's own trust configuration survives" and a session where
    // every TLS-honoring tool sees a nonexistent certificate path.
    expect(source).toContain(
      "if (caSnapshot.path && !command.credentialCapabilities?.length) {",
    );
    expect(source).toContain(
      'throw new Error("child environment value is not a string");',
    );
  });
});

describe("ZSR credential configuration", () => {
  it("keeps credential injection scoped to exact TLS authorities", () => {
    const authorities = ["api.cursor.com:443", "api2.cursor.sh:443"];
    const config = {
      network: {
        allowedDomains: ["*"],
        deniedDomains: [],
        tlsTerminate: { includeDomains: authorities },
      },
      filesystem: {
        allowRead: [],
        allowWrite: [],
        denyRead: [],
        denyWrite: [],
      },
      credentials: {
        envVars: [
          {
            name: "CURSOR_API_KEY",
            mode: "mask",
            injectHosts: credentialInjectionAuthorities(authorities),
          },
        ],
      },
    };

    expect(config.credentials.envVars[0].injectHosts).toEqual([
      "api.cursor.com:443",
      "api2.cursor.sh:443",
    ]);
    expect(SandboxRuntimeConfigSchema.safeParse(config).success).toBe(true);
  });

  it("summarizes schema failures by bounded paths without values", () => {
    const parsed = SandboxRuntimeConfigSchema.safeParse({
      network: { allowedDomains: ["*"] },
      filesystem: {},
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const summary = schemaIssueSummary(parsed.error);
    expect(summary).toMatch(/network\.deniedDomains/);
    expect(summary).not.toContain("Must be");
  });
});

describe("ZSR macOS credential authority", () => {
  it("compiles local host parity as a write-only subtraction", () => {
    const design = "/Users/example/project/Zeros Design";
    const privatePolicy = "/Users/example/private/policy.json";
    const command = wrapCommandWithSandboxMacOS({
      command: "true",
      hostParity: true,
      needsNetworkRestriction: false,
      allowUnixSockets: [],
      allowAllUnixSockets: true,
      allowLocalBinding: true,
      allowedLocalPorts: [],
      allowedBindPorts: [],
      deniedLocalPorts: [],
      readConfig: { denyOnly: [privatePolicy], allowWithinDeny: ["/"] },
      writeConfig: {
        allowOnly: ["/"],
        denyWithinAllow: [design],
        allowWithinDeny: [],
      },
      allowPty: true,
      disableMandatoryWriteProtection: true,
    });

    expect(command).toContain("(allow default)");
    expect(command).not.toContain("(deny default");
    expect(command).toContain(`(subpath "${design}")`);
    expect(command).not.toContain("(target same-sandbox)");
    const broadReadAllow = command.indexOf(
      '(allow file-read*\n  (subpath "/")',
    );
    const latePrivateDeny = command.indexOf(
      "(deny file-read*",
      broadReadAllow + 1,
    );
    expect(broadReadAllow).toBeGreaterThan(-1);
    expect(latePrivateDeny).toBeGreaterThan(broadReadAllow);
    expect(command.slice(latePrivateDeny)).toContain(
      `(subpath "${privatePolicy}")`,
    );
  });

  it("keeps the generated trust bundle readable inside a denied runtime directory", () => {
    const networkRoot = "/private/tmp/zeros-zsr-network";
    const runtimeRoot = `${networkRoot}/runtime`;
    const trustBundle = `${runtimeRoot}/srt-ca-test/trust-bundle.crt`;
    const command = wrapCommandWithSandboxMacOS({
      command: "true",
      needsNetworkRestriction: true,
      httpProxyPort: 41_001,
      socksProxyPort: 41_002,
      caCertPath: trustBundle,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowedLocalPorts: [],
      allowedBindPorts: [],
      deniedLocalPorts: [],
      readConfig: {
        denyOnly: [runtimeRoot],
        allowWithinDeny: [networkRoot, trustBundle],
      },
      writeConfig: undefined,
      allowPty: true,
    });
    const profile = command;

    expect(profile).toContain(
      `(require-all (subpath "${runtimeRoot}") (require-not (subpath "${trustBundle}")))`,
    );
    expect(profile).not.toContain(`(require-not (subpath "${networkRoot}"))`);
  });

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

// Filesystem projections are a Linux bind-mount primitive. macOS protects
// canonical Git through native interposition and correctly rejects a projection
// descriptor before reaching these Linux-specific shape checks.
const describeLinuxProjectionAuthority =
  process.platform === "linux" ? describe : describe.skip;
describeLinuxProjectionAuthority("ZSR supervisor projection authority", () => {
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

  it("snapshots Codex CA trust when authentication lives in private HOME", async () => {
    const missingCa = path.join(root, "sensitive", "missing-codex-ca.pem");
    const result = await rejectionFor(
      path.join(privateRoot, "git"),
      path.join(workspace, ".git"),
      {
        env: { CODEX_CA_CERTIFICATE: missingCa },
      },
    );

    expect(result.status).toBe(125);
    expect(result.stderr).toMatch(
      /configured CA trust file from CODEX_CA_CERTIFICATE is unavailable/,
    );
    expect(result.stderr).not.toContain(missingCa);
  });
});
