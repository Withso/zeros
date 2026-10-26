import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { WorkspaceService } from "../service";
import { repositoryFixture } from "./repository-fixture";
import { DEFERRED_GIT_OPS } from "../git";
import { commandRunner } from "../commands";

const services: WorkspaceService[] = [];
const noPr = async () => ({ prNumber: null, prState: null, prUrl: null });
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); });

it("returns one native workspace row with live HEAD and cached branch PR metadata", async () => {
  const { scope, state, git, root } = await repositoryFixture(); const calls: string[] = [], frames: BridgeMessage[] = [];
  const service = await WorkspaceService.open(scope, state, { watch: false, publish: frame => { frames.push(frame); }, lookupPr: async branch => {
    calls.push(branch); return { prNumber: 12, prState: "ready", prUrl: "https://github.com/fixture/repo/pull/12" };
  } }); services.push(service);
  const expected = { id: scope.workspace.id, path: root, repoRoot: root, repoSlug: "fixture/repo", branch: "workspace/fixture", baseBranch: "main", status: "in-progress", kind: "code", placement: "cloud", organizationId: scope.workspace.organizationId, prNumber: 12, prState: "ready", prUrl: "https://github.com/fixture/repo/pull/12", archivedAt: null, stashRef: null, agentId: null, lastActiveAt: null };
  expect(await service.handle("workspace.list", {})).toMatchObject({ workspaces: [expected] });
  expect(await service.handle("workspace.get", { workspaceId: scope.workspace.id })).toMatchObject(expected);
  expect(calls).toEqual(["workspace/fixture"]);
  expect(await service.handle("workspace.list", { archived: true })).toEqual({ workspaces: [] });
  await git("switch", "-c", "workspace/other"); await service.poll();
  expect(frames).toContainEqual(expect.objectContaining({ type: "DB_CHANGED", kinds: ["workspaces"], workspaceIds: [scope.workspace.id], gitRefsChanged: true }));
  expect(await service.handle("workspace.get", {})).toMatchObject({ branch: "workspace/other" });
  expect(calls).toEqual(["workspace/fixture", "workspace/other"]);
  await expect(service.handle("workspace.get", { workspaceId: "foreign" })).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
});

it("keeps cloud discovery on an unqualified branch when gh resolves a transferred repository", async () => {
  const { scope, state, root, git } = await repositoryFixture();
  await git("remote", "add", "origin", "https://github.com/fixture/repo.git");
  const run = commandRunner(root), lookups: string[][] = [];
  const service = await WorkspaceService.open(scope, state, {
    watch: false,
    run: async (program, args, options) => {
      if (program !== "gh") return run(program, args, options);
      lookups.push(args);
      return { code: 0, stdout: JSON.stringify({ number: 12, state: "OPEN", isDraft: false, url: "https://github.com/new-owner/repo/pull/12" }) };
    },
  });
  services.push(service);

  expect(await service.handle("workspace.get", {})).toMatchObject({
    placement: "cloud", branch: "workspace/fixture", prNumber: 12, prState: "ready", prUrl: "https://github.com/new-owner/repo/pull/12",
  });
  expect(lookups).toEqual([["pr", "view", "workspace/fixture", "--repo", "fixture/repo", "--json", "number,state,url,isDraft"]]);
  expect(await git("remote", "get-url", "origin")).toBe("https://github.com/fixture/repo.git");
  await expect(service.handle("gh.prSync", {})).rejects.toMatchObject({ code: "CLOUD_V2_UNSUPPORTED" });
});

it("persists target metadata across restart and identical replacement config", async () => {
  const { scope, state } = await repositoryFixture();
  const first = await WorkspaceService.open(scope, state, { watch: false, lookupPr: noPr }); services.push(first);
  await first.handle("git.changeTarget", { newTarget: "release" });
  await first.configure(scope.workspace); await first.dispose();
  const second = await WorkspaceService.open(scope, state, { watch: false, lookupPr: noPr }); services.push(second);
  expect(await second.handle("workspace.get", {})).toMatchObject({ baseBranch: "release" });
  await second.configure({ ...scope.workspace, baseBranch: "develop" });
  expect(await second.handle("workspace.get", {})).toMatchObject({ baseBranch: "develop" });
});

it("never puts a previous branch's slow PR response on the new branch", async () => {
  const { scope, state, git } = await repositoryFixture();
  let resolve!: (value: { prNumber: number; prState: "ready"; prUrl: string }) => void;
  const pending = new Promise<{ prNumber: number; prState: "ready"; prUrl: string }>(done => { resolve = done; });
  let requested = false;
  const service = await WorkspaceService.open(scope, state, { watch: false, lookupPr: branch => {
    if (branch === "workspace/fixture") { requested = true; return pending; }
    return Promise.resolve({ prNumber: null, prState: null, prUrl: null });
  } }); services.push(service);
  const row = service.handle("workspace.get", {});
  await expect.poll(() => requested).toBe(true);
  await git("switch", "-c", "workspace/new");
  resolve({ prNumber: 12, prState: "ready", prUrl: "https://github.com/fixture/repo/pull/12" });
  expect(await row).toMatchObject({ branch: "workspace/new", prNumber: null });
});

it("notifies clients after native nested file edits and branch switches", async () => {
  const { scope, state, root, git } = await repositoryFixture(); const frames: BridgeMessage[] = [];
  const service = await WorkspaceService.open(scope, state, { lookupPr: noPr, publish: frame => { frames.push(frame); } }); services.push(service);
  await service.handle("file.write", { path: "src/nested.txt", content: "first\n" });
  await service.flush(); frames.length = 0;
  await writeFile(join(root, "src/nested.txt"), "second\n");
  await expect.poll(() => frames.some(frame => frame.type === "DB_CHANGED")).toBe(true);
  await git("switch", "main");
  await expect.poll(async () => (await service.handle("workspace.get", {}) as { branch: string }).branch).toBe("main");
});

it("explicitly reports the remaining Git operation gaps", async () => {
  const { scope, state } = await repositoryFixture(); const service = await WorkspaceService.open(scope, state, { watch: false }); services.push(service);
  for (const op of DEFERRED_GIT_OPS) await expect(service.handle(op, {})).rejects.toMatchObject({ code: "CLOUD_V2_UNSUPPORTED" });
});
