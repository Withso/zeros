import { constants, type Stats } from "node:fs";
import { link, lstat, mkdtemp, open, readdir, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { descriptorPath } from "../workspace/checked-files";
import type { CloudV2BootCleanRefusal } from "@zeros/protocol/cloud-v2-relay";
import { NoFollowRefusal, openDirectoryNoFollow } from "./no-follow";
import { removeSeededEnvironment, type LegacyRemoval } from "../workspace/environment-seed";
import { CREATOR_IDENTITY_MARKER } from "../credentials/git-identity";

export type { LegacyRemoval };

/** The empty identity configureGitIdentity writes for gitIdentity: null: Git refuses rather than guessing; leases supply each person's. */
const EMPTY_IDENTITY = "[user]\n\tuseConfigOnly = true\n\tname = \"\"\n\temail = \"\"\n";
const RESTORE_TOKEN_DIRECTORY = /^zeros-restore-auth-[A-Za-z0-9]{10}$/;
class Refused extends Error { constructor(readonly refusal: CloudV2BootCleanRefusal) { super(refusal); } }
const refuse = (refusal: CloudV2BootCleanRefusal): never => { throw new Refused(refusal); };
/** Each cleanup's own classes: a walk that met a link, a foreign directory or entry. */
interface Site { linked: CloudV2BootCleanRefusal; foreign: CloudV2BootCleanRefusal; notRegular: CloudV2BootCleanRefusal }
const IDENTITY: Site = { linked: "git_identity_linked", foreign: "git_identity_foreign", notRegular: "git_identity_not_regular" };
const TERMINALS: Site = { linked: "terminal_dir_linked", foreign: "terminal_entry_foreign", notRegular: "terminal_entry_foreign" };
const TOKENS: Site = { linked: "shm_linked", foreign: "restore_token_dir_invalid", notRegular: "restore_token_dir_invalid" };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const mine = (info: Stats) => info.uid === process.getuid?.();

/** Team sharing slice D (wire Q-D2, Q-D3): what the phase-1 worker (or a legacy
 * restore) left on disk for its Creator, removed at an activated boot before
 * the clean-boot attestation (notes-O.md inventory): the seeded env files in
 * the shared checkout (by the seed journal's inode proof), the Creator's Git
 * identity (replaced with the empty useConfigOnly identity), restorable
 * terminal screens, and restore-token directories in /dev/shm. No link is
 * followed at any path component; only regular files and directories owned by
 * this user, captured and checked by inode, are changed. Anything uncertain
 * is refused and kept. In-memory material ends with the old processes. */
export async function removeLegacyMaterial(paths: { root: string; state: string; home: string; shm?: string },
  /** Each refused class, for the boot-clean diagnostics (no paths or values). */
  note: (refusal: CloudV2BootCleanRefusal) => void = () => {}): Promise<LegacyRemoval> {
  const results: LegacyRemoval[] = [];
  results.push(await removeSeededEnvironment(paths.root, paths.state, note));
  results.push(await guarded(() => clearGitIdentity(paths.home), IDENTITY, note));
  results.push(await guarded(() => clearTerminalRecords(paths.state), TERMINALS, note));
  results.push(await guarded(() => clearRestoreTokens(paths.shm ?? "/dev/shm"), TOKENS, note));
  return results.includes("refused") ? "refused" : results.includes("removed") ? "removed" : "none";
}

async function guarded(work: () => Promise<LegacyRemoval>, site: Site, note: (refusal: CloudV2BootCleanRefusal) => void): Promise<LegacyRemoval> {
  try { return await work(); }
  catch (error) {
    note(error instanceof Refused ? error.refusal : error instanceof NoFollowRefusal ? site[error.kind] : "io_error");
    return "refused";
  }
}

/** base/parts... through the shared no-follow walk (every ancestor included), ending in a directory this user owns; undefined when missing. */
async function heldDirectory(base: string, parts: readonly string[], site: Site): Promise<FileHandle | undefined> {
  const handle = await openDirectoryNoFollow(join(base, ...parts));
  if (handle && !mine(await handle.stat())) { await handle.close(); refuse(site.foreign); }
  return handle;
}

/** An entry of a held directory: a regular file owned by this user, or nothing. Anything else refuses. */
async function ownedFile(directory: FileHandle, name: string, site: Site): Promise<Stats | undefined> {
  const info = await lstat(`${descriptorPath(directory)}/${name}`).catch(error => { if (missing(error)) return undefined; throw error; });
  if (info && !info.isFile()) refuse(site.notRegular);
  if (info && !mine(info)) refuse(site.foreign);
  return info;
}

/** Remove exactly this inode: captured into a private directory first, put back if another took its place. */
async function removeExactly(directory: FileHandle, name: string, identity: Stats, site: Site): Promise<void> {
  const holder = await mkdtemp(`${descriptorPath(directory)}/.zeros-retire-`), captured = join(holder, "entry");
  try {
    await rename(`${descriptorPath(directory)}/${name}`, captured);
    const info = await lstat(captured);
    if (info.dev === identity.dev && info.ino === identity.ino) await unlink(captured);
    else { await link(captured, `${descriptorPath(directory)}/${name}`).catch(() => {}); refuse(site.foreign); }
  } finally { await unlink(captured).catch(() => {}); await rmdir(holder).catch(() => {}); }
}

async function clearGitIdentity(home: string): Promise<LegacyRemoval> {
  const directory = await heldDirectory(home, [".config", "zeros"], IDENTITY);
  if (!directory) return "none";
  try {
    const info = await ownedFile(directory, "git-identity", IDENTITY);
    if (!info) return "none";
    const file = await open(`${descriptorPath(directory)}/git-identity`, constants.O_RDONLY | constants.O_NOFOLLOW);
    let contents: string;
    try {
      const opened = await file.stat();
      if (opened.dev !== info.dev || opened.ino !== info.ino) refuse("git_identity_changed");
      if (opened.size > 64 * 1024) refuse("git_identity_not_regular");
      contents = await file.readFile("utf8");
    } finally { await file.close(); }
    if (contents === EMPTY_IDENTITY || contents.startsWith(`${CREATOR_IDENTITY_MARKER}\n`)) return "none";
    // The empty identity replaces exactly the file that was read, in the same held directory.
    const temporary = `${descriptorPath(directory)}/.git-identity-${process.pid}-${Date.now()}`;
    const replacement = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await replacement.writeFile(EMPTY_IDENTITY); await replacement.sync(); } finally { await replacement.close(); }
    try {
      const still = await ownedFile(directory, "git-identity", IDENTITY);
      if (!still || still.dev !== info.dev || still.ino !== info.ino) refuse("git_identity_changed");
      await rename(temporary, `${descriptorPath(directory)}/git-identity`);
    } finally { await unlink(temporary).catch(() => {}); }
    await directory.sync();
    return "removed";
  } finally { await directory.close(); }
}

