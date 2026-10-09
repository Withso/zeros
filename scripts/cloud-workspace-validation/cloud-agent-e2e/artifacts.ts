import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { HarnessFailure } from "./assertions";

type FixtureFileIO = {
  openSync: typeof openSync;
  fstatSync(descriptor: number): Stats;
  readSync(descriptor: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  closeSync(descriptor: number): void;
};
/** Caller guards the private fixture view. Ownership is observed from the same
 * no-follow descriptor as the bounded bytes; the path cannot substitute a
 * symlink target or a replacement inode after metadata inspection. */
export function readFixtureNativeFile(file: string, owner = { uid: 10003, gid: 10003 },
  io: FixtureFileIO = { openSync, fstatSync, readSync, closeSync }) {
  const maximum = 64 * 1024;
  let descriptor: number | undefined;
  try {
    descriptor = io.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const valid = (stat: Stats) => stat.isFile() && stat.nlink === 1 && stat.uid === owner.uid && stat.gid === owner.gid &&
      Number.isSafeInteger(stat.size) && stat.size >= 0 && stat.size <= maximum;
    const before = io.fstatSync(descriptor);
    if (!valid(before)) throw new HarnessFailure("fixture_contract_invalid");
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const length = io.readSync(descriptor, buffer, size, buffer.length - size, null);
      if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - size)
        throw new HarnessFailure("fixture_contract_invalid");
      if (!length) break;
      size += length;
    }
    const after = io.fstatSync(descriptor);
    if (!valid(after) || before.dev !== after.dev || before.ino !== after.ino || size > maximum ||
      size !== before.size || size !== after.size) throw new HarnessFailure("fixture_contract_invalid");
    return { uid: after.uid, gid: after.gid, bytes: size,
      sha256: createHash("sha256").update(buffer.subarray(0, size)).digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new HarnessFailure("fixture_contract_invalid");
  } finally { if (descriptor !== undefined) io.closeSync(descriptor); }
}
export function freshNativeArtifacts(nonce: string = randomUUID(), inputValue: string = randomUUID()) {
  const input = `fixture unread value ${inputValue}\n`;
  // Engine and direct provider tools share non-root namespace and VM UID10003.
  const output = `${input}fixture native edit ${nonce}\n`, start = `fixture native start ${nonce}\n`, shell = `fixture native shell ${nonce}\n10003\n`;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  return { nonce, input, output, start, shell, outputHash: hash(output), startHash: hash(start), shellHash: hash(shell) };
}
export function fixtureFileMatches(value: unknown, hash: string) {
  return value !== null && typeof value === "object" && (value as { sha256?: unknown }).sha256 === hash;
}
/** Current tool acceptance requires independently inspected agent ownership. */
export function fixtureAgentFileMatches(value: unknown, hash: string) {
  return fixtureFileMatches(value, hash) && (value as { uid?: unknown }).uid === 10003 &&
    (value as { gid?: unknown }).gid === 10003;
}
/** Metadata comes from the guarded parent namespace's real file inspection. */
export function fixtureEngineFileMatches(value: unknown, hash: string) {
  return fixtureFileMatches(value, hash) && (value as { uid?: unknown }).uid === 10003 &&
    (value as { gid?: unknown }).gid === 10003;
}
