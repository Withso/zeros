import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { boundedInteger, commandRunner, safeRef, type CommandOptions, type CommandRunner } from "./commands";
import { bucketPorcelain, parseNameStatus, parseNumstat, parseUnifiedDiff, type DiffFileSummary } from "./git-parsers";
import { reqString, unsupported, WorkspaceError, type WorkspaceScope } from "./scope";
import { CheckedFiles } from "./checked-files";

type ConflictState = "merge" | "rebase" | "cherry-pick" | "revert" | null;
interface GitOptions {
  run?: CommandRunner;
  baseBranch?: () => string;
  setBaseBranch?: (branch: string) => Promise<void>;
  changed?: () => void;
  historyDiff?: (params: Record<string, unknown>) => Promise<unknown>;
}
const WRITE_OPS = new Set(["git.stage", "git.unstage", "git.discard", "git.clean", "git.commit", "git.push", "git.pull", "git.rebase", "git.fetch", "git.stashSave", "git.stashPop", "git.stashApply", "git.stashDrop", "git.checkoutBranch", "git.createBranch", "git.renameBranch", "git.changeTarget", "git.merge", "git.cherryPick", "git.revert", "git.continue", "git.abort", "git.deleteBranch", "git.tagCreate", "git.tagDelete"]);
export const DEFERRED_GIT_OPS = ["git.reset", "git.restore", "git.stageHunk", "git.unstageHunk", "git.discardHunk", "git.initInPlace", "git.repoBranchCatalog", "git.listAllBranches"] as const;

/** One checkout-scoped writer queue. Ordinary reads never wait behind a
 * fetch, push or editor operation; every comparison has its own Git baseline. */
export class GitService {
  private readonly run: CommandRunner;
  private mutations = Promise.resolve();
  constructor(readonly scope: WorkspaceScope, private readonly options: GitOptions = {}) { this.run = options.run ?? commandRunner(scope.root); }
  get baseBranch(): string { return this.options.baseBranch?.() ?? this.scope.workspace.baseBranch; }

  handle(op: string, params: Record<string, unknown>): Promise<unknown> {
    this.scope.assertId(params.workspaceId);
    for (const key of ["cwd", "folder", "repoRoot"]) if (params[key] !== undefined) this.scope.folder(params[key]);
    if (!WRITE_OPS.has(op)) return this.read(op, params);
    const pending = this.mutations.then(async () => {
      try { return await this.write(op, params); }
      finally { this.options.changed?.(); }
    });
    this.mutations = pending.then(() => {}, () => {});
    return pending;
  }
  flush(): Promise<void> { return this.mutations; }
  async branch(): Promise<string> { return (await this.probe(["symbolic-ref", "--quiet", "--short", "HEAD"])) ?? "HEAD"; }
  async head(): Promise<string | null> { return this.probe(["rev-parse", "--verify", "HEAD"]); }
  private async git(args: string[], options: CommandOptions = {}): Promise<string> { return (await this.run("git", args, options)).stdout; }
  private async probe(args: string[]): Promise<string | null> { try { return (await this.git(args, { readOnly: true })).trim() || null; } catch { return null; } }
  private paths(value: unknown, max = 5000): string[] {
    if (!Array.isArray(value) || value.length > max) throw new WorkspaceError("VALIDATION_FAILED", "Expected a list of workspace file paths.");
    return [...new Set(value.map(path => this.scope.relative(path)))];
  }
  private literal(paths: string[]): string[] { return paths.map(path => `:(literal)${path}`); }

