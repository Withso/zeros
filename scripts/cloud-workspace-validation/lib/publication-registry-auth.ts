import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

type Locations = {
  dockerConfigDirectory: string;
  stateDirectory: string;
  homeDirectory?: string;
};
type Snapshot = { data: string; mode: number } | null;
type Journal = {
  version: 1;
  destination: string;
  previous: Snapshot;
  installedSha256: string;
  createdDirectory: boolean;
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const same = (a: Snapshot, b: Snapshot) =>
  a?.data === b?.data && a?.mode === b?.mode;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function locations(options: Locations) {
  const home = options.homeDirectory ?? homedir();
  if (
    ![home, options.dockerConfigDirectory, options.stateDirectory].every(
      path.isAbsolute,
    )
  )
    throw new Error("Registry credential paths must be absolute");
  const directory = path.join(home, ".docker");
  const destination = path.join(directory, "config.json");
  const source = path.join(options.dockerConfigDirectory, "config.json");
  if (source === destination)
    throw new Error("Registry credential stores must be distinct");
  return {
    directory,
    destination,
    source,
    journal: path.join(options.stateDirectory, "registry-auth-bridge.json"),
  };
}

async function snapshot(file: string): Promise<Snapshot> {
  let handle;
  try {
    handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 1_048_576 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0
    )
      throw new Error("Unsafe registry credential file");
    const bytes = await handle.readFile();
    return {
      data: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      ),
      mode: stat.mode & 0o777,
    };
  } finally {
    await handle.close();
  }
}

async function directoryCheck(directory: string) {
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o022) !== 0
  )
    throw new Error("Unsafe registry credential directory");
}
async function syncDirectory(directory: string) {
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function removeEmptyDirectory(directory: string) {
  await rmdir(directory).catch((error) => {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  });
}

async function atomicWrite(
  file: string,
  value: NonNullable<Snapshot>,
  expected: Snapshot,
) {
  if (!same(await snapshot(file), expected))
    throw new Error("Registry credential file changed concurrently");
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", value.mode);
  try {
    await handle.writeFile(value.data);
    await handle.chmod(value.mode);
    await handle.sync();
    if (!same(await snapshot(file), expected))
      throw new Error("Registry credential file changed concurrently");
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await handle.close();
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

// The pinned actions/attest OCI reader ignores DOCKER_CONFIG and reads only
// homedir()/.docker/config.json. Bridge that one registry without changing HOME.
// A private write-ahead journal permits cleanup after an interrupted stage.
export async function stagePublicationRegistryAuth(options: Locations) {
  const files = locations(options);
  await directoryCheck(options.stateDirectory);
  await directoryCheck(options.dockerConfigDirectory);
  const source = await snapshot(files.source);
  const config: unknown = JSON.parse(source?.data ?? "null");
  const auths = object(config) && config.auths;
  const entry = object(auths) && auths["ghcr.io"];
  const auth = object(entry) && entry.auth;
  if (
    typeof auth !== "string" ||
    !auth ||
    Buffer.from(auth, "base64").toString("base64") !== auth
  )
    throw new Error("Missing GHCR publication credential");
  const decoded = Buffer.from(auth, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 1 || separator === decoded.length - 1)
    throw new Error("Invalid GHCR publication credential");
  let createdDirectory = false;
  try {
    await mkdir(files.directory, { mode: 0o700 });
    createdDirectory = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let journalWritten = false;
  try {
    await directoryCheck(files.directory);
    if (
      (await realpath(files.directory)) ===
      (await realpath(options.dockerConfigDirectory))
    )
      throw new Error("Registry credential stores must be distinct");
    const previous = await snapshot(files.destination);
    const prior: unknown = JSON.parse(previous?.data ?? "{}");
    if (!object(prior) || (prior.auths !== undefined && !object(prior.auths)))
      throw new Error("Invalid existing Docker configuration");
    const installed = {
      data: JSON.stringify({ auths: { "ghcr.io": { auth } } }) + "\n",
      mode: 0o600,
    };
    const journal: Journal = {
      version: 1,
      destination: files.destination,
      previous,
      installedSha256: digest(installed.data),
      createdDirectory,
    };
    const encodedJournal = JSON.stringify(journal);
    if (Buffer.byteLength(encodedJournal) > 1_048_576)
      throw new Error("Registry restoration journal exceeds its size limit");
    const handle = await open(files.journal, "wx", 0o600);
    journalWritten = true;
    try {
      await handle.writeFile(encodedJournal);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(options.stateDirectory);
    await atomicWrite(files.destination, installed, previous);
  } catch (error) {
    if (createdDirectory && !journalWritten)
      await removeEmptyDirectory(files.directory);
    throw error;
  }
}

export async function restorePublicationRegistryAuth(options: Locations) {
  const files = locations(options);
  await directoryCheck(options.stateDirectory);
  const saved = await snapshot(files.journal);
  if (!saved) return;
  const journal = JSON.parse(saved.data) as Journal;
  if (
    journal.version !== 1 ||
    journal.destination !== files.destination ||
    !/^[a-f0-9]{64}$/.test(journal.installedSha256) ||
    typeof journal.createdDirectory !== "boolean" ||
    !(
      journal.previous === null ||
      (object(journal.previous) &&
        typeof journal.previous.data === "string" &&
        Number.isInteger(journal.previous.mode) &&
        journal.previous.mode >= 0 &&
        journal.previous.mode <= 0o777 &&
        (journal.previous.mode & 0o022) === 0)
    )
  )
    throw new Error("Invalid registry credential restoration journal");
  await directoryCheck(files.directory).catch((error) => {
    if (error.code !== "ENOENT" || journal.previous !== null) throw error;
  });
  const current = await snapshot(files.destination);
  if (!same(current, journal.previous)) {
    if (
      !current ||
      current.mode !== 0o600 ||
      digest(current.data) !== journal.installedSha256
    )
      throw new Error("Registry credential file changed after staging");
    if (journal.previous)
      await atomicWrite(files.destination, journal.previous, current);
    else await unlink(files.destination);
  }
  if (current) await syncDirectory(files.directory);
  await unlink(files.journal);
  await syncDirectory(options.stateDirectory);
  if (journal.createdDirectory) await removeEmptyDirectory(files.directory);
}
