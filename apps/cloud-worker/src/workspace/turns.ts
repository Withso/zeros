import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { authoredPathsFromMessages, commitShasFromMessages } from "@zeros/protocol/turn-attribution";
import { isTurnCommitSha, TURN_COMMIT_LOOKUP_LIMIT, type TurnCommitLink } from "@zeros/protocol/turns";
import { changesHistorySchema, turnHistoryCursorSchema } from "@zeros/protocol/changes-history";
import { applyTurnSpanReset, undoTurnReset, type TurnInfo, type TurnResetHost } from "@zeros/protocol/turns";
import type { AgentTextMessage } from "@zeros/protocol/agent-messages";
import type { InboxEntry, SessionStore } from "../sessions/session-store";
import { boundedInteger, commandRunner, type CommandOptions, type CommandRunner } from "./commands";
import { parseNameStatus, parseNumstat, parseUnifiedDiff, type DiffFileSummary } from "./git-parsers";
import { reqString, unsupported, WorkspaceError, WorkspaceScope } from "./scope";
import { turnResetHost } from "./turn-reset";

const order = (a: TurnInfo, b: Pick<TurnInfo, "startedAt" | "chatId" | "turnId">) =>
  b.startedAt - a.startedAt || b.chatId.localeCompare(a.chatId) || b.turnId.localeCompare(a.turnId);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const refPrefix = (chatId: string) => `refs/zeros/turns/${hash(chatId)}/`;
const ref = (chatId: string, turnId: string, phase: "pre" | "post") =>
  `${refPrefix(chatId)}${hash(turnId)}/${phase}`;
const MAX_PATCH_BYTES = 6 * 1024 * 1024;

/** One repository the turn history reads and writes: its folder in the project
 * folder (empty for a workspace of one), its own scope and Git. */
type Repository = { folder: string; scope: WorkspaceScope; run: CommandRunner };
/** A workspace of several repositories: a snapshot is each repository's tree,
 * `zeros-repositories-1:<folder>=<tree>,…`. A workspace of one keeps the bare tree. */
const SEVERAL = "zeros-repositories-1:";
const TREE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Standalone, disk-authoritative cloud turn history. Scratch indexes and
 * hidden refs leave the user's branch, staging area and checkout untouched.
 * In a workspace of several repositories each repository is captured, compared
 * and reset in its own checkout, with paths in the project folder. */
export class TurnService {
  private readonly repositories: readonly Repository[];
  private readonly several: boolean;
  private readonly finishing = new Map<string, Promise<AgentTextMessage | undefined>>();
  constructor(private readonly store: SessionStore, private readonly scope: WorkspaceScope) {
    this.several = scope.nested.length > 1;
    this.repositories = this.several
      ? scope.nested.map(checkout => ({ folder: relative(scope.root, checkout), scope: new WorkspaceScope({ ...scope.workspace, checkoutPath: checkout }), run: commandRunner(checkout) }))
      : [{ folder: "", scope, run: commandRunner(scope.root) }];
  }

  private async git(repository: Repository, args: string[], options: CommandOptions = {}): Promise<string> {
    return (await repository.run("git", args, { readOnly: true, ...options })).stdout;
  }

  /** Each repository's tree in a snapshot; empty for one this service cannot read. */
  private trees(snapshot: string): Map<string, string> {
    if (!this.several) return new Map(TREE.test(snapshot) ? [["", snapshot]] : []);
    if (!snapshot.startsWith(SEVERAL)) return new Map();
    const folders = new Set(this.repositories.map(entry => entry.folder)), trees = new Map<string, string>();
    for (const part of snapshot.slice(SEVERAL.length).split(",")) {
      const at = part.indexOf("="), folder = part.slice(0, at), tree = part.slice(at + 1);
      if (at < 1 || !folders.has(folder) || !TREE.test(tree) || trees.has(folder)) return new Map();
      trees.set(folder, tree);
    }
    return trees;
  }

  /** The repository a project-folder path is in, and the path inside it. */
  private locate(path: string): { repository: Repository; path: string } {
    if (!this.several) return { repository: this.repositories[0]!, path };
    const at = path.indexOf("/"), folder = at < 0 ? path : path.slice(0, at);
    const repository = this.repositories.find(entry => entry.folder === folder);
    if (!repository || at < 0) throw new WorkspaceError("VALIDATION_FAILED", "Choose a file inside one of the workspace's repositories.");
    return { repository, path: path.slice(at + 1) };
  }