  async tracking(): Promise<{ ahead: number | null; behind: number | null; upstream: string | null }> {
    const upstream = await this.probe(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    if (!upstream) return { ahead: null, behind: null, upstream: null };
    const counts = await this.probe(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    if (!counts) return { ahead: null, behind: null, upstream };
    const [ahead, behind] = counts.split(/\s+/).map(Number); return { ahead, behind, upstream };
  }

  async conflictState(): Promise<ConflictState> {
    const dir = await this.probe(["rev-parse", "--absolute-git-dir"]);
    if (!dir) return null;
    for (const [file, state] of [["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"], ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"]] as const) {
      if (await access(join(dir, file)).then(() => true, () => false)) return state;
    }
    return null;
  }

  private async status(params: Record<string, unknown> = {}) {
    const paths = params.paths === undefined ? [] : this.literal(this.paths(params.paths, 256));
    const [raw, conflictState, tracking, shallow] = await Promise.all([
      this.git(["status", "--porcelain=v1", "-z", "-uall", ...(paths.length ? ["--", ...paths] : [])], { readOnly: true }),
      this.conflictState(), params.includeTracking === false ? { ahead: null, behind: null, upstream: null } : this.tracking(),
      this.probe(["rev-parse", "--is-shallow-repository"]),
    ]);
    return { ...bucketPorcelain(raw), conflictState, ...tracking, shallow: shallow === "true" };
  }

  private async headOrEmpty(): Promise<string> {
    const head = await this.head(); if (head) return head;
    const format = await this.probe(["rev-parse", "--show-object-format"]);
    return createHash(format === "sha256" ? "sha256" : "sha1").update("tree 0\0").digest("hex");
  }

  /** Matches Local's deepest local/remote merge-base and creation-reflog
   * fallback, so a stale main or an already-merged branch doesn't lie. */
  private async forkPoint(base = this.baseBranch): Promise<string | null> {
    safeRef(base);
    const candidates = [...new Set([base, `origin/${base}`, "origin/HEAD", "main", "master", "origin/main", "origin/master"])];
    let resolved: string | null = null;
    for (const ref of candidates) if (await this.probe(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) { resolved = ref; break; }
    const head = await this.head(); if (!resolved || !head) return null;
    let floor: string | null = null;
    for (const ref of new Set([resolved, base, `origin/${base}`])) {
      const candidate = await this.probe(["merge-base", ref, "HEAD"]);
      if (candidate && (!floor || await this.git(["merge-base", "--is-ancestor", floor, candidate], { readOnly: true }).then(() => true, () => false))) floor = candidate;
    }
    if (!floor || floor === head) {
      const branch = await this.branch();
      if (branch !== "HEAD" && branch !== base && branch !== resolved && `origin/${branch}` !== resolved) {
        const oldest = (await this.probe(["reflog", "show", "--format=%H%x09%gs", branch]))?.split("\n").pop();
        if (oldest && /^[a-f0-9]+\tbranch: Created from/.test(oldest)) floor = oldest.split("\t")[0];
      }
    }
    return floor && floor !== head ? floor : null;
  }

  private async comparison(params: Record<string, unknown>): Promise<string[]> {
    const mode = params.mode ?? (params.against === "HEAD" ? "worktree-vs-head" : params.against === "main" ? "base" : "worktree-vs-index");
    switch (mode) {
      case "index-vs-head": return ["--cached"];
      case "worktree-vs-index": return [];
      case "worktree-vs-head": return [await this.headOrEmpty()];
      case "worktree-vs-base": return [await this.forkPoint(params.base === undefined ? undefined : safeRef(params.base)) ?? await this.headOrEmpty()];
      case "base": return [await this.forkPoint(params.base === undefined ? undefined : safeRef(params.base)) ?? await this.headOrEmpty(), "HEAD"];
      case "refs": return [`${await this.forkPoint(safeRef(params.base)) ?? safeRef(params.base)}...${safeRef(params.head ?? "HEAD")}`];
      case "range": return [safeRef(params.base), safeRef(params.head ?? "HEAD")];
      default: throw new WorkspaceError("VALIDATION_FAILED", "Unknown Git comparison.");
    }
  }

  private async metadata(range: string[], paths: string[] = []): Promise<DiffFileSummary[]> {
    const args = ["--no-ext-diff", "--no-textconv", "--no-color", ...range, "--", ...this.literal(paths)];
    const [names, numbers] = await Promise.all([
      this.git(["diff", "--name-status", "-z", ...args], { readOnly: true }),
      this.git(["diff", "--numstat", "-z", ...args], { readOnly: true }),
    ]);
    const stats = new Map(parseNumstat(numbers).map(file => [file.path, file]));
    return parseNameStatus(names).map(file => ({ ...file, additions: stats.get(file.path)?.additions ?? 0, deletions: stats.get(file.path)?.deletions ?? 0, binary: stats.get(file.path)?.binary ?? false }));
  }

  private async counts(lines = false) {
    const head = await this.headOrEmpty(), floor = await this.forkPoint() ?? head;
    const [all, raw] = await Promise.all([this.metadata([floor]), this.status({ includeTracking: false })]);
    const conflicts = new Set(raw.conflicted.map(file => file.path));
    const visible = (files: DiffFileSummary[]) => files.filter(file => !conflicts.has(file.path));
    if (!lines) {
      const [uncommitted, staged, unstaged] = await Promise.all([this.metadata([head]), this.metadata(["--cached"]), this.metadata([])]);
      const count = (files: DiffFileSummary[], untracked = false) => new Set([...conflicts, ...visible(files).map(file => file.path), ...(untracked ? raw.untracked : [])]).size;
      return { all: count(all, true), uncommitted: count(uncommitted, true), staged: count(staged), unstaged: count(unstaged, true) };
    }
    const result = visible(all).reduce((sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }), { additions: 0, deletions: 0 });
    // Git counts symlinks/binary files correctly; never read their targets.
    for (const path of raw.untracked) {
      this.scope.path(path);
      const rawStats = await this.git(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--no-index", "--", "/dev/null", path], { readOnly: true, allowExitCodes: [1] });
      for (const file of parseNumstat(rawStats)) { result.additions += file.additions; result.deletions += file.deletions; }
    }
    return result;
  }

  private async read(op: string, params: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case "git.status": return this.status(params);
      case "git.changeCounts": return this.counts();
      case "git.changeLineCounts": return this.counts(true);
      case "git.hasChanges": return { hasChanges: (await this.counts() as { all: number }).all > 0 };
      case "git.diff": {
        if (params.history !== undefined) return this.options.historyDiff?.(params) ?? unsupported();
        const range = await this.comparison(params);
        const paths = [params.filePath, params.oldFilePath].filter(value => value !== undefined).map(value => this.scope.relative(value));
        if (params.fullContext === true && !paths.length) throw new WorkspaceError("VALIDATION_FAILED", "Full context requires a file.");
        let files: DiffFileSummary[] | undefined;
        if (params.summaryLimit !== undefined) {
          const limit = boundedInteger(params.summaryLimit, 100, 100_000); files = await this.metadata(range, paths);
          if (files.length > limit) return { hunks: [], files, summary: true };
        }
        try {
          const patch = await this.git(["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color", params.fullContext === true ? "-U2147483647" : "-U3", ...range, "--", ...this.literal(paths)], { readOnly: true, maxBuffer: 6 * 1024 * 1024 });
          return { hunks: parseUnifiedDiff(patch), ...(params.rawPatch === true ? { patch } : {}) };
        } catch (error) {
          if (files && error instanceof WorkspaceError && error.code === "GIT_OUTPUT_TOO_LARGE") return { hunks: [], files, summary: true };
          throw error;
        }
      }
      case "git.show": {
        const sha = safeRef(params.sha);
        const [names, patch] = await Promise.all([
          this.git(["diff-tree", "--root", "--no-commit-id", "-r", "--name-status", "-z", sha, "--"], { readOnly: true }),
          this.git(["-c", "core.quotePath=false", "show", "--format=", "--no-ext-diff", "--no-textconv", "--no-color", sha, "--"], { readOnly: true, maxBuffer: 6 * 1024 * 1024 }),
        ]); return { files: parseNameStatus(names), patch };
      }
      case "git.log": {
        const ref = safeRef(params.ref ?? "HEAD"), base = params.base === undefined ? undefined : safeRef(params.base);
        const args = ["log", "-z", "--format=%H%x00%h%x00%B%x00%an%x00%ae%x00%at%x00%P", `--max-count=${boundedInteger(params.limit, 50, 1000, 1)}`, `--skip=${boundedInteger(params.skip, 0, 100_000)}`];
        if (params.since !== undefined) args.push(`--since=@${boundedInteger(params.since, 0, Number.MAX_SAFE_INTEGER) / 1000}`);
        if (!(await this.head())) return { commits: [] };
        const fields = (await this.git([...args, base ? `${base}..${ref}` : ref, "--"], { readOnly: true })).split("\0"), commits = [];
        for (let i = 0; i + 6 < fields.length; i += 7) commits.push({ sha: fields[i], abbreviatedSha: fields[i + 1], message: fields[i + 2], authorName: fields[i + 3], authorEmail: fields[i + 4], authorDate: Number(fields[i + 5]) * 1000, parents: fields[i + 6].split(" ").filter(Boolean) });
        return { commits };
      }
      case "git.branches": return { branches: await this.branches(false) };
      case "git.remoteBranches": return { branches: await this.branches(true) };
      case "git.stashList": return this.stashes();
      case "git.tagList": return (await this.git(["tag", "--list"], { readOnly: true })).split("\n").filter(Boolean);
      default: return unsupported();
    }
  }

  private async branches(remote: boolean) {
    const prefix = remote ? "refs/remotes/origin/" : "refs/heads/", branch = await this.branch();
    const raw = await this.git(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)", prefix], { readOnly: true });
    return raw.split("\n").filter(Boolean).flatMap(line => {
      const [ref, tipSha, date] = line.split("\0"), name = ref.slice(prefix.length);
      if (name === "HEAD") return [];
      return [{ name, tipSha, isCheckedOut: name === branch, worktreePath: !remote && name === branch ? this.scope.root : null, origin: "zeros", lastCommitDate: Number(date) * 1000, prUrl: null }];
    }).sort((a, b) => b.lastCommitDate - a.lastCommitDate);
  }
  private async stashes() {
    return (await this.git(["stash", "list", "--format=%gd%x00%H%x00%ct%x00%gs"], { readOnly: true })).split("\n").filter(Boolean).map((line, index) => {
      const [ref, sha, date, message] = line.split("\0"); return { index, ref, sha, message, date: Number(date) * 1000 };
    });
  }
  private async remote(value: unknown): Promise<string> {
    const remote = safeRef(value ?? "origin");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(remote) || !(await this.git(["remote"], { readOnly: true })).split("\n").includes(remote)) throw new WorkspaceError("VALIDATION_FAILED", "Choose an existing Git remote.");
    return remote;
  }
  private async requireBranch(): Promise<string> {
    const branch = await this.branch(); if (branch === "HEAD") throw new WorkspaceError("VALIDATION_FAILED", "Check out a branch before this operation."); return branch;
  }
  private async validBranch(value: unknown): Promise<string> {
    const branch = safeRef(value);
    try { await this.git(["check-ref-format", `refs/heads/${branch}`], { readOnly: true }); }
    catch { throw new WorkspaceError("VALIDATION_FAILED", "Invalid Git branch name."); }
    return branch;
  }
  private async integration(args: string[]) {
    try { await this.git(args, { timeout: 120_000 }); return { applied: true, conflicts: [] as string[] }; }
    catch (error) {
      const conflicts = (await this.status({ includeTracking: false })).conflicted.map(file => file.path);
      if (!conflicts.length) throw error; return { applied: false, conflicts };
    }
  }

  private async write(op: string, params: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case "git.clean": {
        const paths = this.paths(params.paths), literal = this.literal(paths);
        if (!paths.length || params.confirm !== true) throw new WorkspaceError("VALIDATION_FAILED", "Cleaning requires confirmed, explicit file paths.");
        const untracked = new Set((await this.git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...literal], { readOnly: true })).split("\0").filter(Boolean));
        if (paths.some(path => !untracked.has(path))) throw new WorkspaceError("VALIDATION_FAILED", "Only untracked files can be cleaned.");
        const checked = new CheckedFiles(this.scope), handles = [];
        try {
          // This file action never expands directories or pathspec programs.
          // Validate the whole batch, including symlink resolution, first.
          for (const path of paths) handles.push(await checked.file(path));
          for (const handle of handles) await checked.assertDescriptor(handle);
          const output = await this.git(["clean", "-f", "--", ...literal]);
          return { removed: output.split("\n").map(line => line.replace(/^Removing /, "").trim()).filter(Boolean) };
        } finally { await Promise.all(handles.map(handle => handle.close())); }
      }
      case "git.stage": case "git.unstage": case "git.discard": {
        const paths = this.paths(params.paths); if (!paths.length) return { ok: true };
        const literal = this.literal(paths);
        if (op === "git.stage") await this.git(["add", "-A", "--", ...literal]);
        else if (op === "git.unstage") await this.git(await this.head() ? ["reset", "HEAD", "--", ...literal] : ["rm", "--cached", "--ignore-unmatch", "--", ...literal]);
        else {
          const status = await this.status({ paths, includeTracking: false }), untracked = new Set(status.untracked);
          const tracked = paths.filter(path => !untracked.has(path));
          if (tracked.length) await this.git(["restore", "--worktree", "--", ...this.literal(tracked)]);
          if (untracked.size) await this.git(["clean", "-f", "--", ...this.literal([...untracked])]);
        }
        return { ok: true };
      }
      case "git.commit": {
        const message = reqString(params, "message"), files = params.files === undefined ? [] : this.paths(params.files);
        if (files.length) await this.git(["add", "-A", "--", ...this.literal(files)]);
        await this.git(["commit", ...(params.amend === true ? ["--amend"] : []), "-F", "-", ...(files.length ? ["--only", "--", ...this.literal(files)] : [])], { input: message + "\n", timeout: 120_000 });
        return { sha: await this.head(), branch: await this.branch() };
      }
      case "git.push": {
        const branch = await this.requireBranch(), remote = await this.remote(params.remote);
        await this.git(["push", ...(params.setUpstream === false ? [] : ["-u"]), ...(params.force === true ? ["--force-with-lease"] : []), remote, branch], { timeout: 120_000 });
        const [behind = 0, ahead = 0] = (await this.probe(["rev-list", "--left-right", "--count", `${remote}/${branch}...HEAD`]) ?? "0 0").split(/\s+/).map(Number);
        return { remoteRef: `${remote}/${branch}`, ahead, behind };
      }
      case "git.fetch": {
        const remote = await this.remote(params.remote);
        await this.git(["fetch", ...(params.prune === true ? ["--prune"] : []), ...(params.unshallow === true ? ["--unshallow"] : []), remote], { timeout: 120_000 });
        return { ok: true };
      }
      case "git.pull": {
        const remote = await this.remote(params.remote), branch = await this.requireBranch();
        if (params.strategy !== undefined && params.strategy !== "merge" && params.strategy !== "rebase") throw new WorkspaceError("VALIDATION_FAILED", "Invalid pull strategy.");
        return this.integration(["pull", params.strategy === "merge" ? "--no-rebase" : "--rebase", ...(params.autoStash === true ? ["--autostash"] : []), remote, branch]);
      }
      case "git.rebase": return this.integration(["rebase", ...(params.autoStash === true ? ["--autostash"] : []), safeRef(params.ontoBranch)]);
      case "git.merge": return this.integration(["merge", "--no-edit", ...(params.noFF === true ? ["--no-ff"] : []), safeRef(params.branch)]);
      case "git.cherryPick": return this.integration(["cherry-pick", safeRef(params.sha)]);
      case "git.revert": return this.integration(["revert", "--no-edit", safeRef(params.sha)]);
      case "git.continue": case "git.abort": {
        const state = await this.conflictState();
        if (!state) return { applied: false, conflicts: [] };
        return this.integration([state, op === "git.abort" ? "--abort" : "--continue"]);
      }
      case "git.checkoutBranch": {
        const branch = await this.validBranch(params.branchName);
        const exists = await this.probe(["show-ref", "--verify", `refs/heads/${branch}`]);
        await this.git(["switch", ...(!exists && params.createIfMissing === true ? ["-c", branch] : ["--", branch])]); return { ok: true };
      }
      case "git.createBranch": {
        await this.git(["switch", "-c", await this.validBranch(params.newBranchName), safeRef(params.sourceBranch)]); return { ok: true };
      }
      case "git.renameBranch": {
        const current = await this.requireBranch(), prefix = current.slice(0, current.lastIndexOf("/") + 1), input = reqString(params, "newName");
        const slug = prefix && input.startsWith(prefix) ? input.slice(prefix.length) : input;
        if (!/^[a-zA-Z][a-zA-Z0-9-]{2,48}$/.test(slug)) throw new WorkspaceError("VALIDATION_FAILED", "Use 3–49 letters, numbers or hyphens, starting with a letter.");
        const branch = await this.validBranch(prefix + slug); if (branch !== current) await this.git(["branch", "-m", branch]);
        return { ok: true, branch };
      }
      case "git.changeTarget": {
        if (!this.options.setBaseBranch) return unsupported();
        const baseBranch = await this.validBranch(params.newTarget);
        let conflicts: string[] = [];
        if (params.rebase === true) {
          const target = await this.probe(["show-ref", "--verify", `refs/heads/${baseBranch}`]) ? baseBranch : `origin/${baseBranch}`;
          conflicts = (await this.integration(["rebase", "--autostash", target])).conflicts;
        }
        await this.options.setBaseBranch(baseBranch); return { baseBranch, conflicts };
      }
      case "git.deleteBranch": await this.git(["branch", params.force === true ? "-D" : "-d", await this.validBranch(params.branchName)]); return { ok: true };
      case "git.stashSave": {
        const before = await this.probe(["rev-parse", "--verify", "refs/stash"]);
        await this.git(["stash", "push", "--include-untracked", ...(params.message === undefined ? [] : ["-m", reqString(params, "message")])]);
        const after = await this.probe(["rev-parse", "--verify", "refs/stash"]); return { stashRef: after !== before ? after : null };
      }
      case "git.stashPop": case "git.stashApply": case "git.stashDrop": {
        const input = safeRef(params.stashRef), stash = (await this.stashes()).find(stash => stash.ref === input || stash.sha === input);
        if (op === "git.stashDrop") { if (!stash) throw new WorkspaceError("VALIDATION_FAILED", "The stash is no longer in the list."); await this.git(["stash", "drop", stash.ref]); return { ok: true }; }
        const result = await this.integration(["stash", op === "git.stashPop" && stash ? "pop" : "apply", stash?.ref ?? input]);
        return { conflicts: result.conflicts };
      }
      case "git.tagCreate": {
        const name = safeRef(params.name); await this.git(["check-ref-format", `refs/tags/${name}`], { readOnly: true });
        await this.git(["tag", ...(params.message === undefined ? [] : ["-a", "-m", reqString(params, "message")]), name, safeRef(params.ref ?? "HEAD")]); return { ok: true };
      }
      case "git.tagDelete": await this.git(["tag", "-d", safeRef(params.name)]); return { ok: true };
      default: return unsupported();
    }
  }
}
