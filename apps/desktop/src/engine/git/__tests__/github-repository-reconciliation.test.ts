import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeZerosDb, setZerosDbPathForTesting } from "../../db";
import { listProjects, removeRepoByRoot, upsertRepoByRoot } from "../../db/projects";
import { WorkspaceService } from "../../workspace/service";
import { engineGithubTokenStore, seedGithubToken } from "../engine-token-store";
import { resolveGithubWorkspaceRepository, setOctokitFactoryForTesting, setTokenStoreForTesting } from "../github";
import * as repoSettings from "../../settings/repo-git";
import { getWorkspaceById, insertWorkspace, updateWorkspace } from "../state";

const oldUrl = "git@github.com:former/widgets.git";
const newUrl = "git@github.com:current/renamed.git";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("verified GitHub repository reconciliation", () => {
  let root: string;
  let service: WorkspaceService;
  let repository: { id: number; node_id: string; owner: { login: string }; name: string };
  let get: ReturnType<typeof vi.fn>;
  let graphql: ReturnType<typeof vi.fn>;
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const project = () => listProjects([])[0];
  const reconcile = () => service.handle("project.reconcileGithubRemote", { repoRoot: root });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-repository-move-"));
    setZerosDbPathForTesting(path.join(root, "state.db"));
    git("init", "--quiet", "-b", "main");
    git("remote", "add", "origin", oldUrl);
    upsertRepoByRoot({ repoRoot: root, name: "My project", repoSlug: "former-widgets", originUrl: oldUrl });
    insertWorkspace({ id: "ws_fixture", repoRoot: root, repoSlug: "former-widgets", path: root,
      branch: "main", baseBranch: "main", status: "in-progress", createdAt: 1,
      archivedAt: null, stashRef: null, prNumber: null, prUrl: null, prState: null, agentId: null, lastActiveAt: null });
    service = new WorkspaceService(root);
    repository = { id: 123, node_id: "R_fixture", owner: { login: "current" }, name: "renamed" };
    get = vi.fn(async () => ({ data: repository }));
    graphql = vi.fn(async () => ({ node: { databaseId: repository.id, id: repository.node_id, name: repository.name, owner: repository.owner } }));
    setOctokitFactoryForTesting(() => ({ repos: { get }, graphql }) as never);
    setTokenStoreForTesting(engineGithubTokenStore);
    seedGithubToken("test-selected-connection");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    seedGithubToken(null);
    setTokenStoreForTesting(null);
    setOctokitFactoryForTesting(null);
    closeZerosDb();
    setZerosDbPathForTesting(null);
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    [oldUrl, newUrl],
    ["https://github.com/former/widgets.git", "https://github.com/current/renamed.git"],
    ["https://reader@github.com/former/widgets", "https://reader@github.com/current/renamed"],
    ["ssh://git@ssh.github.com:443/former/widgets.git", "ssh://git@ssh.github.com:443/current/renamed.git"],
    ["github.com:former/widgets.git", "github.com:current/renamed.git"],
  ])("updates %s and saved Origin, preserving local identities", async (before, after) => {
    git("remote", "set-url", "origin", before);
    const original = project();
    await reconcile();
    expect(git("remote", "get-url", "origin")).toBe(after);
    expect(project()).toMatchObject({ ...original, originUrl: after, originRevision: original.originRevision + 1 });
    expect(git("config", "--get", "remote.origin.fetch")).toBe("+refs/heads/*:refs/remotes/origin/*");
  });

  it("follows the recorded immutable ID after restart, even when the old name is reused", async () => {
    await reconcile();
    closeZerosDb();
    repository = { ...repository, owner: { login: "third" }, name: "latest" };
    get.mockResolvedValue({ data: { id: 456, node_id: "R_other", owner: { login: "current" }, name: "renamed" } });
    await reconcile();
    expect(graphql).toHaveBeenCalledWith(expect.any(String), { id: "R_fixture" });
    expect(git("remote", "get-url", "origin")).toBe("git@github.com:third/latest.git");
    expect(get).toHaveBeenCalledTimes(1);
    expect(project().repoSlug).toBe("former-widgets");
  });

  it("uses the saved ID for read-only Review resolution without rewriting Git", async () => {
    await reconcile();
    repository = { ...repository, owner: { login: "third" } };
    const config = await readFile(path.join(root, ".git/config"), "utf8");
    await expect(resolveGithubWorkspaceRepository("ws_fixture")).resolves.toEqual({ owner: "third", repo: "renamed", remote: "origin" });
    expect(await readFile(path.join(root, ".git/config"), "utf8")).toBe(config);
  });

  it("does not bind a different repository ID returned for a saved node", async () => {
    await reconcile();
    repository = { ...repository, id: 456, owner: { login: "unrelated" } };
    await expect(reconcile()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(git("remote", "get-url", "origin")).toBe(newUrl);
  });

  it("keeps a deliberately changed remote and learns its separate identity", async () => {
    await reconcile();
    git("remote", "set-url", "origin", "https://github.com/another/project.git");
    repository = { id: 789, node_id: "R_another", owner: { login: "another" }, name: "project" };
    await reconcile();
    expect(get).toHaveBeenLastCalledWith({ owner: "another", repo: "project" });
    expect(project().originUrl).toBe("https://github.com/another/project.git");
  });

  it("repairs a configured upstream without replacing an independent fork push URL", async () => {
    const settings = repoSettings.resolveRepoGit(root);
    vi.spyOn(repoSettings, "resolveRepoGit").mockReturnValue({ ...settings, remote: "upstream" });
    git("remote", "add", "upstream", oldUrl);
    git("remote", "set-url", "--push", "upstream", "git@github.com:fork/widgets.git");
    git("remote", "set-url", "origin", "git@github.com:fork/widgets.git");
    get.mockImplementation(async ({ owner }: { owner: string }) => ({ data: owner === "fork"
      ? { id: 999, node_id: "R_fork", owner: { login: "fork" }, name: "widgets" } : repository }));
    await reconcile();
    expect(git("remote", "get-url", "upstream")).toBe(newUrl);
    expect(git("remote", "get-url", "--push", "upstream")).toBe("git@github.com:fork/widgets.git");
    expect(git("remote", "get-url", "origin")).toBe("git@github.com:fork/widgets.git");
    expect(project().originUrl).toBe("git@github.com:fork/widgets.git");
  });

  it("repairs a separate push URL only when it names the same verified repository", async () => {
    git("remote", "set-url", "--push", "origin", "https://github.com/former/widgets.git");
    await reconcile();
    expect(git("remote", "get-url", "--push", "origin")).toBe("https://github.com/current/renamed.git");
  });

  it("keeps duplicate push URL entries at the same cardinality", async () => {
    git("config", "--add", "remote.origin.pushurl", oldUrl);
    git("config", "--add", "remote.origin.pushurl", oldUrl);
    await reconcile();
    expect(git("config", "--get-all", "remote.origin.pushurl").split("\n")).toEqual([newUrl, newUrl]);
  });

  it("updates matching saved PR URLs while leaving the workspace and chat owner intact", async () => {
    updateWorkspace("ws_fixture", { prNumber: 28, prUrl: "https://github.com/former/widgets/pull/28" });
    const before = getWorkspaceById("ws_fixture");
    await reconcile();
    expect(getWorkspaceById("ws_fixture")).toEqual({ ...before, prUrl: "https://github.com/current/renamed/pull/28" });
  });

  it("does not carry a removed checkout's binding into an explicit re-add", async () => {
    await reconcile();
    removeRepoByRoot(root);
    upsertRepoByRoot({ repoRoot: root, originUrl: newUrl });
    repository = { id: 789, node_id: "R_replacement", owner: { login: "current" }, name: "renamed" };
    await reconcile();
    expect(get).toHaveBeenCalledTimes(2);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("accepts the inspected Origin when explicitly re-adding a replacement checkout", async () => {
    removeRepoByRoot(root);
    await service.handle("project.upsert", { repoRoot: root, originUrl: "https://example.test/replacement.git" });
    expect(project().originUrl).toBe("https://example.test/replacement.git");
  });

  it.each(["project.upsert", "project.bulkUpsert"])("%s distinguishes an omitted Origin from an inspected removal", async op => {
    const before = project();
    const save = (row: { repoRoot: string; originUrl?: string | null; originRevision?: number }) =>
      service.handle(op, op === "project.upsert" ? row : { projects: [row] });
    await save({ repoRoot: root });
    expect(project().originUrl).toBe(oldUrl);
    await save({ repoRoot: root, originUrl: null, originRevision: before.originRevision });
    expect(project()).toMatchObject({ originUrl: null, originRevision: before.originRevision + 1 });
    await save(before);
    expect(project().originUrl).toBeNull();
  });

  it("does not flatten multiple fetch URLs or inherited insteadOf configuration", async () => {
    git("remote", "set-url", "--add", "origin", "git@github.com:mirror/widgets.git");
    const before = await readFile(path.join(root, ".git/config"), "utf8");
    await reconcile();
    expect(await readFile(path.join(root, ".git/config"), "utf8")).toBe(before);
    expect(get).not.toHaveBeenCalled();
  });

  it.each(["insteadOf", "pushInsteadOf"])("retains an inherited %s transport rule", async rule => {
    git("config", `url.ssh://git@mirror.example.test/.${rule}`, "git@github.com:");
    const before = await readFile(path.join(root, ".git/config"), "utf8");
    await reconcile();
    expect(await readFile(path.join(root, ".git/config"), "utf8")).toBe(before);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a held transfer after an included push rewrite changes", async () => {
    const included = path.join(root, "transport.config");
    await writeFile(included, "");
    git("config", "include.path", included);
    const before = await readFile(path.join(root, ".git/config"), "utf8");
    const entered = deferred(), release = deferred();
    get.mockImplementation(async () => { entered.resolve(); await release.promise; return { data: repository }; });
    const operation = reconcile();
    await Promise.race([entered.promise, operation]);
    expect(get).toHaveBeenCalledOnce();
    await writeFile(included, '[url "ssh://git@mirror.example.test/"]\n\tpushInsteadOf = git@github.com:\n');
    release.resolve();
    await operation;
    expect(await readFile(path.join(root, ".git/config"), "utf8")).toBe(before);
    expect(project().originUrl).toBe(oldUrl);
  });

  it.each([401, 403, 404, 500])("retains remote and metadata when GitHub refuses or fails (%s)", async status => {
    get.mockRejectedValue(Object.assign(new Error("GitHub request failed"), { status }));
    const before = project();
    await expect(reconcile()).rejects.toBeDefined();
    expect(git("remote", "get-url", "origin")).toBe(oldUrl);
    expect(project()).toEqual(before);
  });

  it.each(["account", "account-return", "remote", "removed", "readded", "settings"])("rejects a held reply after %s changes", async change => {
    const entered = deferred(), release = deferred();
    get.mockImplementation(async () => { entered.resolve(); await release.promise; return { data: repository }; });
    const operation = reconcile();
    await Promise.race([entered.promise, operation]);
    expect(get).toHaveBeenCalledTimes(1);
    if (change.startsWith("account")) {
      seedGithubToken("test-other-connection");
      if (change === "account-return") seedGithubToken("test-selected-connection");
    } else if (change === "remote") git("remote", "set-url", "origin", "git@github.com:manual/choice.git");
    else if (change === "settings") vi.spyOn(repoSettings, "resolveRepoGit").mockReturnValue({ ...repoSettings.resolveRepoGit(root), remote: "fork" });
    else {
      removeRepoByRoot(root);
      if (change === "readded") upsertRepoByRoot({ repoRoot: root, originUrl: oldUrl });
    }
    release.resolve();
    await operation;
    expect(git("remote", "get-url", "origin")).toBe(change === "remote" ? "git@github.com:manual/choice.git" : oldUrl);
    if (change === "removed") expect(listProjects([])).toEqual([]);
    else expect(project().originUrl).toBe(oldUrl);
  });

  it("retains an existing Git config lock, without partially updating saved metadata", async () => {
    const lock = path.join(root, ".git/config.lock");
    await writeFile(lock, "other process owns this lock");
    await expect(reconcile()).rejects.toBeDefined();
    expect(git("remote", "get-url", "origin")).toBe(oldUrl);
    expect(project().originUrl).toBe(oldUrl);
    expect(await readFile(lock, "utf8")).toBe("other process owns this lock");
  });

  it("cannot restore an obsolete Origin through the renderer's old boot cache", async () => {
    const before = project();
    await reconcile();
    await service.handle("project.bulkUpsert", { projects: [before] });
    expect(project().originUrl).toBe(newUrl);
    expect(project().repoSlug).toBe(before.repoSlug);
    expect(project().canonicalId).toBe(before.canonicalId);
  });
});