  /** Paths grouped by the repository that holds them, each relative to it. */
  private byRepository(paths: string[]): Map<Repository, string[]> {
    const groups = new Map<Repository, string[]>();
    for (const path of paths) {
      const { repository, path: inside } = this.locate(path);
      groups.set(repository, [...groups.get(repository) ?? [], inside]);
    }
    return groups;
  }

  private inProject(repository: Repository, path: string): string { return repository.folder ? `${repository.folder}/${path}` : path; }

  private async snapshot(chatId: string, turnId: string, phase: "pre" | "post"): Promise<string | null> {
    return this.capture(phase === "pre" ? ref(chatId, turnId, phase) : undefined);
  }

  /** Every repository's tree; a repository that cannot be read is left out (its paths are then skipped by a reset). */
  private async capture(reference?: string): Promise<string | null> {
    const trees: [string, string][] = [];
    for (const repository of this.repositories) {
      const tree = await this.captureRepository(repository, reference);
      if (tree) trees.push([repository.folder, tree]);
    }
    if (!this.several) return trees[0]?.[1] ?? null;
    return trees.length ? `${SEVERAL}${trees.map(([folder, tree]) => `${folder}=${tree}`).join(",")}` : null;
  }

  /** Pins each repository's tree of a snapshot under one reference. */
  private async pin(reference: string, snapshot: string): Promise<void> {
    for (const [folder, tree] of this.trees(snapshot)) {
      const repository = this.repositories.find(entry => entry.folder === folder)!;
      await this.git(repository, ["update-ref", "--no-deref", reference, tree]);
    }
  }

