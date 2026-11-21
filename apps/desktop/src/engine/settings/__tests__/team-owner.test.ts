import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeState,
  getLocalWorkspaceOwnerForPath,
  insertWorkspace,
  setStateRootForTesting,
} from "../../git/state";
import type { Workspace } from "../../git/types";
import { resolveRepoGit } from "../repo-git";
import { opSettingsResolve, opSettingsResolveWithOverride } from "../ops";
import { resolveSpawnEnv } from "../spawn-env";
import {
  clearTeamContext,
  configureSettingsOwnerLookup,
  setTeamContext,
} from "../team-context";

const ORG_A = "org_a";
const ORG_B = "org_b";
const TEAM_DOC = {
  git: { base_branch: "team-base" },
  env: { TEAM_ONLY: "1" },
};

describe("organization settings layer follows the resolved workspace's owner", () => {
  let root: string;
  let repoRoot: string;
  let userDir: string;

  const workspace = (
    id: string,
    organizationId: string | null,
  ): Workspace => {
    const wsPath = path.join(root, "worktrees", id);
    mkdirSync(wsPath, { recursive: true });
    const ws: Workspace = {
      id,
      canonicalId: randomUUID(),
      repoSlug: "repo",
      repoRoot,
      branch: `zeros/${id}`,
      baseBranch: "main",
      path: wsPath,
      kind: "code",
      viewMode: "code",
      organizationId,
      placement: "local",
      status: "in-progress",
      createdAt: Date.now(),
      archivedAt: null,
      stashRef: null,
      archivedHead: null,
      archiveSnapshot: null,
      prNumber: null,
      prState: null,
      prUrl: null,
      agentId: null,
      lastActiveAt: null,
      setupState: null,
    };
    insertWorkspace(ws);
    return ws;
  };

  const baseBranch = (cwd?: string, owner?: { organizationId?: string | null }) =>
    (opSettingsResolve(cwd, undefined, owner).effective.git as Record<string, unknown>)
      .base_branch;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-team-owner-"));
    repoRoot = path.join(root, "repo");
    mkdirSync(repoRoot, { recursive: true });
    userDir = path.join(root, "user");
    mkdirSync(userDir, { recursive: true });
    process.env.ZEROS_USER_SETTINGS_DIR = userDir;
    setStateRootForTesting(path.join(root, "state"));
    configureSettingsOwnerLookup(getLocalWorkspaceOwnerForPath);
  });

  afterEach(() => {
    clearTeamContext();
    configureSettingsOwnerLookup(null);
    closeState();
    setStateRootForTesting(null);
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    rmSync(root, { recursive: true, force: true });
  });

  it("never applies an organization document to a Personal local workspace", () => {
    const personal = workspace("ws_personal", null);
    setTeamContext({ teamId: ORG_A, doc: TEAM_DOC });

    expect(baseBranch(personal.path)).toBe("main");
    expect(baseBranch(path.join(personal.path, "src"))).toBe("main");
    expect(resolveSpawnEnv(personal.path).env.TEAM_ONLY).toBeUndefined();
    expect(
      opSettingsResolveWithOverride(personal.path, repoRoot, {
        path: path.join(userDir, "settings.toml"),
        doc: {},
      }).sources["git.base_branch"],
    ).toBe("default");
  });

  it("applies the document to a historical workspace owned by that organization", () => {
    const owned = workspace("ws_owned", ORG_A);
    setTeamContext({ teamId: ORG_A, doc: TEAM_DOC });

    expect(baseBranch(owned.path)).toBe("team-base");
    expect(opSettingsResolve(owned.path).sources["git.base_branch"]).toBe("team");
    expect(resolveSpawnEnv(owned.path, repoRoot).env.TEAM_ONLY).toBe("1");
    expect(
      opSettingsResolveWithOverride(owned.path, repoRoot, {
        path: path.join(userDir, "settings.toml"),
        doc: {},
      }).sources["git.base_branch"],
    ).toBe("team");
  });

  it("does not apply another organization's document to an organization-owned workspace", () => {
    const owned = workspace("ws_owned_b", ORG_B);
    setTeamContext({ teamId: ORG_A, doc: TEAM_DOC });

    expect(baseBranch(owned.path)).toBe("main");
    expect(resolveSpawnEnv(owned.path).env.TEAM_ONLY).toBeUndefined();
  });

  it("resolves defaults for every owner when no document is loaded", () => {
    const personal = workspace("ws_personal_none", null);
    const owned = workspace("ws_owned_none", ORG_A);
    clearTeamContext();

    expect(baseBranch(personal.path)).toBe("main");
    expect(baseBranch(owned.path)).toBe("main");
  });

  it("treats a shared main checkout as Personal unless the caller names the workspace owner", () => {
    const owned = workspace("ws_owned_repo", ORG_A);
    workspace("ws_personal_repo", null);
    setTeamContext({ teamId: ORG_A, doc: TEAM_DOC });

    expect(baseBranch(repoRoot)).toBe("main");
    expect(baseBranch(repoRoot, owned)).toBe("team-base");
    expect(baseBranch(repoRoot, { organizationId: null })).toBe("main");
    expect(resolveRepoGit(owned.repoRoot, owned).baseBranch).toBe("team-base");
    expect(resolveRepoGit(owned.repoRoot, { organizationId: ORG_B }).baseBranch).toBe("main");
  });

  it("uses the most specific registered workspace for a nested path", () => {
    const outer = workspace("ws_outer", ORG_A);
    const innerPath = path.join(outer.path, "nested");
    mkdirSync(innerPath, { recursive: true });
    insertWorkspace({
      ...outer,
      id: "ws_inner",
      canonicalId: randomUUID(),
      branch: "zeros/ws_inner",
      path: innerPath,
      organizationId: null,
    });
    setTeamContext({ teamId: ORG_A, doc: TEAM_DOC });

    expect(baseBranch(outer.path)).toBe("team-base");
    expect(baseBranch(path.join(innerPath, "src"))).toBe("main");
  });

  it("fails closed when the engine registry is not configured", () => {
    const owned = workspace("ws_unconfigured", ORG_A);
    configureSettingsOwnerLookup(null);
    setTeamContext({ teamId: ORG_A, doc: TEAM_DOC });

    expect(baseBranch(owned.path)).toBe("main");
  });

  it("resolves with no workspace as Personal unless the caller names the owner", () => {
    setTeamContext({ teamId: ORG_A, doc: TEAM_DOC });
    expect(baseBranch()).toBe("main");
    expect(opSettingsResolve().sources["git.base_branch"]).toBe("default");
    expect(baseBranch(undefined, { organizationId: ORG_A })).toBe("team-base");
  });
});
