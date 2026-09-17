import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SandboxManager,
  SandboxRuntimeConfigSchema,
} from "@anthropic-ai/sandbox-runtime";
import {
  cleanupBwrapMountPoints,
  type LinuxSandboxParams,
  wrapCommandWithSandboxLinux,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
import { wrapCommandWithSandboxMacOS } from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";
import { rgPath } from "@vscode/ripgrep";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SUPERVISOR = path.join(
  process.cwd(),
  "apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs",
);
const MACOS_PROCESS_DOMAIN_HELPER = path.join(
  process.cwd(),
  "apps/desktop/src/engine/agents/containment/zsr-macos-process-domain.c",
);
const LOCAL_QUALIFICATION = path.join(
  process.cwd(),
  "scripts/zsr-qualification/local-host-parity.ts",
);
const QUALIFICATION_RUNNER = path.join(
  process.cwd(),
  "scripts/zsr-qualification/run.mjs",
);

describe("ZSR host-parity supervisor", () => {
  it("does not initialize a network proxy for host parity", async () => {
    const config = SandboxRuntimeConfigSchema.parse({
      hostParity: true,
      filesystem: {
        denyRead: [],
        allowRead: ["/"],
        allowWrite: ["/"],
        denyWrite: [],
        allowGitConfig: true,
        disableMandatoryWriteProtection: true,
      },
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowAllUnixSockets: true,
        allowLocalBinding: true,
      },
      allowPty: true,
      allowAppleEvents: false,
      ripgrep: { command: rgPath },
    });

    try {
      await SandboxManager.initialize(config);
      expect(SandboxManager.getProxyPort()).toBeUndefined();
      expect(SandboxManager.getSocksProxyPort()).toBeUndefined();
      expect(SandboxManager.getLinuxHttpSocketPath()).toBeUndefined();
      expect(SandboxManager.getLinuxSocksSocketPath()).toBeUndefined();
    } finally {
      await SandboxManager.reset();
    }
  });

  it("contains only the shipped host-parity controls", async () => {
    const source = await readFile(SUPERVISOR, "utf8");
    expect(source).toContain("hostParity: true");
    expect(source).toContain("linuxPrivilegedWorker");
    expect(source).toContain("allowAppleEvents: false");
    // The observational violation monitor is gated on SRT_DEBUG: enforcement
    // is the generated profile, not the monitor, and the supervisor never
    // reads the violation store — so production spawns must not pay for it.
    expect(source).toContain("const enableViolationMonitor =");
    expect(source).not.toContain(
      "SandboxManager.initialize(parsedConfig.data, undefined, true)",
    );
    expect(source).toContain("ZEROS_ZSR_RIPGREP_PATH");
    expect(source).toContain("ripgrep:");
    expect(source).not.toContain("allowAppleEvents: true");
    expect(source).not.toContain("subtractionProfile");
    expect(source).not.toMatch(/allowedBindPorts|allowedLocalPorts: \[\]/);
    expect(source).not.toMatch(
      /zsr-resource-limits|zsr-port-policy-control|zsr-credential-authority/,
    );
    expect(source).not.toMatch(
      /credentialCapabilities|filesystemProjections|networkBridge|resourceLimitShell/,
    );
  });

  it("live-qualifies the macOS Apple Events subtraction without launching an app", async () => {
    const helper = await readFile(MACOS_PROCESS_DOMAIN_HELPER, "utf8");
    const fixture = await readFile(LOCAL_QUALIFICATION, "utf8");
    const runner = await readFile(QUALIFICATION_RUNNER, "utf8");

    expect(helper).toContain('"appleevent-send"');
    expect(helper).toContain('"lsopen"');
    expect(helper).toContain('"authority"');
    expect(fixture).toContain("appleEventsDenied");
    expect(fixture).toContain("ambientContainerSocketDenied");
    expect(fixture).toContain("ambientContainerSelectorsScrubbed");
    expect(runner).toContain('"macos-apple-events-denial"');
    expect(runner).toContain('"ambient-container-authority-denial"');
  });

  it("compiles macOS host parity as a write-only subtraction", () => {
    const design = "/Users/example/project/Zeros Design";
    const privatePolicy = "/Users/example/private/policy.json";
    const ambientContainerSocket = "/private/var/run/docker.sock";
    const command = wrapCommandWithSandboxMacOS({
      command: "true",
      hostParity: true,
      needsNetworkRestriction: false,
      allowUnixSockets: [],
      allowAllUnixSockets: true,
      allowLocalBinding: true,
      readConfig: {
        denyOnly: [privatePolicy, ambientContainerSocket],
        allowWithinDeny: ["/"],
      },
      writeConfig: {
        allowOnly: ["/"],
        denyWithinAllow: [design],
        allowWithinDeny: [],
      },
      allowPty: true,
      allowAppleEvents: false,
      disableMandatoryWriteProtection: true,
    });

    expect(command).toContain("(allow default)");
    expect(command).not.toContain("(deny default");
    expect(command).toContain("(deny appleevent-send)");
    expect(command).toContain("(deny lsopen)");
    expect(command).toContain(
      '(deny mach-lookup (global-name "com.apple.coreservices.appleevents"))',
    );
    expect(command).toContain(
      `(deny network-bind (local unix-socket (literal "${ambientContainerSocket}")))`,
    );
    expect(command).toContain(
      `(deny network-outbound (remote unix-socket (literal "${ambientContainerSocket}")))`,
    );
    expect(command).toContain(`(subpath "${design}")`);
    const broadReadAllow = command.indexOf(
      '(allow file-read*\n  (subpath "/")',
    );
    const latePrivateDeny = command.indexOf(
      "(deny file-read*",
      broadReadAllow + 1,
    );
    expect(latePrivateDeny).toBeGreaterThan(broadReadAllow);
    expect(command.slice(latePrivateDeny)).toContain(
      `(subpath "${privatePolicy}")`,
    );
  });

  it("keeps grouped macOS denies after a writable-island carve-out", () => {
    const writableIsland = "/Users/example/project";
    const deniedPaths = ["alpha", "beta", "gamma", "delta", "epsilon"].map(
      (name) => `${writableIsland}/worktrees/${name}/config.worktree`,
    );
    const command = wrapCommandWithSandboxMacOS({
      command: "true",
      hostParity: true,
      needsNetworkRestriction: false,
      readConfig: { denyOnly: [], allowWithinDeny: ["/"] },
      writeConfig: {
        allowOnly: ["/"],
        denyWithinAllow: deniedPaths,
        allowWithinDeny: [writableIsland],
      },
      disableMandatoryWriteProtection: true,
    });

    const carveOut = command.indexOf(
      `(allow file-write* file-write-unlink file-write-create\n  (subpath "${writableIsland}")`,
    );
    const groupedDeny =
      "worktrees/(alpha|beta|gamma|delta|epsilon)/(config\\\\.worktree)";

    expect(carveOut).toBeGreaterThan(-1);
    expect(command.lastIndexOf(groupedDeny)).toBeGreaterThan(carveOut);
  });
});