  private async captureRepository(repository: Repository, reference?: string): Promise<string | null> {
    let directory: string | undefined;
    try {
      if ((await this.git(repository, ["rev-parse", "--show-toplevel"])).trim() !== repository.scope.root) return null;
      directory = await mkdtemp(join(tmpdir(), "zeros-turn-"));
      const index = join(directory, "index");
      const run = commandRunner(repository.scope.root, { GIT_INDEX_FILE: index });
      const git = async (args: string[], input?: string) => (await run("git", ["-c", "core.splitIndex=false", "-c", "core.fsmonitor=false", ...args], { input, timeout: 15_000 })).stdout;
      const indexPath = (await this.git(repository, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
      try {
        const handle = await open(indexPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return null;
          await writeFile(index, await handle.readFile(), { mode: 0o600 });
        } finally { await handle.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await git(["read-tree", "--empty"]);
      }
      const paths = await git(["ls-files", "-z"]);
      if (paths) {
        await git(["update-index", "--no-assume-unchanged", "-z", "--stdin"], paths);
        await git(["update-index", "--no-skip-worktree", "-z", "--stdin"], paths);
      }
      await git(["-c", "core.sparseCheckout=false", "add", "--sparse", "-A", "--", "."]);
      const tree = (await git(["write-tree"])).trim();
      if (reference) await git(["update-ref", "--no-deref", reference, tree]);
      return tree;
    } catch { return null; }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }

  async begin(chatId: string, entry: InboxEntry, agentId: string): Promise<void> {
    if (this.store.turnRecord(chatId, entry.userMessageId)) return;
    const preSnapshot = await this.snapshot(chatId, entry.userMessageId, "pre");
    if (!preSnapshot) return;
    await this.store.saveTurn({ chatId, turnId: entry.userMessageId, workspaceId: this.scope.workspace.id,
      folder: this.scope.root, agentId, ord: this.store.turnRecords(chatId).length + 1,
      summary: (entry.bubble?.displayText ?? entry.prompt.flatMap(block => block.type === "text" ? [block.text] : []).join(" ")).slice(0, 500),
      startedAt: entry.startedAt, endedAt: null, status: "running", stopReason: null, preSnapshot, postSnapshot: null, files: [] });
  }

  finish(chatId: string, turnId: string, state?: Pick<TurnInfo, "status" | "stopReason" | "usage">): Promise<AgentTextMessage | undefined> {
    // A background completion can overlap the first terminal capture. Read the
    // record only after its prior capture commits, so a refresh cannot restore
    // running status or replace a newer comparison with an older tree.
    const key = JSON.stringify([chatId, turnId]);
    const next = (this.finishing.get(key) ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.finishTurn(chatId, turnId, state));
    this.finishing.set(key, next);
    const release = () => { if (this.finishing.get(key) === next) this.finishing.delete(key); };
    void next.then(release, release);
    return next;
  }

  private async finishTurn(chatId: string, turnId: string, state?: Pick<TurnInfo, "status" | "stopReason" | "usage">): Promise<AgentTextMessage | undefined> {
    const turn = this.store.turnRecord(chatId, turnId);
    if (!turn) return;
    const messages = this.store.messagesForTurn(chatId, turnId);
    const paths = authoredPathsFromMessages(messages, this.scope.root)
      .map(file => file.path).filter(path => { try { this.scope.path(path); return true; } catch { return false; } });
    // Commits this turn's shell tools reported, kept only when they exist here.
    const commits = state ? await this.resolveCommits(commitShasFromMessages(messages)) : turn.commits;
    const postSnapshot = turn.preSnapshot ? await this.snapshot(chatId, turnId, "post") : null;
    let files = turn.files;
    let confirmedPost = turn.postSnapshot;
    if (turn.preSnapshot && postSnapshot) {
      try {
        const nextFiles = (await this.metadata(turn.preSnapshot, postSnapshot, paths)).map(({ path, oldPath, status, additions, deletions }) =>
          ({ path, oldPath, status: status as TurnInfo["files"][number]["status"], additions, deletions }));
        await this.pin(ref(chatId, turnId, "post"), postSnapshot);
        files = nextFiles; confirmedPost = postSnapshot;
      }
      catch { /* A failed refresh retains the last confirmed comparison. */ }
    }
    return this.store.saveTurn({ ...turn, ...state, endedAt: state ? Date.now() : turn.endedAt,
      postSnapshot: confirmedPost, files, ...(commits?.length ? { commits } : {}) });
  }

  private async resolveCommits(candidates: string[]): Promise<string[]> {
    const valid = candidates.filter(sha => /^[0-9a-f]{7,64}$/.test(sha));
    if (!valid.length) return [];
    const out: string[] = [];
    // A commit in any of the workspace's repositories.
    for (const repository of this.repositories) {
      try {
        const output = await this.git(repository, ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
          { input: valid.map(sha => `${sha}^{commit}\n`).join("") });
        for (const line of output.split("\n")) {
          const [sha, type] = line.trim().split(" ");
          if (type === "commit" && isTurnCommitSha(sha) && !out.includes(sha)) out.push(sha);
        }
      } catch { /* This repository cannot say; the others still can. */ }
    }
    return out;
  }

  /** Which turn made each commit; a commit made again later keeps its first turn. */
  private commitLinks(shas: unknown): TurnCommitLink[] {
    if (!Array.isArray(shas) || shas.length > TURN_COMMIT_LOOKUP_LIMIT || !shas.every(isTurnCommitSha))
      throw new WorkspaceError("VALIDATION_FAILED", "turns.commits requires full commit SHAs.");
    const wanted = new Set(shas);
    const links = new Map<string, TurnCommitLink>();
    for (const turn of this.store.turnRecords().sort((a, b) => a.startedAt - b.startedAt)) {
      for (const sha of turn.commits ?? [])
        if (wanted.has(sha) && !links.has(sha)) links.set(sha, { sha, chatId: turn.chatId, turnId: turn.turnId });
    }
    return [...links.values()];
  }

  async deleteChatSnapshots(chatId: string): Promise<void> {
    // Runs after the durable tombstone. The chat prefix also permits cleanup
    // on a repeated delete after a crash between persistence and ref removal.
    for (const repository of this.repositories) {
      const names = (await this.git(repository, ["for-each-ref", "--format=%(refname)", refPrefix(chatId), `refs/zeros/resets/${hash(chatId)}/`]))
        .split("\n").filter(Boolean);
      if (names.length) await this.git(repository, ["update-ref", "--no-deref", "--stdin"], { input: names.map(name => `delete ${name}\n`).join("") });
    }
  }

  async reset(chatId: string, turns: TurnInfo[]) {
    const reset = `${Date.now()}-${randomUUID()}`;
    return applyTurnSpanReset(this.resetHost(phase => this.capture(`refs/zeros/resets/${hash(chatId)}/${reset}/${phase}`)),
      turns.filter(turn => turn.files.length).map(turn => ({ paths: turn.files.map(file => file.path),
        preSnapshot: turn.preSnapshot, postSnapshot: turn.postSnapshot })));
  }

  async undo(snapshot: string, paths: string[], mergeBase: string | null) {
    if (!mergeBase) return paths.map(path => ({ path, result: "skipped" as const, reason: "no snapshot available" }));
    return undoTurnReset(this.resetHost(async () => null), snapshot, paths, mergeBase);
  }

  /** A workspace of one: its checkout's host. Several: each path goes to the
   * repository that holds it, with that repository's tree of each snapshot; a
   * snapshot without that repository's tree refuses the path, so it is skipped
   * (never treated as absent and deleted). */
  private resetHost(snapshot: TurnResetHost["snapshot"]): TurnResetHost {
    if (!this.several) return turnResetHost(this.scope, snapshot);
    const hosts = new Map(this.repositories.map(repository => [repository, turnResetHost(repository.scope, async () => null)]));
    const at = (path: string) => { const located = this.locate(path); return { host: hosts.get(located.repository)!, ...located }; };
    const tree = (revision: string, repository: Repository) => {
      const found = this.trees(revision).get(repository.folder);
      if (!found) throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "This repository has no snapshot for this turn.");
      return found;
    };
    const first = hosts.get(this.repositories[0]!)!;
    return {
      snapshotAvailable: async revision => {
        const trees = this.trees(revision);
        if (!trees.size) return false;
        for (const [folder, value] of trees)
          if (!await hosts.get(this.repositories.find(entry => entry.folder === folder)!)!.snapshotAvailable(value)) return false;
        return true;
      },
      blobOid: (revision, path) => { const { host, repository, path: inside } = at(path); return host.blobOid(tree(revision, repository), inside); },
      diskBlobOid: path => { const { host, path: inside } = at(path); return host.diskBlobOid(inside); },
      indexBlobOid: path => { const { host, path: inside } = at(path); return host.indexBlobOid(inside); },
      restore: (path, revision, expected) => { const { host, repository, path: inside } = at(path); return host.restore(inside, revision === null ? null : tree(revision, repository), expected); },
      restoreStaged: (path, revision, expected) => { const { host, repository, path: inside } = at(path);
        return host.restoreStaged!(inside, revision === null ? null : tree(revision, repository), expected); },
      restoreIndex: (path, revision) => { const { host, repository, path: inside } = at(path); return host.restoreIndex(inside, tree(revision, repository)); },
      removeIndex: path => { const { host, path: inside } = at(path); return host.removeIndex(inside); },
      readDiskText: path => { const { host, path: inside } = at(path); return host.readDiskText(inside); },
      showText: (revision, path) => { const { host, repository, path: inside } = at(path); return host.showText(tree(revision, repository), inside); },
      mergeText: (ours, base, theirs) => first.mergeText(ours, base, theirs),
      publishMerge: (path, merged, expected) => { const { host, path: inside } = at(path); return host.publishMerge(inside, merged, expected); },
      snapshot,
      prune: async () => {},
    };
  }

  async prune(chatId: string): Promise<void> {
    const session = this.store.snapshot(chatId);
    const kept = [
      ...(session?.turns ?? []).flatMap(turn => [turn.preSnapshot, turn.postSnapshot]),
      ...(session?.resets ?? []).flatMap(reset => [reset.snapshot, reset.postSnapshot,
        ...reset.turns.flatMap(turn => [turn.preSnapshot, turn.postSnapshot])]),
    ].filter((value): value is string => !!value);
    for (const repository of this.repositories) {
      // Each repository keeps the trees its records name.
      const keep = new Set(kept.flatMap(snapshot => { const tree = this.trees(snapshot).get(repository.folder); return tree ? [tree] : []; }));
      const refs = (await this.git(repository, ["for-each-ref", "--format=%(objectname) %(refname)", refPrefix(chatId), `refs/zeros/resets/${hash(chatId)}/`]))
        .split("\n").filter(Boolean).map(line => line.split(" "));
      // Records address trees by object ID. One owned pin per retained tree is
      // enough; repeated resets must not retain every alias of the same object.
      const removed = refs.filter(([object, name]) =>
        /^refs\/zeros\/(?:turns\/[a-f0-9]{64}\/[a-f0-9]{64}|resets\/[a-f0-9]{64}\/[0-9]{1,16}-[a-f0-9-]{36})\/(?:pre|post)$/.test(name!) && !keep.delete(object));
      if (removed.length) await this.git(repository, ["update-ref", "--no-deref", "--stdin"], { input: removed.map(([object, name]) => `delete ${name} ${object}\n`).join("") });
    }
  }

  private async metadata(pre: string, post: string, paths: string[]): Promise<DiffFileSummary[]> {
    if (!paths.length) return [];
    const files: DiffFileSummary[] = [];
    for (const [repository, inside] of this.byRepository(paths)) {
      const from = this.trees(pre).get(repository.folder), to = this.trees(post).get(repository.folder);
      if (!from || !to) throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "This turn's recorded diff is no longer available.");
      const args = ["--no-ext-diff", "--no-textconv", "--no-renames", "-z", from, to, "--", ...inside.map(path => `:(literal)${path}`)];
      const [names, numbers] = await Promise.all([
        this.git(repository, ["diff", "--name-status", ...args]), this.git(repository, ["diff", "--numstat", ...args]),
      ]);
      const stats = new Map(parseNumstat(numbers).map(file => [file.path, file]));
      files.push(...parseNameStatus(names).map(file => ({ ...file, path: this.inProject(repository, file.path),
        ...(file.oldPath ? { oldPath: this.inProject(repository, file.oldPath) } : {}),
        additions: stats.get(file.path)?.additions ?? 0, deletions: stats.get(file.path)?.deletions ?? 0, binary: stats.get(file.path)?.binary ?? false })));
    }
    return files;
  }

  /** `bare`: paths relative to each repository, for one repository's own view. */
  private async patch(pre: string, post: string, paths: string[], fullContext = false, bare = false): Promise<string> {
    if (!paths.length) return "";
    let patch = "";
    for (const [repository, inside] of this.byRepository(paths)) {
      const from = this.trees(pre).get(repository.folder), to = this.trees(post).get(repository.folder);
      if (!from || !to) throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "This turn's recorded diff is no longer available.");
      // Its paths in the project folder: a/<folder>/… and b/<folder>/….
      const prefixes = repository.folder && !bare ? [`--src-prefix=a/${repository.folder}/`, `--dst-prefix=b/${repository.folder}/`] : [];
      patch += await this.git(repository, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", ...prefixes,
        fullContext ? "-U2147483647" : "-U3", from, to, "--", ...inside.map(path => `:(literal)${path}`)], { maxBuffer: MAX_PATCH_BYTES });
    }
    return patch;
  }

  private recorded(): TurnInfo[] {
    return this.store.turnRecords().filter(turn => turn.status !== "running" && turn.files.length > 0).sort(order);
  }

  async handle(op: string, params: Record<string, unknown>): Promise<unknown> {
    this.scope.assertId(params.workspaceId);
    if (op === "turns.commits") return { commits: this.commitLinks(params.shas) };
    if (op === "turns.list") {
      let turns = this.recorded();
      if (params.before !== undefined) {
        const before = boundedInteger(params.before, 0, Number.MAX_SAFE_INTEGER);
        turns = turns.filter(turn => turn.startedAt <= before);
      }
      if (params.after !== undefined) {
        const after = turnHistoryCursorSchema.safeParse(params.after);
        if (!after.success) throw new WorkspaceError("VALIDATION_FAILED", "Invalid turn cursor.");
        turns = turns.filter(turn => order(turn, after.data) > 0);
      } else turns = turns.slice(boundedInteger(params.offset, 0, Number.MAX_SAFE_INTEGER));
      return { turns: turns.slice(0, boundedInteger(params.limit, 500, 1000, 1)) };
    }
    const turn = this.store.turnRecord(reqString(params, "chatId"), reqString(params, "turnId"));
    if (op === "turns.get") return { turn: turn ?? null };
    if (op !== "turns.diff") return unsupported();
    if (!turn) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "This turn is no longer available.");
    const path = params.path === undefined ? undefined : this.scope.relative(params.path);
    const paths = turn.files.filter(file => path === undefined || path === file.path).map(file => file.path);
    if (!paths.length) return { patch: "" };
    if (!turn.preSnapshot || !turn.postSnapshot) throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "This turn's recorded diff is no longer available.");
    return { patch: await this.patch(turn.preSnapshot, turn.postSnapshot, paths) };
  }

  /** History scopes use each path's first pre-image and last post-image, so
   * unrelated files changed by other conversations never enter the review.
   * `within`: one repository's folder of a workspace of several, asked on its
   * own key; its paths and its reply are relative to that repository. */
  async historyDiff(params: Record<string, unknown>, within?: string): Promise<unknown> {
    this.scope.assertId(params.workspaceId);
    if (within !== undefined && !this.repositories.some(entry => entry.folder === within && within))
      throw new WorkspaceError("VALIDATION_FAILED", "Choose one of the workspace's repositories.");
    const inside = (path: string) => within === undefined ? path : `${within}/${path}`;
    const parsed = changesHistorySchema.safeParse(params.history);
    if (!parsed.success) throw new WorkspaceError("VALIDATION_FAILED", "Invalid turn comparison.");
    const history = parsed.data;
    let turns = this.recorded();
    if (history.kind === "last-turn") turns = turns.slice(0, 1);
    else if (history.kind === "turn-range") {
      const start = turns.findIndex(turn => turn.chatId === history.from.chatId && turn.turnId === history.from.turnId);
      const end = turns.findIndex(turn => turn.chatId === history.to.chatId && turn.turnId === history.to.turnId);
      if (start < 0 || end < 0) throw new WorkspaceError("WORKSPACE_NOT_FOUND", "This turn comparison is no longer available.");
      turns = turns.slice(Math.min(start, end), Math.max(start, end) + 1);
    } else if (history.kind !== "turns") return unsupported();
    const requested = [params.filePath, params.oldFilePath].filter(path => path !== undefined).map(path => inside(this.scope.relative(path)));
    if (params.fullContext === true && !requested.length) throw new WorkspaceError("VALIDATION_FAILED", "Full context requires a file.");
    const spans = new Map<string, { pre: string; post: string }>();
    for (const turn of turns.reverse()) for (const file of turn.files) {
      if (requested.length && !requested.includes(file.path)) continue;
      if (within !== undefined && !file.path.startsWith(`${within}/`)) continue;
      if (!turn.preSnapshot || !turn.postSnapshot) throw new WorkspaceError("WORKSPACE_UNAVAILABLE", "This turn's recorded diff is no longer available.");
      spans.set(file.path, { pre: spans.get(file.path)?.pre ?? turn.preSnapshot, post: turn.postSnapshot });
    }
    const groups = new Map<string, { pre: string; post: string; paths: string[] }>();
    for (const [path, span] of spans) {
      const key = `${span.pre}:${span.post}`;
      const group = groups.get(key) ?? { ...span, paths: [] };
      group.paths.push(path); groups.set(key, group);
    }
    const files: DiffFileSummary[] = [];
    for (const group of groups.values()) files.push(...await this.metadata(group.pre, group.post, group.paths));
    // One repository's own view: its paths without its folder.
    if (within !== undefined) for (const file of files) {
      file.path = file.path.slice(within.length + 1);
      if (file.oldPath) file.oldPath = file.oldPath.slice(within.length + 1);
    }
    const limit = params.summaryLimit === undefined ? undefined : boundedInteger(params.summaryLimit, 100, 100_000);
    if (limit !== undefined && files.length > limit) return { hunks: [], files, summary: true };
    let patch = "", bytes = 0;
    try {
      for (const group of groups.values()) {
        const part = await this.patch(group.pre, group.post, group.paths, params.fullContext === true, within !== undefined);
        bytes += Buffer.byteLength(part);
        if (bytes > MAX_PATCH_BYTES) throw new WorkspaceError("GIT_OUTPUT_TOO_LARGE", "This result is too large. Select a file to view its changes.");
        patch += part;
      }
    } catch (error) {
      if (limit !== undefined && error instanceof WorkspaceError && error.code === "GIT_OUTPUT_TOO_LARGE") return { hunks: [], files, summary: true };
      throw error;
    }
    return { hunks: parseUnifiedDiff(patch), files, ...(params.rawPatch === true ? { patch } : {}) };
  }
}
