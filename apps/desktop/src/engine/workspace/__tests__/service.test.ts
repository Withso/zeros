import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { runSessionId } from "@zeros/protocol/run-actions";
import { DESIGN_SELECTION_NODE_LIMIT } from "@zeros/protocol/design-runtime";
import { WorkspaceService, LOCAL_MAIN_WORKSPACE_ID } from "../service";
import {
  setStateRootForTesting,
  closeState,
  createWorkspace,
  getWorkspaceLifecycleStatus,
  listRemoteRestrictedWorkspaceIds,
} from "../../git";
import { insertWorkspace } from "../../git/state";
import type { Workspace } from "../../git/types";
import { getDesignRuntimeAudit } from "../../design/runtime-audits";
import {
  DESIGN_CANVAS_FILE,
  designDirectoryNameFor,
  forgetDesignDirectoryName,
  primeDesignDirectoryName,
} from "../../design/directory-registry";
import {
  getWorkspaceDesignApi,
  resetWorkspaceDesignApisForTests,
} from "../../design/design-api";
import { getDesignSelection } from "../../design/selection";
import { getDesignScreenshot } from "../../design/screenshots";
import { MAX_CONTEXT_GRAPH_ATTACHMENT_BYTES } from "../../files/context-graph";
import { rememberRecognizedDesignDirectories } from "../../design/recognition-store";
import { withWorkspaceGitMutation } from "../../git/mutation-lock";
import { firstUseDesignDirectoryNameForRepo } from "../../design/directory";