describe.skipIf(process.platform !== "linux")(
  "ZSR Linux runtime compatibility",
  () => {
    let root: string;
    let capture: string;

    beforeEach(async () => {
      root = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "zeros-srt-compat-")),
      );
      capture = path.join(root, "capture-bwrap");
      // Capture the real generated argv without needing mount/user namespaces.
      // Kernel enforcement is exercised separately by check:zsr:runtime.
      await writeFile(
        capture,
        "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n",
        { mode: 0o700 },
      );
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      cleanupBwrapMountPoints();
      await rm(root, { recursive: true, force: true });
    });

    async function argumentsFor(overrides: Partial<LinuxSandboxParams> = {}) {
      const command = await wrapCommandWithSandboxLinux({
        command: "true",
        needsNetworkRestriction: false,
        allowAllUnixSockets: true,
        disableMandatoryWriteProtection: true,
        writeConfig: { allowOnly: [root], denyWithinAllow: [] },
        bwrapPath: capture,
        ...overrides,
      });
      const result = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as string[];
    }

    it.each([false, true])(
      "drops root capabilities in upstream isolation (weaker nesting: %s)",
      async (enableWeakerNestedSandbox) => {
        vi.spyOn(process, "geteuid").mockReturnValue(0);
        const args = await argumentsFor({ enableWeakerNestedSandbox });
        expect(args).toContain("--unshare-user");
        expect(args).toContain("--unshare-pid");
        expect(
          args.slice(
            args.indexOf("--cap-drop"),
            args.indexOf("--cap-drop") + 2,
          ),
        ).toEqual(["--cap-drop", "ALL"]);
        expect(args).not.toContain("--cap-add");
      },
    );

    it("drops ordinary host-parity capabilities without isolating host processes", async () => {
      const args = await argumentsFor({ hostParity: true });
      expect(args).not.toContain("--unshare-user");
      expect(args).not.toContain("--unshare-pid");
      expect(args).toContain("--dev-bind");
      expect(
        args.slice(args.indexOf("--cap-drop"), args.indexOf("--cap-drop") + 2),
      ).toEqual(["--cap-drop", "ALL"]);
      expect(args).not.toContain("--cap-add");
    });

    it("retains only worker identity-transition capabilities until setpriv drops them", async () => {
      vi.spyOn(process, "geteuid").mockReturnValue(0);
      const args = await argumentsFor({
        hostParity: true,
        linuxPrivilegedWorker: {
          uid: 1000,
          gid: 1000,
          setprivPath: await realpath("/usr/bin/setpriv"),
        },
      });
      expect(args).not.toContain("--unshare-user");
      expect(args).not.toContain("--unshare-pid");
      expect(
        args.filter((_, index) => args[index - 1] === "--cap-add"),
      ).toEqual(["CAP_SETUID", "CAP_SETGID", "CAP_SETPCAP"]);
      const workload = args.at(-1)!;
      for (const required of [
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--no-new-privs",
        "--reuid=1000",
        "--regid=1000",
        "--clear-groups",
        "+noroot_locked",
        "+no_setuid_fixup_locked",
      ]) {
        expect(workload).toContain(required);
      }
    });

    it("preserves nested write denies and read masks after reopening a writable island", async () => {
      const island = path.join(root, "scratch");
      const denied = path.join(island, "protected");
      const secret = path.join(island, "secret.txt");
      await mkdir(denied, { recursive: true });
      await writeFile(secret, "private");
      const args = await argumentsFor({
        hostParity: true,
        readConfig: { denyOnly: [secret], allowWithinDeny: [] },
        writeConfig: {
          allowOnly: [root, island],
          denyWithinAllow: [root, denied],
          allowWithinDeny: [island],
        },
      });
      const lastBind = args.reduce(
        (last, arg, index) =>
          arg === "--bind" && args[index + 2] === island ? index : last,
        -1,
      );
      expect(lastBind).toBeGreaterThan(-1);
      expect(args.slice(lastBind + 3).join("\n")).toContain(
        ["--ro-bind", denied, denied].join("\n"),
      );
      expect(args.slice(lastBind + 3).join("\n")).toContain(
        ["--ro-bind", "/dev/null", secret].join("\n"),
      );
    });

    it("omits redundant child binds when the containing denied directory stays read-only", async () => {
      const denied = path.join(root, "protected");
      const file = path.join(denied, "config.json");
      await mkdir(denied);
      await writeFile(file, "{}");
      const args = await argumentsFor({
        writeConfig: { allowOnly: [root], denyWithinAllow: [denied, file] },
      });
      expect(args.join("\n")).toContain(
        ["--ro-bind", denied, denied].join("\n"),
      );
      expect(args).not.toContain(file);
    });
  },
);

