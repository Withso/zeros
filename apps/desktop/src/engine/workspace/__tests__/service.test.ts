import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  getWorkspaceDesignApi,
  resetWorkspaceDesignApisForTests,
} from "../../design/design-api";
import { getDesignSelection } from "../../design/selection";
import { MAX_CONTEXT_GRAPH_ATTACHMENT_BYTES } from "../../files/context-graph";

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

  it("reads a file under local-main", async () => {
    const r = (await svc.handle("file.read", {
      workspaceId: LOCAL_MAIN_WORKSPACE_ID,
      path: "hello.txt",
    })) as { kind: string; content?: string };
    expect(r.kind).toBe("text");
    expect(r.content).toBe("hi there");
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

  it("returns exact design mutation snapshots and Save Designs commits only the design directory", async () => {
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    fs.writeFileSync(path.join(dir, ".gitignore"), "Zeros Design/\n");
    execFileSync("git", ["add", "hello.txt", ".gitignore"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
    const workspace = await createWorkspace({
      repoRoot: dir,
      repoSlug: "design-service-test",
      kind: "design",
    });
    const protocolCapability = "d".repeat(64);
    svc.setDesignProtocolCapabilityProvider(() => protocolCapability);
    const createdReply = (await svc.handle("design.frame.create", {
      workspaceId: workspace.workspaceId,
      title: "Checkout",
    })) as {
      frame: { file: string };
      snapshot: {
        protocolCapability: string | null;
        frames: Array<{ file: string }>;
      };
    };
    expect(createdReply.snapshot.protocolCapability).toBe(protocolCapability);
    expect(createdReply.snapshot.frames.map((frame) => frame.file)).toContain(
      createdReply.frame.file,
    );
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

    await expect(
      svc.handle("git.checkoutBranch", {
        workspaceId: workspace.workspaceId,
        branch: "main",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/unavailable in a design workspace/i),
    });

    await expect(
      svc.handle("context.graph.scaffold", {
        workspaceId: workspace.workspaceId,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringMatching(/unavailable in a design workspace/i),
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
    const assetDirectory = path.join(workspace.path, "Zeros Design", "assets");
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
    await expect(
      svc.handle("design.history.undo", {
        workspaceId: workspace.workspaceId,
        frame: frame.file,
      }),
    ).resolves.toMatchObject({
      result: { receipt: { status: "applied" } },
      snapshot: { frames: [expect.any(Object)] },
    });

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
    const saved = (await svc.handle("design.save", {
      workspaceId: workspace.workspaceId,
    })) as { sha: string; branch: string };
    expect(saved.sha).toMatch(/^[a-f0-9]{40}$/);
    const committed = execFileSync(
      "git",
      ["show", "--pretty=format:", "--name-only", "HEAD"],
      { cwd: workspace.path, encoding: "utf8" },
    );
    expect(committed).toContain("Zeros Design/checkout.html");
    expect(committed).not.toContain("outside.txt");
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
    svc.setSetupRunner((workspaceId) => setupStarts.push(workspaceId));
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
    svc.setSetupRunner((id, command) => calls.push({ id, command }));

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

  it("runs setup for the ROWLESS trunk via repoRoot (local:<slug>, no workspace row)", async () => {
    await svc.handle("settings.write", {
      layer: "repo",
      repoRoot: dir,
      patch: { scripts: { setup: "echo trunk-deps" } },
    });

    const runs: { id: string; command: string; target?: unknown }[] = [];
    const stops: string[] = [];
    svc.setSetupRunner((id, command, target) =>
      runs.push({ id, command, target }),
    );
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

    // stopSetup reaches the stopper; a remote client is refused (host shell
    // control stays desktop-only, like rerunSetup).
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
