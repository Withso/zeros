import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authoredPathsFromMessages } from "@zeros/protocol/turn-attribution";
import { changesHistorySchema, turnHistoryCursorSchema } from "@zeros/protocol/changes-history";
import type { TurnInfo } from "@zeros/protocol/turns";
import type { AgentTextMessage } from "@zeros/protocol/agent-messages";
import type { InboxEntry, SessionStore } from "../sessions/session-store";
import { boundedInteger, commandRunner, type CommandOptions, type CommandRunner } from "./commands";
import { parseNameStatus, parseNumstat, parseUnifiedDiff, type DiffFileSummary } from "./git-parsers";
import { reqString, unsupported, WorkspaceError, type WorkspaceScope } from "./scope";

const order = (a: TurnInfo, b: Pick<TurnInfo, "startedAt" | "chatId" | "turnId">) =>
  b.startedAt - a.startedAt || b.chatId.localeCompare(a.chatId) || b.turnId.localeCompare(a.turnId);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const refPrefix = (chatId: string) => `refs/zeros/turns/${hash(chatId)}/`;
const ref = (chatId: string, turnId: string, phase: "pre" | "post") =>
  `${refPrefix(chatId)}${hash(turnId)}/${phase}`;
const MAX_PATCH_BYTES = 6 * 1024 * 1024;

/** Standalone, disk-authoritative cloud turn history. Scratch indexes and
 * hidden refs leave the user's branch, staging area and checkout untouched. */
export class TurnService {
  private readonly run: CommandRunner;
  private readonly finishing = new Map<string, Promise<AgentTextMessage | undefined>>();
  constructor(private readonly store: SessionStore, private readonly scope: WorkspaceScope) {
    this.run = commandRunner(scope.root);
  }

  private async git(args: string[], options: CommandOptions = {}): Promise<string> {
    return (await this.run("git", args, { readOnly: true, ...options })).stdout;
  }

  private async snapshot(chatId: string, turnId: string, phase: "pre" | "post"): Promise<string | null> {
    let directory: string | undefined;
    try {
      if ((await this.git(["rev-parse", "--show-toplevel"])).trim() !== this.scope.root) return null;
      directory = await mkdtemp(join(tmpdir(), "zeros-turn-"));
      const index = join(directory, "index");
      const run = commandRunner(this.scope.root, { GIT_INDEX_FILE: index });
      const git = async (args: string[], input?: string) => (await run("git", ["-c", "core.splitIndex=false", "-c", "core.fsmonitor=false", ...args], { input, timeout: 15_000 })).stdout;
      const indexPath = (await this.git(["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
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
      if (phase === "pre") await git(["update-ref", ref(chatId, turnId, phase), tree]);
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

  finish(chatId: string, turnId: string, state?: Pick<TurnInfo, "status" | "stopReason">): Promise<AgentTextMessage | undefined> {
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

  private async finishTurn(chatId: string, turnId: string, state?: Pick<TurnInfo, "status" | "stopReason">): Promise<AgentTextMessage | undefined> {
    const turn = this.store.turnRecord(chatId, turnId);
    if (!turn) return;
    const paths = authoredPathsFromMessages(this.store.messagesForTurn(chatId, turnId), this.scope.root)
      .map(file => file.path).filter(path => { try { this.scope.path(path); return true; } catch { return false; } });
    const postSnapshot = turn.preSnapshot ? await this.snapshot(chatId, turnId, "post") : null;
    let files = turn.files;
    let confirmedPost = turn.postSnapshot;
    if (turn.preSnapshot && postSnapshot) {
      try {
        const nextFiles = (await this.metadata(turn.preSnapshot, postSnapshot, paths)).map(({ path, oldPath, status, additions, deletions }) =>
          ({ path, oldPath, status: status as TurnInfo["files"][number]["status"], additions, deletions }));
        await this.git(["update-ref", ref(chatId, turnId, "post"), postSnapshot]);
        files = nextFiles; confirmedPost = postSnapshot;
      }
      catch { /* A failed refresh retains the last confirmed comparison. */ }
    }
    return this.store.saveTurn({ ...turn, ...state, endedAt: state ? Date.now() : turn.endedAt,
      postSnapshot: confirmedPost, files });
  }

  async deleteChatSnapshots(chatId: string): Promise<void> {
    // Runs after the durable tombstone. The chat prefix also permits cleanup
    // on a repeated delete after a crash between persistence and ref removal.
    const names = (await this.git(["for-each-ref", "--format=%(refname)", refPrefix(chatId)]))
      .split("\n").filter(Boolean);
    if (names.length) await this.git(["update-ref", "--stdin"], { input: names.map(name => `delete ${name}\n`).join("") });
  }

  private async metadata(pre: string, post: string, paths: string[]): Promise<DiffFileSummary[]> {
    if (!paths.length) return [];
    const args = ["--no-ext-diff", "--no-textconv", "--no-renames", "-z", pre, post, "--", ...paths.map(path => `:(literal)${path}`)];
    const [names, numbers] = await Promise.all([
      this.git(["diff", "--name-status", ...args]), this.git(["diff", "--numstat", ...args]),
    ]);
    const stats = new Map(parseNumstat(numbers).map(file => [file.path, file]));
    return parseNameStatus(names).map(file => ({ ...file, additions: stats.get(file.path)?.additions ?? 0,
      deletions: stats.get(file.path)?.deletions ?? 0, binary: stats.get(file.path)?.binary ?? false }));
  }

  private async patch(pre: string, post: string, paths: string[], fullContext = false): Promise<string> {
    if (!paths.length) return "";
    return this.git(["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
      fullContext ? "-U2147483647" : "-U3", pre, post, "--", ...paths.map(path => `:(literal)${path}`)], { maxBuffer: MAX_PATCH_BYTES });
  }

  private recorded(): TurnInfo[] {
    return this.store.turnRecords().filter(turn => turn.status !== "running" && turn.files.length > 0).sort(order);
  }

  async handle(op: string, params: Record<string, unknown>): Promise<unknown> {
    this.scope.assertId(params.workspaceId);
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
   * unrelated files changed by other conversations never enter the review. */
  async historyDiff(params: Record<string, unknown>): Promise<unknown> {
    this.scope.assertId(params.workspaceId);
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
    const requested = [params.filePath, params.oldFilePath].filter(path => path !== undefined).map(path => this.scope.relative(path));
    if (params.fullContext === true && !requested.length) throw new WorkspaceError("VALIDATION_FAILED", "Full context requires a file.");
    const spans = new Map<string, { pre: string; post: string }>();
    for (const turn of turns.reverse()) for (const file of turn.files) {
      if (requested.length && !requested.includes(file.path)) continue;
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
    const limit = params.summaryLimit === undefined ? undefined : boundedInteger(params.summaryLimit, 100, 100_000);
    if (limit !== undefined && files.length > limit) return { hunks: [], files, summary: true };
    let patch = "", bytes = 0;
    try {
      for (const group of groups.values()) {
        const part = await this.patch(group.pre, group.post, group.paths, params.fullContext === true);
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
