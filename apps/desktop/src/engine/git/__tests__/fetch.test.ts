import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetch } from "../fetch";

const fixture = vi.hoisted(() => ({ workspace: { path: "", repoRoot: "", placement: "local", baseBranch: "main", organizationId: null as string | null }, git: vi.fn() }));
vi.mock("../worktree", () => ({ getWorkspace: () => fixture.workspace }));
vi.mock("../../settings/repo-git", () => ({ resolveRepoGit: () => ({ remote: "origin" }) }));
vi.mock("../git-exec", async original => ({ ...await original<typeof import("../git-exec")>(), runGit: fixture.git }));
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-test-fetch-"));
  await mkdir(path.join(root, ".git/objects"), { recursive: true });
  fixture.workspace = { path: root, repoRoot: root, placement: "local", baseBranch: "main", organizationId: null };
  fixture.git.mockReset().mockResolvedValue({ stdout: "", stderr: "" });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.each([null, "organization"])("runs an ordinary Local fetch (owner=%s)", async organizationId => {
  fixture.workspace.organizationId = organizationId;
  expect(await fetch({ workspaceId: "local", prune: true })).toEqual({ summary: "" });
  expect(fixture.git).toHaveBeenCalledExactlyOnceWith(root, ["fetch", "--prune", "origin"], { timeoutMs: 60000 });
});