async function clearTerminalRecords(state: string): Promise<LegacyRemoval> {
  const directory = await heldDirectory(state, ["terminals"], TERMINALS);
  if (!directory) return "none";
  try {
    const records = (await readdir(descriptorPath(directory))).filter(name => name.endsWith(".json"));
    // Every record is checked before any is removed: one foreign entry refuses them all.
    const owned: Array<[string, Stats]> = [];
    for (const name of records) { const info = await ownedFile(directory, name, TERMINALS); if (info) owned.push([name, info]); }
    if (!owned.length) return "none";
    for (const [name, info] of owned) await removeExactly(directory, name, info, TERMINALS);
    return "removed";
  } finally { await directory.close(); }
}

/** Q-D3: a restore command's private token directory: 0700, this user's, holding only its 0600 token. */
async function clearRestoreTokens(shm: string): Promise<LegacyRemoval> {
  const root = await openDirectoryNoFollow(shm);   // /dev/shm itself is root's; each token directory must be ours
  if (!root) return "none";
  const found: Array<{ name: string; directory: FileHandle; token?: Stats }> = [];
  try {
    const names = (await readdir(descriptorPath(root))).filter(name => name.startsWith("zeros-restore-auth-"));
    if (!names.length) return "none";
    for (const name of names) {
      if (!RESTORE_TOKEN_DIRECTORY.test(name)) refuse("restore_token_dir_invalid");
      const directory = await open(`${descriptorPath(root)}/${name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        .catch(error => { if (missing(error)) return undefined; throw ["ELOOP", "ENOTDIR"].includes(error.code) ? new Refused("restore_token_dir_invalid") : error; });
      if (!directory) continue;
      found.push({ name, directory });
      const info = await directory.stat();
      if (!mine(info) || (info.mode & 0o777) !== 0o700) refuse("restore_token_dir_invalid");
      const entries = await readdir(descriptorPath(directory));
      if (entries.some(entry => entry !== "token")) refuse("restore_token_dir_invalid");
      found.at(-1)!.token = await ownedFile(directory, "token", TOKENS);
    }
    for (const { name, directory, token } of found) {
      if (token) await removeExactly(directory, "token", token, TOKENS);
      await rmdir(`${descriptorPath(root)}/${name}`);
    }
    return found.length ? "removed" : "none";
  } finally {
    await Promise.all(found.map(({ directory }) => directory.close().catch(() => {})));
    await root.close().catch(() => {});
  }
}