describe("ZSR supervisor launch contract", () => {
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
    commandPath = path.join(privateRoot, "commands", "command.json");
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(path.join(privateRoot, "commands"), {
        recursive: true,
        mode: 0o700,
      }),
      mkdir(path.join(privateRoot, "tools"), {
        recursive: true,
        mode: 0o700,
      }),
      mkdir(path.join(privateRoot, "container"), {
        recursive: true,
        mode: 0o700,
      }),
    ]);
    await writeFile(
      policyPath,
      `${JSON.stringify({
        version: 1,
        executionId: "launch-validation",
        generation,
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
        filesystem: {
          allowRead: ["/"],
          allowWrite: ["/"],
          denyWrite: [],
          denyRead: [],
        },
        runtime: {
          normalNetwork: true,
          allowPty: true,
          localHostParity: true,
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

  async function rejectCommand(extra: Record<string, unknown>) {
    await writeFile(
      commandPath,
      `${JSON.stringify({
        version: 6,
        generation,
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        cwd: workspace,
        deniedContainerSockets: [],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          OPENAI_API_KEY: "raw-provider-key-must-not-be-logged",
        },
        ...extra,
      })}\n`,
      { mode: 0o600 },
    );
    return spawnSync(
      process.execPath,
      [SUPERVISOR, "--policy", policyPath, "--command", commandPath],
      {
        cwd: workspace,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ZEROS_ZSR_RIPGREP_PATH: rgPath,
        },
        encoding: "utf8",
      },
    );
  }

  it.each([
    ["credentialCapabilities", []],
    ["filesystemProjections", []],
    ["networkBridge", {}],
    ["portPolicy", {}],
    ["internalProxyPorts", { http: 41_001, socks: 41_002 }],
  ])("rejects the retired %s authority field", async (name, value) => {
    const result = await rejectCommand({ [name]: value });
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("unsupported field");
    expect(result.stderr).not.toContain("raw-provider-key");
  });

  it("rejects a non-string environment value without echoing it", async () => {
    const result = await rejectCommand({ env: { SECRET: { nested: true } } });
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("invalid entry");
    expect(result.stderr).not.toContain("nested");
  });

  it("rejects a Git dispatcher configuration outside private tools", async () => {
    const result = await rejectCommand({
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ZEROS_ZSR_GIT_DISPATCH_CONFIG: path.join(root, "attacker.conf"),
      },
    });
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("Git dispatcher configuration is invalid");
  });

  it("preserves the validated private Git dispatcher configuration", async () => {
    const expected = path.join(privateRoot, "tools", "git-dispatch.conf");
    const result = await rejectCommand({
      args: [
        "-e",
        `process.exit(process.env.ZEROS_ZSR_GIT_DISPATCH_CONFIG === ${JSON.stringify(expected)} ? 0 : 91)`,
      ],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        ZEROS_ZSR_GIT_DISPATCH_CONFIG: expected,
      },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it.runIf(process.platform === "linux")(
    "rejects cloud container authority from a desktop boundary",
    async () => {
      const result = await rejectCommand({
        containerWorker: {
          version: 1,
          runtime: "podman",
          node: process.execPath,
          engine: process.execPath,
          launcher: path.join(
            privateRoot,
            "tools",
            "cloud-container-worker.mjs",
          ),
          state: path.join(privateRoot, "container"),
          socket: path.join(privateRoot, "container", "podman.sock"),
        },
      });
      expect(result.status).toBe(125);
      expect(result.stderr).toContain(
        "invalid cloud container-worker descriptor",
      );
    },
  );
});
