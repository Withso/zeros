import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudActorRole } from "@zeros/protocol/cloud-actors";
import { cloudActorMaySend } from "../../cloud-actor-policy";
import { resetWorkspaceDesignApisForTests } from "../../design/design-api";
import { forgetDesignDirectoryName, primeDesignDirectoryName } from "../../design/directory-registry";
import { ensureCloudPrimaryWorkspace } from "../../git/cloud-primary-workspace";
import { closeState, setStateRootForTesting } from "../../git/state";
import type { EngineMessage } from "../../types";
import { WorkspaceService } from "../service";

describe("cloud Design directory management", () => {
  let temporary: string;
  let root: string;
  let service: WorkspaceService;
  let authorized: boolean;
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const request = (
    op: string,
    params: Record<string, unknown> = {},
    role: CloudActorRole = "manager",
  ) => {
    const message: Extract<EngineMessage, { type: "WORKSPACE_REQUEST" }> = {
      type: "WORKSPACE_REQUEST",
      id: randomUUID(),
      source: "browser",
      timestamp: Date.now(),
      op,
      params: { workspaceId: "local-main", ...params },
    };
    if (!cloudActorMaySend(role, message, service))
      return Promise.reject(new Error("Role denied"));
    return service.handle(op, message.params, {
      remote: true,
      cloudWorker: true,
      hostLocalResources: false,
      cloudActorIdentity: { userId: "user", deviceId: "device-a" },
      cloudFileActor: { role, authorized: () => authorized },
    });
  };
  const listing = () =>
    request("design.listDirectories") as Promise<{
      directories: string[];
      directoryIds: Record<string, string>;
      active: string;
    }>;
  beforeEach(async () => {
    temporary = await mkdtemp(
      path.join(tmpdir(), "zeros-v2-test-directories-"),
    );
    root = path.join(temporary, "repo");
    await mkdir(root);
    setStateRootForTesting(path.join(temporary, "state"));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.test");
    git("remote", "add", "origin", path.join(temporary, "remote.git"));
    await writeFile(path.join(root, "code.txt"), "code\n");
    git("add", "code.txt");
    git("commit", "-qm", "Base");
    await ensureCloudPrimaryWorkspace(root, {
      organizationId: randomUUID(),
      workspaceId: randomUUID(),
    });
    service = new WorkspaceService(root, { primaryDesignWorkspace: true });
    authorized = true;
  });
  afterEach(async () => {
    resetWorkspaceDesignApisForTests();
    forgetDesignDirectoryName(root);
    closeState();
    setStateRootForTesting(null);
    await rm(temporary, { recursive: true, force: true });
  });

  it("creates registrations without committing, switches with a checked handoff, and survives restart", async () => {
    const head = git("rev-parse", "HEAD");
    const index = git("write-tree");
    await request("design.createDirectory", { directory: "Brand" });
    await request("design.createDirectory", { directory: "Designs/Other" });
    const before = await listing();
    expect(before.directories).toEqual(["Brand", "Designs/Other"]);
    const transition = vi.fn(async (_targets, mutation) => mutation());
    service.setDesignTerritoryTransitioner(transition);
    await request("design.selectDirectory", {
      directoryId: before.directoryIds["Designs/Other"],
      expectedDirectoryId: before.directoryIds[before.active] ?? null,
    });
    expect(transition).toHaveBeenCalledOnce();
    expect(transition.mock.calls[0][0]).toEqual([
      {
        workspaceId: "local-main",
        designDirectory: path.join(root, "Designs/Other"),
      },
    ]);
    expect((await listing()).active).toBe("Designs/Other");
    await expect(
      request(
        "design.frame.create",
        {
          directoryId: before.directoryIds.Brand,
          title: "Queued in old canvas",
        },
        "developer",
      ),
    ).rejects.toThrow(/directory changed/i);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("write-tree")).toBe(index);
    expect(git("status", "--porcelain")).toContain("Designs/");
    forgetDesignDirectoryName(root);
    service = new WorkspaceService(root, { primaryDesignWorkspace: true });
    expect((await listing()).active).toBe("Designs/Other");
    await expect(
      request("settings.write", {
        layer: "workspace-local",
        repoRoot: root,
        patch: { design: { directory: "Brand" } },
        confirmDesignDirectoryChange: true,
      }),
    ).rejects.toThrow(/Remote clients cannot write/i);
  });

  it("rejects stale selections and revocation during the handoff without retargeting", async () => {
    await request("design.createDirectory", { directory: "Brand" });
    await request("design.createDirectory", { directory: "Other" });
    const before = await listing();
    const expectedDirectoryId = before.directoryIds[before.active] ?? null;
    await request("design.selectDirectory", {
      directoryId: before.directoryIds.Other,
      expectedDirectoryId,
    });
    await expect(
      request("design.selectDirectory", {
        directoryId: before.directoryIds.Brand,
        expectedDirectoryId,
      }),
    ).rejects.toThrow(/changed/i);
    service.setDesignTerritoryTransitioner(async (_targets, mutation) => {
      authorized = false;
      return mutation();
    });
    await expect(
      request("design.selectDirectory", {
        directoryId: before.directoryIds.Brand,
        expectedDirectoryId: before.directoryIds.Other,
      }),
    ).rejects.toThrow();
    authorized = true;
    expect((await listing()).active).toBe("Other");
  });

  it("browses only VM directories, including empty folders, excluding links and nested owners", async () => {
    await mkdir(path.join(root, "Brand/Empty"), { recursive: true });
    await mkdir(path.join(root, "nested/.git"), { recursive: true });
    await mkdir(path.join(root, ".zeros"));
    await symlink(temporary, path.join(root, "escape"));
    expect(
      await request("design.browseDirectories", { directory: "" }, "prompter"),
    ).toEqual({ directory: "", directories: ["Brand"], truncated: false });
    expect(
      await request("design.browseDirectories", { directory: "Brand" }),
    ).toEqual({
      directory: "Brand",
      directories: ["Brand/Empty"],
      truncated: false,
    });
    for (const directory of [
      "../",
      root,
      ".git",
      "nested",
      "escape",
      "Brand/../Brand",
    ]) {
      await expect(
        request("design.browseDirectories", { directory }),
      ).rejects.toThrow();
    }
    for (const directory of [
      "../escape",
      ".zeros/Design",
      "nested/Design",
      "escape/Design",
    ]) {
      await expect(
        request("design.createDirectory", { directory }),
      ).rejects.toThrow();
    }
    await expect(
      request("design.createDirectory", { directory: "Brand" }),
    ).rejects.toThrow(/exists/i);
  });

  it("lets managers adopt, rename and remove registration in the live primary while preserving source", async () => {
    await mkdir(path.join(root, "Brand"));
    await writeFile(path.join(root, "Brand/home.html"), "<h1>Keep me</h1>");
    const preview = (await request("design.previewExistingDirectory", {
      folder: "Brand",
    })) as { revision: string };
    await request("design.adoptDirectory", {
      folder: "Brand",
      revision: preview.revision,
    });
    const before = await listing();
    await request("design.selectDirectory", {
      directoryId: before.directoryIds.Brand,
      expectedDirectoryId: before.directoryIds[before.active] ?? null,
    });
    git("add", "Brand", ".gitignore");
    git("commit", "-qm", "Design");
    await request("design.renameDirectory", { from: "Brand", to: "Studio" });
    expect((await listing()).active).toBe("Studio");
    await request("design.removeDirectory", { directory: "Studio" });
    expect((await listing()).directories).toEqual([]);
    expect(
      await readFile(path.join(root, "Studio/page-1/home.html"), "utf8"),
    ).toContain("Keep me");
    expect(await request("design.status")).not.toMatchObject({
      kind: "blocked",
    });
  });

  it("keeps cloud-only directory commands unavailable to Local workspaces", async () => {
    const local = new WorkspaceService(root);
    for (const op of ["design.browseDirectories", "design.createDirectory", "design.selectDirectory"]) {
      await expect(local.handle(op, { workspaceId: "local-main", directory: "Brand" }))
        .rejects.toThrow(/admitted cloud workspace role/);
    }
  });

  it("preserves Local directory listing semantics while cloud selection uses its persisted pointer", async () => {
    const created = await request("design.createDirectory", { directory: "Brand" }) as { directoryId: string };
    await request("design.selectDirectory", { directoryId: created.directoryId, expectedDirectoryId: created.directoryId });
    primeDesignDirectoryName(root, "Local cached directory");
    const local = await new WorkspaceService(root).handle("design.listDirectories", { workspaceId: "local-main" });
    expect(local).toMatchObject({ active: "Local cached directory", target: { directory: "Brand", exists: true } });
    expect(await listing()).toMatchObject({ active: "Brand" });
  });

  it("limits lifecycle operations to managers and the admitted primary checkout", async () => {
    for (const role of ["viewer", "prompter", "developer"] as const) {
      for (const op of [
        "design.createDirectory",
        "design.selectDirectory",
        "design.adoptDirectory",
        "design.renameDirectory",
        "design.removeDirectory",
      ]) {
        await expect(request(op, {}, role)).rejects.toThrow("Role denied");
      }
    }
    await expect(
      request("design.createDirectory", {
        workspaceId: "another",
        directory: "Brand",
      }),
    ).rejects.toThrow(/primary workspace/i);
    await expect(
      request("design.createDirectory", {
        repoRoot: temporary,
        directory: "Brand",
      }),
    ).rejects.toThrow(/primary workspace/i);
    await expect(
      service.handle(
        "design.createDirectory",
        { workspaceId: "local-main", directory: "Brand" },
        { remote: true },
      ),
    ).rejects.toThrow();
  });
});
