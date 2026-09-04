import {
  link,
  mkdtemp,
  mkdir,
  open,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

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
import {
  prepareZsrPolicy,
  type PrepareZsrPolicyOptions,
  type PreparedZsrPolicy,
  zsrNetworkRoot,
} from "../policy";
import { newTerritoryGeneration } from "../status";
import type { BoundaryRequest } from "../types";

function territory(
  workspaceRoot: string,
  protectedDesignDirectories: string[],
  deniedPaths: string[] = protectedDesignDirectories,
): AgentFilesystemTerritory {
  return {
    agentRole: "code",
    workspaceRoot,
    designDirectory: protectedDesignDirectories[0]!,
    protectedDesignDirectories,
    designRecognitionPaths: [],
    writeCapabilities: { workspace: "write", deniedPaths },
  };
}

describe("ZSR host-parity policy builder", () => {
  let temporaryRoot: string;
  let previousDataDir: string | undefined;
  let sequence: number;
  const cleanupRoots = new Set<string>();

  beforeEach(async () => {
    temporaryRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-policy-")),
    );
    previousDataDir = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = path.join(temporaryRoot, "engine");
    sequence = 0;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
    else process.env.ZEROS_DATA_DIR = previousDataDir;
    await Promise.all(
      [...cleanupRoots].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
    cleanupRoots.clear();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function prepare(
    request: Omit<BoundaryRequest, "executionId"> & { executionId?: string },
    options: PrepareZsrPolicyOptions = {},
  ): Promise<PreparedZsrPolicy> {
    sequence += 1;
    const generation = newTerritoryGeneration();
    cleanupRoots.add(zsrNetworkRoot(generation));
    const prepared = await prepareZsrPolicy(
      {
        ...request,
        executionId: request.executionId ?? `policy-${sequence}`,
      },
      generation,
      options,
    );
    cleanupRoots.add(prepared.paths.root);
    return prepared;
  }

  it("subtracts every Design directory while retaining normal host authority", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    const primaryDesign = path.join(workspace, "Zeros Design");
    const nestedDesign = path.join(workspace, "examples", "Product Design");
    const git = path.join(workspace, ".git");
    const extra = path.join(temporaryRoot, "extra");
    await Promise.all(
      [primaryDesign, nestedDesign, git, extra].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );

    const prepared = await prepare({
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
      territory: territory(
        workspace,
        [primaryDesign, nestedDesign],
        [primaryDesign, nestedDesign, git],
      ),
      additionalReadWriteRoots: [extra],
    });

    expect(prepared.document.runtime.localHostParity).toBe(true);
    expect(prepared.document.filesystem.allowRead).toContain(
      path.parse(workspace).root,
    );
    expect(prepared.document.filesystem.allowWrite).toContain(
      path.parse(workspace).root,
    );
    expect(prepared.document.filesystem.denyWrite).toEqual(
      expect.arrayContaining([primaryDesign, nestedDesign]),
    );
    expect(prepared.document.filesystem.denyWrite).not.toContain(git);
    expect(prepared.document.filesystem.denyRead).not.toContain(
      process.env.ZEROS_DATA_DIR,
    );
    const database = path.join(process.env.ZEROS_DATA_DIR!, "zeros.db");
    expect(prepared.document.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        database,
        `${database}-wal`,
        `${database}-shm`,
        `${database}-journal`,
      ]),
    );
    expect(prepared.document.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        prepared.paths.policy,
        prepared.paths.commands,
        prepared.paths.tools,
      ]),
    );
    expect(Object.keys(prepared.paths)).not.toEqual(
      expect.arrayContaining([
        "shadowGit",
        "networkBridge",
        "networkClientState",
      ]),
    );
    expect((await stat(prepared.paths.root)).mode & 0o777).toBe(0o700);
    const markerHandle = await open(prepared.paths.processIdentityMarker, "r");
    try {
      expect((await markerHandle.stat()).mode & 0o777).toBe(0o400);
      expect(await markerHandle.readFile("utf8")).toBe(
        `${prepared.document.generation}\n`,
      );
    } finally {
      await markerHandle.close();
    }
    const policyHandle = await open(prepared.paths.policy, "r");
    try {
      expect((await policyHandle.stat()).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await policyHandle.readFile("utf8"))).toEqual(
        prepared.document,
      );
    } finally {
      await policyHandle.close();
    }
  });

  it("admits engine context for reads while subtracting its write authority", async () => {
    const workspace = path.join(temporaryRoot, "context-workspace");
    const context = path.join(temporaryRoot, "engine", "context", "design");
    await Promise.all(
      [workspace, context].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );

    const prepared = await prepare({
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
      additionalReadOnlyRoots: [context],
    });

    expect(prepared.document.filesystem.allowRead).toContain(context);
    expect(prepared.document.filesystem.denyWrite).toContain(context);
    expect(prepared.document.filesystem.allowWrite).not.toContain(context);
  });

  it("allocates private Podman state only for the qualified cloud worker", async () => {
    const workspace = path.join(temporaryRoot, "cloud-container-workspace");
    await mkdir(workspace, { recursive: true });

    const prepared = await prepare(
      {
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
      },
      {
        cloudWorker: { uid: 10_001, gid: 10_001 },
        cloudContainerWorker: true,
      },
    );

    const state = prepared.paths.containerState;
    expect(state).toBeDefined();
    expect((await stat(state!)).isDirectory()).toBe(true);
    expect(prepared.document.filesystem.allowRead).toContain(state);
    expect(prepared.document.filesystem.allowWrite).toContain(state);
    expect(prepared.document.runtime.allowedUnixSockets).toContain(
      path.join(state!, "podman.sock"),
    );
  });

  it("pre-denies future managed siblings while reopening the current workspace", async () => {
    const managed = path.join(temporaryRoot, "workspaces");
    const workspace = path.join(managed, "repo", "Shocking");
    const sibling = path.join(managed, "repo", "Onyx");
    const design = path.join(workspace, "Zeros Design");
    await Promise.all(
      [design, sibling].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );

    const request: Omit<BoundaryRequest, "executionId"> = {
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
      territory: territory(workspace, [design]),
      protectedWorkspaceDirectories: [managed],
    };
    const prepared = await prepare(request);

    expect(prepared.document.filesystem.denyWrite).toContain(managed);
    expect(prepared.document.filesystem.allowWrite).toContain(workspace);
    expect(prepared.document.filesystem.denyWrite).toContain(design);
  });

  it("materializes an absent protected collection before the runtime can stub it as a file", async () => {
    const workspace = path.join(temporaryRoot, "existing-workspace");
    const managed = path.join(temporaryRoot, "future", "workspaces");
    await mkdir(workspace, { recursive: true });
    await expect(stat(managed)).rejects.toMatchObject({ code: "ENOENT" });

    const prepared = await prepare({
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
      protectedWorkspaceDirectories: [managed],
    });

    await expect(stat(managed)).resolves.toSatisfy((entry) =>
      entry.isDirectory(),
    );
    expect(prepared.document.filesystem.denyWrite).toContain(managed);
  });

  it("reopens only existing managed islands covered by a broad explicit grant", async () => {
    const workspace = path.join(temporaryRoot, "primary");
    const managedParent = path.join(temporaryRoot, "shared");
    const managed = path.join(managedParent, "workspaces");
    const sibling = path.join(managed, "repo", "Onyx");
    const siblingDesign = path.join(sibling, "Zeros Design");
    await Promise.all(
      [workspace, siblingDesign].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );

    const prepared = await prepare({
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
      territory: territory(workspace, [siblingDesign]),
      additionalReadWriteRoots: [managedParent],
      protectedWorkspaceDirectories: [managed],
      protectedWorkspaceWriteDirectories: [sibling],
    });

    expect(prepared.document.filesystem.allowWrite).toEqual(
      expect.arrayContaining([managedParent, sibling, workspace]),
    );
    expect(prepared.document.filesystem.denyWrite).toEqual(
      expect.arrayContaining([managed, siblingDesign]),
    );

    await expect(
      prepare({
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
        protectedWorkspaceDirectories: [managed],
        protectedWorkspaceWriteDirectories: [sibling],
      }),
    ).rejects.toThrow(/inside an authorized root/);
  });

  it("refuses a pre-existing hard-link alias to database authority", async () => {
    const workspace = path.join(temporaryRoot, "authority-alias-workspace");
    const database = path.join(process.env.ZEROS_DATA_DIR!, "zeros.db");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(path.dirname(database), { recursive: true }),
    ]);
    await writeFile(database, "authority\n");
    await link(database, path.join(temporaryRoot, "database-alias"));

    await expect(
      prepare({
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
      }),
    ).rejects.toThrow(/engine authority.*hard-link/i);
  });

  it("refuses hard-link aliases to recovery seeds but ignores unrelated backups", async () => {
    const workspace = path.join(temporaryRoot, "seed-alias-workspace");
    const seedDirectory = path.join(
      process.env.ZEROS_DATA_DIR!,
      "worktrees",
      "seed-key",
    );
    const seed = path.join(seedDirectory, "workspace.json");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(seedDirectory, { recursive: true }),
    ]);
    await writeFile(seed, '{"id":"ws_seed"}\n');
    await link(seed, path.join(temporaryRoot, "workspace-seed-alias.json"));

    await expect(
      prepare({
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
      }),
    ).rejects.toThrow(/engine authority.*hard-link/i);

    await rm(path.join(temporaryRoot, "workspace-seed-alias.json"));
    await rm(seed);
    const backup = path.join(seedDirectory, "notes.backup");
    await writeFile(seed, '{"id":"ws_seed"}\n');
    await writeFile(backup, "backup\n");
    await link(backup, path.join(temporaryRoot, "notes-alias.backup"));
    await expect(
      prepare({
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
      }),
    ).resolves.toBeDefined();
  });

  it("gives Design agents API-only mutation authority", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    const design = path.join(workspace, "Zeros Design");
    const siblingWorkspace = path.join(temporaryRoot, "sibling-workspace");
    const siblingDesign = path.join(siblingWorkspace, "Zeros Design");
    const git = path.join(workspace, ".git");
    const extra = path.join(temporaryRoot, "extra");
    const managedWorkspaces = path.join(temporaryRoot, "managed-workspaces");
    await Promise.all(
      [design, siblingDesign, git, extra, managedWorkspaces].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    const base = {
      cwd: workspace,
      workspaceRoot: workspace,
      territory: territory(workspace, [design, siblingDesign], [design, git]),
      additionalReadWriteRoots: [extra],
      protectedWorkspaceDirectories: [managedWorkspaces],
      protectedCodeDirectories: [siblingWorkspace],
      allowedLocalPorts: [5432],
      trustedLocalPorts: [3000],
    } as const;

    const designPolicy = await prepare(
      { ...base, actor: "design-agent" },
      { localHostParityWriteIslands: [git] },
    );
    expect(designPolicy.document.filesystem.allowWrite).toEqual(
      [designPolicy.paths.providerState, designPolicy.paths.scratch].sort(),
    );
    expect(designPolicy.document.filesystem.denyRead).toContain(
      process.env.ZEROS_DATA_DIR,
    );
    expect(designPolicy.document.filesystem.allowRead).toEqual(
      expect.arrayContaining([
        workspace,
        extra,
        designPolicy.paths.providerState,
        designPolicy.paths.scratch,
      ]),
    );
    expect(designPolicy.document.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        workspace,
        design,
        siblingWorkspace,
        siblingDesign,
        git,
        extra,
        managedWorkspaces,
      ]),
    );
    expect(designPolicy.document.runtime.allowedLocalPorts).toEqual([
      3000, 5432,
    ]);

    const codePolicy = await prepare({ ...base, actor: "agent-code" });
    expect(codePolicy.document.filesystem.denyWrite).toEqual(
      expect.arrayContaining([design, siblingDesign]),
    );
    expect(codePolicy.document.filesystem.denyWrite).not.toContain(workspace);
    expect(codePolicy.document.filesystem.denyWrite).not.toContain(
      siblingWorkspace,
    );
  });

  it.runIf(process.platform === "linux")(
    "uses the same parity policy in cloud while hiding root-owned engine state",
    async () => {
      const workspace = path.join(temporaryRoot, "cloud-workspace");
      const design = path.join(workspace, "Zeros Design");
      await mkdir(design, { recursive: true });

      const prepared = await prepare(
        {
          actor: "agent-code",
          cwd: workspace,
          workspaceRoot: workspace,
          territory: territory(workspace, [design]),
        },
        { cloudWorker: { uid: 10_001, gid: 10_001 } },
      );

      expect(prepared.document.runtime).toMatchObject({
        localHostParity: true,
        cloudWorker: { version: 1, uid: 10_001, gid: 10_001 },
      });
      expect(prepared.document.filesystem.allowWrite).toContain(
        path.parse(workspace).root,
      );
      expect(prepared.document.filesystem.denyWrite).toEqual(
        expect.arrayContaining([design, process.env.ZEROS_DATA_DIR!]),
      );
      expect(prepared.document.filesystem.denyRead).toContain(
        process.env.ZEROS_DATA_DIR,
      );
      expect(prepared.document.runtime.deniedLocalPorts).toEqual([]);
    },
  );

  it("canonicalizes design-actor additional roots before denying them", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    const target = path.join(temporaryRoot, "target");
    const alias = path.join(temporaryRoot, "alias");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(target, { recursive: true }),
    ]);
    await symlink(target, alias, "dir");

    const prepared = await prepare({
      actor: "design-agent",
      cwd: workspace,
      workspaceRoot: workspace,
      additionalReadWriteRoots: [alias],
    });
    expect(prepared.document.filesystem.denyWrite).toContain(target);
    expect(prepared.document.filesystem.denyWrite).not.toContain(alias);
  });

  it("rejects file-shaped and unbounded additional write grants", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    const file = path.join(temporaryRoot, "not-a-directory");
    await mkdir(workspace, { recursive: true });
    await writeFile(file, "data\n");

    await expect(
      prepare({
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
        additionalReadWriteRoots: [file],
      }),
    ).rejects.toThrow(/must be directories/);
    await expect(
      prepare({
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
        additionalReadWriteRoots: Array.from({ length: 33 }, (_, index) =>
          path.join(temporaryRoot, `future-${index}`),
        ),
      }),
    ).rejects.toThrow(/at most 32/);
  });

  it("keeps engine authority denied even when a requested root encloses it", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    await mkdir(workspace, { recursive: true });
    const prepared = await prepare({
      actor: "agent-code",
      cwd: workspace,
      workspaceRoot: workspace,
      additionalReadWriteRoots: [temporaryRoot],
    });
    expect(prepared.document.filesystem.denyWrite).toContain(
      path.join(process.env.ZEROS_DATA_DIR!, "zeros.db"),
    );
  });

  it("rejects a foreign territory and traversal-shaped execution id", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    const other = path.join(temporaryRoot, "other");
    const design = path.join(other, "Zeros Design");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(design, { recursive: true }),
    ]);
    await expect(
      prepare({
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
        territory: territory(other, [design]),
      }),
    ).rejects.toThrow(/different workspace/);

    await expect(
      prepare({
        executionId: "../execution",
        actor: "agent-code",
        cwd: workspace,
        workspaceRoot: workspace,
      }),
    ).rejects.toThrow(/invalid execution id/);
  });

  it("admits only private physical Unix sockets without private-network machinery", async () => {
    const workspace = path.join(temporaryRoot, "workspace");
    const generation = newTerritoryGeneration();
    const networkRoot = zsrNetworkRoot(generation);
    const socket = path.join(networkRoot, "services", "s0.sock");
    cleanupRoots.add(networkRoot);
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
          executionId: "unix-socket",
          actor: "agent-code",
          cwd: workspace,
          workspaceRoot: workspace,
        },
        generation,
        { allowedUnixSockets: [socket] },
      );
      cleanupRoots.add(prepared.paths.root);
      expect(prepared.document.runtime.allowedUnixSockets).toEqual([socket]);
      expect(Object.keys(prepared.paths)).not.toEqual(
        expect.arrayContaining(["networkBridge", "networkClientState"]),
      );
    } finally {
      unsupportedSocketRealpaths.delete(socket);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
