import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type { AgentAdapter } from "../types";
import type { PreparedBoundary } from "../containment/types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";
import {
  configureLoginShellPathRunner,
  getLoginShellPath,
  resetLoginShellPathForTests,
} from "../adapters/shared/login-shell-path";
import {
  closeState,
  insertWorkspace,
  setStateRootForTesting,
} from "../../git/state";

const exec = promisify(execFile);
const gateways: AgentGateway[] = [];
let root: string;
let bin: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-agent-path-"));
  bin = path.join(root, "new-bin");
  await mkdir(bin);
  const shell = path.join(root, "shell");
  await writeFile(shell, '#!/bin/sh\n/bin/cat "$0.path"\n');
  await chmod(shell, 0o755);
  await writeFile(`${shell}.path`, "/usr/bin:/bin\n");
  vi.stubEnv("SHELL", shell);
  vi.stubEnv("ZEROS_USER_SETTINGS_DIR", path.join(root, "settings"));
  setStateRootForTesting(path.join(root, "state"));
  expect(await getLoginShellPath()).toBe("/usr/bin:/bin");
  await writeFile(`${shell}.path`, `${bin}:/usr/bin:/bin\n`);
  await writeFile(
    path.join(bin, "zeros-new-agent"),
    '#!/bin/sh\nprintf "started\\n" >> "$MARKER"\n',
  );
  await chmod(path.join(bin, "zeros-new-agent"), 0o755);
});

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.dispose()));
  closeState();
  setStateRootForTesting(null);
  resetLoginShellPathForTests();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function fixture(
  native = true,
  operation?: (
    env: Record<string, string>,
    boundary: PreparedBoundary,
  ) => Promise<unknown>,
) {
  const boundary = testExecutionBoundary();
  const gateway = new AgentGateway({
    projectRoot: root,
    executionBoundary: native ? { ...boundary, backend: "none" } : boundary,
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  });
  gateways.push(gateway);
  gateway.setOrganizationMcpResolver(async () => []);
  const starts: Record<string, string>[] = [];
  const start = async (opts: {
    cwd: string;
    env: Record<string, string>;
    executionId: string;
    executionBoundary: PreparedBoundary;
  }) => {
    starts.push({ ...opts.env });
    await (operation?.(opts.env, opts.executionBoundary) ??
      exec("zeros-new-agent", [], { cwd: opts.cwd, env: opts.env }));
    return {
      session: { executionId: opts.executionId, sessionId: opts.executionId },
      initialize: {},
    };
  };
  const adapter = {
    agentId: "path-test-agent",
    newSession: start,
    loadSession: async (opts: {
      cwd: string;
      env: Record<string, string>;
      executionId: string;
      executionBoundary: PreparedBoundary;
    }) => {
      await start(opts);
      return { executionId: opts.executionId, resumedFresh: false };
    },
    forkProviderBinding: async (opts: {
      cwd: string;
      env: Record<string, string>;
      executionBoundary: PreparedBoundary;
    }) => {
      await start({ ...opts, executionId: "fork" });
      return {
        providerBinding: {
          version: 1,
          providerId: "path-test-agent",
          kind: "native",
          resumeId: "forked-session",
        },
      };
    },
    dispose: async () => {},
  } as unknown as AgentAdapter;
  (gateway as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
    adapter.agentId,
    adapter,
  );
  const options = {
    cwd: root,
    env: { PATH: "/usr/bin:/bin", MARKER: path.join(root, "effects") },
  };
  return { gateway, starts, options };
}

async function registerWorkspace(id: string, organizationId: string | null) {
  const cwd = path.join(root, id);
  await mkdir(cwd);
  insertWorkspace({
    id,
    organizationId,
    placement: "local",
    repoSlug: id,
    repoRoot: cwd,
    branch: "main",
    baseBranch: "main",
    path: cwd,
    status: "in-progress",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    archivedAt: null,
    stashRef: null,
    prNumber: null,
    prState: null,
    prUrl: null,
    agentId: null,
  });
  return { workspaceId: id, cwd };
}

