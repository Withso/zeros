import { createHash, randomUUID } from "node:crypto";
import { link, lstat, readdir, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { SyncBootstrapReplySchema, type SyncBootstrapReply } from "@zeros/protocol/workspace-sync";
import { GitMirror, runGit, type GitOptions, type GitRun, type GitSource, type GitState } from "./git";
import { assertGitCurrent, gitDirectory, gitTreeBytes, gitTreeStats, readGitFile, withGitStoreLock, writeGitFile, type GitLifetime } from "./git-storage";
import type { WorkspaceSyncStorage } from "../../shared/workspace-sync";

export interface SharedGitScope { organizationId: string; repository: string }
export interface GithubReadToken { token: string; expiresAt: string; repository: string }
export interface SharedGitOptions {
  channel: string;
  scope: SharedGitScope;
  workspaceId: string;
  token(): Promise<GithubReadToken>;
  git?: GitRun;
  now?(): number;
  log?(line: string): void;
  isCurrent?(): boolean;
  signal?: AbortSignal;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
interface StoreRecord { version: 1; organizationId: string; repository: string; changedAt: number; gcAt: number; emptyAt?: number }
interface Registration { version: 1; workspaceId: string; store: string; registration: string; root: string }
interface RegistrationIntent extends Registration { stage: string; head: string; legacy?: { dev: number; ino: number } }
const DAY = 86_400_000;
const byteCache = new Map<string, { until: number; bytes: number }>();
const byteReads = new Map<string, Promise<number>>();
const maintainedAt = new Map<string, number>();
async function cachedBytes(path: string, now: number): Promise<number> {
  const known = byteCache.get(path);
  if (known && known.until > now) return known.bytes;
  const reading = byteReads.get(path);
  if (reading) return reading;
  const next = gitTreeBytes(path).then(bytes => {
    byteCache.delete(path); byteCache.set(path, { until: now + 3600_000, bytes });
    while (byteCache.size > 512) byteCache.delete(byteCache.keys().next().value!);
    return bytes;
  }).finally(() => { byteReads.delete(path); });
  byteReads.set(path, next);
  return next;
}

function normalizedScope(scope: SharedGitScope): SharedGitScope {
  if (!UUID.test(scope.organizationId) || !REPOSITORY.test(scope.repository)) throw new Error("Invalid shared Git scope.");
  return { organizationId: scope.organizationId, repository: scope.repository.toLowerCase() };
}

export function sharedGitStorePath(channel: string, scope: SharedGitScope): string {
  const normalized = normalizedScope(scope), remote = `github.com/${normalized.repository}`;
  return join(channel, "cloud-workspaces", normalized.organizationId, `${remote.replaceAll("/", "-")}--${createHash("sha256").update(remote).digest("hex").slice(0, 12)}`);
}

export class SharedGitMirror extends GitMirror {
  private readonly store: string;
  private readonly common: string;
  private readonly scope: SharedGitScope;
  private readonly remote: string;
  constructor(root: string, meta: string, private readonly options: SharedGitOptions) {
    super(root, meta, options.git, options.now);
    if (!UUID.test(options.workspaceId)) throw new Error("Invalid shared Git workspace.");
    this.scope = normalizedScope(options.scope);
    this.store = sharedGitStorePath(options.channel, this.scope);
    this.common = join(this.store, ".git");
    this.remote = `https://github.com/${this.scope.repository}`;
  }

  private check(): void { assertGitCurrent(this.options); }
  private log(line: string): void { this.options.log?.(line); }
  private async run(args: string[], options: GitOptions = {}): Promise<string> {
    this.check();
    const text = await this.git(args, { cwd: this.root, ...options, signal: this.options.signal });
    this.check();
    return text.trim();
  }
  private storeGit(...args: string[]): Promise<string> { return this.run(["--git-dir", this.common, ...args], { cwd: this.store }); }
  private workGit(registration: string, ...args: string[]): Promise<string> {
    return this.run(["--git-dir", join(this.common, "worktrees", registration), "--work-tree", this.root, ...args]);
  }

  override async current(previous: GitState): Promise<boolean> {
    try {
      this.check();
      if (await lstat(join(this.meta, "git-intent.json")).then(() => true, () => false)) return false;
      if (!previous.shared) return await this.legacyOwned(previous) ? false : super.current(previous);
      if (previous.shared.store !== this.store) return false;
      await this.readStore();
      await this.checkConfig(this.common, false);
      const registration = await this.registration();
      if (!registration || registration !== previous.shared.registration) return false;
      await this.verify(registration, previous.head);
      await this.periodicMaintenance();
      return true;
    } catch { return false; }
  }

  override async apply(source: GitSource, previous: GitState | undefined): Promise<GitState | "too_many_bytes"> {
    this.check();
    await gitDirectory(this.root); await gitDirectory(this.meta);
    const owner = JSON.parse(await readGitFile(join(this.meta, "root.json"))) as { workspaceId?: unknown };
    if (owner.workspaceId !== this.options.workspaceId) throw new Error("Foreign Git mirror.");
    const existing = await lstat(join(this.root, ".git")).catch(() => null);
    const recovering = await lstat(join(this.meta, "git-intent.json")).then(() => true, () => false);
    if (existing?.isDirectory() && !recovering && !await this.legacyOwned(previous)) return super.apply(source, previous);
    const result = await withGitStoreLock(this.store, this.options, async () => {
      const record = await this.readStore(true);
      await this.recover();
      const recovered = await lstat(join(this.root, ".git")).catch(() => null);
      if (recovered?.isDirectory() && !await this.legacyOwned(previous)) return super.apply(source, previous);
      for (const name of await readdir(this.store)) if (/^\.clone-[0-9a-f-]{36}$/.test(name)) await rm(join(this.store, name), { recursive: true, force: true });
      if (await lstat(this.common).then(() => true, () => false)) await this.checkConfig(this.common, false);
      await this.registration();
      const github = await this.refreshGithub();
      if (recovered?.isDirectory()) {
        await this.run(["--git-dir", this.common, "fetch", "-q", "--no-tags", "--no-write-fetch-head", join(this.root, ".git"), "HEAD"], { fileTransport: true });
      }
      const have = github ? await this.heldHeads(previous?.head) : [];
      let reply = SyncBootstrapReplySchema.parse(await source.bootstrap(have.length ? have : undefined));
      this.check();
      if (reply.stopped) return "too_many_bytes";
      if (!reply.bundle && !await this.hasCommit(reply.head)) {
        reply = SyncBootstrapReplySchema.parse(await source.bootstrap());
        this.check();
        if (reply.stopped) return "too_many_bytes";
      }
      await this.importBundle(source, reply);
      if (!await this.hasCommit(reply.head)) throw new Error("Missing cloud Git head.");
      let registration = await this.registration();
      if (!registration) registration = await this.register(reply.head, previous);
      await this.setHead(registration, reply.head);
      record.changedAt = this.now(); delete record.emptyAt;
      await writeGitFile(join(this.store, "store.json"), JSON.stringify(record));
      this.check();
      return { head: reply.head, branch: reply.branch, created: [], shared: { store: this.store, registration } } satisfies GitState;
    });
    await this.periodicMaintenance();
    return result;
  }

  private async readStore(create = false): Promise<StoreRecord> {
    await gitDirectory(this.store);
    const path = join(this.store, "store.json"), exists = await lstat(path).catch(() => null);
    if (!exists) {
      if (!create || (await readdir(this.store)).some(name => name !== ".writer-lock")) throw new Error("Unowned Git store.");
      const record: StoreRecord = { version: 1, ...this.scope, changedAt: this.now(), gcAt: this.now(), emptyAt: this.now() };
      await writeGitFile(path, JSON.stringify(record));
      return record;
    }
    const record = JSON.parse(await readGitFile(path)) as StoreRecord;
    if (record.version !== 1 || record.organizationId !== this.scope.organizationId || record.repository !== this.scope.repository ||
      !Number.isFinite(record.changedAt) || !Number.isFinite(record.gcAt)) throw new Error("Foreign Git store.");
    return record;
  }

  private async checkConfig(gitDir: string, legacy: boolean, previous?: GitState): Promise<void> {
    await gitDirectory(gitDir); await readGitFile(join(gitDir, "config"));
    for (const name of ["objects", "refs"]) await gitDirectory(join(gitDir, name));
    for (const name of ["objects/info/alternates", "objects/info/http-alternates", "config.worktree", "commondir"]) {
      if (await lstat(join(gitDir, name)).then(() => true, () => false)) throw new Error("Custom Git repository.");
    }
    const entries = (await this.run(["config", "--file", join(gitDir, "config"), "--no-includes", "--null", "--list"], { cwd: gitDir })).split("\0").filter(Boolean);
    const allowed = new Map<string, string[]>([
      ["core.repositoryformatversion", ["0", "1"]], ["core.filemode", ["true", "false"]], ["core.bare", [legacy ? "false" : "true"]],
      ["core.logallrefupdates", ["true"]], ["core.ignorecase", ["true", "false"]], ["core.precomposeunicode", ["true", "false"]],
      ["remote.origin.url", [this.remote, ...(legacy ? [`${this.remote}.git`, `git@github.com:${this.scope.repository}.git`, `git@github.com:${this.scope.repository}`] : [])]],
      ["remote.origin.fetch", ["+refs/heads/*:refs/remotes/origin/*"]],
      ...(!legacy ? [["remote.origin.promisor", ["true"]], ["remote.origin.partialclonefilter", ["blob:none"]], ["remote.origin.tagopt", ["--no-tags"]], ["extensions.partialclone", ["origin"]]] as Array<[string, string[]]> : []),
    ]);
    for (const branch of legacy ? previous?.created ?? [] : []) {
      allowed.set(`branch.${branch}.remote`, ["origin"]);
      allowed.set(`branch.${branch}.merge`, [`refs/heads/${branch}`]);
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      const split = entry.indexOf("\n"), key = entry.slice(0, split), value = entry.slice(split + 1);
      if (split < 0 || seen.has(key) || !allowed.get(key)?.includes(key === "remote.origin.url" ? value.toLowerCase() : value)) throw new Error("Custom Git config.");
      seen.add(key);
    }
    if (!seen.has("core.bare") || !seen.has("remote.origin.url")) throw new Error("Incomplete Git config.");
  }

  private async legacyOwned(previous: GitState | undefined): Promise<boolean> {
    if (!previous || previous.shared || !COMMIT.test(previous.head) || !previous.created?.includes(previous.branch)) return false;
    const gitDir = join(this.root, ".git");
    try {
      await this.checkConfig(gitDir, true, previous);
      const owner = JSON.parse(await readGitFile(join(this.meta, "root.json"))) as { workspaceId?: unknown };
      if (owner.workspaceId !== this.options.workspaceId) return false;
      const hooks = await readdir(join(gitDir, "hooks")).catch(() => []);
      if (hooks.some(name => !name.endsWith(".sample"))) return false;
      const g = (...args: string[]) => this.run(["--git-dir", gitDir, "--work-tree", this.root, ...args]);
      if (await g("symbolic-ref", "HEAD") !== `refs/heads/${previous.branch}` || await g("rev-parse", "HEAD") !== previous.head) return false;
      await g("diff-index", "--cached", "--quiet", previous.head, "--");
      const refs = (await g("for-each-ref", "--format=%(refname)")).split("\n").filter(Boolean);
      // Legacy state cannot prove who created another ref; keep its history in the original repository.
      return refs.length === 1 && refs[0] === `refs/heads/${previous.branch}`;
    } catch { return false; }
  }

  private async refreshGithub(): Promise<boolean> {
    const exists = await lstat(this.common).then(() => true, () => false);
    const before = exists ? await gitTreeBytes(this.common) : 0;
    let stage: string | undefined;
    try {
      const token = await this.options.token(); this.check();
      const remaining = Date.parse(token.expiresAt) - this.now();
      if (token.repository.toLowerCase() !== this.scope.repository || !Number.isFinite(remaining) || remaining <= 0 || remaining > 60 * 60_000 ||
        !token.token || token.token.length > 8192 || /[\r\n\0]/.test(token.token)) throw new Error("Invalid Git credential.");
      const auth = { githubToken: { token: token.token, repository: this.scope.repository } };
      if (exists) await this.run(["--git-dir", this.common, "fetch", "-q", "--filter=blob:none", "--no-tags", "--no-write-fetch-head", "origin", "+refs/heads/*:refs/remotes/origin/*"], auth);
      else {
        stage = join(this.store, `.clone-${randomUUID()}`);
        await this.run(["clone", "-q", "--bare", "--filter=blob:none", "--no-tags", "--template=", this.remote, stage], auth);
        await this.configure(stage);
        this.check(); await rename(stage, this.common); stage = undefined;
      }
      this.log(`git source=github before=${before} after=${await gitTreeBytes(this.common)}`);
      return true;
    } catch (error) {
      this.check();
      const status = (error as { status?: number }).status;
      const reason = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not_found" : status === 429 ? "rate_limited" : "unavailable";
      this.log(`git source=bundle reason=${reason}`);
      if (!exists) {
        if (stage) await rm(stage, { recursive: true, force: true });
        stage = join(this.store, `.clone-${randomUUID()}`);
        await this.run(["init", "-q", "--bare", "--template=", "--initial-branch=main", stage]);
        await this.configure(stage);
        this.check(); await rename(stage, this.common); stage = undefined;
      }
      return false;
    } finally { if (stage) await rm(stage, { recursive: true, force: true }); }
  }

  private async configure(gitDir: string): Promise<void> {
    for (const [key, value] of Object.entries({ "remote.origin.url": this.remote, "remote.origin.fetch": "+refs/heads/*:refs/remotes/origin/*",
      "remote.origin.promisor": "true", "remote.origin.partialclonefilter": "blob:none", "remote.origin.tagopt": "--no-tags" }))
      await this.run(["--git-dir", gitDir, "config", key, value]);
    await gitDirectory(join(gitDir, "info"), true);
    await writeGitFile(join(gitDir, "info", "exclude"), "/.zeros-sync/\n/.context/\n");
  }

  private async hasCommit(head: string): Promise<boolean> {
    return COMMIT.test(head) && this.storeGit("cat-file", "-e", `${head}^{commit}`).then(() => true, () => false);
  }
  private async heldHeads(previous?: string): Promise<string[]> {
    const refs = (await this.storeGit("for-each-ref", "--count=128", "--sort=-committerdate", "--format=%(objectname)", "refs/heads/", "refs/remotes/origin/", "refs/zeros-sync/")).split("\n");
    const heads: string[] = [];
    for (const head of new Set([...(previous ? [previous] : []), ...refs])) {
      if (await this.hasCommit(head)) heads.push(head);
      if (heads.length === 64) break;
    }
    return heads;
  }
  private async importBundle(source: GitSource, reply: SyncBootstrapReply): Promise<void> {
    if (!reply.bundle) return;
    const bundle = await this.download({ ...source, bundleRead: async (...args) => { this.check(); const result = await source.bundleRead(...args); this.check(); return result; } }, reply.bundle);
    try {
      const before = await gitTreeBytes(this.common);
      await this.storeGit("bundle", "verify", "-q", bundle);
      await this.run(["--git-dir", this.common, "fetch", "-q", "--no-tags", "--no-write-fetch-head", bundle, `refs/heads/${reply.branch}`], { fileTransport: true });
      this.log(`git source=bundle before=${before} after=${await gitTreeBytes(this.common)}`);
    } finally { await rm(bundle, { force: true }); }
  }

  private registrationId(gitdir: string): string {
    const registration = basename(gitdir);
    if (gitdir !== join(this.common, "worktrees", registration) || !new RegExp(`^${this.options.workspaceId}[0-9]*$`).test(registration)) throw new Error("Foreign Git registration.");
    return registration;
  }
  private async linkedRegistration(file: string): Promise<string> {
    const text = await readGitFile(file, 8192);
    if (!text.startsWith("gitdir: ") || text.trim().includes("\n")) throw new Error("Invalid Git link.");
    return this.registrationId(text.trim().slice(8));
  }
  private registrationRecord(registration: string): Registration {
    return { version: 1, workspaceId: this.options.workspaceId, store: this.store, registration, root: this.root };
  }
  private async registration(): Promise<string | undefined> {
    const info = await lstat(join(this.root, ".git")).catch(() => null);
    if (!info || info.isDirectory()) return undefined;
    const registration = await this.linkedRegistration(join(this.root, ".git"));
    await gitDirectory(join(this.common, "worktrees", registration));
    const record = JSON.parse(await readGitFile(join(this.meta, "shared-git.json"))) as Registration;
    if (JSON.stringify(record) !== JSON.stringify(this.registrationRecord(registration))) throw new Error("Foreign Git registration.");
    if ((await readGitFile(join(this.common, "worktrees", registration, "gitdir"))).trim() !== join(this.root, ".git")) throw new Error("Moved Git registration.");
    return registration;
  }
  private async verify(registration: string, head: string): Promise<void> {
    if (await this.workGit(registration, "rev-parse", "HEAD") !== head) throw new Error("Git head changed.");
    if (!(await readGitFile(join(this.common, "worktrees", registration, "HEAD"))).trim().match(COMMIT)) throw new Error("Git head is attached.");
    await this.workGit(registration, "diff-index", "--cached", "--quiet", head, "--");
  }
  private async setHead(registration: string, head: string): Promise<void> {
    await this.workGit(registration, "update-ref", "--no-deref", "HEAD", head);
    await this.storeGit("update-ref", `refs/zeros-sync/${this.options.workspaceId}/${registration}/head`, head);
    await this.workGit(registration, "read-tree", head);
    await this.verify(registration, head);
  }

  private async register(head: string, previous?: GitState): Promise<string> {
    const old = await lstat(join(this.root, ".git")).catch(() => null);
    if (old && (!old.isDirectory() || old.isSymbolicLink())) throw new Error("Foreign Git link.");
    if (old && !await this.legacyOwned(previous)) throw new Error("Legacy Git changed.");
    if (await lstat(join(this.meta, "old-git")).then(() => true, () => false)) throw new Error("Unfinished Git migration.");
    const parent = join(this.meta, `register-${randomUUID()}`), stage = join(parent, this.options.workspaceId);
    await gitDirectory(parent, true);
    const intent: RegistrationIntent = { ...this.registrationRecord(""), stage, head, ...(old ? { legacy: { dev: old.dev, ino: old.ino } } : {}) };
    await writeGitFile(join(this.meta, "git-intent.json"), JSON.stringify(intent));
    await this.storeGit("worktree", "add", "--detach", "--no-checkout", stage, head);
    intent.registration = await this.linkedRegistration(join(stage, ".git"));
    await writeGitFile(join(this.meta, "git-intent.json"), JSON.stringify(intent));
    this.check();
    if (old) {
      if (!await this.legacyOwned(previous)) throw new Error("Legacy Git changed.");
      const current = await lstat(join(this.root, ".git"));
      if (current.dev !== old.dev || current.ino !== old.ino) throw new Error("Legacy Git changed.");
      this.check(); await rename(join(this.root, ".git"), join(this.meta, "old-git"));
    }
    // Link is an atomic no-replace publication; a folder chosen later cannot retarget an older registration.
    await link(join(stage, ".git"), join(this.root, ".git"));
    await this.finishRegistration(intent);
    return intent.registration;
  }

  private async finishRegistration(intent: RegistrationIntent): Promise<void> {
    await this.storeGit("worktree", "repair", this.root);
    await this.setHead(intent.registration, intent.head);
    const record = this.registrationRecord(intent.registration);
    await writeGitFile(join(this.meta, "shared-git.json"), JSON.stringify(record));
    await gitDirectory(join(this.store, "registrations"), true);
    await writeGitFile(join(this.store, "registrations", `${intent.registration}.json`), JSON.stringify(record));
    if (intent.legacy) {
      const backup = await lstat(join(this.meta, "old-git")).catch(() => null);
      if (backup && (backup.dev !== intent.legacy.dev || backup.ino !== intent.legacy.ino || !backup.isDirectory())) throw new Error("Git backup changed.");
      if (backup) await rm(join(this.meta, "old-git"), { recursive: true });
    }
    await this.removeStage(intent);
    await rm(join(this.meta, "git-intent.json"));
  }

  private async removeStage(intent: RegistrationIntent): Promise<void> {
    await rm(join(intent.stage, ".git"), { force: true });
    await rmdir(intent.stage).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    await rmdir(dirname(intent.stage)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
  }

  private async recover(): Promise<void> {
    const path = join(this.meta, "git-intent.json");
    if (!await lstat(path).then(() => true, () => false)) return;
    const intent = JSON.parse(await readGitFile(path)) as RegistrationIntent;
    if (intent.version !== 1 || intent.workspaceId !== this.options.workspaceId || intent.store !== this.store || intent.root !== this.root || !COMMIT.test(intent.head) ||
      dirname(dirname(intent.stage)) !== this.meta || !/^register-[0-9a-f-]{36}$/.test(basename(dirname(intent.stage))) || basename(intent.stage) !== this.options.workspaceId) throw new Error("Invalid Git recovery.");
    if (!intent.registration) intent.registration = await this.linkedRegistration(join(intent.stage, ".git")).catch(() => "");
    if (intent.registration) this.registrationId(join(this.common, "worktrees", intent.registration));
    const current = await lstat(join(this.root, ".git")).catch(() => null);
    if (current?.isFile() && await this.linkedRegistration(join(this.root, ".git")) === intent.registration) {
      await this.finishRegistration(intent); return;
    }
    if (current && (!current.isDirectory() || !intent.legacy || current.dev !== intent.legacy.dev || current.ino !== intent.legacy.ino)) throw new Error("Git recovery changed.");
    if (!current && intent.legacy) {
      const backup = await lstat(join(this.meta, "old-git"));
      if (!backup.isDirectory() || backup.dev !== intent.legacy.dev || backup.ino !== intent.legacy.ino) throw new Error("Git backup changed.");
      await rename(join(this.meta, "old-git"), join(this.root, ".git"));
    }
    if (intent.registration) {
      const admin = join(this.common, "worktrees", intent.registration);
      if ((await readGitFile(join(admin, "gitdir"))).trim() !== join(intent.stage, ".git")) throw new Error("Git registration changed.");
      await rm(admin, { recursive: true });
    }
    await this.removeStage(intent);
    await rm(path);
  }

  override async storage(changed = false): Promise<WorkspaceSyncStorage | undefined> {
    this.check();
    if (!await this.registration()) return undefined;
    if (changed) await withGitStoreLock(this.store, this.options, async () => {
      const record = await this.readStore(); record.changedAt = this.now();
      this.check(); await writeGitFile(join(this.store, "store.json"), JSON.stringify(record));
    });
    const [sharedGitBytes, folderBytes] = await Promise.all([cachedBytes(this.common, this.now()), cachedBytes(this.root, this.now())]);
    this.check();
    return { storeId: createHash("sha256").update(`${this.scope.organizationId}/${this.scope.repository}`).digest("hex"), sharedGitBytes, folderBytes };
  }

  private async periodicMaintenance(): Promise<void> {
    const now = this.now(), last = maintainedAt.get(this.store);
    if (last !== undefined && now - last < 60_000) return;
    maintainedAt.delete(this.store); maintainedAt.set(this.store, now);
    while (maintainedAt.size > 512) maintainedAt.delete(maintainedAt.keys().next().value!);
    await this.maintain().catch(() => { this.check(); this.log("git maintenance=skipped"); });
  }

  async maintain(): Promise<void> {
    if (!await lstat(this.store).then(() => true, () => false)) return;
    await withGitStoreLock(this.store, this.options, async () => {
      const record = await this.readStore();
      const hasGit = await lstat(this.common).then(() => true, () => false);
      if (hasGit) { await this.checkConfig(this.common, false); await this.storeGit("worktree", "prune", "--expire=now"); }
      const ids = hasGit ? await readdir(join(this.common, "worktrees")).catch(() => [] as string[]) : [];
      const registrations = await readdir(join(this.store, "registrations")).catch(() => [] as string[]);
      for (const name of registrations) {
        if (!name.endsWith(".json") || ids.includes(name.slice(0, -5))) continue;
        const path = join(this.store, "registrations", name), old = JSON.parse(await readGitFile(path)) as Registration;
        if (old.version !== 1 || old.store !== this.store || !UUID.test(old.workspaceId) || !new RegExp(`^${old.workspaceId}[0-9]*$`).test(old.registration) || name !== `${old.registration}.json`) throw new Error("Invalid Git registration.");
        await this.storeGit("update-ref", "-d", `refs/zeros-sync/${old.workspaceId}/${old.registration}/head`);
        await rm(path);
      }
      const now = this.now();
      if (ids.length) delete record.emptyAt;
      else record.emptyAt ??= now;
      if (!ids.length && now - record.emptyAt! >= 30 * DAY) {
        this.check();
        const trash = join(dirname(this.store), `.removed-${randomUUID()}`);
        await rename(this.store, trash);
        await rm(trash, { recursive: true });
        byteCache.delete(this.common);
        this.log("git maintenance=removed");
        return;
      }
      if (hasGit && now - record.gcAt >= 7 * DAY && now - record.changedAt >= DAY) {
        let changedAt = record.changedAt;
        for (const id of ids) {
          const admin = join(this.common, "worktrees", id);
          await gitDirectory(admin);
          const gitdir = (await readGitFile(join(admin, "gitdir"), 8192)).trim();
          if (basename(gitdir) !== ".git") throw new Error("Invalid Git registration.");
          const root = dirname(gitdir); await gitDirectory(root);
          changedAt = Math.max(changedAt, (await gitTreeStats(root, [".git", ".zeros-sync"])).modifiedAt,
            (await gitTreeStats(admin)).modifiedAt);
        }
        if (now - changedAt >= DAY) { await this.storeGit("gc", "--prune=2.weeks"); record.gcAt = now; this.log("git maintenance=gc"); }
      }
      this.check(); await writeGitFile(join(this.store, "store.json"), JSON.stringify(record));
    });
  }
}

export async function maintainSharedGitStores(channel: string, options: GitLifetime & { now?(): number; log?(line: string): void; git?: GitRun } = {}): Promise<void> {
  const base = join(channel, "cloud-workspaces");
  if (!await lstat(base).then(() => true, () => false)) return;
  await gitDirectory(base);
  let visited = 0;
  for (const organizationId of await readdir(base)) {
    if (!UUID.test(organizationId)) continue;
    const organization = join(base, organizationId); await gitDirectory(organization);
    for (const name of await readdir(organization)) {
      assertGitCurrent(options);
      if (++visited > 4096) return;
      const store = join(organization, name);
      try {
        await gitDirectory(store);
        const record = JSON.parse(await readGitFile(join(store, "store.json"))) as StoreRecord;
        const scope = normalizedScope(record);
        if (record.version !== 1 || sharedGitStorePath(channel, scope) !== store) continue;
        const mirror = new SharedGitMirror(store, store, { ...options, channel, scope, workspaceId: "00000000-0000-0000-0000-000000000000", token: async () => { throw new Error("Maintenance is offline."); }, git: options.git ?? runGit });
        await mirror.maintain();
      } catch { assertGitCurrent(options); options.log?.("git maintenance=skipped"); }
    }
  }
}
