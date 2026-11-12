import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, rename, rm, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { isCloudEnvironmentPath, type CloudEnvironmentSeedError, type CloudWorkspaceEnvironment } from "@zeros/protocol/cloud-v2-relay";
import { CheckedFiles, descriptorPath } from "./checked-files";
import { openDirectoryNoFollow } from "../sharing/no-follow";
import { commandRunner } from "./commands";
import type { WorkspaceScope } from "./scope";

const SEED_DIRECTORY = "environment-seed";
const fileSchema = z.object({ path: z.string().refine(isCloudEnvironmentPath), alias: z.string().uuid(),
  phase: z.enum(["preparing", "prepared", "publishing", "complete"]),
  dev: z.number().int().nonnegative().optional(), ino: z.number().int().nonnegative().optional(),
}).strict();
const journalSchema = z.object({ version: z.literal(1), workspace: z.string(), versionId: z.string().uuid(), repositoryId: z.string(),
  complete: z.boolean(), files: z.array(fileSchema).max(16),
}).strict();
type Journal = z.infer<typeof journalSchema>;
type Entry = Journal["files"][number];
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const noEntry = async (path: string) => lstat(path).catch(error => { if (missing(error)) return undefined; throw error; });
const owns = (entry: Pick<Entry, "dev" | "ino">, info: { dev: number; ino: number }) => entry.dev === info.dev && entry.ino === info.ino;

export class EnvironmentSeedError extends Error {
  constructor(readonly code: CloudEnvironmentSeedError) { super("The cloud environment could not be prepared."); }
}
const refuse = (code: CloudEnvironmentSeedError): never => { throw new EnvironmentSeedError(code); };

async function readBounded(file: FileHandle, maximum: number): Promise<Buffer> {
  const before = await file.stat();
  if (!before.isFile() || before.size > maximum) return refuse("cloud_environment_seed_uncertain");
  const buffer = Buffer.alloc(before.size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  const after = await file.stat();
  if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
    return refuse("cloud_environment_seed_uncertain");
  return buffer.subarray(0, offset);
}

async function save(directory: FileHandle, journal: Journal): Promise<void> {
  const temporary = `${descriptorPath(directory)}/${randomUUID()}`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(journal)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, `${descriptorPath(directory)}/manifest.json`);
  await directory.sync();
}

async function retire(path: string, identity: Pick<Entry, "dev" | "ino">): Promise<void> {
  const privateDirectory = await mkdtemp(join(dirname(path), "retired-")), captured = join(privateDirectory, "entry");
  try {
    await rename(path, captured);
    if (owns(identity, await lstat(captured))) await unlink(captured);
    else await link(captured, path).catch(() => {});
  } catch (error) { if (!missing(error)) throw error; }
  finally { await rmdir(privateDirectory).catch(() => {}); }
}