describe("Local agent executable recovery", () => {
  it.each(["newSession", "loadSession", "forkSession"] as const)(
    "re-probes the real shell/cache once for %s after native spawn ENOENT",
    async (stage) => {
      const { gateway, starts, options } = fixture();
      const result =
        stage === "newSession"
          ? gateway.newSession("path-test-agent", options)
          : stage === "loadSession"
            ? gateway.loadSession(
                "path-test-agent",
                "previous-session",
                options,
              )
            : gateway.forkProviderBinding(
                "path-test-agent",
                {
                  version: 1,
                  providerId: "path-test-agent",
                  kind: "native",
                  resumeId: "previous-session",
                },
                options,
              );
      await expect(result).resolves.toBeDefined();
      expect(starts).toHaveLength(2);
      expect(starts[1]!.PATH).toBe(`${bin}:/usr/bin:/bin`);
      expect(await readFile(path.join(root, "effects"), "utf8")).toBe(
        "started\n",
      );
    },
  );

  it("uses the confirmed refreshed PATH for the next ordinary start", async () => {
    await getLoginShellPath({ refresh: true });
    vi.stubEnv("PATH", "/usr/bin:/bin");
    const { gateway, starts, options } = fixture();
    await gateway.newSession("path-test-agent", {
      ...options,
      env: { MARKER: options.env.MARKER },
    });
    expect(starts).toHaveLength(1);
    expect(starts[0]!.PATH).toBe(`${bin}:/usr/bin:/bin`);
  });

  it("keeps an explicit session PATH prefix when refreshing inherited entries", async () => {
    const customBin = path.join(root, "session-bin");
    await mkdir(customBin);
    const { gateway, starts, options } = fixture();
    await gateway.newSession("path-test-agent", {
      ...options,
      env: { ...options.env, PATH: `${customBin}:/usr/bin:/bin` },
    });
    expect(starts[1]!.PATH).toBe(`${customBin}:${bin}:/usr/bin:/bin`);
  });

  it("does not repeat startup after an earlier child already performed effects", async () => {
    const { gateway, starts, options } = fixture(
      true,
      async (env, boundary) => {
        const child = await boundary.spawn({
          command: "/bin/sh",
          args: ["-c", 'printf "started\\n" >> "$MARKER"'],
          cwd: root,
          env,
        });
        await child.wait();
        await exec("zeros-new-agent", [], { cwd: root, env });
      },
    );
    await expect(
      gateway.newSession("path-test-agent", options),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(starts).toHaveLength(1);
    expect(await readFile(path.join(root, "effects"), "utf8")).toBe(
      "started\n",
    );
  });

  it("does not re-run an executable that exits 127 after its own effects", async () => {
    const { gateway, starts, options } = fixture(true, (env) =>
      exec("/bin/sh", ["-c", 'printf "started\\n" >> "$MARKER"; exit 127'], {
        cwd: root,
        env,
      }),
    );
    await expect(
      gateway.newSession("path-test-agent", options),
    ).rejects.toMatchObject({ code: 127 });
    expect(starts).toHaveLength(1);
    expect(await readFile(path.join(root, "effects"), "utf8")).toBe(
      "started\n",
    );
  });

  it("does not mistake file-read ENOENT for an unstarted executable", async () => {
    const { gateway, starts, options } = fixture(true, () =>
      readFile(path.join(root, "absent-config")),
    );
    await expect(
      gateway.newSession("path-test-agent", options),
    ).rejects.toMatchObject({ code: "ENOENT", syscall: "open" });
    expect(starts).toHaveLength(1);
    expect(await getLoginShellPath()).toBe("/usr/bin:/bin");
  });

  it("never imports the Local PATH into a non-native agent boundary", async () => {
    const { gateway, starts, options } = fixture(false);
    await expect(
      gateway.newSession("path-test-agent", options),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(starts).toHaveLength(1);
    expect(await getLoginShellPath()).toBe("/usr/bin:/bin");
  });

  it("does not restart after admission is cancelled while the recovery probe is held", async () => {
    let entered!: () => void;
    let finishProbe!: (result: { stdout: string }) => void;
    const probing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    configureLoginShellPathRunner({
      cacheKey: "held-agent-refresh",
      run: vi
        .fn()
        .mockResolvedValueOnce({ stdout: "/usr/bin:/bin\n" })
        .mockImplementationOnce(() => {
          entered();
          return new Promise((resolve) => {
            finishProbe = resolve;
          });
        }),
    });
    await getLoginShellPath();
    const { gateway, starts, options } = fixture();
    const abort = new AbortController();
    const starting = gateway.newSession("path-test-agent", {
      ...options,
      admissionSignal: abort.signal,
    });
    const rejected = expect(starting).rejects.toThrow();
    await probing;
    abort.abort(new Error("cancelled startup"));
    finishProbe({ stdout: `${bin}:/usr/bin:/bin\n` });
    await rejected;
    expect(starts).toHaveLength(1);
  });

  it("keeps a cancelled Local start retired across organization-local and Local starts", async () => {
    const personal = await registerWorkspace("personal", null);
    const organization = await registerWorkspace("organization", "org-test");
    let entered!: () => void;
    let finishProbe!: (result: { stdout: string }) => void;
    const probing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    configureLoginShellPathRunner({
      cacheKey: "owner-switch-refresh",
      run: vi
        .fn()
        .mockResolvedValueOnce({ stdout: "/usr/bin:/bin\n" })
        .mockImplementationOnce(() => {
          entered();
          return new Promise((resolve) => {
            finishProbe = resolve;
          });
        }),
    });
    await getLoginShellPath();
    const { gateway, starts, options } = fixture();
    const abort = new AbortController();
    let retiredId = "";
    const retired = gateway.newSession("path-test-agent", {
      ...options,
      ...personal,
      admissionSignal: abort.signal,
      onExecutionCreated: (id) => {
        retiredId = id;
      },
    });
    const rejected = expect(retired).rejects.toThrow();
    await probing;
    abort.abort(new Error("owner changed"));
    await rejected;
    const env = { ...options.env, PATH: `${bin}:/usr/bin:/bin` };
    const other = await gateway.newSession("path-test-agent", {
      ...organization,
      env,
    });
    const returned = await gateway.newSession("path-test-agent", {
      ...personal,
      env,
    });
    finishProbe({ stdout: `${bin}:/usr/bin:/bin\n` });
    await getLoginShellPath();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(starts).toHaveLength(3);
    const ownerForCwd = (cwd: string) =>
      cwd === personal.cwd
        ? personal.workspaceId
        : cwd === organization.cwd
          ? organization.workspaceId
          : null;
    await vi.waitFor(() =>
      expect(
        gateway.workspaceOwnedSessionIds(
          personal.workspaceId,
          personal.cwd,
          ownerForCwd,
        ),
      ).toEqual([returned.executionId]),
    );
    expect(
      gateway.workspaceOwnedSessionIds(
        organization.workspaceId,
        organization.cwd,
        ownerForCwd,
      ),
    ).toEqual([other.executionId]);
    expect(gateway.sessionAgentId(retiredId)).toBeNull();
    expect(await readFile(path.join(root, "effects"), "utf8")).toBe(
      "started\nstarted\n",
    );
  });
});
