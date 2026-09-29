import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceService, LOCAL_MAIN_WORKSPACE_ID } from "../service";
import { closeState, setStateRootForTesting } from "../../git";
import { insertWorkspace, updateWorkspace } from "../../git/state";
import type { Workspace } from "../../git/types";
import type { CloudActorRole } from "@zeros/protocol/cloud-actors";
import { designDirectoryNameFor } from "../../design/directory-registry";
import * as designDirectories from "../../design/directory";
import { resetWorkspaceDesignApisForTests } from "../../design/design-api";
import * as ownership from "../../files/cloud-workspace-ownership";
import * as gitExec from "../../git/git-exec";
import * as projects from "../../db/projects";

describe("qualified cloud checkout file policy", () => {
  let root: string, repo: string, service: WorkspaceService;
  let authorized: boolean;
  const target = { workspaceId: LOCAL_MAIN_WORKSPACE_ID };
  const options = (role: CloudActorRole = "developer") => ({ remote: true, cloudWorker: true,
    cloudActorIdentity: { userId: "11111111-1111-4111-8111-111111111111", deviceId: "22222222-2222-4222-8222-222222222222" },
    cloudFileActor: { role, authorized: () => authorized } });
  const put = (rel: string, text = "fixture") => { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), text); };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-files-"));
    repo = path.join(root, "checkout"); fs.mkdirSync(repo);
    setStateRootForTesting(path.join(root, "engine-state"));
    git("init", "-q", "-b", "main"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
    put("src/code.txt"); put("docs/readme.md"); put(".gitignore", "ignored/\n.env\n*.pem\n");
    git("add", "."); git("commit", "-qm", "Initial");
    authorized = true;
    service = new WorkspaceService(repo, { primaryDesignWorkspace: true });
  });
  afterEach(() => { vi.restoreAllMocks(); resetWorkspaceDesignApisForTests(); closeState(); fs.rmSync(root, { recursive: true, force: true }); });
  const read = (rel: string, role?: CloudActorRole) => service.handle("file.read", { ...target, path: rel }, options(role));
  const write = (rel: string, role?: CloudActorRole) => service.handle("file.write", { ...target, path: rel, content: "changed" }, options(role));
  async function refused(action: Promise<unknown>) {
    const result = await action.catch(() => ({ kind: "error" }));
    expect(result).toMatchObject({ kind: "error" });
  }

  it("lists and searches ignored normal files, including before mention limits", async () => {
    put("ignored/note.txt"); put(".zeros/private.txt");
    expect(await service.handle("file.ignored", target, options())).toMatchObject({ entries: ["ignored/"] });
    expect(await service.handle("file.ignored", { ...target, dir: "ignored/" }, options())).toEqual({ entries: ["ignored/note.txt"] });
    expect(await service.handle("file.tree", { ...target, includeIgnored: true, query: "note", limit: 1 }, options())).toEqual({ files: ["ignored/note.txt"] });
    expect(await read("ignored/note.txt")).toMatchObject({ kind: "text", content: "fixture" });
  });
  it("lets an editor read and edit repository .env and PEM files while viewers/prompters remain read-only", async () => {
    for (const file of [".env", "test.pem"]) {
      put(file);
      expect(await read(file)).toMatchObject({ kind: "text" });
      expect(await write(file)).toMatchObject({ kind: "success" });
      for (const role of ["viewer", "prompter"] as const) { await refused(read(file, role)); await refused(write(file, role)); }
    }
    expect(await read("src/code.txt", "viewer")).toMatchObject({ kind: "text" });
    await refused(write("src/code.txt", "prompter"));
  });
  it("excludes internal paths, nested owners, traversal and innocuous aliases from every file surface", async () => {
    put("nested/.git/config"); put("nested/note.txt");
    put(".zeros/note.txt"); put(".codex/auth.json");
    put("engine-private/note.txt"); setStateRootForTesting(path.join(repo, "engine-private"));
    put("registered/note.txt");
    const { workspaces } = await service.handle("workspace.list") as { workspaces: Workspace[] };
    insertWorkspace({ ...workspaces[0], id: "nested-owner", path: path.join(repo, "registered"), repoRoot: repo });
    fs.writeFileSync(path.join(root, "outside.txt"), "fixture");
    fs.symlinkSync(path.join(repo, ".zeros"), path.join(repo, "innocent"));
    fs.symlinkSync(path.join(root, "outside.txt"), path.join(repo, "outside-alias"));
    fs.symlinkSync(path.join(repo, "engine-private/note.txt"), path.join(repo, "secret-alias"));
    fs.linkSync(path.join(root, "outside.txt"), path.join(repo, "hardlink"));
    for (const rel of [".git/config", ".zeros/note.txt", ".codex/auth.json", "nested/note.txt", "registered/note.txt", "engine-private/note.txt", "../outside.txt", "innocent/note.txt", "outside-alias", "secret-alias", "hardlink"]) {
      await refused(read(rel)); await refused(write(rel));
    }
    const tree = await service.handle("file.tree", { ...target, includeIgnored: true, query: "note" }, options()) as { files: string[] };
    expect(tree.files).toEqual([]);
    expect(await service.handle("file.ignored", { ...target, dir: "nested" }, options())).toEqual({ entries: [] });
    expect(fs.readFileSync(path.join(root, "outside.txt"), "utf8")).toBe("fixture");
  });
  it("rejects cross-workspace and revoked actors, including revocation during an async read", async () => {
    for (const workspaceId of [repo, "another-workspace"]) {
      await expect(service.handle("file.tree", { workspaceId }, options())).rejects.toThrow();
      await expect(service.handle("context.graph.scaffold", { workspaceId }, options())).rejects.toThrow();
    }
    authorized = false;
    await expect(service.handle("file.tree", target, options())).rejects.toThrow();
    await refused(read("src/code.txt")); await refused(write("src/code.txt"));
    authorized = true;
    const pending = service.handle("file.tree", { ...target, includeIgnored: true }, options());
    authorized = false;
    await expect(pending).rejects.toThrow();
  });
  it("uses context and sparse-checkout lifecycle barriers and preserves dirty files", async () => {
    expect(await service.handle("context.graph.scaffold", target, options())).toEqual({ ok: true, created: true });
    put(".context/local/attachments/item/note.txt");
    expect(await service.handle("context.graph.list", target, options())).toMatchObject({ items: [expect.objectContaining({ name: "note.txt" })] });
    expect(await service.handle("context.graph.setShared", { ...target, attachmentId: "item", shared: true }, options())).toMatchObject({ ok: true, moved: true });
    expect(await service.handle("workspace.listWorkingDirectories", target, options())).toMatchObject({ supported: true });
    put("docs/readme.md", "dirty");
    await service.handle("workspace.setWorkingDirectories", { ...target, directories: ["src"] }, options());
    expect(fs.readFileSync(path.join(repo, "docs/readme.md"), "utf8")).toBe("dirty");
    const { workspaces } = await service.handle("workspace.list") as { workspaces: Workspace[] };
    insertWorkspace(workspaces.find(row => row.id === LOCAL_MAIN_WORKSPACE_ID)!);
    updateWorkspace(LOCAL_MAIN_WORKSPACE_ID, { archivedAt: Date.now() });
    for (const op of ["context.graph.scaffold", "context.graph.setShared", "workspace.setWorkingDirectories"]) {
      expect(service.lifecycleMutationWorkspaceId(op, target)).toBe(LOCAL_MAIN_WORKSPACE_ID);
      await expect(service.handle(op, { ...target, directories: [] }, options())).rejects.toThrow();
    }
  });
  it("keeps Design writes and legacy remote relay restrictions intact", async () => {
    await service.handle("design.initialize", target);
    const created = await service.handle("design.frame.create", { ...target, title: "Frame" }) as { frame: { file: string } };
    const rel = `${designDirectoryNameFor(repo)}/${created.frame.file}`;
    expect(await read(rel)).toMatchObject({ kind: "text", designPath: true });
    await refused(write(rel));
    put(".env");
    for (const [op, params] of [
      ["file.read", { path: ".env" }], ["file.write", { path: ".env", content: "changed" }],
      ["file.tree", { includeIgnored: true }], ["file.ignored", {}], ["context.graph.list", {}],
      ["context.graph.scaffold", {}], ["context.graph.setShared", { attachmentId: "item" }],
    ] as const) await expect(service.handle(op, { ...target, ...params }, { remote: true })).rejects.toThrow();
    for (const op of ["file.ignored", "context.graph.list", "context.graph.scaffold", "context.graph.setShared", "workspace.listWorkingDirectories", "workspace.setWorkingDirectories"])
      expect(service.isRemoteAllowed(op)).toBe(false);
  });
  it("excludes private/nested context content and refuses sharing it in either direction", async () => {
    await service.handle("context.graph.scaffold", target, options());
    put(".context/local/docs/.zeros/note.md");
    put(".context/local/docs/nested/.git/config"); put(".context/local/docs/nested/note.md");
    put(".zeros/note.md");
    fs.symlinkSync(path.join(repo, ".zeros/note.md"), path.join(repo, ".context/local/alias.md"));
    expect(await service.handle("context.graph.list", target, options())).toMatchObject({ items: [] });
    for (const shared of [true, false]) {
      const scope = shared ? "local" : "shared";
      put(`.context/${scope}/attachments/item/nested/.git/config`);
      put(`.context/${scope}/attachments/item/nested/note.md`);
      await expect(service.handle("context.graph.setShared", { ...target, attachmentId: "item", shared }, options())).rejects.toThrow();
      expect(fs.existsSync(path.join(repo, `.context/${scope}/attachments/item/nested/note.md`))).toBe(true);
      fs.rmSync(path.join(repo, `.context/${scope}/attachments/item`), { recursive: true });
    }
  });
  it("keeps a file alias to Design territory read-only", async () => {
    await service.handle("design.initialize", target);
    const created = await service.handle("design.frame.create", { ...target, title: "Frame" }) as { frame: { file: string } };
    const frame = path.join(repo, designDirectoryNameFor(repo), created.frame.file);
    const before = fs.readFileSync(frame, "utf8");
    fs.symlinkSync(frame, path.join(repo, "alias.html"));
    await refused(write("alias.html"));
    expect(fs.readFileSync(frame, "utf8")).toBe(before);
    expect(await read("alias.html")).toMatchObject({ kind: "text", designPath: true });
  });
  it("refuses a file alias switched into Design territory during write admission", async () => {
    await service.handle("design.initialize", target);
    const created = await service.handle("design.frame.create", { ...target, title: "Frame" }) as { frame: { file: string } };
    const frame = path.join(repo, designDirectoryNameFor(repo), created.frame.file);
    const before = fs.readFileSync(frame, "utf8");
    const alias = path.join(repo, "alias.html");
    fs.symlinkSync(path.join(repo, "src/code.txt"), alias);
    const discover = designDirectories.discoverDesignDirectories;
    vi.spyOn(designDirectories, "discoverDesignDirectories").mockImplementation(async (...args) => {
      const result = await discover(...args);
      fs.unlinkSync(alias); fs.symlinkSync(frame, alias);
      return result;
    });
    await refused(write("alias.html"));
    expect(fs.readFileSync(frame, "utf8")).toBe(before);
    expect(fs.readFileSync(path.join(repo, "src/code.txt"), "utf8")).toBe("fixture");
  });
  it("publishes a cloud context scaffold to the tenant filesystem identity", async () => {
    const publish = vi.spyOn(ownership, "publishCloudWorkspacePath");
    await service.handle("context.graph.scaffold", target, options());
    const published = publish.mock.calls.map(([file]) => file);
    for (const rel of [".context/local/attachments", ".context/shared/attachments", ".context/.gitignore", ".context/local/.gitignore"])
      expect(published).toContain(path.join(repo, rel));
  });
  it("rechecks actor authority after sparse-checkout preflight before changing the index", async () => {
    const runGit = gitExec.runGit;
    vi.spyOn(gitExec, "runGit").mockImplementation(async (...args) => {
      try { return await runGit(...args); }
      finally { if (args[1][0] === "sparse-checkout" && args[1][1] === "list") authorized = false; }
    });
    await expect(service.handle("workspace.setWorkingDirectories", { ...target, directories: ["src"] }, options())).rejects.toThrow();
    expect(fs.existsSync(path.join(repo, "docs/readme.md"))).toBe(true);
  });
  it("does not publish an empty file tree when owner metadata cannot be checked", async () => {
    vi.spyOn(projects, "listProjects").mockImplementation(() => { throw new Error("Owner metadata unavailable"); });
    vi.spyOn(projects, "listKnownRepoRoots").mockImplementation(() => { throw new Error("Owner metadata unavailable"); });
    await expect(service.handle("file.tree", target, options())).rejects.toThrow("Owner metadata unavailable");
  });
});
