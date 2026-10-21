import type { DesignContextReference } from "@zeros/protocol/design-context";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDesignCaptureService } from "../../design/capture-service";
import { setDesignCaptureConfig } from "../../design/capture-client";
import { WorkspaceService } from "../service";
import { closeState, createWorkspace, setStateRootForTesting } from "../../git";
import { getWorkspaceById } from "../../git/state";
import { designDirectoryNameFor } from "../../design/directory-registry";
import { resetWorkspaceDesignApisForTests } from "../../design/design-api";

describe("Design in the shared workbench", () => {
  let root: string;
  let service: WorkspaceService;
  let workspace: Awaited<ReturnType<typeof createWorkspace>>;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-workbench-"));
    setStateRootForTesting(path.join(root, "state"));
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.com");
    await writeFile(path.join(root, "code.txt"), "Code one\n");
    git(root, "add", "code.txt");
    git(root, "commit", "-qm", "Initial");
    workspace = await createWorkspace({
      repoRoot: root,
      repoSlug: "workbench",
      kind: "code",
    });
    service = new WorkspaceService(root);
  });

  afterEach(async () => {
    setDesignCaptureConfig(undefined);
    resetWorkspaceDesignApisForTests();
    closeState();
    await rm(root, { recursive: true, force: true });
  });

  it("captures an exact Design revision for an admitted cloud device without a proposal or client browser", async () => {
    const service = new WorkspaceService(root, { primaryDesignWorkspace: true });
    const params = { workspaceId: "local-main" };
    await service.handle("design.initialize", params);
    const created = await service.handle("design.frame.create", { ...params, title: "Portable capture" }) as { frame: { file: string } };
    const opened = await service.handle("design.foundation.open", { ...params, frame: created.frame.file }) as { summary: { revision: string } };
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=", "base64");
    const render = vi.fn(async () => ({ bytes: png, renderer: "fixture" }));
    const capture = await startDesignCaptureService(render);
    setDesignCaptureConfig(capture);
    const input = { ...params, frame: created.frame.file, expectedRevision: opened.summary.revision, width: 1, height: 1 };
    try {
      // Cloud admission already binds this engine to its one workspace. It
      // has no client-local renderer, unlike the desktop service context.
      const result = await service.handle("design.capture", input, { hostLocalResources: false });
      expect(result).toMatchObject({ revision: opened.summary.revision, mimeType: "image/png", width: 1, height: 1, data: png.toString("base64") });
      expect(JSON.stringify(result)).not.toContain(capture.token);
      expect(JSON.stringify(result)).not.toContain(root);
      await expect(service.handle("design.capture", { ...input, expectedRevision: "0".repeat(64) })).rejects.toThrow(/repository changed/i);
      await expect(service.handle("design.capture", { ...input, width: 2049 })).rejects.toThrow();
      await expect(service.handle("design.capture", { ...input, url: "https://example.test" })).rejects.toThrow();
      await expect(service.handle("design.capture", { ...input, workspaceId: "unknown" })).rejects.toThrow();
      expect(render).toHaveBeenCalledOnce();
    } finally { setDesignCaptureConfig(undefined); await capture.stop(); }
  });

  it("renders a canvas preview of the saved frame through the capture host, refusing stale versions without one", async () => {
    const service = new WorkspaceService(root, { primaryDesignWorkspace: true });
    const params = { workspaceId: "local-main" };
    await service.handle("design.initialize", params);
    const created = await service.handle("design.frame.create", { ...params, title: "Preview" }) as { frame: { file: string } };
    const snapshot = await service.handle("design.snapshot", params) as {
      snapshot: { frames: { file: string; sourceVersion: string; width: number; height: number }[] };
    };
    const frame = snapshot.snapshot.frames.find((candidate) => candidate.file === created.frame.file)!;
    // Transport fixture: a PNG header of the requested raster size.
    const render = vi.fn(async (input: { width: number; height: number; layoutViewport?: unknown; maxDimension?: number }) => {
      const bytes = Buffer.alloc(24);
      Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
      bytes.write("IHDR", 12); bytes.writeUInt32BE(input.width, 16); bytes.writeUInt32BE(input.height, 20);
      return { bytes, renderer: "transport-fixture" };
    });
    const capture = await startDesignCaptureService(render);
    setDesignCaptureConfig(capture);
    const input = { ...params, frame: frame.file, sourceVersion: frame.sourceVersion, theme: null, maxDimension: 256 };
    try {
      const result = await service.handle("design.preview", input, { hostLocalResources: false }) as {
        sourceVersion: string; width: number; height: number; data: string;
      };
      const longest = Math.max(frame.width, frame.height);
      expect(result).toMatchObject({ sourceVersion: frame.sourceVersion, theme: null, mimeType: "image/png",
        width: Math.round((frame.width * 256) / longest), height: Math.round((frame.height * 256) / longest) });
      expect(render).toHaveBeenCalledOnce();
      expect(render.mock.calls[0]![0]).toMatchObject({ layoutViewport: { width: frame.width, height: frame.height }, maxDimension: 256 });
      expect(JSON.stringify(result)).not.toContain(capture.token);
      expect(JSON.stringify(result)).not.toContain(root);
      await expect(service.handle("design.preview", { ...input, sourceVersion: "0".repeat(24) }))
        .resolves.toEqual({ stale: true, sourceVersion: frame.sourceVersion });
      await expect(service.handle("design.preview", { ...input, maxDimension: 4096 })).rejects.toThrow();
      await expect(service.handle("design.preview", { ...input, url: "https://example.test" })).rejects.toThrow();
      await expect(service.handle("design.preview", { ...input, workspaceId: "unknown" })).rejects.toThrow();
      expect(render).toHaveBeenCalledOnce();
    } finally { setDesignCaptureConfig(undefined); await capture.stop(); }
  });

  it("moves several canvas frames in one write and one undo step, refusing a stale gesture", async () => {
    const service = new WorkspaceService(root, { primaryDesignWorkspace: true });
    const params = { workspaceId: "local-main" };
    await service.handle("design.initialize", params);
    const files: string[] = [];
    for (const title of ["Alpha", "Beta", "Gamma"])
      files.push(((await service.handle("design.frame.create", { ...params, title })) as { frame: { file: string } }).frame.file);
    type Frames = { snapshot: { frames: { file: string; x: number; y: number; width: number; height: number; z: number }[] } };
    const geometryOf = (snapshot: Frames, file: string) => {
      const frame = snapshot.snapshot.frames.find((candidate) => candidate.file === file)!;
      return { x: frame.x, y: frame.y, w: frame.width, h: frame.height, z: frame.z };
    };
    const before = (await service.handle("design.snapshot", params)) as Frames;
    const moves = files.slice(0, 2).map((file) => {
      const from = geometryOf(before, file);
      return { frame: file, from, to: { ...from, x: from.x + 100, y: from.y + 50 } };
    });
    const moved = (await service.handle("design.frames.move", { ...params, moves })) as Frames;
    for (const move of moves) expect(geometryOf(moved, move.frame)).toEqual(move.to);
    expect(geometryOf(moved, files[2]!)).toEqual(geometryOf(before, files[2]!));
    // One undo step restores every frame of the move; redo replays it.
    const undone = (await service.handle("design.history.undo", params)) as Frames;
    for (const move of moves) expect(geometryOf(undone, move.frame)).toEqual(move.from);
    const redone = (await service.handle("design.history.redo", params)) as Frames;
    for (const move of moves) expect(geometryOf(redone, move.frame)).toEqual(move.to);
    // A gesture measured before that move is stale and moves nothing.
    await expect(service.handle("design.frames.move", { ...params, moves })).rejects.toThrow(/moved or changed/);
    const after = (await service.handle("design.snapshot", params)) as Frames;
    for (const move of moves) expect(geometryOf(after, move.frame)).toEqual(move.to);
    await expect(service.handle("design.frames.move", { ...params, moves: [moves[0], moves[0]] })).rejects.toThrow();
  });

  it("initializes and edits Design without changing presentation, HEAD or the index", async () => {
    const beforeHead = git(workspace.path, "rev-parse", "HEAD");
    const beforeIndex = git(workspace.path, "write-tree");
    const params = { workspaceId: workspace.workspaceId };
    await expect(
      service.handle("design.initialize", params),
    ).resolves.toMatchObject({ snapshot: { frames: [] } });
    expect(getWorkspaceById(workspace.workspaceId)?.kind).toBe("code");
    const created = (await service.handle("design.frame.create", {
      ...params,
      title: "Shared canvas",
    })) as { frame: { file: string } };
    await expect(service.handle("design.save", params)).resolves.toEqual({
      ok: true,
    });
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(git(workspace.path, "write-tree")).toBe(beforeIndex);
    expect(
      await readFile(
        path.join(
          workspace.path,
          designDirectoryNameFor(workspace.path),
          created.frame.file,
        ),
        "utf8",
      ),
    ).toContain("Shared canvas");
    await expect(
      service.handle("file.write", {
        ...params,
        path: `${designDirectoryNameFor(workspace.path)}/${created.frame.file}`,
        content: '<main data-oid="screen">Native edit</main>',
      }),
    ).resolves.toMatchObject({ kind: "success" });
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(beforeHead);
    expect(git(workspace.path, "write-tree")).toBe(beforeIndex);
  });

  it("initializes Design in a cloud primary checkout without creating a second worktree", async () => {
    const cloud = new WorkspaceService(root, { primaryDesignWorkspace: true });
    const params = { workspaceId: "local-main" };
    const head = git(root, "rev-parse", "HEAD");
    const index = git(root, "write-tree");
    await expect(cloud.handle("design.initialize", params, { hostLocalResources: false }))
      .resolves.toMatchObject({ snapshot: { frames: [] } });
    await cloud.handle("design.frame.create", { ...params, title: "Cloud canvas" }, { hostLocalResources: false });
    await expect(cloud.handle("design.initialize", params, { hostLocalResources: false }))
      .resolves.toMatchObject({ snapshot: { frames: [expect.objectContaining({ title: "Cloud canvas" })] } });
    expect(git(root, "rev-parse", "HEAD")).toBe(head);
    expect(git(root, "write-tree")).toBe(index);
    await expect(cloud.handle("design.initialize", params, { remote: true }))
      .rejects.toMatchObject({ code: "REMOTE_RESTRICTED" });
    await expect(cloud.handle("design.initialize", { workspaceId: "unknown-primary" }))
      .rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
  });

  it("preserves the local primary checkout's existing Design restriction", async () => {
    await expect(service.handle("design.initialize", { workspaceId: "local-main" }))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("commits the staged Code and Design snapshot while retaining later edits", async () => {
    const params = { workspaceId: workspace.workspaceId };
    await service.handle("design.initialize", params);
    const first = (await service.handle("design.frame.create", {
      ...params,
      title: "First",
    })) as { frame: { file: string } };
    const directory = designDirectoryNameFor(workspace.path);
    await writeFile(path.join(workspace.path, "code.txt"), "Code two\n");
    await service.handle("git.stage", {
      ...params,
      paths: [directory, "code.txt"],
    });
    const stagedTree = git(workspace.path, "write-tree");
    const later = (await service.handle("design.frame.create", {
      ...params,
      title: "Later",
    })) as { frame: { file: string } };
    await writeFile(path.join(workspace.path, "code.txt"), "Code three\n");
    await service.handle("design.save", params);
    expect(git(workspace.path, "write-tree")).toBe(stagedTree);
    await service.handle("git.commit", {
      ...params,
      message: "Code and Design",
    });
    expect(git(workspace.path, "rev-parse", "HEAD^{tree}")).toBe(stagedTree);
    expect(git(workspace.path, "show", "HEAD:code.txt")).toBe("Code two");
    expect(
      git(workspace.path, "show", `HEAD:${directory}/${first.frame.file}`),
    ).toContain("First");
    expect(
      await readFile(
        path.join(workspace.path, directory, later.frame.file),
        "utf8",
      ),
    ).toContain("Later");
    expect(git(workspace.path, "diff", "--name-only")).toContain("code.txt");
    expect(git(workspace.path, "diff", "--cached", "--name-only")).toBe("");
    await expect(
      service.handle("git.discard", { ...params, paths: [directory] }),
    ).resolves.toEqual({ ok: true });
    expect(git(workspace.path, "diff", "--name-only")).toBe("code.txt");
    expect(await readFile(path.join(workspace.path, "code.txt"), "utf8")).toBe("Code three\n");
    expect(git(workspace.path, "rev-parse", "HEAD^{tree}")).toBe(stagedTree);
  });

  it("unstages Design without changing authored files or unrelated staged Code", async () => {
    const params = { workspaceId: workspace.workspaceId };
    await service.handle("design.initialize", params);
    const directory = designDirectoryNameFor(workspace.path);
    await writeFile(path.join(workspace.path, "code.txt"), "Staged code\n");
    await service.handle("git.stage", {
      ...params,
      paths: [directory, "code.txt"],
    });
    await service.handle("git.unstage", { ...params, paths: [directory] });
    expect(git(workspace.path, "diff", "--cached", "--name-only")).toBe(
      "code.txt",
    );
    expect(
      await readFile(
        path.join(workspace.path, directory, "meta/design.toml"),
        "utf8",
      ),
    ).toContain('format = "zeros-design"');
  });

  it("keeps initialization local, lifecycle gated, and idempotent", async () => {
    const params = { workspaceId: workspace.workspaceId };
    expect(service.isWriteOp("design.initialize")).toBe(true);
    expect(service.isRemoteAllowed("design.initialize")).toBe(false);
    expect(
      service.lifecycleMutationWorkspaceId("design.initialize", params),
    ).toBe(workspace.workspaceId);
    await expect(
      service.handle("design.initialize", params, { remote: true }),
    ).rejects.toMatchObject({ code: "REMOTE_RESTRICTED" });
    await service.handle("design.initialize", params);
    const frame = (await service.handle("design.frame.create", {
      ...params,
      title: "Keep me",
    })) as { frame: { file: string } };
    await expect(
      service.handle("design.initialize", params),
    ).resolves.toMatchObject({
      snapshot: {
        frames: [expect.objectContaining({ file: frame.frame.file })],
      },
    });
  });

  it("rejects an edit addressed to an old directory identity without changing the document", async () => {
    const params = { workspaceId: workspace.workspaceId };
    const { snapshot } = (await service.handle(
      "design.initialize",
      params,
    )) as { snapshot: { directoryId: string } };
    await expect(
      service.handle("design.frame.create", {
        ...params,
        directoryId: "replaced-directory",
        title: "Wrong target",
      }),
    ).rejects.toThrow("directory changed");
    await expect(
      service.handle("design.snapshot", params),
    ).resolves.toMatchObject({
      snapshot: { directoryId: snapshot.directoryId, frames: [] },
    });
    await expect(
      service.handle("design.frame.create", {
        ...params,
        directoryId: snapshot.directoryId,
        title: "Current target",
      }),
    ).resolves.toMatchObject({ frame: { title: "Current target" } });
  });
  it("keeps context reads observational and reports stale and deleted frames", async () => {
    const params = { workspaceId: workspace.workspaceId };
    await service.handle("design.initialize", params);
    const created = (await service.handle("design.frame.create", {
      ...params,
      title: "Reference",
    })) as { frame: { file: string } };
    const { reference } = (await service.handle("design.context.create", {
      ...params,
      frame: created.frame.file,
    })) as { reference: DesignContextReference };
    const before = git(workspace.path, "status", "--porcelain");
    await expect(
      service.handle("design.context.inspect", { ...params, reference }),
    ).resolves.toMatchObject({
      status: "ready",
      source: expect.stringContaining("Reference"),
    });
    expect(git(workspace.path, "status", "--porcelain")).toBe(before);
    await expect(
      service.handle("design.context.inspect", {
        ...params,
        reference: { ...reference, directoryId: "other" },
      }),
    ).resolves.toMatchObject({ status: "wrong-directory" });
    await expect(
      service.handle("design.context.inspect", {
        ...params,
        reference: { ...reference, workspaceId: "other" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await service.handle("design.canvas.update", {
      ...params,
      frame: created.frame.file,
      x: 0,
      y: 0,
      w: 777,
      h: 333,
      z: 0,
    });
    await expect(
      service.handle("design.context.inspect", { ...params, reference }),
    ).resolves.toMatchObject({ status: "stale" });
    await service.handle("design.frame.delete", {
      ...params,
      frame: created.frame.file,
    });
    await expect(
      service.handle("design.context.inspect", { ...params, reference }),
    ).resolves.toMatchObject({ status: "missing" });
  });

  it("pauses before parsing a conflicted manifest and recovers after cancellation", async () => {
    const params = { workspaceId: workspace.workspaceId };
    await service.handle("design.initialize", params);
    const directory = designDirectoryNameFor(workspace.path);
    await service.handle("git.stage", { ...params, paths: [directory] });
    await service.handle("git.commit", { ...params, message: "Design base" });
    const branch = git(workspace.path, "branch", "--show-current");
    const manifestPath = path.join(workspace.path, directory, "meta/design.toml");
    const base = await readFile(manifestPath, "utf8");
    git(workspace.path, "checkout", "-qb", "conflicting-design");
    await writeFile(manifestPath, "# theirs\n" + base);
    git(workspace.path, "add", directory);
    git(workspace.path, "commit", "-qm", "Theirs");
    git(workspace.path, "checkout", "-q", branch);
    await writeFile(manifestPath, "# ours\n" + base);
    git(workspace.path, "add", directory);
    git(workspace.path, "commit", "-qm", "Ours");
    expect(() => git(workspace.path, "merge", "conflicting-design")).toThrow();
    const conflicted = await readFile(manifestPath, "utf8");
    expect(conflicted).toContain("<<<<<<<");
    await expect(
      service.handle("design.status", params),
    ).resolves.toMatchObject({
      operation: "merge",
      conflicts: [`${directory}/meta/design.toml`],
    });
    await expect(service.handle("design.snapshot", params)).rejects.toThrow(
      "Design is paused",
    );
    await expect(
      service.handle("design.frame.create", { ...params, title: "Blocked" }),
    ).rejects.toThrow("Design is paused");
    expect(await readFile(manifestPath, "utf8")).toBe(conflicted);
    await service.handle("git.abort", params);
    await expect(service.handle("design.status", params)).resolves.toEqual({
      operation: null,
      conflicts: [],
    });
    await expect(
      service.handle("design.snapshot", params),
    ).resolves.toMatchObject({ snapshot: { frames: [] } });
  });

  it("refuses a partial first Design commit until its metadata is staged", async () => {
    const params = { workspaceId: workspace.workspaceId };
    await service.handle("design.initialize", params);
    const directory = designDirectoryNameFor(workspace.path);
    await service.handle("git.stage", {
      ...params,
      paths: [`${directory}/tokens.css`],
    });
    const head = git(workspace.path, "rev-parse", "HEAD");
    const index = git(workspace.path, "write-tree");
    await expect(
      service.handle("git.commit", { ...params, message: "Incomplete" }),
    ).rejects.toThrow("meta/design.toml");
    expect(git(workspace.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(workspace.path, "write-tree")).toBe(index);
  });

  it("commits valid staged Design even when a later external draft needs repair", async () => {
    const params = { workspaceId: workspace.workspaceId };
    await service.handle("design.initialize", params);
    const created = (await service.handle("design.frame.create", {
      ...params,
      title: "Valid staged frame",
    })) as { frame: { file: string } };
    await service.handle("design.stage", params);
    const stagedTree = git(workspace.path, "write-tree");
    const file = path.join(
      workspace.path,
      designDirectoryNameFor(workspace.path),
      created.frame.file,
    );
    await writeFile(file, "<html><body><script>bad()</script></body></html>");
    await expect(service.handle("design.save", params)).rejects.toThrow(
      "before saving",
    );
    await service.handle("design.commit", {
      ...params,
      message: "Reviewed version",
    });
    expect(git(workspace.path, "rev-parse", "HEAD^{tree}")).toBe(stagedTree);
    expect(await readFile(file, "utf8")).toContain("bad()");
  });
});
