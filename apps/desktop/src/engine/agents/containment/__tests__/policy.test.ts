import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { unsupportedSocketRealpaths } = vi.hoisted(() => ({
  unsupportedSocketRealpaths: new Set<string>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (
      candidate: Parameters<typeof actual.realpath>[0],
      options?: Parameters<typeof actual.realpath>[1],
    ) => {
      if (unsupportedSocketRealpaths.has(String(candidate))) {
        const error = new Error(
          `EOPNOTSUPP: unknown error, lstat '${String(candidate)}'`,
        ) as NodeJS.ErrnoException;
        error.code = "EOPNOTSUPP";
        error.syscall = "lstat";
        throw error;
      }
      return actual.realpath(candidate, options as never);
    },
  };
});

import type { AgentFilesystemTerritory } from "../../types";
import { prepareZsrPolicy, zsrNetworkRoot } from "../policy";
import { newTerritoryGeneration } from "../status";

describe("ZSR policy builder", () => {
  let temporaryRoot: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    temporaryRoot = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-zsr-policy-")),
    );
    previousDataDir = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = path.join(temporaryRoot, "engine");
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
    else process.env.ZEROS_DATA_DIR = previousDataDir;
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("grants normal code roots while subtracting Design, Git, and policy authority", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    const design = path.join(workspace, "Zeros Design");
    const git = path.join(workspace, ".git");
    const extra = path.join(temporaryRoot, "extra");
    await Promise.all([
      mkdir(design, { recursive: true }),
      mkdir(git, { recursive: true }),
      mkdir(extra, { recursive: true }),
    ]);
    const territory: AgentFilesystemTerritory = {
      agentRole: "code",
      workspaceRoot: workspace,
      designDirectory: design,
      protectedDesignDirectories: [design],
      writeCapabilities: {
        workspace: "write",
        deniedPaths: [design, git],
      },
    };
    const prepared = await prepareZsrPolicy(
      {
        executionId: "execution-1",
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
        territory,
        additionalReadWriteRoots: [extra],
      },
      newTerritoryGeneration(),
    );

    expect(prepared.document.filesystem.allowWrite).toEqual(
      expect.arrayContaining([workspace, extra, prepared.paths.home]),
    );
    expect(prepared.document.filesystem.allowRead).toEqual(
      expect.arrayContaining([
        prepared.paths.home,
        prepared.paths.providerState,
        prepared.paths.tools,
      ]),
    );
    expect(prepared.document.filesystem.denyRead).toContain(
      process.env.ZEROS_DATA_DIR,
    );
    const cloudValidationState = path.join(
      homedir(),
      ".zeros",
      "cloud-workspace-validation",
    );
    expect(
      prepared.document.filesystem.denyRead.some(
        (root) =>
          root === cloudValidationState ||
          cloudValidationState.startsWith(`${root}${path.sep}`),
      ),
    ).toBe(true);
    expect(prepared.document.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        design,
        git,
        prepared.paths.policy,
        prepared.paths.commands,
        prepared.paths.tools,
      ]),
    );
    expect(prepared.document.filesystem.allowWrite).not.toContain(
      prepared.paths.root,
    );
    expect(prepared.document.filesystem.allowWrite).not.toContain(
      prepared.paths.tools,
    );
    expect(prepared.paths.providerState.startsWith(prepared.paths.root)).toBe(
      true,
    );
    expect((await stat(prepared.paths.root)).mode & 0o777).toBe(0o700);
    expect((await stat(prepared.paths.policy)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(prepared.paths.processIdentityMarker)).mode & 0o777,
    ).toBe(0o400);
    expect(
      await readFile(prepared.paths.processIdentityMarker, "utf8"),
    ).toBe(`${prepared.document.generation}\n`);
    expect(prepared.document.filesystem.allowRead).toContain(
      prepared.paths.tools,
    );
    expect(path.dirname(prepared.paths.processIdentityMarker)).toBe(
      prepared.paths.tools,
    );
    expect(JSON.parse(await readFile(prepared.paths.policy, "utf8"))).toEqual(
      prepared.document,
    );
  });

  it("hides stable cloud-operator credentials from dev-channel code actors", async () => {
    const workspace = path.join(temporaryRoot, "dev-workspace");
    await mkdir(workspace, { recursive: true });
    const previousDev = process.env.ZEROS_DEV;
    process.env.ZEROS_DEV = "1";
    try {
      const prepared = await prepareZsrPolicy(
        {
          executionId: "execution-dev-operator-state",
          actor: "agent-code",
          cwd: workspace,
          workspaceRoot: workspace,
        },
        newTerritoryGeneration(),
      );
      const operatorState = path.join(
        homedir(),
        ".zeros",
        "cloud-workspace-validation",
      );
      expect(
        prepared.document.filesystem.denyRead.some(
          (root) =>
            root === operatorState || operatorState.startsWith(`${root}${path.sep}`),
        ),
      ).toBe(true);
    } finally {
      if (previousDev === undefined) delete process.env.ZEROS_DEV;
      else process.env.ZEROS_DEV = previousDev;
    }
  });

  it("canonicalizes additional-root symlinks before granting them", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    const target = path.join(temporaryRoot, "target");
    const alias = path.join(temporaryRoot, "alias");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(target, { recursive: true }),
    ]);
    await symlink(target, alias, "dir");
    const prepared = await prepareZsrPolicy(
      {
        executionId: "execution-2",
        actor: "repo-code-task",
        cwd: workspace,
        workspaceRoot: workspace,
        additionalReadWriteRoots: [alias],
      },
      newTerritoryGeneration(),
    );
    expect(prepared.document.filesystem.allowWrite).toContain(target);
    expect(prepared.document.filesystem.allowWrite).not.toContain(alias);
  });

  it("rejects file-shaped and unbounded additional write grants", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    const file = path.join(temporaryRoot, "not-a-directory");
    await mkdir(workspace, { recursive: true });
    await writeFile(file, "data\n");

    await expect(
      prepareZsrPolicy(
        {
          executionId: "execution-file-root",
          actor: "agent-code",
          cwd: workspace,
          workspaceRoot: workspace,
          additionalReadWriteRoots: [file],
        },
        newTerritoryGeneration(),
      ),
    ).rejects.toThrow(/must be directories/);
    await expect(
      prepareZsrPolicy(
        {
          executionId: "execution-too-many-roots",
          actor: "agent-code",
          cwd: workspace,
          workspaceRoot: workspace,
          additionalReadWriteRoots: Array.from(
            { length: 33 },
            (_, index) => path.join(temporaryRoot, `future-${index}`),
          ),
        },
        newTerritoryGeneration(),
      ),
    ).rejects.toThrow(/at most 32/);
  });

  it("rejects write roots inside engine-private state", async () => {
    const engineRoot = process.env.ZEROS_DATA_DIR!;
    const workspace = path.join(engineRoot, "accidental-workspace");
    await mkdir(workspace, { recursive: true });

    await expect(
      prepareZsrPolicy(
        {
          executionId: "execution-engine-overlap",
          actor: "agent-code",
          cwd: workspace,
          workspaceRoot: workspace,
        },
        newTerritoryGeneration(),
      ),
    ).rejects.toThrow(/engine-private state/);
  });

  it("keeps engine state denied when an authorized root encloses it", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    await mkdir(workspace, { recursive: true });
    const prepared = await prepareZsrPolicy(
      {
        executionId: "execution-broad-root",
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
        additionalReadWriteRoots: [temporaryRoot],
      },
      newTerritoryGeneration(),
    );

    expect(prepared.document.filesystem.allowWrite).toContain(temporaryRoot);
    expect(prepared.document.filesystem.denyWrite).toContain(
      process.env.ZEROS_DATA_DIR,
    );
  });

  it("rejects a territory resolved for a different workspace", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    const other = path.join(temporaryRoot, "other");
    const design = path.join(other, "Zeros Design");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(design, { recursive: true }),
    ]);
    const territory: AgentFilesystemTerritory = {
      agentRole: "code",
      workspaceRoot: other,
      designDirectory: design,
      protectedDesignDirectories: [design],
      writeCapabilities: { workspace: "write", deniedPaths: [design] },
    };

    await expect(
      prepareZsrPolicy(
        {
          executionId: "execution-territory-mismatch",
          actor: "agent-code",
          cwd: workspace,
          workspaceRoot: workspace,
          territory,
        },
        newTerritoryGeneration(),
      ),
    ).rejects.toThrow(/different workspace/);
  });

  it("rejects execution ids that would alias the session directory", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    await mkdir(workspace, { recursive: true });
    await expect(
      prepareZsrPolicy(
        {
          executionId: "../execution",
          actor: "agent-code",
          cwd: workspace,
          workspaceRoot: workspace,
        },
        newTerritoryGeneration(),
      ),
    ).rejects.toThrow(/invalid execution id/);
  });

  it("couples Linux Unix-socket admission to a root read allowlist", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    const generation = newTerritoryGeneration();
    const socket = path.join(zsrNetworkRoot(generation), "services", "s0.sock");
    await mkdir(workspace, { recursive: true });
    const prepared = await prepareZsrPolicy(
      {
        executionId: "execution-unix",
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
      },
      generation,
      { allowedUnixSockets: [socket] },
    );

    expect(prepared.document.runtime.allowedUnixSockets).toEqual([socket]);
    expect(prepared.document.filesystem.allowWrite).not.toContain(
      prepared.paths.networkServices,
    );
    expect(prepared.document.filesystem.allowWrite).toContain(
      prepared.paths.networkBridge,
    );
    expect(prepared.document.filesystem.allowWrite).toContain(
      prepared.paths.networkClientState,
    );
    if (process.platform === "linux") {
      expect(prepared.document.filesystem.denyRead).toContain(
        path.parse(workspace).root,
      );
      expect(prepared.document.filesystem.allowRead).toEqual(
        expect.arrayContaining([workspace, prepared.paths.home, socket]),
      );
    }
  });

  it("canonicalizes an admitted socket when its runtime cannot realpath the socket vnode", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    const generation = newTerritoryGeneration();
    const networkRoot = zsrNetworkRoot(generation);
    const socket = path.join(networkRoot, "services", "s0.sock");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(path.dirname(socket), { recursive: true, mode: 0o700 }),
    ]);
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    unsupportedSocketRealpaths.add(socket);
    try {
      const prepared = await prepareZsrPolicy(
        {
          executionId: "execution-unix-runtime",
          actor: "agent-code",
          cwd: workspace,
          workspaceRoot: workspace,
        },
        generation,
        { allowedUnixSockets: [socket] },
      );
      expect(prepared.document.runtime.allowedUnixSockets).toEqual([socket]);
    } finally {
      unsupportedSocketRealpaths.delete(socket);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(networkRoot, { recursive: true, force: true });
    }
  });
});
