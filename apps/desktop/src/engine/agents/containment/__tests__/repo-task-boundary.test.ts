import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { testExecutionBoundary } from "../../__tests__/helpers/test-execution-boundary";
import { previewRegisteredCodeWriteAuthorityIdentity } from "../../gateway";
import { createRepoTaskBoundaryFactory } from "../repo-task-boundary";
import type { BoundaryRequest } from "../types";
import * as projectState from "../../../db/projects";
import * as gitState from "../../../git/state";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

async function designRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-repo-design-"));
  temporaryDirectories.push(root);
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@test"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: root });
  await mkdir(path.join(root, "Zeros Design"), { recursive: true });
  await writeFile(
    path.join(root, "Zeros Design", ".zeros-canvas.json"),
    "{}\n",
  );
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-q", "-m", "design"], {
    cwd: root,
  });
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("repository task boundary factory", () => {
  it("canonicalizes symlinked task roots before deriving authority identity", async () => {
    const physical = await designRepo();
    const aliasParent = await mkdtemp(
      path.join(os.tmpdir(), "zeros-repo-boundary-alias-"),
    );
    temporaryDirectories.push(aliasParent);
    const alias = path.join(aliasParent, "workspace");
    await symlink(physical, alias, "dir");
    const requests: BoundaryRequest[] = [];
    const factory = createRepoTaskBoundaryFactory(
      testExecutionBoundary({
        onPrepare: (candidate) => requests.push(candidate),
      }),
    );

    const prepared = await factory({
      executionId: "repo-task-physical-identity",
      cwd: alias,
      workspaceRoot: alias,
      repoRoot: alias,
    });
    await prepared.stopAndProve();

    expect(requests.at(-1)).toMatchObject({
      cwd: await realpath(physical),
      workspaceRoot: await realpath(physical),
    });
  });

  it("does not provision service or container authority for a PATH-only shell probe", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-repo-boundary-"));
    temporaryDirectories.push(root);
    const requests: BoundaryRequest[] = [];
    const factory = createRepoTaskBoundaryFactory(
      testExecutionBoundary({
        onPrepare: (candidate) => {
          requests.push(candidate);
        },
      }),
    );

    const prepared = await factory({
      executionId: "path-only-probe",
      cwd: root,
      workspaceRoot: root,
      repoRoot: root,
      env: {
        HOME: root,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        DOCKER_HOST: "unix:///ambient/docker.sock",
      },
      serviceCapabilities: "none",
    });
    await prepared.stopAndProve();

    const request = requests.at(-1);
    expect(request).toBeDefined();
    expect(request?.containerWorker).toBeUndefined();
    expect(request?.containerWorkflowExpected).toBeUndefined();
  });

  it("subtracts Design roots from every registered local owner without granting them", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-repo-boundary-"));
    temporaryDirectories.push(root);
    const registeredWorktree = await designRepo();
    const registeredMain = await designRepo();
    const registeredProject = await designRepo();
    const workspaceSpy = vi.spyOn(gitState, "listWorkspaces").mockReturnValue([
      {
        id: "ws_registered",
        path: registeredWorktree,
        repoRoot: registeredMain,
        placement: "local",
      },
    ] as ReturnType<typeof gitState.listWorkspaces>);
    const projectSpy = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([registeredProject]);
    const requests: BoundaryRequest[] = [];
    const factory = createRepoTaskBoundaryFactory(
      testExecutionBoundary({
        onPrepare: (candidate) => requests.push(candidate),
      }),
    );

    try {
      const prepared = await factory({
        executionId: "repo-task-global-design",
        cwd: root,
        workspaceRoot: root,
        repoRoot: root,
      });
      expect(prepared.registeredDesignAuthorityIdentity).toBe(
        await previewRegisteredCodeWriteAuthorityIdentity(),
      );
      await prepared.stopAndProve();

      expect(requests.at(-1)?.territory?.protectedDesignDirectories).toEqual(
        expect.arrayContaining(
          [registeredWorktree, registeredMain, registeredProject].map((owner) =>
            path.join(owner, "Zeros Design"),
          ),
        ),
      );
      expect(requests.at(-1)?.additionalReadWriteRoots ?? []).toEqual([]);
    } finally {
      projectSpy.mockRestore();
      workspaceSpy.mockRestore();
    }
  });

  it("pre-protects managed siblings for Setup and Run boundaries", async () => {
    const previousWorkspacesDir = process.env.ZEROS_WORKSPACES_DIR;
    const container = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "zeros-repo-managed-boundary-")),
    );
    temporaryDirectories.push(container);
    const managed = path.join(container, "workspaces");
    process.env.ZEROS_WORKSPACES_DIR = managed;
    const workspaceSource = await designRepo();
    const siblingSource = await designRepo();
    const registeredMain = await designRepo();
    const workspace = path.join(managed, "zeros", "Shocking");
    const sibling = path.join(managed, "zeros", "Onyx");
    await mkdir(path.dirname(workspace), { recursive: true });
    await Promise.all([
      rename(workspaceSource, workspace),
      rename(siblingSource, sibling),
    ]);
    const workspaceSpy = vi.spyOn(gitState, "listWorkspaces").mockReturnValue([
      {
        id: "ws_shocking",
        path: workspace,
        repoRoot: registeredMain,
        placement: "local",
      },
      {
        id: "ws_onyx",
        path: sibling,
        repoRoot: registeredMain,
        placement: "local",
      },
    ] as ReturnType<typeof gitState.listWorkspaces>);
    const projectSpy = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([registeredMain]);
    const requests: BoundaryRequest[] = [];
    const factory = createRepoTaskBoundaryFactory(
      testExecutionBoundary({
        onPrepare: (candidate) => requests.push(candidate),
      }),
    );
    let prepared: Awaited<ReturnType<typeof factory>> | undefined;
    const onAuthorityResolved = vi.fn();

    try {
      prepared = await factory({
        executionId: "repo-task-managed-sibling",
        cwd: workspace,
        workspaceRoot: workspace,
        repoRoot: registeredMain,
        onAuthorityResolved,
      });
      const request = requests.at(-1);

      expect(request?.protectedWorkspaceDirectories).toContain(managed);
      expect(request?.territory?.protectedDesignDirectories).toContain(
        path.join(workspace, "Zeros Design"),
      );
      expect(request?.territory?.protectedDesignDirectories).toContain(
        path.join(registeredMain, "Zeros Design"),
      );
      expect(request?.territory?.protectedDesignDirectories).not.toContain(
        path.join(sibling, "Zeros Design"),
      );
      expect(onAuthorityResolved).toHaveBeenCalledOnce();
      expect(prepared.territoryContributions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workspaceRoot: workspace, full: true }),
          expect.objectContaining({
            workspaceRoot: registeredMain,
            full: true,
          }),
        ]),
      );
    } finally {
      await prepared?.stopAndProve();
      projectSpy.mockRestore();
      workspaceSpy.mockRestore();
      if (previousWorkspacesDir === undefined) {
        delete process.env.ZEROS_WORKSPACES_DIR;
      } else {
        process.env.ZEROS_WORKSPACES_DIR = previousWorkspacesDir;
      }
    }
  });

  it("does not label an unregistered rowless task's own Design deny as registered authority", async () => {
    const root = await designRepo();
    const workspaceSpy = vi
      .spyOn(gitState, "listWorkspaces")
      .mockReturnValue([] as ReturnType<typeof gitState.listWorkspaces>);
    const projectSpy = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([]);
    const requests: BoundaryRequest[] = [];
    const factory = createRepoTaskBoundaryFactory(
      testExecutionBoundary({
        onPrepare: (candidate) => requests.push(candidate),
      }),
    );

    try {
      const prepared = await factory({
        executionId: "repo-task-rowless-local-design",
        cwd: root,
        workspaceRoot: root,
        repoRoot: root,
      });

      expect(requests.at(-1)?.territory?.protectedDesignDirectories).toContain(
        path.join(root, "Zeros Design"),
      );
      expect(prepared.registeredDesignAuthorityIdentity).toBeNull();
      await prepared.stopAndProve();
    } finally {
      projectSpy.mockRestore();
      workspaceSpy.mockRestore();
    }
  });

  it("retires a prepared task boundary when Design territory changes during admission", async () => {
    const root = await designRepo();
    const onStop = vi.fn();
    let changed = false;
    const factory = createRepoTaskBoundaryFactory(
      testExecutionBoundary({
        onPrepare: () => {
          if (changed) return;
          changed = true;
          mkdirSync(path.join(root, ".zeros"), { recursive: true });
          mkdirSync(path.join(root, "Product Design"), { recursive: true });
          writeFileSync(
            path.join(root, ".zeros", "settings.toml"),
            '[design]\ndirectory = "Product Design"\n',
          );
        },
        onStop,
      }),
    );

    await expect(
      factory({
        executionId: "repo-task-territory-race",
        cwd: root,
        workspaceRoot: root,
        repoRoot: root,
      }),
    ).rejects.toThrow(/Design territory changed while.*prepared/i);
    expect(onStop).toHaveBeenCalledOnce();
  });
});
