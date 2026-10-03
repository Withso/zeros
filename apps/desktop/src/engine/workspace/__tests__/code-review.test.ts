import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CodeReviewThread, CodeReviewListResult } from "@zeros/protocol/code-review";
import { WorkspaceService, LOCAL_MAIN_WORKSPACE_ID } from "../service";
import { closeState, setStateRootForTesting } from "../../git";
import { insertWorkspace, setWorkspaceRemoteRestricted } from "../../git/state";
import type { Workspace } from "../../git/types";
import { closeZerosDb } from "../../db/database";
import { upsertRepoByRoot } from "../../db/projects";
import { codeReviewHumanActor } from "../../code-review/actors";
import { codeReviewStore } from "../../db/code-review";
import { dbChangedIncludesOriginator, dbChangedKinds } from "../change-events";

const anchor = { path: "example.ts", side: "file" as const, startLine: 1, endLine: 1, revision: "sha256:original" };
const humanIdentity = { userId: "11111111-1111-4111-8111-111111111111", deviceId: "22222222-2222-4222-8222-222222222222" };
describe("workspace code review routes and trusted attribution", () => {
  let directory: string;
  let root: string;
  let service: WorkspaceService;
  let template: Workspace;
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-code-review-routes-"));
    root = path.join(directory, "repo");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "example.ts"), "original\n");
    setStateRootForTesting(path.join(directory, "state"));
    service = new WorkspaceService(root);
    const result = await service.handle("workspace.list") as { workspaces: Workspace[] };
    template = result.workspaces.find((workspace) => workspace.id === LOCAL_MAIN_WORKSPACE_ID)!;
  });
  afterEach(() => { closeState(); setStateRootForTesting(null); fs.rmSync(directory, { recursive: true, force: true }); });
  const create = (workspaceId = LOCAL_MAIN_WORKSPACE_ID) => ({ workspaceId, anchor, body: "Review this line" });

  it("stores durable local human identity and source-neutral threads including Design anchors", async () => {
    const thread = await service.handle("codeReview.create", create()) as CodeReviewThread;
    const actor = codeReviewHumanActor();
    expect(thread.comments[0]!.author).toEqual(actor);
    expect(actor).toMatchObject({ kind: "human" });
    expect(actor.name).toMatch(/^Local reviewer [A-F0-9]{8}$/);
    fs.mkdirSync(path.join(root, "design"));
    fs.writeFileSync(path.join(root, "design", "design.toml"), '[design]\nname="Example"\n');
    fs.writeFileSync(path.join(root, "design", "page.html"), "<p>original</p>\n");
    const design = await service.handle("codeReview.create", { ...create(), anchor: { ...anchor, path: "design/page.html" } }) as CodeReviewThread;
    expect(design.comments[0]!.author).toEqual(actor);
    closeZerosDb();
    service = new WorkspaceService(root);
    const result = await service.handle("codeReview.list", { workspaceId: LOCAL_MAIN_WORKSPACE_ID }) as CodeReviewListResult;
    expect(result.threads.map((entry) => entry.id)).toContain(thread.id);
    expect(codeReviewHumanActor()).toEqual(actor);
    expect(fs.readFileSync(path.join(root, "example.ts"), "utf8")).toBe("original\n");
    expect(fs.readFileSync(path.join(root, "design", "page.html"), "utf8")).toBe("<p>original</p>\n");
    expect(fs.existsSync(path.join(root, "design", "canvas.json"))).toBe(false);
  });

  it("uses trusted transport identity, rejecting spoofed authors and unauthenticated remote writes", async () => {
    const options = { remote: true, cloudActorIdentity: humanIdentity };
    const target = path.join(root, "managed"); fs.mkdirSync(target);
    insertWorkspace({ ...template, id: "managed", path: target, repoRoot: root });
    const thread = await service.handle("codeReview.create", create("managed"), options) as CodeReviewThread;
    expect(thread.comments[0]!.author).toEqual(codeReviewHumanActor(humanIdentity.userId, true));
    const differentDevice = await service.handle("codeReview.reply", { workspaceId: "managed", threadId: thread.id, body: "Follow-up" }, { ...options, cloudActorIdentity: { ...humanIdentity, deviceId: "33333333-3333-4333-8333-333333333333" } }) as CodeReviewThread;
    expect(differentDevice.comments[1]!.author.id).toBe(thread.comments[0]!.author.id);
    for (const field of ["actor", "author", "userId", "reviewUserId"]) {
      await expect(service.handle("codeReview.create", { ...create("managed"), [field]: "forged" }, options)).rejects.toMatchObject({ code: "CODE_REVIEW_INVALID" });
    }
    await expect(service.handle("codeReview.create", create("managed"), { remote: true })).rejects.toMatchObject({ code: "CODE_REVIEW_AUTHORITY_REJECTED" });
  });

  it("uses trusted display names, distinct stable human fallbacks and exact viewer attribution", async () => {
    const first = await service.handle("codeReview.create", create(), { reviewUserId: "first-account", reviewUserName: "Ada Reviewer" }) as CodeReviewThread;
    expect(first.comments[0]!.author).toEqual({ id: "human:first-account", name: "Ada Reviewer", kind: "human" });
    const second = await service.handle("codeReview.reply", { workspaceId: LOCAL_MAIN_WORKSPACE_ID, threadId: first.id, body: "Second human" }, { reviewUserId: "second-account" }) as CodeReviewThread;
    const third = await service.handle("codeReview.reply", { workspaceId: LOCAL_MAIN_WORKSPACE_ID, threadId: first.id, body: "Third human" }, { reviewUserId: "third-account" }) as CodeReviewThread;
    expect(second.comments[1]!.author.name).not.toBe(third.comments[2]!.author.name);
    expect(second.comments[1]!.author.name).not.toContain("second-account");
    const read = await service.handle("codeReview.list", { workspaceId: LOCAL_MAIN_WORKSPACE_ID }, { reviewUserId: "second-account" }) as CodeReviewListResult;
    expect(read.viewerActorId).toBe(second.comments[1]!.author.id);
    expect(read.threads[0]!.comments[0]!.author.name).toBe("Ada Reviewer");
    expect(codeReviewHumanActor("second-account")).toEqual(second.comments[1]!.author);
    await expect(service.handle("codeReview.create", { ...create(), reviewUserName: "Forged" })).rejects.toMatchObject({ code: "CODE_REVIEW_INVALID" });
  });

  it("isolates every mutation by exact registered workspace and honors remote restriction", async () => {
    const thread = await service.handle("codeReview.create", create()) as CodeReviewThread;
    const sibling = path.join(directory, "sibling"); fs.mkdirSync(sibling);
    insertWorkspace({ ...template, id: "sibling", path: sibling, repoRoot: root });
    expect(await service.handle("codeReview.list", { workspaceId: "sibling" })).toMatchObject({ threads: [] });
    await expect(service.handle("codeReview.reply", { workspaceId: "sibling", threadId: thread.id, body: "Crossed owner" })).rejects.toMatchObject({ code: "CODE_REVIEW_NOT_FOUND" });
    await expect(service.handle("codeReview.setResolved", { workspaceId: "sibling", threadId: thread.id, resolved: true, expectedVersion: 1 })).rejects.toMatchObject({ code: "CODE_REVIEW_NOT_FOUND" });
    await expect(service.handle("codeReview.list", { workspaceId: "unknown" })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    setWorkspaceRemoteRestricted("sibling", true);
    await expect(service.handle("codeReview.list", { workspaceId: "sibling" }, { remote: true })).rejects.toMatchObject({ code: "REMOTE_RESTRICTED" });
  });

  it("rejects escape paths, symlinks, directories, private metadata and nested owners", async () => {
    fs.symlinkSync(directory, path.join(root, "outside"));
    fs.mkdirSync(path.join(root, "nested"));
    insertWorkspace({ ...template, id: "nested", path: path.join(root, "nested"), repoRoot: root });
    for (const filePath of ["../outside.ts", "/outside.ts", ".git/config", "outside/state/zeros.db", ".zeros/private.ts", "nested/file.ts", "nested"]) {
      await expect(service.handle("codeReview.create", { ...create(), anchor: { ...anchor, path: filePath } })).rejects.toThrow();
    }
    expect(await service.handle("codeReview.list", { workspaceId: LOCAL_MAIN_WORKSPACE_ID })).toMatchObject({ threads: [] });
    const deleted = await service.handle("codeReview.create", { ...create(), anchor: { ...anchor, path: "deleted.ts", side: "old" } }) as CodeReviewThread;
    expect(deleted.anchor.side).toBe("old");
  });

  it("preserves old threads but removes visibility across a newly registered nested owner", async () => {
    fs.mkdirSync(path.join(root, "nested"));
    const thread = await service.handle("codeReview.create", { ...create(), anchor: { ...anchor, path: "nested/deleted.ts", side: "old" } }) as CodeReviewThread;
    insertWorkspace({ ...template, id: "nested", path: path.join(root, "nested"), repoRoot: root });
    expect(await service.handle("codeReview.list", { workspaceId: LOCAL_MAIN_WORKSPACE_ID })).toMatchObject({ threads: [] });
    await expect(service.handle("codeReview.reply", { workspaceId: LOCAL_MAIN_WORKSPACE_ID, threadId: thread.id, body: "Late reply" })).rejects.toMatchObject({ code: "CODE_REVIEW_PATH_DENIED" });
  });

  it("does not export alias-to-sensitive-file context or admit remote alias creates/replies/resolution", async () => {
    const target = path.join(root, "managed"); fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, ".env"), "EXAMPLE=synthetic-placeholder\n");
    fs.symlinkSync(".env", path.join(target, "public-alias.txt"));
    insertWorkspace({ ...template, id: "managed", path: target, repoRoot: root });
    const input = { ...create("managed"), anchor: { ...anchor, path: "public-alias.txt", context: "EXAMPLE=synthetic-placeholder" } };
    // Seed a pre-policy thread to exercise read/reply protection as well as
    // creation. All context/source bytes are synthetic fixtures.
    const thread = codeReviewStore.create(input, codeReviewHumanActor());
    const options = { remote: true, reviewUserId: humanIdentity.userId };
    expect(await service.handle("codeReview.list", { workspaceId: "managed" }, options)).toMatchObject({ threads: [] });
    await expect(service.handle("codeReview.list", { workspaceId: "managed", path: "public-alias.txt" }, options)).rejects.toMatchObject({ code: "CODE_REVIEW_PATH_DENIED" });
    await expect(service.handle("codeReview.create", input, options)).rejects.toMatchObject({ code: "CODE_REVIEW_PATH_DENIED" });
    await expect(service.handle("codeReview.create", input)).rejects.toMatchObject({ code: "CODE_REVIEW_PATH_DENIED" });
    await expect(service.handle("codeReview.reply", { workspaceId: "managed", threadId: thread.id, body: "Remote reply" }, options)).rejects.toMatchObject({ code: "CODE_REVIEW_PATH_DENIED" });
    await expect(service.handle("codeReview.setResolved", { workspaceId: "managed", threadId: thread.id, resolved: true, expectedVersion: 1 }, options)).rejects.toMatchObject({ code: "CODE_REVIEW_PATH_DENIED" });
    const retained = codeReviewStore.get("managed", thread.id);
    expect(retained.comments).toHaveLength(1);
    expect(retained.anchor).toEqual(input.anchor);
  });

  it("admits cloud primary comments with current actor policy and hides restricted file contexts from viewers", async () => {
    const cloud = new WorkspaceService(root, { primaryDesignWorkspace: true });
    const options = { remote: true, cloudWorker: true, cloudActorIdentity: humanIdentity, cloudFileActor: { role: "developer" as const, authorized: () => true } };
    fs.writeFileSync(path.join(root, ".env"), "EXAMPLE=placeholder\n");
    await cloud.handle("codeReview.create", { ...create(), anchor: { ...anchor, path: ".env" } }, options);
    const viewer = { ...options, cloudFileActor: { role: "viewer" as const, authorized: () => true } };
    expect(await cloud.handle("codeReview.list", { workspaceId: LOCAL_MAIN_WORKSPACE_ID }, viewer)).toMatchObject({ threads: [] });
    await expect(cloud.handle("codeReview.create", create(), viewer)).rejects.toThrow();
    await expect(cloud.handle("codeReview.list", { workspaceId: LOCAL_MAIN_WORKSPACE_ID }, { ...options, cloudFileActor: { ...options.cloudFileActor, authorized: () => false } })).rejects.toThrow();
    await expect(cloud.handle("codeReview.list", { workspaceId: "other" }, options)).rejects.toMatchObject({ code: "REMOTE_RESTRICTED" });
  });

  it("binds agent tools to registered rowless roots and revokes on nested-owner or path changes", () => {
    const other = path.join(directory, "other-repo"); fs.mkdirSync(other);
    upsertRepoByRoot({ repoRoot: other, name: "Other repository" });
    const signal = new AbortController().signal;
    const scope = service.codeReviewAgentScope({ cwd: other, signal })!;
    expect(scope.workspaceId).toBe(other);
    scope.assertCurrent();
    const nested = path.join(other, "nested"); fs.mkdirSync(nested);
    const original = service.codeReviewAgentScope({ cwd: nested, signal })!;
    insertWorkspace({ ...template, id: "new-owner", path: nested, repoRoot: other });
    expect(() => original.assertCurrent()).toThrow(/changed/i);
    expect(service.codeReviewAgentScope({ cwd: nested, workspaceId: LOCAL_MAIN_WORKSPACE_ID, signal })).toBeNull();
  });

  it("classifies narrow review operations and emits exact-key invalidation including the originator", () => {
    expect(service.remoteReadable("codeReview.list")).toBe(true);
    for (const op of ["codeReview.create", "codeReview.reply", "codeReview.setResolved"]) {
      expect(service.isWriteOp(op)).toBe(true);
      expect(service.isRemoteAllowed(op)).toBe(true);
      expect(service.lifecycleMutationWorkspaceId(op, { workspaceId: LOCAL_MAIN_WORKSPACE_ID })).toBeNull();
      expect(dbChangedKinds(op)).toEqual(["codeReview"]);
      expect(dbChangedIncludesOriginator(op)).toBe(true);
    }
    expect(service.isRemoteAllowed("codeReview.delete")).toBe(false);
    expect(dbChangedKinds("codeReview.list")).toBeNull();
  });
});