const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("WorkspaceService", () => {
  let dir: string;
  let svc: WorkspaceService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-ws-"));
    setStateRootForTesting(path.join(dir, "state"));
    fs.writeFileSync(path.join(dir, "hello.txt"), "hi there", "utf-8");
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
    } catch {
      // listWorkspaceFiles falls back to a directory walk without git.
    }
    svc = new WorkspaceService(dir);
  });
  afterEach(() => {
    resetWorkspaceDesignApisForTests();
    closeState();
    const contextCache = path.join(
      dir,
      "state",
      ".appdata",
      "isolation-context",
    );
    const makeOwnerWritable = (root: string): void => {
      try {
        fs.chmodSync(root, 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        const candidate = path.join(root, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          makeOwnerWritable(candidate);
        } else if (entry.isFile()) {
          fs.chmodSync(candidate, 0o600);
        }
      }
    };
    makeOwnerWritable(contextCache);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists workspaces including the synthetic local-main entry", async () => {
    const r = (await svc.handle("workspace.list")) as {
      workspaces: { id: string; path: string }[];
    };
    const local = r.workspaces.find((w) => w.id === LOCAL_MAIN_WORKSPACE_ID);
    expect(local).toBeTruthy();
    expect(local!.path).toBe(dir);
  });

  it("accepts explicit device-Personal detachment only over the local bridge", async () => {
    const op = "workspace.reassignLocalOrganization";
    const params = {
      fromOrganizationId: "personal_old",
      toOrganizationId: null,
    };
    await expect(svc.handle(op, params)).resolves.toEqual({
      changes: 0,
      repoSlugs: [],
    });
    await expect(
      svc.handle(op, params, { remote: true }),
    ).rejects.toMatchObject({ code: "REMOTE_RESTRICTED" });
    for (const toOrganizationId of [undefined, "", false, 1]) {
      await expect(
        svc.handle(op, { ...params, toOrganizationId }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    }
  });

  it("reports exact local lifecycle status without inventing a missing operation", async () => {
    await expect(
      svc.handle("workspace.lifecycleStatus", { workspaceId: "ws_missing" }),
    ).resolves.toEqual({
      active: false,
      operation: null,
      phase: null,
      startedAt: null,
    });
    await expect(
      svc.handle("workspace.createFromBranchStatus", {
        repoRoot: dir,
        repoSlug: "missing",
        branchName: "feature/missing",
      }),
    ).resolves.toEqual({
      active: false,
      operation: null,
      phase: null,
      startedAt: null,
      workspace: null,
    });
  });

  it("file.read/tree resolve a registered repo ROOT (Local main trunk) for LOCAL; remote refused", async () => {
    const { upsertRepoByRoot } = await import("../../db/projects");
    // A second repo that is NOT the engine root, registered as a project.
    const repoB = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-trunk-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoB });
      fs.writeFileSync(
        path.join(repoB, "hello.txt"),
        "trunk content\n",
        "utf-8",
      );
      execFileSync("git", ["add", "."], { cwd: repoB });
      execFileSync(
        "git",
        [
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "-m",
          "init",
        ],
        { cwd: repoB },
      );
      upsertRepoByRoot({ repoRoot: repoB, repoSlug: "repob" });

      // LOCAL: the trunk (a repo root with no workspace row) resolves by path.
      const r = (await svc.handle(
        "file.read",
        { workspaceId: repoB, path: "hello.txt" },
        { remote: false },
      )) as { kind: string; content?: string };
      expect(r.kind).toBe("text");
      expect(r.content).toContain("trunk content");

      const t = (await svc.handle(
        "file.tree",
        { workspaceId: repoB },
        { remote: false },
      )) as { files: string[] };
      expect(t.files).toContain("hello.txt");

      // REMOTE: no raw-path trunk access (a remote client addresses workspaces by
      // opaque id only) — falls through to the strict resolveCwd, which rejects.
      await expect(
        svc.handle(
          "file.read",
          { workspaceId: repoB, path: "hello.txt" },
          { remote: true },
        ),
      ).rejects.toThrow();
    } finally {
      fs.rmSync(repoB, { recursive: true, force: true });
    }
  });

  it("writes an image attachment into the workspace context graph", async () => {
    const result = (await svc.handle("attachment.write", {
      workspaceId: LOCAL_MAIN_WORKSPACE_ID,
      chatId: "chat-1",
      attachmentId: "att-1",
      base64: Buffer.from("full-resolution-image").toString("base64"),
      mimeType: "image/png",
      filename: "../../shot.png",
    })) as {
      absolutePath: string;
      relativePath: string;
      bytes: number;
    };

    expect(result.relativePath).toBe(
      ".context-graph/local/attachments/att-1/shot.png",
    );
    expect(result.absolutePath).toBe(path.join(dir, result.relativePath));
    expect(fs.readFileSync(result.absolutePath, "utf8")).toBe(
      "full-resolution-image",
    );
    expect(
      fs.readFileSync(path.join(dir, ".context-graph/.gitignore"), "utf8"),
    ).toContain("/local/");
  });

  it("rejects an oversized attachment from a paired remote client before writing", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://example.com/attachments.git"],
      { cwd: dir },
    );
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const workspace = await createWorkspace({ repoRoot: dir });
    const attachmentId = "remote-oversized";

    await expect(
      svc.handle(
        "attachment.write",
        {
          workspaceId: workspace.workspaceId,
          attachmentId,
          base64: Buffer.alloc(MAX_CONTEXT_GRAPH_ATTACHMENT_BYTES + 1).toString(
            "base64",
          ),
          mimeType: "image/png",
          filename: "oversized.png",
        },
        { remote: true },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    expect(
      fs.existsSync(
        path.join(
          workspace.path,
          ".context-graph/local/attachments",
          attachmentId,
        ),
      ),
    ).toBe(false);
  });

  it("externalizes legacy transcript data URLs on first window read", async () => {
    const { upsertChat } = await import("../../db/chats");
    const { upsertChatMessagesBulk, windowChatMessages } =
      await import("../../db/messages");
    const chatId = "legacy-images";
    upsertChat({
      id: chatId,
      folder: dir,
      agentId: "claude",
      agentName: "Claude",
      model: null,
      effort: "",
      permissionMode: "default",
      lastModeId: null,
      prePlanModeId: null,
      fast: false,
      additionalDirectories: [],
      title: "Legacy image",
      createdAt: 1,
      updatedAt: 1,
      sessionId: null,
      pinned: false,
      archived: false,
      sourceChatId: null,
      kind: "chat",
    });
    const thumbnailUri = `data:image/png;base64,${Buffer.from("legacy-png").toString("base64")}`;
    const message = {
      id: "m1",
      kind: "text",
      role: "user",
      text: "see image",
      createdAt: 2,
      attachments: [
        {
          name: "shot.png",
          mimeType: "image/png",
          kind: "image",
          thumbnailUri,
        },
      ],
      segments: [
        { type: "text", text: "see image " },
        {
          type: "attachment",
          name: "shot.png",
          mimeType: "image/png",
          kind: "image",
          thumbnailUri,
        },
      ],
    };
    upsertChatMessagesBulk(chatId, [
      {
        msgId: "m1",
        kind: "text",
        payload: JSON.stringify(message),
        createdAt: 2,
      },
    ]);

    const result = (await svc.handle("messages.window", {
      chatId,
      limit: 10,
    })) as { messages: Array<{ payload: string }> };
    const payload = JSON.parse(result.messages[0].payload) as typeof message & {
      attachments: Array<{ diskPath?: string; thumbnailUri?: string }>;
      segments: Array<{ diskPath?: string; thumbnailUri?: string }>;
    };
    expect(payload.attachments[0].diskPath).toMatch(
      /^\.context-graph\/local\/attachments\/legacy_[a-f0-9]+\//,
    );
    expect(payload.segments[1].diskPath).toBe(payload.attachments[0].diskPath);
    expect(payload.attachments[0].thumbnailUri).toBeUndefined();
    expect(payload.segments[1].thumbnailUri).toBeUndefined();
    expect(result.messages[0].payload).not.toContain("base64");
    expect(windowChatMessages(chatId, 10)[0].payload).toBe(
      result.messages[0].payload,
    );
    expect(
      fs.existsSync(path.join(dir, payload.attachments[0].diskPath!)),
    ).toBe(true);
  });

  it("migrates legacy disk-backed transcript images into the context graph", async () => {
    const { upsertChat } = await import("../../db/chats");
    const { upsertChatMessagesBulk, windowChatMessages } =
      await import("../../db/messages");
    const chatId = "legacy-disk-images";
    upsertChat({
      id: chatId,
      folder: dir,
      agentId: "claude",
      agentName: "Claude",
      model: null,
      effort: "",
      permissionMode: "default",
      lastModeId: null,
      prePlanModeId: null,
      fast: false,
      additionalDirectories: [],
      title: "Legacy disk image",
      createdAt: 1,
      updatedAt: 1,
      sessionId: null,
      pinned: false,
      archived: false,
      sourceChatId: null,
      kind: "chat",
    });
    const oldDiskPath = `.context/attachments/${chatId}/old-shot.png`;
    fs.mkdirSync(path.join(dir, path.dirname(oldDiskPath)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(dir, oldDiskPath), "legacy-disk-png");
    const message = {
      id: "m-disk",
      kind: "text",
      role: "user",
      text: "see old image",
      createdAt: 2,
      attachments: [
        {
          name: "shot.png",
          mimeType: "image/png",
          kind: "image",
          diskPath: oldDiskPath,
        },
      ],
      segments: [
        { type: "text", text: "see old image " },
        {
          type: "attachment",
          name: "shot.png",
          mimeType: "image/png",
          kind: "image",
          diskPath: oldDiskPath,
        },
      ],
    };
    upsertChatMessagesBulk(chatId, [
      {
        msgId: "m-disk",
        kind: "text",
        payload: JSON.stringify(message),
        createdAt: 2,
      },
    ]);

    const result = (await svc.handle("messages.window", {
      chatId,
      limit: 10,
    })) as { messages: Array<{ payload: string }> };
    const payload = JSON.parse(result.messages[0].payload) as typeof message & {
      attachments: Array<{ diskPath: string; attachmentId?: string }>;
      segments: Array<{ diskPath?: string; attachmentId?: string }>;
    };

    expect(payload.attachments[0].diskPath).toMatch(
      /^\.context-graph\/local\/attachments\/legacy_[a-f0-9]+\//,
    );
    expect(payload.segments[1].diskPath).toBe(payload.attachments[0].diskPath);
    expect(payload.attachments[0].attachmentId).toMatch(/^legacy_[a-f0-9]+$/);
    expect(payload.segments[1].attachmentId).toBe(
      payload.attachments[0].attachmentId,
    );
    expect(result.messages[0].payload).not.toContain(oldDiskPath);
    expect(windowChatMessages(chatId, 10)[0].payload).toBe(
      result.messages[0].payload,
    );
    expect(
      fs.readFileSync(path.join(dir, payload.attachments[0].diskPath), "utf8"),
    ).toBe("legacy-disk-png");
  });

  it("does not recreate a missing chat folder while reading legacy images", async () => {
    const { upsertChat } = await import("../../db/chats");
    const { upsertChatMessagesBulk } = await import("../../db/messages");
    const chatId = "missing-legacy-folder";
    const missingFolder = path.join(dir, "removed-worktree");
    fs.mkdirSync(missingFolder);
    upsertChat({
      id: chatId,
      folder: missingFolder,
      agentId: "claude",
      agentName: "Claude",
      model: null,
      effort: "",
      permissionMode: "default",
      lastModeId: null,
      prePlanModeId: null,
      fast: false,
      additionalDirectories: [],
      title: "Legacy image",
      createdAt: 1,
      updatedAt: 1,
      sessionId: null,
      pinned: false,
      archived: false,
      sourceChatId: null,
      kind: "chat",
    });
    const thumbnailUri = `data:image/png;base64,${Buffer.from("legacy-png").toString("base64")}`;
    upsertChatMessagesBulk(chatId, [
      {
        msgId: "m1",
        kind: "text",
        payload: JSON.stringify({
          id: "m1",
          kind: "text",
          role: "user",
          text: "see image",
          createdAt: 2,
          attachments: [
            {
              name: "shot.png",
              mimeType: "image/png",
              kind: "image",
              thumbnailUri,
            },
          ],
        }),
        createdAt: 2,
      },
    ]);
    fs.rmSync(missingFolder, { recursive: true, force: true });

    const result = (await svc.handle("messages.window", {
      chatId,
      limit: 10,
    })) as { messages: Array<{ payload: string }> };

    expect(result.messages[0].payload).toContain("data:image/png;base64,");
    expect(fs.existsSync(missingFolder)).toBe(false);
  });

  it("registers transcript-window migrations with the owning workspace barrier", async () => {
    const { upsertChat } = await import("../../db/chats");
    upsertChat({
      id: "barrier-chat",
      folder: dir,
      agentId: "claude",
      agentName: "Claude",
      model: null,
      effort: "",
      permissionMode: "default",
      lastModeId: null,
      prePlanModeId: null,
      fast: false,
      additionalDirectories: [],
      title: "Barrier",
      createdAt: 1,
      updatedAt: 1,
      sessionId: null,
      pinned: false,
      archived: false,
      sourceChatId: null,
      kind: "chat",
    });

    expect(
      svc.lifecycleMutationWorkspaceId("messages.window", {
        chatId: "barrier-chat",
      }),
    ).toBe(LOCAL_MAIN_WORKSPACE_ID);
    expect(
      svc.lifecycleMutationWorkspaceId("messages.windowOlder", {
        chatId: "barrier-chat",
      }),
    ).toBe(LOCAL_MAIN_WORKSPACE_ID);
  });

  it("registers Design staging with the workspace lifecycle barrier", () => {
    expect(
      svc.lifecycleMutationWorkspaceId("design.stage", {
        workspaceId: "design-workspace",
      }),
    ).toBe("design-workspace");
  });

  it("file.write writes a registered repo ROOT file for LOCAL; remote raw-path + non-strings rejected", async () => {
    const { upsertRepoByRoot } = await import("../../db/projects");
    const repoC = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-write-op-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoC });
      upsertRepoByRoot({ repoRoot: repoC, repoSlug: "repoc" });

      // LOCAL: write a new (nested) file under the trunk, then read it back.
      const w = (await svc.handle(
        "file.write",
        {
          workspaceId: repoC,
          path: "src/new.ts",
          content: "export const x = 1;\n",
        },
        { remote: false },
      )) as { kind: string };
      expect(w.kind).toBe("success");
      const r = (await svc.handle(
        "file.read",
        { workspaceId: repoC, path: "src/new.ts" },
        { remote: false },
      )) as { kind: string; content?: string };
      expect(r.kind).toBe("text");
      expect(r.content).toContain("export const x = 1;");

      // REMOTE: a raw repo path isn't resolvable for a remote client (addresses
      // workspaces by opaque id), and the secret denylist also applies — either
      // way it throws and writes nothing.
      await expect(
        svc.handle(
          "file.write",
          { workspaceId: repoC, path: ".env", content: "SECRET=1" },
          { remote: true },
        ),
      ).rejects.toThrow();
      expect(fs.existsSync(path.join(repoC, ".env"))).toBe(false);

      // Non-string content is rejected.
      await expect(
        svc.handle(
          "file.write",
          { workspaceId: repoC, path: "x.txt", content: 123 },
          { remote: false },
        ),
      ).rejects.toThrow();
    } finally {
      fs.rmSync(repoC, { recursive: true, force: true });
    }
  });

  it("remote-restricts a workspace (opt-out): hidden for remote, kept local", async () => {
    // Default share-all: a remote client sees local-main.
    const before = (await svc.handle(
      "workspace.list",
      {},
      { remote: true },
    )) as {
      workspaces: { id: string }[];
    };
    expect(
      before.workspaces.some((w) => w.id === LOCAL_MAIN_WORKSPACE_ID),
    ).toBe(true);

    // Owner restricts it (local-only op).
    await svc.handle("workspace.setRemoteRestricted", {
      workspaceId: LOCAL_MAIN_WORKSPACE_ID,
      restricted: true,
    });
    const listed = (await svc.handle("workspace.listRemoteRestricted")) as {
      ids: string[];
    };
    expect(listed.ids).toContain(LOCAL_MAIN_WORKSPACE_ID);

    // Relay no longer sees it…
    const remote = (await svc.handle(
      "workspace.list",
      {},
      { remote: true },
    )) as {
      workspaces: { id: string }[];
    };
    expect(
      remote.workspaces.some((w) => w.id === LOCAL_MAIN_WORKSPACE_ID),
    ).toBe(false);
    // …but the local desktop still does (remote != local ONLY for restricted).
    const localList = (await svc.handle(
      "workspace.list",
      {},
      { remote: false },
    )) as { workspaces: { id: string }[] };
    expect(
      localList.workspaces.some((w) => w.id === LOCAL_MAIN_WORKSPACE_ID),
    ).toBe(true);

    // Un-restrict → visible to remote again.
    await svc.handle("workspace.setRemoteRestricted", {
      workspaceId: LOCAL_MAIN_WORKSPACE_ID,
      restricted: false,
    });
    const after = (await svc.handle(
      "workspace.list",
      {},
      { remote: true },
    )) as {
      workspaces: { id: string }[];
    };
    expect(after.workspaces.some((w) => w.id === LOCAL_MAIN_WORKSPACE_ID)).toBe(
      true,
    );
  });

  it("keeps design workspaces local-only across discovery and design reads", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const design = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-remote-boundary",
      kind: "design",
    });
    try {
      expect(listRemoteRestrictedWorkspaceIds()).toContain(design.workspaceId);

      const local = (await svc.handle(
        "workspace.list",
        {},
        { remote: false },
      )) as { workspaces: Array<{ id: string }> };
      const remote = (await svc.handle(
        "workspace.list",
        {},
        { remote: true },
      )) as { workspaces: Array<{ id: string }> };
      expect(
        local.workspaces.some(
          (workspace) => workspace.id === design.workspaceId,
        ),
      ).toBe(true);
      expect(
        remote.workspaces.some(
          (workspace) => workspace.id === design.workspaceId,
        ),
      ).toBe(false);

      await expect(
        svc.handle(
          "design.snapshot",
          { workspaceId: design.workspaceId },
          { remote: true },
        ),
      ).rejects.toMatchObject({ code: "REMOTE_RESTRICTED" });
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: design.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("previews an empty reserved folder as a design directory that still needs creation", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-directory-preview",
    });
    const directory = firstUseDesignDirectoryNameForRepo(dir);
    const target = path.join(created.path, directory);
    fs.mkdirSync(target, { recursive: true });

    try {
      const reserved = (await svc.handle("design.listDirectories", {
        workspaceId: created.workspaceId,
      })) as {
        target: { directory: string; exists: boolean } | null;
      };
      expect(reserved.target).toEqual({ directory, exists: false });

      fs.writeFileSync(path.join(target, DESIGN_CANVAS_FILE), "{}\n");
      await rememberRecognizedDesignDirectories(created.path, [directory]);
      const initialized = (await svc.handle("design.listDirectories", {
        workspaceId: created.workspaceId,
      })) as {
        target: { directory: string; exists: boolean } | null;
      };
      expect(initialized.target).toEqual({ directory, exists: true });
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("shares concurrent aggregate Design snapshot scans for one workspace", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const design = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-snapshot-single-flight",
      kind: "design",
    });
    try {
      const [first, second] = (await Promise.all([
        svc.handle("design.snapshot", { workspaceId: design.workspaceId }),
        svc.handle("design.snapshot", { workspaceId: design.workspaceId }),
      ])) as Array<{ snapshot: object }>;

      // Sharing the exact result object pins that only one filesystem parse /
      // lint / render-identity pass owned this concurrent cold generation.
      expect(first.snapshot).toBe(second.snapshot);
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: design.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("does not share an in-flight snapshot across an active Design directory change", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const design = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-snapshot-directory-flight",
      kind: "design",
    });
    const originalDirectory = designDirectoryNameFor(design.path);
    const alternateDirectory = "Alternate Design";
    const setDirectory = (directory: string) =>
      svc.handle("settings.write", {
        layer: "workspace-local",
        repoRoot: design.path,
        patch: { design: { directory } },
        confirmDesignDirectoryChange: true,
      });

    try {
      const originalFrame = (await svc.handle("design.frame.create", {
        workspaceId: design.workspaceId,
        title: "Original directory frame",
      })) as { frame: { file: string } };
      fs.cpSync(
        path.join(design.path, originalDirectory),
        path.join(design.path, alternateDirectory),
        { recursive: true },
      );
      execFileSync(
        "git",
        ["add", "-f", "--", originalDirectory, alternateDirectory],
        { cwd: design.path },
      );
      execFileSync("git", ["commit", "-q", "-m", "add alternate design"], {
        cwd: design.path,
      });

      await setDirectory(alternateDirectory);
      const alternateFrame = (await svc.handle("design.frame.create", {
        workspaceId: design.workspaceId,
        title: "Alternate directory frame",
      })) as { frame: { file: string } };
      await setDirectory(originalDirectory);

      const original = (await svc.handle("design.snapshot", {
        workspaceId: design.workspaceId,
      })) as { snapshot: { frames: Array<{ file: string }> } };
      const internals = svc as unknown as {
        designSnapshotFlights: Map<string, Promise<typeof original.snapshot>>;
      };
      let releaseOriginal!: () => void;
      const blockedOriginal = new Promise<typeof original.snapshot>(
        (resolve) => {
          releaseOriginal = () => resolve(original.snapshot);
        },
      );
      const baseKey = `${design.workspaceId}\u0000${path.resolve(design.path)}\u0000write`;
      // Seed both the historical key and the directory-aware key so this test
      // exercises the same blocked lower flight before and after the fix.
      internals.designSnapshotFlights.set(baseKey, blockedOriginal);
      internals.designSnapshotFlights.set(
        `${baseKey}\u0000${originalDirectory}`,
        blockedOriginal,
      );
      const getFlight = vi.spyOn(internals.designSnapshotFlights, "get");

      const oldRequest = svc.handle("design.snapshot", {
        workspaceId: design.workspaceId,
      }) as Promise<typeof original>;
      await vi.waitFor(() => expect(getFlight).toHaveBeenCalledTimes(1));

      await setDirectory(alternateDirectory);
      const newRequest = svc.handle("design.snapshot", {
        workspaceId: design.workspaceId,
      }) as Promise<typeof original>;
      await vi.waitFor(() =>
        expect(getFlight.mock.calls.length).toBeGreaterThanOrEqual(2),
      );
      releaseOriginal();

      const [oldResult, newResult] = await Promise.all([
        oldRequest,
        newRequest,
      ]);
      expect(oldResult.snapshot.frames.map((frame) => frame.file)).toContain(
        originalFrame.frame.file,
      );
      expect(
        oldResult.snapshot.frames.map((frame) => frame.file),
      ).not.toContain(alternateFrame.frame.file);
      expect(newResult.snapshot.frames.map((frame) => frame.file)).toContain(
        alternateFrame.frame.file,
      );
    } finally {
      const flights = (
        svc as unknown as { designSnapshotFlights: Map<string, unknown> }
      ).designSnapshotFlights;
      flights.clear();
      await svc.handle("workspace.delete", {
        workspaceId: design.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("undoes and redoes a frame deletion through the shared Design history", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const design = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-frame-delete-history",
      kind: "design",
    });
    try {
      const first = (await svc.handle("design.frame.create", {
        workspaceId: design.workspaceId,
        title: "First frame",
        x: 35,
        y: 45,
        w: 640,
        h: 360,
        z: 2,
      })) as { frame: { file: string } };
      const second = (await svc.handle("design.frame.create", {
        workspaceId: design.workspaceId,
        title: "Second frame",
      })) as { frame: { file: string } };

      const deleted = (await svc.handle("design.frame.delete", {
        workspaceId: design.workspaceId,
        frame: first.frame.file,
      })) as { snapshot: { frames: Array<{ file: string }> } };
      expect(deleted.snapshot.frames.map((frame) => frame.file)).not.toContain(
        first.frame.file,
      );

      const undone = (await svc.handle("design.history.undo", {
        workspaceId: design.workspaceId,
        frame: second.frame.file,
      })) as {
        historySelection?: string | null;
        snapshot: {
          frames: Array<{
            file: string;
            x: number;
            y: number;
            width: number;
            height: number;
            z: number;
          }>;
        };
      };
      expect(undone.historySelection).toBe(first.frame.file);
      expect(
        undone.snapshot.frames.find((frame) => frame.file === first.frame.file),
      ).toMatchObject({ x: 35, y: 45, width: 640, height: 360, z: 2 });

      const redone = (await svc.handle("design.history.redo", {
        workspaceId: design.workspaceId,
        frame: first.frame.file,
      })) as {
        historySelection?: string | null;
        snapshot: { frames: Array<{ file: string }> };
      };
      expect(redone.historySelection).toBe(second.frame.file);
      expect(redone.snapshot.frames.map((frame) => frame.file)).not.toContain(
        first.frame.file,
      );

      const emptied = (await svc.handle("design.frame.delete", {
        workspaceId: design.workspaceId,
        frame: second.frame.file,
      })) as { snapshot: { frames: Array<{ file: string }> } };
      expect(emptied.snapshot.frames).toEqual([]);
      const restoredFromEmptyCanvas = (await svc.handle("design.history.undo", {
        workspaceId: design.workspaceId,
      })) as {
        historySelection?: string | null;
        snapshot: { frames: Array<{ file: string }> };
      };
      expect(restoredFromEmptyCanvas.historySelection).toBe(second.frame.file);
      expect(
        restoredFromEmptyCanvas.snapshot.frames.map((frame) => frame.file),
      ).toEqual([second.frame.file]);
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: design.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("orders frame creation, renaming, and duplication in shared Design history", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const design = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-frame-lifecycle-history",
      kind: "design",
    });
    try {
      const created = (await svc.handle("design.frame.create", {
        workspaceId: design.workspaceId,
        title: "Original frame",
        x: 18,
        y: 28,
        w: 720,
        h: 480,
        z: 3,
      })) as { frame: { file: string } };

      const undoneCreation = (await svc.handle("design.history.undo", {
        workspaceId: design.workspaceId,
        frame: created.frame.file,
      })) as {
        historySelection?: string | null;
        snapshot: { frames: Array<{ file: string }> };
      };
      expect(undoneCreation.snapshot.frames).toEqual([]);
      expect(undoneCreation.historySelection).toBeNull();

      const redoneCreation = (await svc.handle("design.history.redo", {
        workspaceId: design.workspaceId,
      })) as {
        historySelection?: string | null;
        snapshot: {
          frames: Array<{
            file: string;
            title: string;
            x: number;
            y: number;
            width: number;
            height: number;
            z: number;
          }>;
        };
      };
      expect(redoneCreation.historySelection).toBe(created.frame.file);
      expect(redoneCreation.snapshot.frames).toEqual([
        expect.objectContaining({
          file: created.frame.file,
          title: "Original frame",
          x: 18,
          y: 28,
          width: 720,
          height: 480,
          z: 3,
        }),
      ]);

      await svc.handle("design.frame.rename", {
        workspaceId: design.workspaceId,
        frame: created.frame.file,
        title: "Renamed frame",
      });
      const undoneRename = (await svc.handle("design.history.undo", {
        workspaceId: design.workspaceId,
        frame: created.frame.file,
      })) as { snapshot: { frames: Array<{ title: string }> } };
      expect(undoneRename.snapshot.frames[0]?.title).toBe("Original frame");
      const redoneRename = (await svc.handle("design.history.redo", {
        workspaceId: design.workspaceId,
        frame: created.frame.file,
      })) as { snapshot: { frames: Array<{ title: string }> } };
      expect(redoneRename.snapshot.frames[0]?.title).toBe("Renamed frame");

      const duplicated = (await svc.handle("design.frame.duplicate", {
        workspaceId: design.workspaceId,
        frame: created.frame.file,
      })) as { frame: { file: string } };
      const undoneDuplicate = (await svc.handle("design.history.undo", {
        workspaceId: design.workspaceId,
        frame: duplicated.frame.file,
      })) as { snapshot: { frames: Array<{ file: string }> } };
      expect(
        undoneDuplicate.snapshot.frames.map((frame) => frame.file),
      ).toEqual([created.frame.file]);
      const redoneDuplicate = (await svc.handle("design.history.redo", {
        workspaceId: design.workspaceId,
        frame: created.frame.file,
      })) as {
        historySelection?: string | null;
        snapshot: { frames: Array<{ file: string }> };
      };
      expect(redoneDuplicate.historySelection).toBe(duplicated.frame.file);
      expect(
        redoneDuplicate.snapshot.frames.map((frame) => frame.file),
      ).toContain(duplicated.frame.file);
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: design.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("publishes validated Design screenshots without replacing the cache on malformed input", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const design = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-artifact-export",
      kind: "design",
    });
    try {
      const createdFrame = (await svc.handle("design.frame.create", {
        workspaceId: design.workspaceId,
        title: "Artifact frame",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        z: 0,
      })) as { frame: { file: string; sourceVersion: string } };
      const snapshotReply = (await svc.handle("design.snapshot", {
        workspaceId: design.workspaceId,
      })) as {
        snapshot: { frames: Array<{ file: string; sourceVersion: string }> };
      };
      const frame =
        snapshotReply.snapshot.frames.find(
          (candidate) => candidate.file === createdFrame.frame.file,
        ) ?? createdFrame.frame;
      const screenshot = {
        workspaceId: design.workspaceId,
        frame: frame.file,
        nodeId: null,
        mimeType: "image/png",
        data: PNG_1X1_BASE64,
        width: 1,
        height: 1,
        scale: 1,
        capturedAt: 1,
        sourceVersion: frame.sourceVersion,
      };

      await expect(
        svc.handle("design.screenshot.set", screenshot),
      ).resolves.toEqual({ ok: true });

      await expect(
        svc.handle("design.screenshot.set", {
          ...screenshot,
          data: Buffer.from("valid-base64-but-not-a-png").toString("base64"),
        }),
      ).rejects.toThrow(/PNG/i);
      expect(
        getDesignScreenshot(
          design.workspaceId,
          frame.file,
          null,
          frame.sourceVersion,
        )?.data,
      ).toBe(PNG_1X1_BASE64);
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: design.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("workspace.setMode flips modes concurrently (never blocks on processes) and stays local-only", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "mode-switch",
    });
    const designDirectory = designDirectoryNameFor(created.path);
    const headBeforeEnter = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: created.path,
      encoding: "utf8",
    }).trim();
    const territoryTransitions: string[][] = [];
    svc.setDesignTerritoryTransitioner(async (targets, mutation) => {
      territoryTransitions.push(targets.map((target) => target.workspaceId));
      return mutation();
    });
    try {
      // Concurrent duality: the switch enforces nothing and blocks on
      // nothing — agents/terminals keep running through it in both
      // directions. (The old census refusal is retired.)
      const entered = (await svc.handle("workspace.setMode", {
        workspaceId: created.workspaceId,
        mode: "design",
      })) as {
        ok: true;
        mode: "design";
        snapshot?: { frames: unknown[]; tokenSourceVersion: string };
      };
      expect(entered).toMatchObject({
        ok: true,
        mode: "design",
        snapshot: {
          frames: expect.any(Array),
          tokenSourceVersion: expect.any(String),
        },
      });
      const afterEnter = (await svc.handle("workspace.list")) as {
        workspaces: Array<{ id: string; kind?: string }>;
      };
      expect(
        afterEnter.workspaces.find((w) => w.id === created.workspaceId)?.kind,
      ).toBe("design");
      // First entry initializes a live, uncommitted draft. It does not create
      // a Git commit or disturb the existing index.
      expect(
        fs.existsSync(path.join(created.path, designDirectory, "tokens.css")),
      ).toBe(true);
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: created.path,
          encoding: "utf8",
        }).trim(),
      ).toBe(headBeforeEnter);
      const tokens = path.join(created.path, designDirectory, "tokens.css");
      const frame = path.join(created.path, designDirectory, "draft.txt");
      fs.writeFileSync(tokens, "/* uncommitted design */\n");
      fs.writeFileSync(frame, "<main>uncommitted</main>\n");
      const headBeforeExit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: created.path,
        encoding: "utf8",
      }).trim();
      // Idempotent no-op when already in the requested mode.
      await expect(
        svc.handle("workspace.setMode", {
          workspaceId: created.workspaceId,
          mode: "design",
        }),
      ).resolves.toEqual({ ok: true, mode: "design" });

      // Exit returns a code-surface workspace; the checkout was never
      // whole-tree locked in the first place.
      await expect(
        svc.handle("workspace.setMode", {
          workspaceId: created.workspaceId,
          mode: "code",
        }),
      ).resolves.toEqual({ ok: true, mode: "code" });
      const afterExit = (await svc.handle("workspace.list")) as {
        workspaces: Array<{ id: string; kind?: string }>;
      };
      expect(
        afterExit.workspaces.find((w) => w.id === created.workspaceId)?.kind,
      ).toBe("code");
      expect(fs.existsSync(path.join(created.path, designDirectory))).toBe(
        true,
      );
      expect(fs.readFileSync(tokens, "utf8")).toBe(
        "/* uncommitted design */\n",
      );
      expect(fs.readFileSync(frame, "utf8")).toBe("<main>uncommitted</main>\n");
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: created.path,
          encoding: "utf8",
        }).trim(),
      ).toBe(headBeforeExit);
      expect(territoryTransitions).toEqual([]);

      await expect(
        svc.handle("workspace.setMode", {
          workspaceId: created.workspaceId,
          mode: "design",
        }),
      ).resolves.toMatchObject({ ok: true, mode: "design" });
      expect(fs.readFileSync(tokens, "utf8")).toBe(
        "/* uncommitted design */\n",
      );
      expect(fs.readFileSync(frame, "utf8")).toBe("<main>uncommitted</main>\n");
      expect(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: created.path,
          encoding: "utf8",
        }).trim(),
      ).toBe(headBeforeExit);

      await expect(
        svc.handle(
          "workspace.setMode",
          { workspaceId: created.workspaceId, mode: "design" },
          { remote: true },
        ),
      ).rejects.toMatchObject({ code: "REMOTE_RESTRICTED" });
      await expect(
        svc.handle("workspace.setMode", {
          workspaceId: created.workspaceId,
          mode: "sparse",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("re-enters an initialized non-default Design directory while its draft is still uncommitted", async () => {
    fs.mkdirSync(path.join(dir, ".zeros"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".zeros", "settings.toml"),
      '[design]\ndirectory = "Product Design"\n',
    );
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt", ".zeros/settings.toml"], {
      cwd: dir,
    });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "non-default-design-reentry",
    });

    try {
      await expect(
        svc.handle("workspace.setMode", {
          workspaceId: created.workspaceId,
          mode: "design",
        }),
      ).resolves.toMatchObject({ ok: true, mode: "design" });
      await expect(
        svc.handle("workspace.setMode", {
          workspaceId: created.workspaceId,
          mode: "code",
        }),
      ).resolves.toEqual({ ok: true, mode: "code" });

      await expect(
        svc.handle("workspace.setMode", {
          workspaceId: created.workspaceId,
          mode: "design",
        }),
      ).resolves.toMatchObject({ ok: true, mode: "design" });
      expect(
        fs.existsSync(
          path.join(created.path, "Product Design", ".zeros-canvas.json"),
        ),
      ).toBe(true);
      expect(
        execFileSync("git", ["diff", "--cached", "--name-only"], {
          cwd: created.path,
          encoding: "utf8",
        }),
      ).toBe("");
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("does not publish Design mode when its initial snapshot cannot be produced", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "mode-snapshot-atomicity",
    });
    const internals = svc as unknown as {
      readDesignSnapshot: (...args: unknown[]) => Promise<unknown>;
    };
    const originalRead = internals.readDesignSnapshot.bind(svc);
    internals.readDesignSnapshot = async () => {
      throw new Error("snapshot fixture failed");
    };

    try {
      await expect(
        svc.handle("workspace.setMode", {
          workspaceId: created.workspaceId,
          mode: "design",
        }),
      ).rejects.toThrow("snapshot fixture failed");
      const afterFailure = (await svc.handle("workspace.list")) as {
        workspaces: Array<{ id: string; kind?: string }>;
      };
      expect(
        afterFailure.workspaces.find((w) => w.id === created.workspaceId)?.kind,
      ).toBe("code");

      internals.readDesignSnapshot = originalRead;
      await expect(
        svc.handle("workspace.setMode", {
          workspaceId: created.workspaceId,
          mode: "design",
        }),
      ).resolves.toMatchObject({ ok: true, mode: "design" });
    } finally {
      internals.readDesignSnapshot = originalRead;
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("treats the legacy isolation setting as inert for Code processes and checkout shape", async () => {
    const previousSettingsDir = process.env.ZEROS_USER_SETTINGS_DIR;
    const settingsDir = path.join(dir, "user-settings-isolation-transition");
    process.env.ZEROS_USER_SETTINGS_DIR = settingsDir;
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "settings.toml"),
      '[design.isolation]\nmode = "sandbox"\n',
      "utf8",
    );
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "isolation-setting-transition",
      kind: "design",
    });
    const designDirectory = designDirectoryNameFor(created.path);
    const transitions: string[][] = [];
    svc.setDesignTerritoryTransitioner(async (targets, mutation) => {
      transitions.push(targets.map((target) => target.workspaceId));
      return mutation();
    });

    try {
      await svc.handle("workspace.setMode", {
        workspaceId: created.workspaceId,
        mode: "code",
      });
      transitions.length = 0;

      await svc.handle("settings.write", {
        layer: "user",
        patch: { design: { isolation: { mode: "sparse" } } },
      });

      expect(transitions).toEqual([]);
      expect(fs.existsSync(path.join(created.path, designDirectory))).toBe(
        true,
      );
    } finally {
      if (previousSettingsDir === undefined) {
        delete process.env.ZEROS_USER_SETTINGS_DIR;
      } else {
        process.env.ZEROS_USER_SETTINGS_DIR = previousSettingsDir;
      }
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("does not create a sparse shape for a managed legacy isolation setting", async () => {
    const previousSettingsDir = process.env.ZEROS_USER_SETTINGS_DIR;
    const settingsDir = path.join(dir, "managed-isolation-precedence");
    process.env.ZEROS_USER_SETTINGS_DIR = settingsDir;
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "settings.managed.toml"),
      '[design.isolation]\nmode = "sparse"\n',
      "utf8",
    );
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "managed-isolation-precedence",
      kind: "design",
    });
    const transitions: string[][] = [];
    svc.setDesignTerritoryTransitioner(async (targets, mutation) => {
      transitions.push(targets.map((target) => target.workspaceId));
      return mutation();
    });

    try {
      await svc.handle("workspace.setMode", {
        workspaceId: created.workspaceId,
        mode: "code",
      });
      transitions.length = 0;

      await svc.handle("settings.write", {
        layer: "user",
        patch: { design: { isolation: { mode: "sandbox" } } },
      });

      expect(transitions).toEqual([]);
    } finally {
      if (previousSettingsDir === undefined) {
        delete process.env.ZEROS_USER_SETTINGS_DIR;
      } else {
        process.env.ZEROS_USER_SETTINGS_DIR = previousSettingsDir;
      }
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("keeps committed Design reads independent from the presentation view mode", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-view-mode-independence",
      kind: "design",
    });
    try {
      const inDesign = (await svc.handle("design.snapshot", {
        workspaceId: created.workspaceId,
      })) as {
        snapshot: {
          tokenSourceVersion: string;
          tokens: unknown[];
          frames: unknown[];
          lint: { workspacePath: string; checkedFiles: string[] };
        };
      };
      await svc.handle("workspace.setMode", {
        workspaceId: created.workspaceId,
        mode: "code",
      });
      const [inCode, concurrentInCode] = (await Promise.all([
        svc.handle("design.snapshot", { workspaceId: created.workspaceId }),
        svc.handle("design.snapshot", { workspaceId: created.workspaceId }),
      ])) as [typeof inDesign, typeof inDesign];

      expect(inCode.snapshot).toBe(concurrentInCode.snapshot);
      expect(inCode.snapshot).toMatchObject({
        tokenSourceVersion: inDesign.snapshot.tokenSourceVersion,
        tokens: inDesign.snapshot.tokens,
        frames: inDesign.snapshot.frames,
        lint: {
          workspacePath: created.path,
          checkedFiles: inDesign.snapshot.lint.checkedFiles,
        },
      });
      await expect(
        svc.handle("design.frames", { workspaceId: created.workspaceId }),
      ).resolves.toEqual({ frames: [] });
      await expect(
        svc.handle("design.tokens", { workspaceId: created.workspaceId }),
      ).resolves.toEqual({ tokens: inDesign.snapshot.tokens });
      await expect(
        svc.handle("design.lint", { workspaceId: created.workspaceId }),
      ).resolves.toMatchObject({
        report: {
          workspacePath: created.path,
          checkedFiles: inDesign.snapshot.lint.checkedFiles,
        },
      });
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("keeps Design reads non-writing in sandbox Code view", async () => {
    const previousSettingsDir = process.env.ZEROS_USER_SETTINGS_DIR;
    const settingsDir = path.join(dir, "sandbox-code-read-settings");
    process.env.ZEROS_USER_SETTINGS_DIR = settingsDir;
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, "settings.toml"),
      '[design.isolation]\nmode = "sandbox"\n',
      "utf8",
    );
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "sandbox-code-read-only",
      kind: "design",
    });
    const designDirectory = designDirectoryNameFor(created.path);
    try {
      const frame = (await svc.handle("design.frame.create", {
        workspaceId: created.workspaceId,
        title: "Read only",
      })) as { frame: { file: string } };
      const framePath = path.join(
        created.path,
        designDirectory,
        frame.frame.file,
      );
      const withoutOid = fs
        .readFileSync(framePath, "utf8")
        .replace(/\sdata-oid="[^"]+"/, "");
      fs.writeFileSync(framePath, withoutOid);
      execFileSync("git", ["add", "-f", "--", designDirectory], {
        cwd: created.path,
      });
      execFileSync("git", ["commit", "-q", "-m", "missing oid fixture"], {
        cwd: created.path,
      });
      await svc.handle("workspace.setMode", {
        workspaceId: created.workspaceId,
        mode: "code",
      });

      const before = fs.readFileSync(framePath, "utf8");
      const lint = (await svc.handle("design.lint", {
        workspaceId: created.workspaceId,
      })) as { report: { healedOids: number } };
      expect(lint.report.healedOids).toBe(0);
      expect(fs.readFileSync(framePath, "utf8")).toBe(before);
    } finally {
      if (previousSettingsDir === undefined) {
        delete process.env.ZEROS_USER_SETTINGS_DIR;
      } else {
        process.env.ZEROS_USER_SETTINGS_DIR = previousSettingsDir;
      }
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("keeps the live uncommitted Design draft readable in Code view", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-code-view-residue",
      kind: "design",
    });
    const liveDesign = path.join(
      created.path,
      designDirectoryNameFor(created.path),
    );
    try {
      await svc.handle("workspace.setMode", {
        workspaceId: created.workspaceId,
        mode: "code",
      });
      fs.writeFileSync(path.join(liveDesign, "untracked-draft.txt"), "keep\n");

      await expect(
        svc.handle("design.snapshot", { workspaceId: created.workspaceId }),
      ).resolves.toMatchObject({
        snapshot: { lint: { workspacePath: created.path } },
      });
      await expect(
        svc.handle("design.history.undo", {
          workspaceId: created.workspaceId,
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringMatching(/Design mode/i),
      });
      expect(
        fs.readFileSync(path.join(liveDesign, "untracked-draft.txt"), "utf8"),
      ).toBe("keep\n");
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("requires explicit confirmation before changing a live design-directory pointer", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-pointer-confirmation",
      kind: "design",
    });
    try {
      const currentDesign = path.join(
        created.path,
        designDirectoryNameFor(created.path),
      );
      const alternateDesign = path.join(created.path, "Alternate Design");
      fs.cpSync(currentDesign, alternateDesign, { recursive: true });
      execFileSync("git", ["add", "-f", "--", "Alternate Design"], {
        cwd: created.path,
      });
      execFileSync("git", ["commit", "-q", "-m", "add alternate design"], {
        cwd: created.path,
      });
      await expect(
        svc.handle("settings.write", {
          layer: "workspace-local",
          repoRoot: created.path,
          patch: { design: { directory: "Alternate Design" } },
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringMatching(/confirmation/i),
      });
      await expect(
        svc.handle("settings.write", {
          layer: "workspace-local",
          repoRoot: created.path,
          patch: { design: { directory: "Alternate Design" } },
          confirmDesignDirectoryChange: true,
        }),
      ).resolves.toMatchObject({
        doc: { design: { directory: "Alternate Design" } },
      });
      await expect(
        svc.handle("design.snapshot", { workspaceId: created.workspaceId }),
      ).resolves.toMatchObject({
        snapshot: { lint: { workspacePath: created.path } },
      });
      await svc.handle("workspace.setMode", {
        workspaceId: created.workspaceId,
        mode: "code",
      });
      await expect(
        svc.handle("design.snapshot", { workspaceId: created.workspaceId }),
      ).resolves.toMatchObject({
        snapshot: { lint: { workspacePath: created.path } },
      });
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("rejects confirmed Design pointers that are absent, uncommitted, or symlinked", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-pointer-validation",
      kind: "design",
    });
    try {
      for (const directory of ["Missing Design", "Uncommitted Design"]) {
        if (directory === "Uncommitted Design") {
          fs.mkdirSync(path.join(created.path, directory));
          fs.writeFileSync(
            path.join(created.path, directory, ".zeros-canvas.json"),
            "{}\n",
          );
        }
        await expect(
          svc.handle("settings.write", {
            layer: "workspace-local",
            repoRoot: created.path,
            patch: { design: { directory } },
            confirmDesignDirectoryChange: true,
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      }

      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-outside-"));
      try {
        fs.symlinkSync(outside, path.join(created.path, "Linked Design"));
        await expect(
          svc.handle("settings.write", {
            layer: "workspace-local",
            repoRoot: created.path,
            patch: { design: { directory: "Linked Design" } },
            confirmDesignDirectoryChange: true,
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("serializes Design transactions, deduplicates retries, and rejects stale revisions", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-command-journal",
      kind: "design",
    });
    try {
      const frameReply = (await svc.handle("design.frame.create", {
        workspaceId: created.workspaceId,
        title: "Journal",
      })) as { frame: { file: string } };
      const foundation = (await svc.handle("design.foundation.open", {
        workspaceId: created.workspaceId,
        frame: frameReply.frame.file,
      })) as { summary: { revision: string } };
      const projection = (await svc.handle("design.projection", {
        workspaceId: created.workspaceId,
        frame: frameReply.frame.file,
        expectedRevision: foundation.summary.revision,
        limit: 1,
      })) as { projection: { nodes: Array<{ id: string }> } };
      const targetNodeId = projection.projection.nodes[0]?.id;
      expect(targetNodeId).toBeTruthy();
      const transaction = {
        schemaVersion: 1,
        transactionId: "transaction-one",
        documentId: `frame:${frameReply.frame.file}`,
        baseRevision: foundation.summary.revision,
        actor: { kind: "human", id: "desktop" },
        intent: "Update the journal frame",
        createdAt: 1,
        operations: [
          {
            operationId: "style-one",
            type: "node.set-styles",
            nodeId: targetNodeId!,
            styles: { gap: "24px" },
            scope: "auto",
            responsiveContext: "base",
            stateContext: "default",
          },
        ],
      };
      const params = {
        workspaceId: created.workspaceId,
        frame: frameReply.frame.file,
        transaction,
      };
      const first = (await svc.handle("design.transaction.apply", params)) as {
        result: { revision: string; receipt: { status: string } };
      };
      const duplicate = (await svc.handle(
        "design.transaction.apply",
        params,
      )) as typeof first;

      expect(first.result.receipt.status).toBe("applied");
      expect(duplicate.result.receipt.status).toBe("duplicate");
      expect(duplicate.result.revision).toBe(first.result.revision);

      const stale = {
        ...transaction,
        transactionId: "transaction-stale",
        baseRevision: foundation.summary.revision,
      };
      const staleParams = {
        workspaceId: created.workspaceId,
        frame: frameReply.frame.file,
        transaction: stale,
      };
      await expect(
        svc.handle("design.transaction.apply", staleParams),
      ).rejects.toMatchObject({ code: "DESIGN_REVISION_CONFLICT" });

      const invalidParams = {
        workspaceId: created.workspaceId,
        frame: frameReply.frame.file,
        transaction: {
          ...transaction,
          transactionId: "transaction-invalid-node",
          baseRevision: first.result.revision,
          operations: [
            {
              operationId: "style-missing-node",
              type: "node.set-styles",
              nodeId: "missing-node",
              styles: { gap: "8px" },
              scope: "inline",
              responsiveContext: "base",
              stateContext: "default",
            },
          ],
        },
      };
      await expect(
        svc.handle("design.transaction.apply", invalidParams),
      ).rejects.toThrow(/Design element not found/i);
      const afterRejected = (await svc.handle("design.foundation.open", {
        workspaceId: created.workspaceId,
        frame: frameReply.frame.file,
      })) as { summary: { revision: string } };
      expect(afterRejected.summary.revision).toBe(first.result.revision);
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("refuses code-side writes into the design directory (territorial fences)", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-fences",
      kind: "design",
    });
    const designDirectory = designDirectoryNameFor(created.path);
    try {
      const designFile = `${designDirectory}/tokens.css`;
      const designGitAction = expect.stringMatching(/stage and commit/i);
      const trackedDesignFile = path.join(
        created.path,
        designDirectory,
        "tracked.txt",
      );
      fs.writeFileSync(trackedDesignFile, "original\n");
      execFileSync("git", ["add", "--", `${designDirectory}/tracked.txt`], {
        cwd: created.path,
      });
      execFileSync("git", ["commit", "-q", "-m", "track design fixture"], {
        cwd: created.path,
      });
      fs.writeFileSync(trackedDesignFile, "edited\n");
      await expect(
        svc.handle("git.reset", {
          workspaceId: created.workspaceId,
          mode: "hard",
          confirm: true,
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringContaining("unsaved design"),
        remediation: designGitAction,
      });
      expect(fs.readFileSync(trackedDesignFile, "utf8")).toBe("edited\n");
      // Staging, hunk-staging, discard, commit-with-files, and the file
      // editor all refuse design paths — design files have ONE write path.
      await expect(
        svc.handle("git.stage", {
          workspaceId: created.workspaceId,
          paths: [designFile],
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        remediation: designGitAction,
      });
      await expect(
        svc.handle("git.discard", {
          workspaceId: created.workspaceId,
          paths: [designFile],
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        remediation: designGitAction,
      });
      await expect(
        svc.handle("git.restore", {
          workspaceId: created.workspaceId,
          paths: [`${designDirectory}/tracked.txt`],
          source: "HEAD",
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        remediation: designGitAction,
      });
      await expect(
        svc.handle("git.unstage", {
          workspaceId: created.workspaceId,
          paths: [designFile],
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        remediation: designGitAction,
      });
      // `--` stops option parsing, not Git pathspec expansion. A magic-looking
      // exact filename must be literalized rather than expanding back onto
      // protected content inside the trusted Git bridge.
      await expect(
        svc.handle("git.discard", {
          workspaceId: created.workspaceId,
          paths: [`:(top)${designDirectory}/tracked.txt`],
        }),
      ).rejects.toMatchObject({ code: "GIT_COMMAND_FAILED" });
      expect(fs.readFileSync(trackedDesignFile, "utf8")).toBe("edited\n");
      await expect(
        svc.handle("git.commit", {
          workspaceId: created.workspaceId,
          message: "mixed",
          files: ["hello.txt", designFile],
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        remediation: designGitAction,
      });
      await expect(
        svc.handle("git.unstageHunk", {
          workspaceId: created.workspaceId,
          patch: `diff --git a/${designFile} b/${designFile}\n--- a/${designFile}\n+++ b/${designFile}\n@@ -1 +1 @@\n-a\n+b\n`,
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        remediation: designGitAction,
      });
      await expect(
        svc.handle("git.stageHunk", {
          workspaceId: created.workspaceId,
          patch: `diff --git a/${designFile} b/${designFile}\n--- a/${designFile}\n+++ b/${designFile}\n@@ -1 +1 @@\n-a\n+b\n`,
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        remediation: designGitAction,
      });
      // `git apply` also accepts traditional patches without a `diff --git`
      // header. An empty best-effort path parse must fail closed instead of
      // handing such a patch to the trusted worktree writer.
      await expect(
        svc.handle("git.discardHunk", {
          workspaceId: created.workspaceId,
          patch:
            `--- a/${designDirectory}/tracked.txt\n` +
            `+++ b/${designDirectory}/tracked.txt\n` +
            "@@ -1 +1 @@\n" +
            "-original\n" +
            "+edited\n",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(fs.readFileSync(trackedDesignFile, "utf8")).toBe("edited\n");
      await expect(
        svc.handle("file.write", {
          workspaceId: created.workspaceId,
          path: designFile,
          content: "/* nope */\n",
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        remediation: designGitAction,
      });
      // A pathless clean is refused while unsaved (untracked) design files
      // exist — it would silently destroy not-yet-saved frames.
      fs.writeFileSync(
        path.join(created.path, designDirectory, "unsaved-frame.html"),
        "<!doctype html><html><body>unsaved</body></html>\n",
      );
      await expect(
        svc.handle("git.clean", {
          workspaceId: created.workspaceId,
          confirm: true,
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringContaining("unsaved design"),
      });
      // Code territory stays fully live: staging code paths works in design
      // mode (concurrent duality — agents keep committing code).
      fs.writeFileSync(path.join(created.path, "hello.txt"), "edited\n");
      await expect(
        svc.handle("git.stage", {
          workspaceId: created.workspaceId,
          paths: ["hello.txt"],
        }),
      ).resolves.toEqual({ ok: true });
    } finally {
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("recognizes renamed, nested, and multiple design folders by marker with nothing primed", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-markers",
      kind: "code",
    });
    try {
      // A code-mode workspace primes nothing: not Design mode, not an agent
      // territory, not a settings change. The guard therefore used to compare
      // against the DEFAULT name, match none of these folders, and allow every
      // write below. Recognition is by marker, so no priming is required.
      const renamed = "designs";
      const nested = "apps/web/canvas";

      // Creating the marker is itself a Design-authority mutation. A generic
      // code editor must not manufacture a new Design document and then keep
      // writing it through the code path.
      await expect(
        svc.handle("file.write", {
          workspaceId: created.workspaceId,
          path: "brand-new-design/.zeros-canvas.json",
          content: "{}\n",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(
        fs.existsSync(
          path.join(created.path, "brand-new-design", ".zeros-canvas.json"),
        ),
      ).toBe(false);

      for (const relative of [renamed, nested]) {
        fs.mkdirSync(path.join(created.path, ...relative.split("/")), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(created.path, ...relative.split("/"), ".zeros-canvas.json"),
          "{}\n",
        );
      }
      fs.writeFileSync(path.join(created.path, renamed, "tokens.css"), "a{}\n");
      const designGitAction = expect.stringMatching(/stage and commit/i);
      for (const designPath of [
        `${renamed}/tokens.css`,
        `${nested}/frame.html`,
        renamed, // the folder itself, not just files inside it
      ]) {
        await expect(
          svc.handle("file.write", {
            workspaceId: created.workspaceId,
            path: designPath,
            content: "nope\n",
          }),
        ).rejects.toMatchObject({
          code: "VALIDATION_FAILED",
          remediation: designGitAction,
        });
        await expect(
          svc.handle("git.stage", {
            workspaceId: created.workspaceId,
            paths: [designPath],
          }),
        ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      }

      // Git treats an exact directory path as its complete subtree. A code
      // actor must not stage a writable ancestor and sweep a nested Design
      // document into the index indirectly.
      await expect(
        svc.handle("git.stage", {
          workspaceId: created.workspaceId,
          paths: ["apps"],
        }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        remediation: designGitAction,
      });

      // A sibling under the same parent as a nested design folder stays
      // writable — recognition is per-folder, never per-ancestor, and the
      // workspace root is deliberately never probed.
      await expect(
        svc.handle("file.write", {
          workspaceId: created.workspaceId,
          path: "apps/web/server.ts",
          content: "export const ok = true;\n",
        }),
      ).resolves.toBeTruthy();

      // The viewer is told, so it renders read-only instead of offering an
      // Edit action the write path is going to refuse.
      await expect(
        svc.handle("file.read", {
          workspaceId: created.workspaceId,
          path: `${renamed}/tokens.css`,
        }),
      ).resolves.toMatchObject({ designPath: true });
      const codeRead = (await svc.handle("file.read", {
        workspaceId: created.workspaceId,
        path: "apps/web/server.ts",
      })) as { designPath?: boolean };
      expect(codeRead.designPath).toBeUndefined();

      // A folder reserved for first use has no marker yet. The primed pointer
      // is unioned in — never intersected — so it is still refused.
      primeDesignDirectoryName(created.path, "reserved-designs");
      await expect(
        svc.handle("file.write", {
          workspaceId: created.workspaceId,
          path: "reserved-designs/document.json",
          content: "nope\n",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

      // HEAD/index recognition remains authoritative while a marker is
      // missing from the worktree (for example an unstaged deletion). The
      // service guard must agree with the ZSR territory resolver here.
      execFileSync("git", ["add", renamed, nested], { cwd: created.path });
      execFileSync("git", ["commit", "-q", "-m", "recognize designs"], {
        cwd: created.path,
      });
      fs.rmSync(path.join(created.path, renamed, ".zeros-canvas.json"));
      await expect(
        svc.handle("file.write", {
          workspaceId: created.workspaceId,
          path: `${renamed}/after-marker-delete.txt`,
          content: "nope\n",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    } finally {
      forgetDesignDirectoryName(created.path);
      await svc.handle("workspace.delete", {
        workspaceId: created.workspaceId,
        includeBranch: true,
      });
    }
  });

  it("fs.listDir browses host directories (folder picker)", async () => {
    fs.mkdirSync(path.join(dir, "alpha"));
    fs.mkdirSync(path.join(dir, "beta"));
    fs.writeFileSync(path.join(dir, "afile.txt"), "x");
    fs.mkdirSync(path.join(dir, ".hidden"));
    const r = (await svc.handle("fs.listDir", { path: dir })) as {
      path: string;
      parent: string | null;
      entries: { name: string; path: string }[];
    };
    const names = r.entries.map((e) => e.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).not.toContain("afile.txt"); // files excluded
    expect(names).not.toContain(".hidden"); // dotfolders hidden
    expect(r.path).toBe(fs.realpathSync(dir));
    expect(r.parent).toBe(path.dirname(fs.realpathSync(dir)));
  });

  it("fs.listDir confines a REMOTE client to the home subtree (M3)", async () => {
    const realHome = fs.realpathSync(os.homedir());
    // A remote client asking for '/' (outside ~) is clamped back to the home dir,
    // and can't walk above it — it must not enumerate the whole host filesystem.
    const r = (await svc.handle(
      "fs.listDir",
      { path: "/" },
      { remote: true },
    )) as { path: string; parent: string | null };
    expect(r.path).toBe(realHome);
    expect(r.parent).toBeNull();

    // The SAME request locally (trusted desktop) is NOT clamped — native-picker
    // parity: it resolves to the real filesystem root it asked for.
    const local = (await svc.handle("fs.listDir", { path: "/" })) as {
      path: string;
    };
    expect(local.path).toBe(fs.realpathSync("/"));
  });

  it("project.upsert/bulkUpsert confine a REMOTE client to the home subtree (mirrors M3/C1)", async () => {
    const { setZerosDbPathForTesting, closeZerosDb } = await import("../../db");
    const { isKnownRepoRoot } = await import("../../db/projects");
    setZerosDbPathForTesting(path.join(dir, "zeros-projects.db"));
    try {
      const outside = fs.realpathSync(dir); // tmpdir lives OUTSIDE ~
      const underHome = path.join(os.homedir(), "zeros-clamp-test-repo");

      // A remote client may NOT register a repo outside ~ — that path would
      // otherwise satisfy isKnownRepoRoot() for a later workspace.create.
      await expect(
        svc.handle("project.upsert", { repoRoot: outside }, { remote: true }),
      ).rejects.toThrow(/home directory/i);
      expect(isKnownRepoRoot(outside)).toBe(false);

      // bulkUpsert is fail-closed: one out-of-bounds entry rejects the WHOLE
      // batch — the in-bounds entry must not land either.
      await expect(
        svc.handle(
          "project.bulkUpsert",
          { projects: [{ repoRoot: underHome }, { repoRoot: outside }] },
          { remote: true },
        ),
      ).rejects.toThrow(/home directory/i);
      expect(isKnownRepoRoot(underHome)).toBe(false);

      // A path UNDER ~ is allowed for a remote client (the picker's normal output).
      const ok = (await svc.handle(
        "project.upsert",
        { repoRoot: underHome },
        { remote: true },
      )) as { ok: boolean };
      expect(ok.ok).toBe(true);
      expect(isKnownRepoRoot(underHome)).toBe(true);

      // The LOCAL desktop is the trusted operator — it may register any path.
      const local = (await svc.handle(
        "project.upsert",
        { repoRoot: outside },
        { remote: false },
      )) as { ok: boolean };
      expect(local.ok).toBe(true);
      expect(isKnownRepoRoot(outside)).toBe(true);
    } finally {
      closeZerosDb();
      setZerosDbPathForTesting(null);
    }
  });

  it("H3: a remote client can't delete/clear a chat in a restricted workspace", async () => {
    // A chat that lives in local-main (the svc root).
    await svc.handle("chats.upsert", { chat: { id: "c1", folder: dir } });
    // Owner restricts local-main from remote.
    await svc.handle("workspace.setRemoteRestricted", {
      workspaceId: LOCAL_MAIN_WORKSPACE_ID,
      restricted: true,
    });

    // Every destructive transcript op is refused for a remote client.
    await expect(
      svc.handle("chats.delete", { id: "c1" }, { remote: true }),
    ).rejects.toThrow(/restricted/i);
    await expect(
      svc.handle("messages.clear", { chatId: "c1" }, { remote: true }),
    ).rejects.toThrow(/restricted/i);
    await expect(
      svc.handle("messages.window", { chatId: "c1" }, { remote: true }),
    ).rejects.toThrow(/restricted/i);
    await expect(
      svc.handle(
        "messages.windowOlder",
        { chatId: "c1", beforeMsgId: "m1" },
        { remote: true },
      ),
    ).rejects.toThrow(/restricted/i);
    await expect(
      svc.handle(
        "messages.truncateFrom",
        { chatId: "c1", fromMsgId: "m1" },
        { remote: true },
      ),
    ).rejects.toThrow(/restricted/i);
    await expect(
      svc.handle(
        "file.read",
        { workspaceId: LOCAL_MAIN_WORKSPACE_ID, path: "hello.txt" },
        { remote: true },
      ),
    ).rejects.toThrow(/restricted/i);
    await expect(
      svc.handle(
        "chats.upsert",
        { chat: { id: "c-hidden", folder: LOCAL_MAIN_WORKSPACE_ID } },
        { remote: true },
      ),
    ).rejects.toThrow(/restricted/i);
    await expect(
      svc.handle(
        "chats.bulkUpsert",
        {
          chats: [
            { id: "c-visible", folder: "web-made" },
            { id: "c-hidden-bulk", folder: LOCAL_MAIN_WORKSPACE_ID },
          ],
        },
        { remote: true },
      ),
    ).rejects.toThrow(/restricted/i);
    await expect(
      svc.handle(
        "chats.upsert",
        {
          chat: {
            id: "c1",
            // A forged visible destination must not let the remote overwrite
            // an existing chat whose authoritative row is restricted.
            folder: "web-made",
            title: "stolen",
          },
        },
        { remote: true },
      ),
    ).rejects.toThrow(/restricted/i);
    await expect(
      svc.handle(
        "chats.bulkUpsert",
        {
          chats: [
            { id: "c-visible", folder: "web-made" },
            { id: "c1", folder: "web-made", title: "stolen in batch" },
          ],
        },
        { remote: true },
      ),
    ).rejects.toThrow(/restricted/i);

    // The owner (local) still manages it freely.
    const del = (await svc.handle("chats.delete", { id: "c1" })) as {
      ok: boolean;
    };
    expect(del.ok).toBe(true);
    const deletedSnapshot = (await svc.handle("chats.list")) as {
      chats: { id: string }[];
      chatDeletions: string[];
    };
    expect(deletedSnapshot.chats.some((chat) => chat.id === "c1")).toBe(false);
    expect(
      deletedSnapshot.chats.some(
        (chat) => chat.id === "c-hidden" || chat.id === "c-visible",
      ),
    ).toBe(false);
    expect(deletedSnapshot.chatDeletions).toContain("c1");

    // A chat in a NON-restricted workspace stays freely deletable remotely.
    await svc.handle("chats.upsert", {
      chat: { id: "c2", folder: "web-made" },
    });
    const r2 = (await svc.handle(
      "chats.delete",
      { id: "c2" },
      { remote: true },
    )) as { ok: boolean };
    expect(r2.ok).toBe(true);
  });

  it("strips host-only fields (additionalDirectories, fast) from a REMOTE chat upsert; local keeps them", async () => {
    // Isolate the unified Zeros DB to a tmpdir so this never touches the real
    // chat list (same seam the project.upsert test uses).
    const { setZerosDbPathForTesting, closeZerosDb } = await import("../../db");
    setZerosDbPathForTesting(path.join(dir, "zeros-hostonly.db"));
    try {
      // Local desktop (trusted operator) creates a chat WITH extra dirs + fast.
      await svc.handle("chats.upsert", {
        chat: {
          id: "hk1",
          folder: dir,
          additionalDirectories: ["/Users/me/work-a", "/Users/me/work-b"],
          fast: true,
        },
      });

      // A remote client tries to WIDEN the agent's filesystem scope + flip fast,
      // while also doing a legit metadata edit (title). The title must stick;
      // the host-only fields must NOT change.
      await svc.handle(
        "chats.upsert",
        {
          chat: {
            id: "hk1",
            folder: dir,
            title: "renamed remotely",
            additionalDirectories: ["/etc", "/Users/victim/.ssh"],
            fast: false,
          },
        },
        { remote: true },
      );

      const after = (await svc.handle("chats.list")) as {
        chats: {
          id: string;
          title: string;
          additionalDirectories: string[];
          fast: boolean;
        }[];
      };
      const c = after.chats.find((x) => x.id === "hk1")!;
      expect(c.title).toBe("renamed remotely"); // remote metadata edit applied
      expect(c.additionalDirectories).toEqual([
        "/Users/me/work-a",
        "/Users/me/work-b",
      ]); // remote cannot widen the host agent's filesystem scope
      expect(c.fast).toBe(true); // remote cannot flip host run mode

      // A brand-new chat created remotely can't SEED these either (no prior
      // row → safe defaults, never the wire values).
      await svc.handle(
        "chats.upsert",
        {
          chat: {
            id: "hk2",
            folder: dir,
            additionalDirectories: ["/etc"],
            fast: true,
          },
        },
        { remote: true },
      );
      // bulkUpsert is gated identically.
      await svc.handle(
        "chats.bulkUpsert",
        {
          chats: [
            {
              id: "hk3",
              folder: dir,
              additionalDirectories: ["/"],
              fast: true,
            },
          ],
        },
        { remote: true },
      );
      const seeded = (await svc.handle("chats.list")) as {
        chats: { id: string; additionalDirectories: string[]; fast: boolean }[];
      };
      for (const id of ["hk2", "hk3"]) {
        const row = seeded.chats.find((x) => x.id === id)!;
        expect(row.additionalDirectories).toEqual([]);
        expect(row.fast).toBe(false);
      }

      // The SAME write from the LOCAL desktop DOES apply (trusted operator).
      await svc.handle("chats.upsert", {
        chat: {
          id: "hk2",
          folder: dir,
          additionalDirectories: ["/work/api"],
          fast: true,
        },
      });
      const local = (await svc.handle("chats.list")) as {
        chats: { id: string; additionalDirectories: string[]; fast: boolean }[];
      };
      const n = local.chats.find((x) => x.id === "hk2")!;
      expect(n.additionalDirectories).toEqual(["/work/api"]);
      expect(n.fast).toBe(true);
    } finally {
      closeZerosDb();
      setZerosDbPathForTesting(null);
    }
  });

  it("preserves a host provider binding when a stale chat upsert omits it", async () => {
    const { setZerosDbPathForTesting, closeZerosDb } = await import("../../db");
    const { updateChatProviderIdentity } = await import("../../db/chats");
    setZerosDbPathForTesting(path.join(dir, "zeros-provider-binding.db"));
    try {
      await svc.handle("chats.upsert", {
        chat: {
          id: "provider-owned",
          folder: dir,
          agentId: "codex",
          title: "Local title",
          sessionId: "dead-execution-must-not-win",
          providerBinding: {
            version: 1,
            providerId: "codex",
            kind: "native",
            resumeId: "codex-thread-1",
            scopeId: "codex-root-1",
          },
          providerMetadata: {
            version: 1,
            git: { sha: "abc123", branch: "main", originUrl: null },
          },
        },
      });

      // A protocol-v8 peer predating providerBinding still echoes sessionId.
      // Its metadata edit may apply, but it cannot erase the host's durable
      // provider identity or replace the compatibility locator with a route.
      await svc.handle(
        "chats.bulkUpsert",
        {
          chats: [
            {
              id: "provider-owned",
              folder: dir,
              agentId: "codex",
              title: "Remote title",
              sessionId: "stale-remote-execution",
            },
          ],
        },
        { remote: true },
      );

      const result = (await svc.handle("chats.list")) as {
        chats: Array<{
          id: string;
          title: string;
          archived: boolean;
          sessionId: string | null;
          providerBinding?: {
            providerId: string;
            resumeId: string;
            scopeId?: string;
          } | null;
          providerMetadata?: {
            git?: { sha: string | null; branch: string | null };
          } | null;
        }>;
      };
      expect(
        result.chats.find((chat) => chat.id === "provider-owned"),
      ).toMatchObject({
        title: "Remote title",
        sessionId: "codex-thread-1",
        providerBinding: {
          providerId: "codex",
          resumeId: "codex-thread-1",
          scopeId: "codex-root-1",
        },
        providerMetadata: {
          git: { sha: "abc123", branch: "main" },
        },
      });

      // The desktop's archive write can race a provider_binding_update learned
      // directly by the engine. It is trusted, but its pre-event ChatThread is
      // still stale; same-agent omission must preserve the newer DB identity.
      await svc.handle("chats.bulkUpsert", {
        chats: [
          {
            id: "provider-owned",
            folder: dir,
            agentId: "codex",
            title: "Archived locally",
            archived: true,
            providerBinding: null,
            providerMetadata: null,
          },
        ],
      });
      const afterLocal = (await svc.handle("chats.list")) as typeof result;
      expect(
        afterLocal.chats.find((chat) => chat.id === "provider-owned"),
      ).toMatchObject({
        title: "Archived locally",
        archived: true,
        sessionId: "codex-thread-1",
        providerBinding: {
          providerId: "codex",
          resumeId: "codex-thread-1",
        },
      });

      // The engine may refine a legacy/older binding to a native provider
      // handle immediately before the renderer archives the tab. A stale
      // non-null renderer snapshot is no more authoritative than an omitted
      // binding and must not roll SQLite back to the dead provider thread.
      updateChatProviderIdentity(
        "provider-owned",
        "codex",
        {
          version: 1,
          providerId: "codex",
          kind: "native",
          resumeId: "codex-thread-2",
          scopeId: "codex-root-2",
        },
        {
          version: 1,
          git: { sha: "def456", branch: "feature", originUrl: null },
        },
      );
      await svc.handle("chats.bulkUpsert", {
        chats: [
          {
            id: "provider-owned",
            folder: dir,
            agentId: "codex",
            title: "Stale local snapshot",
            providerBinding: {
              version: 1,
              providerId: "codex",
              kind: "native",
              resumeId: "codex-thread-1",
              scopeId: "codex-root-1",
            },
            providerMetadata: {
              version: 1,
              git: { sha: "abc123", branch: "main", originUrl: null },
            },
          },
        ],
      });
      const afterStaleBinding = (await svc.handle(
        "chats.list",
      )) as typeof result;
      expect(
        afterStaleBinding.chats.find((chat) => chat.id === "provider-owned"),
      ).toMatchObject({
        title: "Stale local snapshot",
        sessionId: "codex-thread-2",
        providerBinding: {
          providerId: "codex",
          resumeId: "codex-thread-2",
          scopeId: "codex-root-2",
        },
        providerMetadata: {
          git: { sha: "def456", branch: "feature" },
        },
      });

      // Changing provider is the explicit clear boundary; a Codex binding must
      // never leak into Claude merely because the incoming row omitted one.
      await svc.handle("chats.upsert", {
        chat: {
          id: "provider-owned",
          folder: dir,
          agentId: "claude",
          title: "Switched provider",
        },
      });
      const switched = (await svc.handle("chats.list")) as typeof result;
      expect(
        switched.chats.find((chat) => chat.id === "provider-owned"),
      ).toMatchObject({
        title: "Switched provider",
        providerBinding: null,
        providerMetadata: null,
      });
    } finally {
      closeZerosDb();
      setZerosDbPathForTesting(null);
    }
  });

  it("clears provider identity only through an explicit compare-and-clear operation", async () => {
    const { setZerosDbPathForTesting, closeZerosDb } = await import("../../db");
    setZerosDbPathForTesting(path.join(dir, "zeros-provider-clear.db"));
    try {
      expect(svc.isRemoteAllowed("chats.clearProviderIdentity")).toBe(false);
      await svc.handle("chats.upsert", {
        chat: {
          id: "provider-clear",
          folder: dir,
          agentId: "codex",
          title: "Bound",
          providerBinding: {
            version: 1,
            providerId: "codex",
            kind: "native",
            resumeId: "thread-to-clear",
          },
          providerMetadata: { version: 1 },
        },
      });

      // A stale reset naming the wrong binding must not erase a newer one.
      await svc.handle("chats.clearProviderIdentity", {
        chatId: "provider-clear",
        agentId: "codex",
        resumeId: "older-thread",
      });
      let result = (await svc.handle("chats.list")) as {
        chats: Array<{
          id: string;
          sessionId: string | null;
          providerBinding?: { resumeId: string } | null;
          providerMetadata?: { version: number } | null;
        }>;
      };
      expect(
        result.chats.find((chat) => chat.id === "provider-clear")
          ?.providerBinding?.resumeId,
      ).toBe("thread-to-clear");

      await svc.handle("chats.clearProviderIdentity", {
        chatId: "provider-clear",
        agentId: "codex",
        resumeId: "thread-to-clear",
      });
      result = (await svc.handle("chats.list")) as typeof result;
      expect(
        result.chats.find((chat) => chat.id === "provider-clear"),
      ).toMatchObject({
        sessionId: null,
        providerBinding: null,
        providerMetadata: null,
      });
    } finally {
      closeZerosDb();
      setZerosDbPathForTesting(null);
    }
  });

  it("workspaceIdForCwd canonicalizes an id OR a real path to a workspace id", () => {
    // The primary checkout's real PATH (what the desktop + a remote client with
    // relaxed redaction send as cwd) resolves to the synthetic local-main id —
    // the fix for the registry storing a raw path that never matched the
    // restricted-id set and fail-closing a valid-path cwd.
    expect(svc.workspaceIdForCwd(dir)).toBe(LOCAL_MAIN_WORKSPACE_ID);
    // An id passes through.
    expect(svc.workspaceIdForCwd(LOCAL_MAIN_WORKSPACE_ID)).toBe(
      LOCAL_MAIN_WORKSPACE_ID,
    );
    // A subdir of the primary checkout still maps to it.
    expect(svc.workspaceIdForCwd(`${dir}/src`)).toBe(LOCAL_MAIN_WORKSPACE_ID);
    // An unmanaged folder, an unknown id, and empty all → null.
    expect(svc.workspaceIdForCwd("/nope/zzz/qqq")).toBeNull();
    expect(svc.workspaceIdForCwd("not-a-real-id")).toBeNull();
    expect(svc.workspaceIdForCwd(undefined)).toBeNull();
  });

  it("workspaceIdForCwd chooses a more-specific managed owner below the engine root", () => {
    const nestedPath = path.join(dir, "nested-workspace");
    fs.mkdirSync(nestedPath, { recursive: true });
    const now = Date.now();
    insertWorkspace({
      id: "ws_nested-owner",
      repoSlug: "nested",
      repoRoot: dir,
      branch: "zeros/nested-owner",
      baseBranch: "main",
      path: nestedPath,
      status: "in-progress",
      createdAt: now,
      archivedAt: null,
      stashRef: null,
      prNumber: null,
      prState: null,
      prUrl: null,
      agentId: null,
      lastActiveAt: now,
      setupState: null,
    } satisfies Workspace);

    expect(svc.workspaceIdForCwd(path.join(nestedPath, "src"))).toBe(
      "ws_nested-owner",
    );
    expect(svc.workspaceIdForCwd(path.join(dir, "ordinary-subdir"))).toBe(
      LOCAL_MAIN_WORKSPACE_ID,
    );
  });

  it("admits target-branch changes through the shared Git mutation lane", async () => {
    const workspaceId = "ws_change-target-lane";
    const now = Date.now();
    insertWorkspace({
      id: workspaceId,
      repoSlug: "change-target-lane",
      repoRoot: dir,
      branch: "main",
      baseBranch: "main",
      path: dir,
      status: "in-progress",
      createdAt: now,
      archivedAt: null,
      stashRef: null,
      prNumber: null,
      prState: null,
      prUrl: null,
      agentId: null,
      lastActiveAt: now,
      setupState: null,
    } satisfies Workspace);

    let release!: () => void;
    let entered!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = withWorkspaceGitMutation(dir, async () => {
      entered();
      await blocker;
    });
    await admitted;

    let settled = false;
    const changing = svc
      .handle("git.changeTarget", {
        workspaceId,
        newTarget: "release",
        rebase: false,
      })
      .finally(() => {
        settled = true;
      });
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(settled).toBe(false);
    } finally {
      release();
      await held;
      await changing.catch(() => undefined);
    }
    await expect(changing).resolves.toMatchObject({ baseBranch: "release" });
  });

  it("reads a file under local-main", async () => {
    const r = (await svc.handle("file.read", {
      workspaceId: LOCAL_MAIN_WORKSPACE_ID,
      path: "hello.txt",
    })) as { kind: string; content?: string };
    expect(r.kind).toBe("text");
    expect(r.content).toBe("hi there");
  });

  it("treats local-main file and Git writes as code authority around Design markers", async () => {
    const design = path.join(dir, "Product Design");
    fs.mkdirSync(design, { recursive: true });
    fs.writeFileSync(path.join(design, ".zeros-canvas.json"), "{}\n");
    fs.writeFileSync(path.join(design, "tokens.css"), "a{}\n");

    await expect(
      svc.handle("file.write", {
        workspaceId: LOCAL_MAIN_WORKSPACE_ID,
        path: "Product Design/tokens.css",
        content: "nope\n",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      svc.handle("git.stage", {
        workspaceId: LOCAL_MAIN_WORKSPACE_ID,
        paths: ["Product Design/tokens.css"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      svc.handle("git.clean", {
        workspaceId: LOCAL_MAIN_WORKSPACE_ID,
        confirm: true,
        directories: true,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("unsaved design"),
    });
  });

  it("keeps ordinary local-main Git path mutations available", async () => {
    execFileSync("git", ["config", "user.email", "test@zeros.local"], {
      cwd: dir,
    });
    execFileSync("git", ["config", "user.name", "Zeros Test"], { cwd: dir });
    execFileSync("git", ["add", "hello.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });

    fs.writeFileSync(path.join(dir, "hello.txt"), "changed\n");
    await expect(
      svc.handle("git.stage", {
        workspaceId: LOCAL_MAIN_WORKSPACE_ID,
        paths: ["hello.txt"],
      }),
    ).resolves.toEqual({ ok: true });
    expect(
      execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: dir,
        encoding: "utf8",
      }).trim(),
    ).toBe("hello.txt");

    await expect(
      svc.handle("git.unstage", {
        workspaceId: LOCAL_MAIN_WORKSPACE_ID,
        paths: ["hello.txt"],
      }),
    ).resolves.toEqual({ ok: true });
    expect(
      execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: dir,
        encoding: "utf8",
      }).trim(),
    ).toBe("");

    await expect(
      svc.handle("git.restore", {
        workspaceId: LOCAL_MAIN_WORKSPACE_ID,
        paths: ["hello.txt"],
        source: "HEAD",
      }),
    ).resolves.toEqual({ ok: true });
    expect(fs.readFileSync(path.join(dir, "hello.txt"), "utf8")).toBe(
      "hi there",
    );

    fs.writeFileSync(path.join(dir, "ordinary-untracked.txt"), "remove me\n");
    await expect(
      svc.handle("git.clean", {
        workspaceId: LOCAL_MAIN_WORKSPACE_ID,
        paths: ["ordinary-untracked.txt"],
        confirm: true,
      }),
    ).resolves.toEqual({ removed: ["ordinary-untracked.txt"] });
    expect(fs.existsSync(path.join(dir, "ordinary-untracked.txt"))).toBe(false);
  });

  it("refuses to read outside the workspace (no client path escape)", async () => {
    const r = (await svc.handle("file.read", {
      workspaceId: LOCAL_MAIN_WORKSPACE_ID,
      path: "../escape.txt",
    })) as { kind: string };
    expect(r.kind).toBe("error");
  });

  it("lists the file tree under local-main", async () => {
    const r = (await svc.handle("file.tree", {
      workspaceId: LOCAL_MAIN_WORKSPACE_ID,
    })) as {
      files: string[];
    };
    expect(Array.isArray(r.files)).toBe(true);
    expect(r.files).toContain("hello.txt");
  });

  it("blocks a REMOTE client from reading secret files (.env), allows local", async () => {
    fs.writeFileSync(path.join(dir, ".env"), "SECRET=hunter2", "utf-8");
    // Remote: denied with VALIDATION_FAILED — never returns the contents.
    await expect(
      svc.handle(
        "file.read",
        { workspaceId: LOCAL_MAIN_WORKSPACE_ID, path: ".env" },
        { remote: true },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // Local (the user's own machine): full access via the Files tab path.
    const local = (await svc.handle("file.read", {
      workspaceId: LOCAL_MAIN_WORKSPACE_ID,
      path: ".env",
    })) as { kind: string; content?: string };
    expect(local.content).toBe("SECRET=hunter2");
  });

  it("blocks a collapsing-path bypass of the secret guard ('.env/.')", async () => {
    fs.writeFileSync(path.join(dir, ".env"), "SECRET=z", "utf-8");
    await expect(
      svc.handle(
        "file.read",
        { workspaceId: LOCAL_MAIN_WORKSPACE_ID, path: ".env/." },
        { remote: true },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("blocks an innocuously-named symlink that points at a secret (remote)", async () => {
    fs.writeFileSync(path.join(dir, ".env"), "API_KEY=sk-leak", "utf-8");
    try {
      fs.symlinkSync(path.join(dir, ".env"), path.join(dir, "notes.txt"));
    } catch {
      return; // platform without symlink perms — skip
    }
    // Remote: the realpath gate refuses despite the innocuous name.
    const remote = (await svc.handle(
      "file.read",
      { workspaceId: LOCAL_MAIN_WORKSPACE_ID, path: "notes.txt" },
      { remote: true },
    )) as { kind: string; content?: string; error?: string };
    expect(remote.kind).toBe("error");
    expect(remote.content).toBeUndefined();
    // Local: full access (the user's own machine).
    const local = (await svc.handle("file.read", {
      workspaceId: LOCAL_MAIN_WORKSPACE_ID,
      path: "notes.txt",
    })) as { kind: string; content?: string };
    expect(local.content).toBe("API_KEY=sk-leak");
  });

  it("refuses a remote git.diff of a secret file before diffing", async () => {
    await expect(
      svc.handle(
        "git.diff",
        { workspaceId: LOCAL_MAIN_WORKSPACE_ID, filePath: ".env" },
        { remote: true },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // Also via a collapsing path.
    await expect(
      svc.handle(
        "git.diff",
        { workspaceId: LOCAL_MAIN_WORKSPACE_ID, filePath: "id_rsa/." },
        { remote: true },
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("allows a remote client to read a public .env.example", async () => {
    fs.writeFileSync(path.join(dir, ".env.example"), "SECRET=", "utf-8");
    const r = (await svc.handle(
      "file.read",
      { workspaceId: LOCAL_MAIN_WORKSPACE_ID, path: ".env.example" },
      { remote: true },
    )) as { kind: string };
    expect(r.kind).toBe("text");
  });

  it("filters secret files out of the tree for a remote client only", async () => {
    fs.writeFileSync(path.join(dir, "id_rsa"), "-----BEGIN-----", "utf-8");
    const remote = (await svc.handle(
      "file.tree",
      { workspaceId: LOCAL_MAIN_WORKSPACE_ID },
      { remote: true },
    )) as { files: string[] };
    expect(remote.files).not.toContain("id_rsa");
    expect(remote.files).toContain("hello.txt");
    const local = (await svc.handle("file.tree", {
      workspaceId: LOCAL_MAIN_WORKSPACE_ID,
    })) as { files: string[] };
    expect(local.files).toContain("id_rsa"); // local keeps full visibility
  });

  it("filters secret paths out of git.status for a remote client only", async () => {
    // git.status resolves a real worktree via the state DB, so register one.
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://example.com/r.git"],
      { cwd: dir },
    );
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const ws = await createWorkspace({ repoRoot: dir });
    // Untracked files in the worktree — one secret, one ordinary.
    fs.writeFileSync(path.join(ws.path, ".env"), "SECRET=x", "utf-8");
    fs.writeFileSync(path.join(ws.path, "note.txt"), "ok", "utf-8");

    const remote = (await svc.handle(
      "git.status",
      { workspaceId: ws.workspaceId },
      { remote: true },
    )) as {
      untracked: string[];
    };
    expect(remote.untracked).toContain("note.txt");
    expect(remote.untracked).not.toContain(".env"); // secret path hidden from remote

    const local = (await svc.handle("git.status", {
      workspaceId: ws.workspaceId,
    })) as { untracked: string[] };
    expect(local.untracked).toContain(".env"); // local desktop keeps full visibility

    const remoteCounts = (await svc.handle(
      "git.changeCounts",
      { workspaceId: ws.workspaceId },
      { remote: true },
    )) as {
      all: number;
      uncommitted: number;
      staged: number;
      unstaged: number;
    };
    expect(remoteCounts).toEqual({
      all: 1,
      uncommitted: 1,
      staged: 0,
      unstaged: 1,
    });
    const localCounts = (await svc.handle("git.changeCounts", {
      workspaceId: ws.workspaceId,
    })) as { all: number };
    expect(localCounts.all).toBe(2);

    // The ± pair has to describe the same rows: a remote client counts
    // note.txt's one line only, never the secret's.
    const remoteLines = (await svc.handle(
      "git.changeLineCounts",
      { workspaceId: ws.workspaceId },
      { remote: true },
    )) as { additions: number; deletions: number };
    expect(remoteLines).toEqual({ additions: 1, deletions: 0 });
    const localLines = (await svc.handle("git.changeLineCounts", {
      workspaceId: ws.workspaceId,
    })) as { additions: number; deletions: number };
    expect(localLines).toEqual({ additions: 2, deletions: 0 });
  });

  it("git.discard (a restriction-gated WRITE op) restores a modified tracked file", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://example.com/r.git"],
      { cwd: dir },
    );
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const ws = await createWorkspace({ repoRoot: dir });
    // Commit a tracked file in the worktree, then dirty it.
    const f = path.join(ws.path, "tracked.txt");
    fs.writeFileSync(f, "original\n", "utf-8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: ws.path });
    execFileSync("git", ["commit", "-q", "-m", "add tracked"], {
      cwd: ws.path,
    });
    fs.writeFileSync(f, "edited\n", "utf-8");
    expect(fs.readFileSync(f, "utf-8")).toBe("edited\n");

    // Newly-exposed over the bridge — must be a WRITE op (remote = restriction-gated).
    expect(svc.isWriteOp("git.discard")).toBe(true);
    const r = (await svc.handle("git.discard", {
      workspaceId: ws.workspaceId,
      paths: ["tracked.txt"],
    })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(f, "utf-8")).toBe("original\n"); // restored
  });

  it("filters secret files out of git.show for a remote client only", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://example.com/r.git"],
      { cwd: dir },
    );
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const ws = await createWorkspace({ repoRoot: dir });
    // A commit IN the worktree touching a secret file + an ordinary one.
    fs.writeFileSync(path.join(ws.path, ".env"), "SECRET=show", "utf-8");
    fs.writeFileSync(path.join(ws.path, "note.txt"), "hello", "utf-8");
    execFileSync("git", ["add", "."], { cwd: ws.path });
    execFileSync("git", ["commit", "-q", "-m", "add files"], { cwd: ws.path });
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws.path })
      .toString()
      .trim();

    const remote = (await svc.handle(
      "git.show",
      { workspaceId: ws.workspaceId, sha },
      { remote: true },
    )) as { files: { path: string }[]; patch: string };
    expect(remote.files.map((f) => f.path)).toContain("note.txt");
    expect(remote.files.map((f) => f.path)).not.toContain(".env");
    expect(remote.patch).toContain("note.txt");
    expect(remote.patch).not.toContain(".env"); // secret path never leaks
    expect(remote.patch).not.toContain("SECRET=show"); // secret CONTENT never leaks

    const local = (await svc.handle("git.show", {
      workspaceId: ws.workspaceId,
      sha,
    })) as { files: { path: string }[] };
    expect(local.files.map((f) => f.path)).toContain(".env"); // local keeps full visibility
  });

  it("filters secret files out of a remote rawPatch (mode:base) git.diff", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://example.com/r.git"],
      { cwd: dir },
    );
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const ws = await createWorkspace({ repoRoot: dir });
    // A commit AHEAD of the base branch touching a secret + an ordinary file —
    // mode:"base" (baseBranch...HEAD) includes it.
    fs.writeFileSync(path.join(ws.path, ".env"), "SECRET=diff", "utf-8");
    fs.writeFileSync(path.join(ws.path, "note.txt"), "hello", "utf-8");
    execFileSync("git", ["add", "."], { cwd: ws.path });
    execFileSync("git", ["commit", "-q", "-m", "add files"], { cwd: ws.path });

    const remote = (await svc.handle(
      "git.diff",
      { workspaceId: ws.workspaceId, mode: "base", rawPatch: true },
      { remote: true },
    )) as { hunks: { filePath: string }[]; patch?: string };
    const patch = remote.patch ?? "";
    expect(patch).toContain("note.txt");
    expect(patch).not.toContain(".env"); // secret path never leaks in the raw patch
    expect(patch).not.toContain("SECRET=diff"); // secret CONTENT never leaks
    expect(remote.hunks.map((h) => h.filePath)).not.toContain(".env");
  });

  it("classifies read vs write ops (incl. GitHub PR mutations)", () => {
    expect(svc.isWriteOp("git.commit")).toBe(true);
    expect(svc.isWriteOp("git.push")).toBe(true);
    expect(svc.isWriteOp("git.checkoutBranch")).toBe(true);
    expect(svc.isWriteOp("git.status")).toBe(false);
    expect(svc.isWriteOp("file.read")).toBe(false);
    // GitHub PR mutations are restriction-gated for remote clients; PR reads are not.
    expect(svc.isWriteOp("gh.prCreate")).toBe(true);
    expect(svc.isWriteOp("gh.prMerge")).toBe(true);
    expect(svc.isWriteOp("gh.prComment")).toBe(true);
    expect(svc.isWriteOp("gh.prGet")).toBe(false);
    expect(svc.isWriteOp("gh.authStatus")).toBe(false);
  });

  it("returns exact Design snapshots while save stays uncommitted and stage stays explicit", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    const designDirectory = firstUseDesignDirectoryNameForRepo(dir);
    fs.writeFileSync(path.join(dir, ".gitignore"), `${designDirectory}/\n`);
    execFileSync("git", ["add", "hello.txt", ".gitignore"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const workspace = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-service-test",
      kind: "design",
    });
    const protocolCapability = "d".repeat(64);
    svc.setDesignProtocolCapabilityProvider(() => protocolCapability);
    await expect(
      svc.handle("design.frame.create", {
        workspaceId: workspace.workspaceId,
        x: 90,
        y: 120,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const createdReply = (await svc.handle("design.frame.create", {
      workspaceId: workspace.workspaceId,
      title: "Checkout",
      x: 90,
      y: 120,
      w: 720,
      h: 480,
      z: 4,
    })) as {
      frame: {
        file: string;
        x: number;
        y: number;
        width: number;
        height: number;
        z: number;
        nodeCount: number;
      };
      snapshot: {
        protocolCapability: string | null;
        frames: Array<{ file: string }>;
      };
    };
    expect(createdReply.snapshot.protocolCapability).toBe(protocolCapability);
    expect(createdReply.snapshot.frames.map((frame) => frame.file)).toContain(
      createdReply.frame.file,
    );
    expect(createdReply.frame).toMatchObject({
      x: 90,
      y: 120,
      width: 720,
      height: 480,
      z: 4,
      nodeCount: 1,
    });
    expect(
      fs.readFileSync(
        path.join(workspace.path, designDirectory, createdReply.frame.file),
        "utf8",
      ),
    ).toMatch(/<main\b[^>]*>\s*<\/main>/);
    const textReply = (await svc.handle("design.frame.create", {
      workspaceId: workspace.workspaceId,
      title: "Loose text",
      kind: "text",
      textNodeId: "text-service-1",
      text: "Type immediately",
      textFixedSize: false,
      x: 40,
      y: 60,
      w: 160,
      h: 28,
      z: 5,
    })) as {
      frame: { file: string; kind: string; nodeCount: number };
    };
    expect(textReply.frame).toMatchObject({ kind: "text", nodeCount: 1 });
    expect(
      fs.readFileSync(
        path.join(workspace.path, designDirectory, textReply.frame.file),
        "utf8",
      ),
    ).toContain('data-oid="text-service-1"');
    const renamedReply = (await svc.handle("design.frame.rename", {
      workspaceId: workspace.workspaceId,
      frame: createdReply.frame.file,
      title: "Checkout flow",
    })) as {
      snapshot: { frames: Array<{ file: string; title: string }> };
    };
    expect(
      renamedReply.snapshot.frames.find(
        (frame) => frame.file === createdReply.frame.file,
      )?.title,
    ).toBe("Checkout flow");
    type DesignTreeNode = {
      tag: string;
      oid: string | null;
      children: DesignTreeNode[];
    };
    const before = (await svc.handle("design.snapshot", {
      workspaceId: workspace.workspaceId,
    })) as {
      snapshot: {
        protocolCapability: string | null;
        frames: Array<{
          file: string;
          sourceVersion: string;
        }>;
      };
    };
    expect(before.snapshot.protocolCapability).toBe(protocolCapability);
    const frame = before.snapshot.frames[0]!;
    expect(frame).not.toHaveProperty("tree");
    const hydrated = (await svc.handle("design.frame", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
    })) as { frame: { sourceVersion: string; tree: DesignTreeNode[] } };
    expect(hydrated.frame.sourceVersion).toBe(frame.sourceVersion);
    expect(hydrated.frame.tree.map((node) => node.tag)).toEqual(["main"]);
    const main = hydrated.frame.tree.find((node) => node.tag === "main");
    expect(main?.oid).toMatch(/^f-.+-main$/);

    const canvasReply = (await svc.handle("design.canvas.update", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
      x: 48.25,
      y: 64.5,
      w: 1_280.75,
      h: 800.125,
      z: 0.4,
    })) as {
      geometry: { x: number; y: number; w: number; h: number; z: number };
    };
    expect(canvasReply.geometry).toEqual({
      x: 48.25,
      y: 64.5,
      w: 1_280.75,
      h: 800.125,
      z: 0,
    });
    const afterCanvasFoundation = (await svc.handle("design.foundation.open", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
    })) as { summary: { history: { canUndo: boolean; undoDepth: number } } };
    expect(afterCanvasFoundation.summary.history.canUndo).toBe(true);
    expect(afterCanvasFoundation.summary.history.undoDepth).toBe(1);

    // Concurrent duality: generic workspace machinery keeps working in
    // design mode (agents/terminals live in code territory) — only the
    // sparse-checkout picker stays blocked, since hiding folders could
    // remove the design directory from disk under the open canvas.
    await expect(
      svc.handle("context.graph.scaffold", {
        workspaceId: workspace.workspaceId,
      }),
    ).resolves.toMatchObject({ ok: true, created: false });
    await expect(
      svc.handle("workspace.setWorkingDirectories", {
        workspaceId: workspace.workspaceId,
        directories: [],
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/design mode/i),
    });

    const tokenSnapshot = (await svc.handle("design.snapshot", {
      workspaceId: workspace.workspaceId,
    })) as {
      snapshot: {
        protocolCapability: string | null;
        tokenSourceVersion: string;
        tokens: Array<{ name: string; value: string }>;
        frames: Array<{ file: string; sourceVersion: string }>;
      };
    };
    const tokenReply = (await svc.handle("design.token.update", {
      workspaceId: workspace.workspaceId,
      name: "--accent",
      theme: null,
      value: "royalblue",
      sourceVersion: tokenSnapshot.snapshot.tokenSourceVersion,
    })) as {
      mutation: { changed: boolean };
      snapshot: {
        protocolCapability: string | null;
        tokenSourceVersion: string;
        tokens: Array<{ name: string; value: string }>;
        frames: Array<{ file: string; sourceVersion: string }>;
      };
    };
    expect(tokenReply.mutation.changed).toBe(true);
    expect(tokenReply.snapshot.protocolCapability).toBe(protocolCapability);
    expect(tokenReply.snapshot.tokenSourceVersion).not.toBe(
      tokenSnapshot.snapshot.tokenSourceVersion,
    );

    await expect(
      svc.handle(
        "design.snapshot",
        { workspaceId: workspace.workspaceId },
        { remote: true },
      ),
    ).rejects.toMatchObject({ code: "REMOTE_RESTRICTED" });
    expect(
      tokenReply.snapshot.tokens.find((token) => token.name === "--accent")
        ?.value,
    ).toBe("royalblue");
    const afterTokenFoundation = (await svc.handle("design.foundation.open", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
    })) as { summary: { history: { undoDepth: number } } };
    expect(afterTokenFoundation.summary.history.undoDepth).toBe(2);
    const tokenFrame = tokenReply.snapshot.frames.find(
      (candidate) => candidate.file === frame.file,
    )!;
    const assetDirectory = path.join(workspace.path, designDirectory, "assets");
    fs.mkdirSync(assetDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(assetDirectory, "mark.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const assetReply = (await svc.handle("design.asset.insert", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
      sourceVersion: tokenFrame.sourceVersion,
      assetPath: "assets/mark.png",
      x: 24,
      y: 32,
    })) as {
      mutation: { frame: { source: string; sourceVersion: string } };
      snapshot: { frames: Array<{ file: string; sourceVersion: string }> };
    };
    expect(assetReply.mutation.frame.source).toContain(
      'src="./assets/mark.png"',
    );
    const afterAssetFoundation = (await svc.handle("design.foundation.open", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
    })) as { summary: { history: { undoDepth: number } } };
    expect(afterAssetFoundation.summary.history.undoDepth).toBe(3);
    const refreshedFrame = assetReply.snapshot.frames.find(
      (candidate) => candidate.file === frame.file,
    )!;

    const response = (await svc.handle("design.node.styles", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
      nodeId: main!.oid!,
      sourceVersion: refreshedFrame.sourceVersion,
      styles: { padding: "36px" },
    })) as {
      mutation: { frame: { source: string; sourceVersion: string } };
      snapshot: { frames: Array<{ sourceVersion: string }> };
      foundationRevision: { before: string; after: string };
    };
    expect(response.mutation.frame.source).toContain("padding:36px;");
    expect(response.snapshot.frames[0]?.sourceVersion).toBe(
      response.mutation.frame.sourceVersion,
    );

    const foundation = (await svc.handle("design.foundation.open", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
    })) as {
      summary: { documentId: string; revision: string; valid: boolean };
      foundation: { manifest: { schemaVersion: number } };
    };
    expect(foundation.summary).toMatchObject({
      documentId: `frame:${frame.file}`,
      valid: true,
    });
    expect(response.foundationRevision).toEqual({
      before: expect.stringMatching(/^[a-f0-9]{24}$/),
      after: foundation.summary.revision,
    });
    expect(response.foundationRevision.after).not.toBe(
      response.foundationRevision.before,
    );
    expect(foundation.foundation.manifest.schemaVersion).toBe(1);
    const projection = (await svc.handle("design.projection", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
      expectedRevision: foundation.summary.revision,
      limit: 2,
    })) as {
      projection: { nodes: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(projection.projection.nodes[0]?.id).toBe(main!.oid);

    const transactionReply = (await svc.handle("design.transaction.apply", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
      transaction: {
        schemaVersion: 1,
        transactionId: "service-headless-style",
        documentId: foundation.summary.documentId,
        baseRevision: foundation.summary.revision,
        actor: { kind: "human", id: "desktop-test" },
        intent: "Adjust the frame gap",
        createdAt: Date.now(),
        operations: [
          {
            operationId: "set-gap",
            type: "node.set-styles",
            nodeId: main!.oid,
            styles: { gap: "20px" },
            scope: "auto",
            responsiveContext: "base",
            stateContext: "default",
          },
        ],
      },
    })) as {
      result: { revision: string; receipt: { status: string } };
      snapshot: { frames: Array<Record<string, unknown>> };
    };
    expect(transactionReply.result.receipt.status).toBe("applied");
    expect(transactionReply.snapshot.frames[0]).not.toHaveProperty("source");
    const authored = (await svc.handle("design.source", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
      file: frame.file,
      expectedRevision: transactionReply.result.revision,
    })) as { source: { source: string } };
    expect(authored.source.source).toContain("gap:20px");
    const provenance = (await svc.handle("design.provenance", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
      nodeId: main!.oid,
      property: "gap",
      expectedRevision: transactionReply.result.revision,
      computedValue: "20px",
      matched: [
        {
          property: "gap",
          value: "20px",
          inherited: false,
          active: true,
        },
      ],
    })) as { provenance: { origin: string; winner: { file: string } | null } };
    expect(provenance.provenance).toMatchObject({
      origin: "inline",
      winner: { file: frame.file },
    });
    const undoReply = (await svc.handle("design.history.undo", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
    })) as {
      result: { receipt: { status: string } };
      snapshot: { frames: Array<{ file: string; kind?: string }> };
    };
    expect(undoReply.result.receipt.status).toBe("applied");
    expect(undoReply.snapshot.frames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: frame.file }),
        expect.objectContaining({ file: textReply.frame.file, kind: "text" }),
      ]),
    );

    const selectedAt = Date.now();
    await svc.handle("design.selection.set", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
      sourceVersion: response.mutation.frame.sourceVersion,
      selectionVersion: selectedAt * 1_024,
      updatedAt: selectedAt,
      nodeIds: [main!.oid!],
      breadcrumb: ["main"],
      rects: [{ x: 0, y: 0, width: 100, height: 100 }],
      keyComputedStyles: {},
    });
    expect(getDesignSelection(workspace.workspaceId)?.updatedAt).toBe(
      selectedAt,
    );

    const deepBreadcrumb = Array.from(
      { length: 24 },
      (_, index) => `layer-${index + 1}`,
    );
    await svc.handle("design.selection.set", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
      sourceVersion: response.mutation.frame.sourceVersion,
      selectionVersion: selectedAt * 1_024 + 1,
      updatedAt: selectedAt + 1,
      nodeIds: [main!.oid!],
      breadcrumb: deepBreadcrumb,
      rects: [{ x: 0, y: 0, width: 100, height: 100 }],
      keyComputedStyles: {},
    });
    expect(getDesignSelection(workspace.workspaceId)?.breadcrumb).toEqual(
      deepBreadcrumb.slice(-16),
    );

    const groupSize = DESIGN_SELECTION_NODE_LIMIT;
    await svc.handle("design.selection.set", {
      workspaceId: workspace.workspaceId,
      frame: frame.file,
      sourceVersion: response.mutation.frame.sourceVersion,
      selectionVersion: selectedAt * 1_024 + 2,
      updatedAt: selectedAt + 2,
      nodeIds: Array.from({ length: groupSize }, () => main!.oid!),
      breadcrumb: ["main"],
      rects: Array.from({ length: groupSize }, (_, index) => ({
        x: index,
        y: 0,
        width: 100,
        height: 100,
      })),
      keyComputedStyles: {},
    });
    expect(getDesignSelection(workspace.workspaceId)?.nodeIds).toHaveLength(
      groupSize,
    );
    await expect(
      svc.handle("design.selection.set", {
        workspaceId: workspace.workspaceId,
        frame: frame.file,
        sourceVersion: response.mutation.frame.sourceVersion,
        selectionVersion: selectedAt * 1_024 + 3,
        updatedAt: selectedAt + 3,
        nodeIds: Array.from({ length: groupSize + 1 }, () => main!.oid!),
        breadcrumb: ["main"],
        rects: [],
        keyComputedStyles: {},
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      svc.handle("design.selection.set", {
        workspaceId: workspace.workspaceId,
        frame: frame.file,
        sourceVersion: response.mutation.frame.sourceVersion,
        selectionVersion: selectedAt * 1_024 + 4,
        updatedAt: selectedAt + 4,
        nodeIds: [main!.oid!],
        breadcrumb: ["main"],
        rects: Array.from({ length: groupSize + 1 }, () => ({
          x: 0,
          y: 0,
          width: 100,
          height: 100,
        })),
        keyComputedStyles: {},
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });

    await expect(
      svc.handle("design.runtime.audit", {
        workspaceId: workspace.workspaceId,
        frame: frame.file,
        sourceVersion: response.mutation.frame.sourceVersion,
        warnings: [
          {
            ruleId: "overflow",
            oid: "stale-runtime-oid",
            message: "A stale runtime still reported this node.",
            fix: "Refresh the frame.",
          },
          {
            ruleId: "overflow",
            oid: main!.oid!,
            message: "Visible overflow.",
            fix: "Constrain the element.",
          },
        ],
      }),
    ).resolves.toEqual({ ok: true });
    expect(
      getDesignRuntimeAudit(
        workspace.path,
        frame.file,
        response.mutation.frame.sourceVersion,
      ).map((warning) => warning.oid),
    ).toEqual([main!.oid!]);

    fs.writeFileSync(path.join(workspace.path, "outside.txt"), "leave me\n");
    const headBeforeStage = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace.path,
      encoding: "utf8",
    }).trim();
    await expect(
      svc.handle("design.save", { workspaceId: workspace.workspaceId }),
    ).resolves.toEqual({ ok: true });
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workspace.path,
        encoding: "utf8",
      }).trim(),
    ).toBe(headBeforeStage);
    expect(
      execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: workspace.path,
        encoding: "utf8",
      }),
    ).toBe("");
    const mergeHead = execFileSync(
      "git",
      ["rev-parse", "--git-path", "MERGE_HEAD"],
      { cwd: workspace.path, encoding: "utf8" },
    ).trim();
    fs.writeFileSync(
      path.resolve(workspace.path, mergeHead),
      `${headBeforeStage}\n`,
    );
    await expect(
      svc.handle("design.stage", { workspaceId: workspace.workspaceId }),
    ).rejects.toMatchObject({ code: "MERGE_IN_PROGRESS" });
    fs.unlinkSync(path.resolve(workspace.path, mergeHead));
    await expect(
      svc.handle("design.stage", { workspaceId: workspace.workspaceId }),
    ).resolves.toEqual({ ok: true });
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workspace.path,
        encoding: "utf8",
      }).trim(),
    ).toBe(headBeforeStage);
    const staged = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--no-renames"],
      { cwd: workspace.path, encoding: "utf8" },
    );
    expect(staged).toContain(`${designDirectory}/checkout.html`);
    expect(staged).not.toContain("outside.txt");

    execFileSync("git", ["add", "--", "outside.txt"], {
      cwd: workspace.path,
    });
    await expect(
      svc.handle("design.unstage", { workspaceId: workspace.workspaceId }),
    ).resolves.toEqual({ ok: true });
    const stagedAfterDesignUnstage = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--no-renames"],
      { cwd: workspace.path, encoding: "utf8" },
    );
    expect(stagedAfterDesignUnstage).toContain("outside.txt");
    expect(stagedAfterDesignUnstage).not.toContain(`${designDirectory}/`);
    await expect(
      svc.handle("design.stage", { workspaceId: workspace.workspaceId }),
    ).resolves.toEqual({ ok: true });

    expect(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workspace.path,
        encoding: "utf8",
      }).trim(),
    ).toBe(headBeforeStage);
    const committed = (await svc.handle("design.commit", {
      workspaceId: workspace.workspaceId,
      message: "Commit explicit Design checkpoint",
    })) as { sha: string; branch: string };
    expect(committed.sha).toMatch(/^[a-f0-9]{40}$/);
    const committedPaths = execFileSync(
      "git",
      ["show", "--pretty=format:", "--name-only", "HEAD"],
      { cwd: workspace.path, encoding: "utf8" },
    );
    expect(committedPaths).toContain(`${designDirectory}/checkout.html`);
    expect(committedPaths).not.toContain("outside.txt");
    expect(
      execFileSync("git", ["status", "--porcelain", "--", "outside.txt"], {
        cwd: workspace.path,
        encoding: "utf8",
      }),
    ).toContain("outside.txt");
    await svc.handle("workspace.delete", {
      workspaceId: workspace.workspaceId,
      includeBranch: true,
    });
  });

  it("maps an unknown workspaceId to WORKSPACE_NOT_FOUND on a git op", async () => {
    await expect(
      svc.handle("git.status", { workspaceId: "does-not-exist" }),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });

  it("rejects an unknown op", async () => {
    await expect(svc.handle("bogus.op", {})).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });

  it.each(["design.explore", "agent.spawn", "cloud.execution.create"])(
    "keeps future operation %s fail-closed until its real vertical slice exists",
    async (op) => {
      await expect(
        svc.handle(op, { workspaceId: LOCAL_MAIN_WORKSPACE_ID }),
      ).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: `unknown workspace op: ${op}`,
      });
    },
  );

  // ── Remote deny-by-default allowlist (FIX 2) ──────────────────────────────

  it("allowlists supported relay reads and metadata ops, denying the rest", () => {
    // Reads an optional remote client drives over the bridge (workspace-bridge.ts).
    for (const op of [
      "workspace.list",
      "project.list",
      "chats.list",
      "chats.summariesForFolder",
      "db.head",
      "db.pull",
      "messages.window",
      "messages.windowOlder",
      "messages.search",
      "file.tree",
      "file.read",
      "git.status",
      "git.changeCounts",
      "git.changeLineCounts",
      "git.diff",
      "git.show",
      "git.log",
      "git.branches",
      "git.remoteBranches",
      "gh.authStatus",
      "gh.repoOwnerAvatar",
      "gh.prGet",
      "gh.prChecks",
      "gh.prCommits",
      "gh.prReviews",
      // Qualified cloud clients see the same repo-task state/output as the
      // desktop. Their execution boundary is selected by actor and locality.
      "workspace.setupInfo",
      "workspace.runInfo",
      "workspace.runLog",
      "mcp.resolveComposed",
      "mcp.gateway.status",
    ]) {
      expect(svc.remoteReadable(op)).toBe(true);
      expect(svc.isRemoteAllowed(op)).toBe(true);
    }
    // Chat/transcript metadata mutations: allowed for remote, but NOT "reads".
    for (const op of [
      "chats.upsert",
      "chats.delete",
      "chats.bulkUpsert",
      "messages.import",
      "messages.clear",
      "messages.truncateFrom",
    ]) {
      expect(svc.remoteReadable(op)).toBe(false);
      expect(svc.isRemoteAllowed(op)).toBe(true);
    }
    // Writes are allowed at the gate (then restriction-gated separately).
    expect(svc.isRemoteAllowed("git.commit")).toBe(true);
    expect(svc.isRemoteAllowed("gh.prMerge")).toBe(true);
    for (const op of [
      "workspace.rerunSetup",
      "workspace.stopSetup",
      "workspace.startRun",
      "workspace.stopRun",
      "mcp.gateway.beginAuth",
      "mcp.gateway.completeAuth",
      "mcp.gateway.disconnect",
      "mcp.gateway.setHeaderSecret",
    ]) {
      expect(svc.isRemoteAllowed(op)).toBe(true);
    }
    // Exact local timeout-recovery probes and unknown/future ops are denied.
    for (const op of [
      "workspace.get",
      "workspace.lifecycleStatus",
      "workspace.createFromBranchStatus",
      "design.frames",
      "design.frame",
      "design.snapshot",
      "design.lint",
      "design.tokens",
    ]) {
      expect(svc.remoteReadable(op)).toBe(false);
      expect(svc.isRemoteAllowed(op)).toBe(false);
    }
    expect(svc.isRemoteAllowed("bogus.op")).toBe(false);
    // Desktop-only ops (publish-to-GitHub + init + adopt): in NONE of the remote
    // allowlists, so a remote client is refused at the gate before reaching the
    // handler. Pin the contract so a future allowlist edit can't silently
    // expose them.
    for (const op of [
      "gh.listOwners",
      "gh.checkRepoName",
      "gh.publishRepo",
      "git.initInPlace",
      "workspace.adoptExisting",
    ]) {
      expect(svc.isRemoteAllowed(op)).toBe(false);
    }
  });

  it("uses the headless MCP credential flow for a qualified cloud client", async () => {
    const calls: string[] = [];
    const connected = {
      name: "docs",
      url: "https://mcp.example.test",
      state: "connected" as const,
      toolCount: 2,
      tools: ["search", "read"],
    };
    const gateway = {
      running: true,
      getStatuses: () => [
        {
          ...connected,
          state: "needs-auth" as const,
          toolCount: 0,
        },
      ],
      beginAuthorize: async (server: string) => {
        calls.push(`begin:${server}`);
        return {
          authorizationUrl:
            "https://identity.example.test/authorize?state=opaque",
        };
      },
      completeAuthorize: async (server: string, code: string) => {
        calls.push(`complete:${server}:${code}`);
        return connected;
      },
      disconnect: async (server: string) => {
        calls.push(`disconnect:${server}`);
      },
    };
    const headerSecrets: Array<{
      url: string;
      headerName: string;
      value: string;
    }> = [];
    svc.setGatewayAccessor(() => gateway as never);
    svc.setGatewayHeaderSecretSetter((url, headerName, value) => {
      headerSecrets.push({ url, headerName, value });
    });

    await expect(
      svc.handle("mcp.gateway.status", {}, { remote: true }),
    ).resolves.toMatchObject({
      running: true,
      servers: [{ name: "docs", state: "needs-auth" }],
    });
    await expect(
      svc.handle("mcp.gateway.beginAuth", { server: "docs" }, { remote: true }),
    ).resolves.toEqual({
      authorizationUrl: "https://identity.example.test/authorize?state=opaque",
    });
    await expect(
      svc.handle(
        "mcp.gateway.completeAuth",
        { server: "docs", code: "auth-code" },
        { remote: true },
      ),
    ).resolves.toEqual({ status: connected });
    await expect(
      svc.handle(
        "mcp.gateway.setHeaderSecret",
        {
          url: "https://mcp.example.test",
          headerName: "Authorization",
          value: "Bearer secret",
        },
        { remote: true },
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      svc.handle(
        "mcp.gateway.disconnect",
        { server: "docs" },
        { remote: true },
      ),
    ).resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      "begin:docs",
      "complete:docs:auth-code",
      "disconnect:docs",
    ]);
    expect(headerSecrets).toEqual([
      {
        url: "https://mcp.example.test",
        headerName: "Authorization",
        value: "Bearer secret",
      },
    ]);
  });

  // ── Path redaction for remote clients (FIX 3) ──────────────────────────────

  it("sends real host paths to remote too (remote == local; no path redaction)", async () => {
    const remote = (await svc.handle(
      "workspace.list",
      {},
      { remote: true },
    )) as {
      workspaces: { id: string; path: string; repoRoot: string }[];
    };
    const rMain = remote.workspaces.find(
      (w) => w.id === LOCAL_MAIN_WORKSPACE_ID,
    )!;
    // Trusted-device model: a remote client gets the SAME real paths as local so
    // it can open / spawn / create by path. The restriction list — not
    // path-hiding — is the access boundary.
    expect(rMain.path).toBe(dir);
    expect(rMain.repoRoot).toBe(dir);
  });

  it("sends real repoRoot + origin to remote clients", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://example.com/r.git"],
      { cwd: dir },
    );
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    await createWorkspace({ repoRoot: dir });

    const remote = (await svc.handle("project.list", {}, { remote: true })) as {
      projects: { id: string; name: string; repoRoot: string }[];
    };
    const realDir = fs.realpathSync.native(dir);
    expect(remote.projects.some((p) => p.repoRoot === realDir)).toBe(true);
    for (const p of remote.projects) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
    }
  });

  // ── Chats remotely: real folders, only restriction-filtered ─────────────

  it("sends real chat folders to remote (remote == local)", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    execFileSync(
      "git",
      ["remote", "add", "origin", "https://example.com/r.git"],
      { cwd: dir },
    );
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const ws = await createWorkspace({ repoRoot: dir });

    await svc.handle("chats.upsert", {
      chat: { id: "c1", folder: ws.path, title: "in worktree" },
    });
    await svc.handle("chats.upsert", {
      chat: { id: "c2", folder: dir, title: "in main checkout" },
    });

    const remote = (await svc.handle("chats.list", {}, { remote: true })) as {
      chats: { id: string; folder: string }[];
    };
    const byId = Object.fromEntries(remote.chats.map((c) => [c.id, c.folder]));
    expect(byId.c1).toBe(ws.path); // real folder, same as local
    expect(byId.c2).toBe(dir);
  });

  it("sends an unrestricted foreign chat folder to remote unchanged", async () => {
    await svc.handle("chats.upsert", {
      chat: { id: "f1", folder: "/some/foreign/repo", title: "foreign" },
    });
    const remote = (await svc.handle("chats.list", {}, { remote: true })) as {
      chats: { id: string; folder: string }[];
    };
    const folder = remote.chats.find((c) => c.id === "f1")!.folder;
    expect(folder).toBe("/some/foreign/repo"); // real folder (no redaction)
  });

  it("disables an UNFILTERED cross-corpus messages.search for remote, allows local", async () => {
    // Seed a searchable message.
    await svc.handle("chats.upsert", { chat: { id: "s1", title: "t" } });
    await svc.handle("messages.import", {
      chatId: "s1",
      messages: [
        {
          msgId: "m1",
          kind: "text",
          payload: JSON.stringify({ role: "user", text: "needle haystack" }),
          createdAt: 1,
        },
      ],
    });
    // Relay, no scope → empty (no cross-corpus content leak).
    const remote = (await svc.handle(
      "messages.search",
      { query: "needle" },
      { remote: true },
    )) as { hits: unknown[] };
    expect(remote.hits).toEqual([]);
    // Local desktop searching its own machine → finds it.
    const local = (await svc.handle("messages.search", {
      query: "needle",
    })) as { hits: { chatId: string }[] };
    expect(local.hits.some((h) => h.chatId === "s1")).toBe(true);
  });

  it("does not reap processes in a foreign folder that replaced a stale workspace path", async () => {
    fs.writeFileSync(path.join(dir, "README.md"), "# x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "init",
      ],
      { cwd: dir },
    );
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "svcrepo",
    });
    // Leave Git's original worktree registration stale while replacing the
    // folder. The reaper must validate the folder's own common Git dir too.
    fs.rmSync(created.path, { recursive: true, force: true });
    fs.mkdirSync(created.path, { recursive: true });
    fs.writeFileSync(path.join(created.path, "FOREIGN.txt"), "keep\n");

    const reaped: string[] = [];
    svc.setWorkspaceProcessReaper(async (workspaceId) => {
      reaped.push(workspaceId);
    });
    await expect(
      svc.handle("workspace.archive", {
        workspaceId: created.workspaceId,
        stashUncommitted: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(reaped).toEqual([]);

    await svc.handle("workspace.delete", {
      workspaceId: created.workspaceId,
      includeBranch: true,
    });
    expect(reaped).toEqual([]);
    expect(
      fs.readFileSync(path.join(created.path, "FOREIGN.txt"), "utf8"),
    ).toBe("keep\n");
  });

  it("keeps create independent while another workspace archive is in flight", async () => {
    fs.writeFileSync(path.join(dir, "README.md"), "# x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "init",
      ],
      { cwd: dir },
    );
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "svcrepo",
    });
    await svc.handle("settings.write", {
      layer: "repo",
      repoRoot: dir,
      patch: {
        scripts: {
          setup: "echo deps",
          run_actions: [{ id: "dev", name: "Dev", command: "echo running" }],
        },
      },
    });
    const setupStarts: string[] = [];
    const runStarts: string[] = [];
    svc.setSetupRunner((workspaceId) => {
      setupStarts.push(workspaceId);
    });
    svc.setRunStarter(async ({ workspaceId }) => {
      if (workspaceId) runStarts.push(workspaceId);
      return { alreadyRunning: false };
    });

    let releaseReaper = () => {};
    let announceReaper = () => {};
    const reaperStarted = new Promise<void>((resolve) => {
      announceReaper = resolve;
    });
    const reaperBlocked = new Promise<void>((resolve) => {
      releaseReaper = resolve;
    });
    svc.setWorkspaceProcessReaper(async () => {
      announceReaper();
      await reaperBlocked;
    });

    const archive = svc.handle("workspace.archive", {
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    await reaperStarted;
    expect(getWorkspaceLifecycleStatus(created.workspaceId)).toMatchObject({
      active: true,
      operation: "archive",
      phase: null,
    });

    // Archive ownership is per workspace, never a global request/Repo lock.
    // This mirrors the UI workflow: prepare + create a second workspace while
    // an active agent in the first one is still being reaped.
    const prepared = (await svc.handle("workspace.prepareCreate", {
      repoRoot: dir,
      repoSlug: "svcrepo",
      prompt: "concurrent create",
    })) as {
      workspaceId: string;
      branch: string;
      path: string;
    };
    const concurrentCreate = svc.handle("workspace.create", {
      repoRoot: dir,
      repoSlug: "svcrepo",
      preparedId: prepared.workspaceId,
      preparedBranch: prepared.branch,
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const createdWhileArchiving = (await Promise.race([
      concurrentCreate,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error("concurrent create was blocked by archive")),
          3_000,
        );
      }),
    ]).finally(() => {
      if (deadline) clearTimeout(deadline);
    })) as { workspaceId: string; path: string };
    expect(createdWhileArchiving.workspaceId).toBe(prepared.workspaceId);
    expect(fs.existsSync(createdWhileArchiving.path)).toBe(true);

    await expect(
      svc.handle("workspace.rerunSetup", {
        workspaceId: created.workspaceId,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      svc.handle("workspace.startRun", {
        workspaceId: created.workspaceId,
        actionId: "dev",
        sessionId: runSessionId(created.path, "dev"),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      svc.handle("file.write", {
        workspaceId: created.workspaceId,
        path: "late.txt",
        content: "must not race archive\n",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(fs.existsSync(path.join(created.path, "late.txt"))).toBe(false);
    expect(setupStarts).toEqual([]);
    expect(runStarts).toEqual([]);
    releaseReaper();
    await archive;
  });

  it("queues an immediate archive behind the exact prepared create", async () => {
    fs.writeFileSync(path.join(dir, "README.md"), "# x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "init",
      ],
      { cwd: dir },
    );
    const prepared = (await svc.handle("workspace.prepareCreate", {
      repoRoot: dir,
      repoSlug: "svcrepo",
    })) as { workspaceId: string; branch: string; path: string };

    const create = svc.handle("workspace.create", {
      repoRoot: dir,
      repoSlug: "svcrepo",
      preparedId: prepared.workspaceId,
      preparedBranch: prepared.branch,
    });
    expect(getWorkspaceLifecycleStatus(prepared.workspaceId)).toMatchObject({
      active: true,
      operation: "create",
    });
    const archive = svc.handle("workspace.archive", {
      workspaceId: prepared.workspaceId,
      stashUncommitted: true,
    });

    await expect(create).resolves.toMatchObject({
      workspaceId: prepared.workspaceId,
      path: prepared.path,
    });
    await expect(archive).resolves.toMatchObject({
      workspace: {
        id: prepared.workspaceId,
        archivedAt: expect.any(Number),
        present: false,
      },
    });
    expect(fs.existsSync(prepared.path)).toBe(false);
    expect(getWorkspaceLifecycleStatus(prepared.workspaceId).active).toBe(
      false,
    );
  });

  it("releases retained Design API sessions on archive and delete", async () => {
    fs.writeFileSync(path.join(dir, "README.md"), "# x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "init",
      ],
      { cwd: dir },
    );
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-api-lifecycle",
      kind: "design",
    });
    const activeApi = getWorkspaceDesignApi(created.path);

    await svc.handle("workspace.archive", {
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });

    expect(getWorkspaceDesignApi(created.path)).not.toBe(activeApi);
    await svc.handle("workspace.restore", {
      workspaceId: created.workspaceId,
    });
    const restoredApi = getWorkspaceDesignApi(created.path);

    await svc.handle("workspace.delete", {
      workspaceId: created.workspaceId,
      includeBranch: false,
    });

    expect(getWorkspaceDesignApi(created.path)).not.toBe(restoredApi);
  });

  it("creates several independently prepared workspaces concurrently", async () => {
    fs.writeFileSync(path.join(dir, "README.md"), "# x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "init",
      ],
      { cwd: dir },
    );
    const prepared = (await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        svc.handle("workspace.prepareCreate", {
          repoRoot: dir,
          repoSlug: "svcrepo",
          prompt: `parallel ${index}`,
        }),
      ),
    )) as { workspaceId: string; branch: string; path: string }[];
    expect(new Set(prepared.map((entry) => entry.workspaceId)).size).toBe(4);
    expect(new Set(prepared.map((entry) => entry.path)).size).toBe(4);

    const created = (await Promise.all(
      prepared.map((entry) =>
        svc.handle("workspace.create", {
          repoRoot: dir,
          repoSlug: "svcrepo",
          preparedId: entry.workspaceId,
          preparedBranch: entry.branch,
        }),
      ),
    )) as { workspaceId: string; path: string }[];

    expect(created.map((entry) => entry.workspaceId).sort()).toEqual(
      prepared.map((entry) => entry.workspaceId).sort(),
    );
    for (const entry of created) expect(fs.existsSync(entry.path)).toBe(true);
  });

  it("does not run the repo setup script after restoring a workspace", async () => {
    // createWorkspace needs a base commit; repoSlug is passed explicitly since
    // the test repo has no origin. Configure a setup script via repo settings.
    fs.writeFileSync(path.join(dir, "README.md"), "# x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "init",
      ],
      { cwd: dir },
    );
    await svc.handle("settings.write", {
      layer: "repo",
      repoRoot: dir,
      patch: { scripts: { setup: "echo deps" } },
    });

    // Record every background-setup kickoff (the engine wires this to its
    // SetupManager in production; here we just capture the call).
    const calls: { id: string; command: string }[] = [];
    svc.setSetupRunner((id, command) => {
      calls.push({ id, command });
    });

    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "svcrepo",
    });

    // Neither archive nor restore should run setup. Restoring a workspace must
    // not execute repository-configured commands implicitly.
    await svc.handle("workspace.archive", {
      workspaceId: created.workspaceId,
      stashUncommitted: true,
    });
    expect(calls).toHaveLength(0);

    const result = (await svc.handle("workspace.restore", {
      workspaceId: created.workspaceId,
    })) as { restoredAt: number };
    expect(result.restoredAt).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });

  it("lets a cloud client control contained setup/run tasks for a managed workspace", async () => {
    fs.writeFileSync(path.join(dir, "README.md"), "# x\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "-m",
        "init",
      ],
      { cwd: dir },
    );
    const created = await createWorkspace({
      repoRoot: dir,
      repoSlug: "svcrepo",
    });
    await svc.handle("settings.write", {
      layer: "repo",
      repoRoot: dir,
      patch: {
        scripts: {
          setup: "echo deps",
          run_actions: [{ id: "dev", name: "Dev", command: "echo running" }],
        },
      },
    });
    const setupStarts: string[] = [];
    const setupStops: string[] = [];
    const runStarts: string[] = [];
    const runStops: Array<{
      sessionId: string;
      expectedWorkspaceId?: string;
    }> = [];
    const runLogReads: Array<{
      sessionId: string;
      expectedWorkspaceId?: string;
    }> = [];
    svc.setSetupRunner((workspaceId) => {
      setupStarts.push(workspaceId);
    });
    svc.setSetupStopper((workspaceId) => setupStops.push(workspaceId));
    svc.setRunStarter(async ({ workspaceId }) => {
      if (workspaceId) runStarts.push(workspaceId);
      return { alreadyRunning: false };
    });
    svc.setRunStopper((sessionId, expectedWorkspaceId) =>
      runStops.push({ sessionId, expectedWorkspaceId }),
    );
    svc.setRunLogGetter((sessionId, expectedWorkspaceId) => {
      runLogReads.push({ sessionId, expectedWorkspaceId });
      return { log: "cloud output", truncated: false };
    });

    await expect(
      svc.handle(
        "workspace.rerunSetup",
        { workspaceId: created.workspaceId },
        { remote: true },
      ),
    ).resolves.toMatchObject({ ok: true, hasCommand: true });
    await expect(
      svc.handle(
        "workspace.stopSetup",
        { workspaceId: created.workspaceId },
        { remote: true },
      ),
    ).resolves.toEqual({ ok: true });
    const sessionId = runSessionId(created.path, "dev");
    await expect(
      svc.handle(
        "workspace.startRun",
        { workspaceId: created.workspaceId, actionId: "dev", sessionId },
        { remote: true },
      ),
    ).resolves.toMatchObject({ ok: true, hasCommand: true });
    await expect(
      svc.handle(
        "workspace.stopRun",
        { workspaceId: created.workspaceId, sessionId },
        { remote: true },
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      svc.handle(
        "workspace.runLog",
        { workspaceId: created.workspaceId, sessionId },
        { remote: true },
      ),
    ).resolves.toEqual({ log: "cloud output", truncated: false });

    expect(setupStarts).toEqual([created.workspaceId]);
    expect(setupStops).toEqual([created.workspaceId]);
    expect(runStarts).toEqual([created.workspaceId]);
    expect(runStops).toEqual([
      { sessionId, expectedWorkspaceId: created.workspaceId },
    ]);
    expect(runLogReads).toEqual([
      { sessionId, expectedWorkspaceId: created.workspaceId },
    ]);
  });

  it("runs setup for the ROWLESS trunk via repoRoot (local:<slug>, no workspace row)", async () => {
    await svc.handle("settings.write", {
      layer: "repo",
      repoRoot: dir,
      patch: { scripts: { setup: "echo trunk-deps" } },
    });

    const runs: { id: string; command: string; target?: unknown }[] = [];
    const stops: string[] = [];
    svc.setSetupRunner((id, command, target) => {
      runs.push({ id, command, target });
    });
    svc.setSetupStopper((id) => stops.push(id));

    const localId = "local:svcrepo";

    // setupInfo resolves the repo's command from the explicit repoRoot.
    const info = (await svc.handle("workspace.setupInfo", {
      workspaceId: localId,
      repoRoot: dir,
    })) as { hasCommand: boolean; state: string | null };
    expect(info.hasCommand).toBe(true);
    expect(info.state).toBeNull();

    // statusOnly skips the command resolution + log payload (placeholders).
    const light = (await svc.handle("workspace.setupInfo", {
      workspaceId: localId,
      repoRoot: dir,
      statusOnly: true,
    })) as { hasCommand: boolean; command: string | null; log: string };
    expect(light).toMatchObject({ hasCommand: false, command: null, log: "" });

    // Without a repoRoot a rowless id is still an error (unknown workspace)…
    await expect(
      svc.handle("workspace.rerunSetup", { workspaceId: localId }),
    ).rejects.toThrow(/not found/i);

    // …with one it kicks off a run targeted at the repo root itself.
    const res = (await svc.handle("workspace.rerunSetup", {
      workspaceId: localId,
      repoRoot: dir,
    })) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(localId);
    expect(runs[0]!.command).toContain("echo trunk-deps");
    expect(runs[0]!.target).toMatchObject({ cwd: dir, repoRoot: dir });

    // stopSetup reaches the stopper; a remote client is refused because raw
    // rowless-path control stays desktop-only, like rerunSetup.
    await svc.handle("workspace.stopSetup", {
      workspaceId: localId,
      repoRoot: dir,
    });
    expect(stops).toEqual([localId]);
    await expect(
      svc.handle(
        "workspace.stopSetup",
        { workspaceId: localId, repoRoot: dir },
        { remote: true },
      ),
    ).rejects.toThrow();
  });

  it("acknowledges a setup rerun only after the setup runner is admitted", async () => {
    await svc.handle("settings.write", {
      layer: "repo",
      repoRoot: dir,
      patch: { scripts: { setup: "echo trunk-deps" } },
    });

    let releaseRunner = () => {};
    const runnerBlocked = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let announceRunner = () => {};
    const runnerStarted = new Promise<void>((resolve) => {
      announceRunner = resolve;
    });
    svc.setSetupRunner(async () => {
      announceRunner();
      await runnerBlocked;
    });

    let acknowledged = false;
    const rerun = svc
      .handle("workspace.rerunSetup", {
        workspaceId: "local:svcrepo",
        repoRoot: dir,
      })
      .then((result) => {
        acknowledged = true;
        return result;
      });

    try {
      await runnerStarted;
      // Let the request's async command-resolution chain settle. The retry RPC
      // must still be pending while the engine admission itself is pending.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(acknowledged).toBe(false);
    } finally {
      releaseRunner();
    }

    await expect(rerun).resolves.toMatchObject({
      ok: true,
      hasCommand: true,
    });
  });

  it("propagates an asynchronous setup admission failure to the rerun caller", async () => {
    await svc.handle("settings.write", {
      layer: "repo",
      repoRoot: dir,
      patch: { scripts: { setup: "echo trunk-deps" } },
    });
    svc.setSetupRunner(async () => {
      await Promise.resolve();
      throw new Error("setup admission refused");
    });

    await expect(
      svc.handle("workspace.rerunSetup", {
        workspaceId: "local:svcrepo",
        repoRoot: dir,
      }),
    ).rejects.toThrow(/setup admission refused/i);
  });

  // ── Working directories: the watcher must go deaf for the rewrite ──
  //
  // The whole reason a save timed out. Chokidar subscribes per DIRECTORY, so
  // unlinking a folder makes it re-read every surviving parent and tear down
  // one subscription per removed subdirectory, on the engine's single thread.
  // Measured on a synthetic 60k-file repo: 795ms unwatched → 3403ms watched,
  // with 1075ms of event-loop lag. Past ~15s of that the host watchdog stops
  // getting /health back and SIGKILLs the engine's process group — taking the
  // in-flight `git sparse-checkout` with it.
  describe("workspace.setWorkingDirectories", () => {
    const gitIn = (cwd: string, ...args: string[]): void => {
      execFileSync("git", args, { cwd, stdio: "ignore" });
    };

    const seedRepo = (): void => {
      fs.mkdirSync(path.join(dir, "keep"), { recursive: true });
      fs.mkdirSync(path.join(dir, "drop"), { recursive: true });
      fs.writeFileSync(path.join(dir, "keep", "a.txt"), "a\n");
      fs.writeFileSync(path.join(dir, "drop", "b.txt"), "b\n");
      gitIn(dir, "config", "user.email", "t@t");
      gitIn(dir, "config", "user.name", "t");
      gitIn(dir, "add", "-A");
      gitIn(dir, "commit", "-q", "-m", "init");
    };

    const trackSuspender = (): {
      calls: string[];
      resumed: number;
      retired: number;
    } => {
      const seen = { calls: [] as string[], resumed: 0, retired: 0 };
      svc.setWorkspaceCheckoutWatchSuspender(async (_id, worktreePath) => {
        seen.calls.push(worktreePath);
        return {
          resume() {
            seen.resumed++;
          },
          retire() {
            seen.retired++;
          },
        };
      });
      return seen;
    };

    it("suspends the worktree watcher for the rewrite and resumes after", async () => {
      seedRepo();
      const seen = trackSuspender();
      const result = (await svc.handle("workspace.setWorkingDirectories", {
        workspaceId: LOCAL_MAIN_WORKSPACE_ID,
        directories: ["keep"],
      })) as { included: string[] };

      expect(result.included).toEqual(["keep"]);
      expect(seen.calls).toEqual([dir]);
      expect(seen.resumed).toBe(1);
      // The checkout stayed exactly where it is, so it must NOT be retired —
      // retiring keeps the root's callbacks inert for 60s, which would blind
      // the tree to terminal/agent edits long after the save finished.
      expect(seen.retired).toBe(0);
      expect(fs.existsSync(path.join(dir, "drop"))).toBe(false);
    });

    it("resumes the watcher even when the rewrite fails", async () => {
      seedRepo();
      const seen = trackSuspender();
      await expect(
        svc.handle("workspace.setWorkingDirectories", {
          workspaceId: LOCAL_MAIN_WORKSPACE_ID,
          directories: ["nope"],
        }),
      ).rejects.toThrow(/not a top-level tracked directory/i);
      // Without the finally, a rejected save would leave this worktree
      // permanently unwatched — no file-tree or Changes refresh until restart.
      expect(seen.calls).toEqual([dir]);
      expect(seen.resumed).toBe(1);
    });

    it("still applies the selection when no watcher is wired", async () => {
      seedRepo();
      // The suspender is injected by the engine; the service must not depend
      // on it (tests, and any host that never starts a git watcher).
      const result = (await svc.handle("workspace.setWorkingDirectories", {
        workspaceId: LOCAL_MAIN_WORKSPACE_ID,
        directories: ["keep"],
      })) as { included: string[] };
      expect(result.included).toEqual(["keep"]);
    });

    it("keeps a sticky Design root locked after its repository marker is removed", async () => {
      fs.mkdirSync(path.join(dir, "keep"), { recursive: true });
      fs.mkdirSync(path.join(dir, "Product Design"), { recursive: true });
      fs.writeFileSync(path.join(dir, "keep", "a.txt"), "a\n");
      fs.writeFileSync(
        path.join(dir, "Product Design", ".zeros-canvas.json"),
        "{}\n",
      );
      fs.writeFileSync(
        path.join(dir, "Product Design", "frame.html"),
        "design\n",
      );
      gitIn(dir, "config", "user.email", "t@t");
      gitIn(dir, "config", "user.name", "t");
      gitIn(dir, "add", "-A");
      gitIn(dir, "commit", "-q", "-m", "initial Design");
      await rememberRecognizedDesignDirectories(dir, ["Product Design"]);

      fs.rmSync(path.join(dir, "Product Design", ".zeros-canvas.json"));
      gitIn(dir, "add", "-A");
      gitIn(dir, "commit", "-q", "-m", "remove marker");

      const listed = (await svc.handle("workspace.listWorkingDirectories", {
        workspaceId: LOCAL_MAIN_WORKSPACE_ID,
      })) as { locked: string[] };
      expect(listed.locked).toEqual(["Product Design"]);

      const applied = (await svc.handle("workspace.setWorkingDirectories", {
        workspaceId: LOCAL_MAIN_WORKSPACE_ID,
        directories: ["keep"],
      })) as { included: string[] };
      expect(applied.included).toEqual(["keep", "Product Design"]);
      expect(
        fs.existsSync(path.join(dir, "Product Design", "frame.html")),
      ).toBe(true);
    });

    it("rejects a non-array directories payload", async () => {
      seedRepo();
      await expect(
        svc.handle("workspace.setWorkingDirectories", {
          workspaceId: LOCAL_MAIN_WORKSPACE_ID,
          directories: "keep",
        }),
      ).rejects.toThrow(/array/i);
    });
  });
});