async function indexLock(scope: WorkspaceScope, action: (assertOwned: () => Promise<void>) => Promise<void>): Promise<void> {
  const git = commandRunner(scope.root);
  const index = (await git("git", ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout.replace(/\n$/, "");
  if (!isAbsolute(index) || index.includes("\0")) throw new Error("The environment index lock is unavailable.");
  const directory = await mkdtemp(join(dirname(index), "zeros-environment-")), privateLock = join(directory, "lock"), publicLock = `${index}.lock`;
  const file = await open(privateLock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const owner = await file.stat();
  let acquired = false;
  try {
    await link(privateLock, publicLock); acquired = true;
    await action(async () => { if (!owns(owner, await lstat(publicLock))) throw new Error("The environment index lock changed."); });
  } finally {
    if (acquired) await retire(publicLock, owner);
    await file.close();
    await retire(privateLock, owner);
    await rmdir(directory).catch(() => {});
  }
}

/** The journal is durable before each irreversible step. A crash after link
 * intent cannot prove an absent file was never published: it may have been
 * deleted by the user. Only a captured inode can settle that uncertainty. */
export async function seedEnvironment(scope: WorkspaceScope, stateDirectory: string, environment: CloudWorkspaceEnvironment | undefined, signal: AbortSignal): Promise<void> {
  const check = () => { if (signal.aborted) throw new Error("Environment preparation was cancelled."); };
  check();
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const state = await open(stateDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let directory: FileHandle | undefined;
  try {
    const path = `${descriptorPath(state)}/${SEED_DIRECTORY}`;
    if (!environment && !await noEntry(path)) return;
    await mkdir(path, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await state.sync();
    const stored = await open(`${descriptorPath(directory)}/manifest.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch(error => { if (missing(error)) return undefined; throw error; });
    let journal: Journal | undefined;
    if (stored) {
      try {
        const parsed = journalSchema.safeParse(JSON.parse((await readBounded(stored, 32 * 1024)).toString("utf8")));
        if (!parsed.success) return refuse("cloud_environment_seed_uncertain");
        journal = parsed.data;
      } catch (error) { if (error instanceof EnvironmentSeedError) throw error; return refuse("cloud_environment_seed_uncertain"); }
      finally { await stored.close(); }
    }
    if (!environment || (journal && (journal.workspace !== scope.key || journal.versionId !== environment.versionId || journal.repositoryId !== environment.repositoryId ||
      JSON.stringify(journal.files.map(file => file.path)) !== JSON.stringify(environment.files.map(file => file.path))))) return refuse("cloud_environment_pin_changed");
    if (journal?.complete) {
      if (journal.files.some(file => file.phase !== "complete")) return refuse("cloud_environment_seed_uncertain");
      return;
    }
    const files = new CheckedFiles(scope);
    const parent = async (relative: string): Promise<FileHandle> => {
      let handle = await open(scope.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        for (const part of relative.split("/").slice(0, -1)) {
          check(); await files.assertDescriptor(handle);
          const child = `${descriptorPath(handle)}/${part}`;
          await mkdir(child, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
          const next = await open(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
            .catch(() => refuse("cloud_environment_path_conflict"));
          await handle.sync(); await handle.close(); handle = next;
          if (await noEntry(`${descriptorPath(handle)}/.git`)) return refuse("cloud_environment_path_conflict");
        }
        await files.assertDescriptor(handle);
        return handle;
      } catch (error) { await handle.close(); throw error; }
    };
    const git = commandRunner(scope.root);
    const eligible = async (relative: string) => {
      const tracked = await git("git", ["ls-files", "--cached", "-z", "--", `:(literal)${relative}`], { readOnly: true });
      if (tracked.stdout) return refuse("cloud_environment_path_untracked_required");
      const ignored = await git("git", ["check-ignore", "--quiet", "--", relative], { readOnly: true, allowExitCodes: [1] });
      if (ignored.code !== 0) return refuse("cloud_environment_path_ignored_required");
    };
    await indexLock(scope, async assertOwned => {
      check();
      // Refuse the complete selection before publishing any of its files.
      for (const file of environment.files) {
        const entry = journal?.files.find(value => value.path === file.path);
        if (entry?.phase === "complete") continue;
        const held = await parent(file.path);
        try {
          await eligible(file.path);
          const target = await noEntry(`${descriptorPath(held)}/${basename(file.path)}`);
          if (target && !(entry?.phase === "publishing" && target.isFile() && owns(entry, target))) return refuse("cloud_environment_path_conflict");
        } finally { await held.close(); }
      }
      journal ??= { version: 1, workspace: scope.key, versionId: environment.versionId, repositoryId: environment.repositoryId, complete: false,
        files: environment.files.map(file => ({ path: file.path, alias: randomUUID(), phase: "preparing" })) };
      await save(directory!, journal);
      for (let i = 0; i < journal.files.length; i++) {
        check();
        const entry = journal.files[i]!;
        const alias = `${descriptorPath(directory!)}/${entry.alias}`;
        if (entry.phase === "complete") { await retire(alias, entry); continue; }
        if (entry.dev === undefined || entry.ino === undefined) {
          const stage = await open(alias, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
            .catch(error => { if ((error as NodeJS.ErrnoException).code === "EEXIST") return refuse("cloud_environment_seed_uncertain"); throw error; });
          try { const info = await stage.stat(); entry.dev = info.dev; entry.ino = info.ino; await stage.sync(); await save(directory!, journal); }
          finally { await stage.close(); }
        }
        const stage = await open(alias, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          .catch(() => refuse("cloud_environment_seed_uncertain"));
        try {
          const info = await stage.stat();
          if (!info.isFile() || !owns(entry, info)) return refuse("cloud_environment_seed_uncertain");
          if (entry.phase === "preparing") {
            if (info.nlink !== 1) return refuse("cloud_environment_seed_uncertain");
            const bytes = Buffer.from(environment.files[i]!.content);
            await stage.writeFile(bytes); await stage.truncate(bytes.length); await stage.sync();
            entry.phase = "prepared"; await save(directory!, journal);
          }
          if (entry.phase === "prepared" && (info.nlink !== 1 || !(await readBounded(stage, 64 * 1024)).equals(Buffer.from(environment.files[i]!.content))))
            return refuse("cloud_environment_seed_uncertain");
        } finally { await stage.close(); }
        const held = await parent(entry.path), target = `${descriptorPath(held)}/${basename(entry.path)}`;
        try {
          check(); await files.assertDescriptor(held); await eligible(entry.path); await assertOwned();
          if (entry.phase === "publishing") {
            const captured = await noEntry(target);
            if (!captured?.isFile() || !owns(entry, captured)) return refuse("cloud_environment_seed_uncertain");
          } else {
            if (await noEntry(target)) return refuse("cloud_environment_path_conflict");
            entry.phase = "publishing"; await save(directory!, journal);
            if (signal.aborted) { entry.phase = "prepared"; await save(directory!, journal); check(); }
            await files.assertDescriptor(held); await assertOwned();
            if (signal.aborted) { entry.phase = "prepared"; await save(directory!, journal); check(); }
            await link(alias, target).catch(error => { if ((error as NodeJS.ErrnoException).code === "EEXIST") return refuse("cloud_environment_path_conflict"); throw error; });
            if (!owns(entry, await lstat(target))) return refuse("cloud_environment_seed_uncertain");
          }
          await held.sync();
          entry.phase = "complete"; await save(directory!, journal);
          await retire(alias, entry);
        } finally { await held.close(); }
      }
      check(); journal.complete = true; await save(directory!, journal);
    });
  } finally { await directory?.close(); await state.close(); }
}

export type LegacyRemoval = "none" | "removed" | "refused";

/** Team sharing slice D (wire Q-D2): the first activated boot removes the
 * Creator's seeded files from the shared checkout, using this journal's proof.
 * Each published file goes only if its path, walked without following any
 * link, still names the journal's exact inode as a regular file. An unfinished
 * or unreadable journal, or a replaced, symlinked or foreign file refuses the
 * whole removal and keeps every byte and the journal. Already deleted files
 * are gone. Afterwards the private seed directory (journal, aliases) goes. */
export async function removeSeededEnvironment(root: string, stateDirectory: string): Promise<LegacyRemoval> {
  // Every ancestor of the state and checkout paths is walked without following links (sharing/no-follow).
  let state: FileHandle | undefined, seed: FileHandle | undefined;
  try {
    state = await openDirectoryNoFollow(stateDirectory);
    if (!state) return "none";
    seed = await open(`${descriptorPath(state)}/${SEED_DIRECTORY}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      .catch(error => { if (missing(error)) return undefined; throw error; });
    if (!seed) return "none";
    return await removeSeededFiles(root, state, seed);
  } catch { return "refused"; }
  finally { await seed?.close().catch(() => {}); await state?.close().catch(() => {}); }
}

async function removeSeededFiles(root: string, state: FileHandle, seed: FileHandle): Promise<LegacyRemoval> {
  let journal: Journal;
  try {
    const stored = await open(`${descriptorPath(seed)}/manifest.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const parsed = journalSchema.safeParse(JSON.parse((await readBounded(stored, 32 * 1024)).toString("utf8")));
      if (!parsed.success) return "refused";
      journal = parsed.data;
    } finally { await stored.close(); }
  } catch { return "refused"; }
  if (!journal.complete || journal.files.some(file => file.phase !== "complete" || file.dev === undefined || file.ino === undefined)) return "refused";
  // Each target's parent, opened component by component without following links.
  const parentOf = async (relative: string): Promise<FileHandle | undefined> => {
    const checkout = await openDirectoryNoFollow(root);
    if (!checkout) return undefined;
    let handle: FileHandle = checkout;
    try {
      for (const part of relative.split("/").slice(0, -1)) {
        const next = await open(`${descriptorPath(handle)}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
          .catch(error => { if (missing(error)) return undefined; throw error; });
        await handle.close();
        if (!next) return undefined;
        handle = next;
      }
      return handle;
    } catch (error) { await handle.close(); throw error; }
  };
  const targets: Array<{ entry: Entry; held: FileHandle }> = [];
  try {
    for (const entry of journal.files) {
      const held = await parentOf(entry.path);
      if (!held) continue;   // its directory is gone: so is the file
      targets.push({ entry, held });
      const info = await noEntry(`${descriptorPath(held)}/${basename(entry.path)}`);
      if (info && (!info.isFile() || !owns(entry, info))) return "refused";
    }
    for (const { entry, held } of targets) await retire(`${descriptorPath(held)}/${basename(entry.path)}`, entry);
    for (const { entry, held } of targets) {
      const left = await noEntry(`${descriptorPath(held)}/${basename(entry.path)}`);
      if (left && owns(entry, left)) return "refused";
    }
  } catch { return "refused"; }
  finally { await Promise.all(targets.map(({ held }) => held.close().catch(() => {}))); }
  try { await rm(`${descriptorPath(state)}/${SEED_DIRECTORY}`, { recursive: true, force: true }); } catch { return "refused"; }
  return "removed";
}
