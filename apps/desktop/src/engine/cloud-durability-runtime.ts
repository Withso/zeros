import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  constants as fsConstants,
  promises as fs,
  type BigIntStats,
  type Stats,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONTENT_HEAD_PATH = "/internal/v1/cloud-workspaces/engine/content/head";
const CONTENT_APPEND_PATH =
  "/internal/v1/cloud-workspaces/engine/content/append";
const CHECKPOINT_PATH =
  "/internal/v1/cloud-workspaces/engine/checkpoints/commit";
const BLOB_PATH = "/internal/v1/cloud-workspaces/engine/blobs";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const MAX_FILES = 100_000;
const REQUEST_TIMEOUT_MS = 30_000;
// O_PATH is Linux-specific and intentionally used only behind a platform gate.
// Node does not expose it, but Linux keeps this UAPI value stable across arches.
const LINUX_O_PATH = 0o10000000;

export type CloudCheckpointDirective = {
  id: string;
  reason:
    | "before_stop"
    | "before_archive"
    | "before_delete"
    | "before_fork"
    | "before_rebuild"
    | "manual";
  deadlineAtMs: number;
};

export type CloudDurabilityAuthority = {
  heartbeatEndpoint: string;
  heartbeatToken: string;
  workspaceId: string;
  organizationId: string;
  generation: number;
  engineInstanceId: string;
};

type ProjectionEntry =
  | {
      operation: "upsert";
      path: string;
      entryType: "file" | "symlink";
      mode: 33188 | 33261 | 40960;
      blobId: string;
      contentSha256: string;
      sizeBytes: number;
    }
  | {
      operation: "delete";
      path: string;
      entryType: null;
      mode: null;
      blobId: null;
      contentSha256: null;
      sizeBytes: null;
    };

type ScannedEntry = {
  path: string;
  entryType: "file" | "symlink";
  mode: 33188 | 33261 | 40960;
  contentSha256: string;
  sizeBytes: number;
  bytes: Buffer;
};

export type CloudWorkspaceChangeScan = {
  gitBaseCommit: string;
  gitHeadRef: string | null;
  entries: Map<string, ScannedEntry>;
  deletions: Set<string>;
  fingerprint: string;
  totalBytes: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function normalizedPath(value: string): string {
  if (
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    // eslint-disable-next-line no-control-regex -- durable paths reject C0 and DEL
    /[\u0000-\u001f\u007f]/u.test(value) ||
    path.posix.normalize(value) !== value ||
    value
      .split("/")
      .some(
        (component) =>
          component === "." ||
          component === ".." ||
          component.toLocaleLowerCase("en-US") === ".git",
      )
  ) {
    throw new Error("cloud checkpoint contains an unsafe path");
  }
  return value;
}

function secretLike(relativePath: string): boolean {
  const lower = relativePath.toLocaleLowerCase("en-US");
  const basename = path.posix.basename(lower);
  const components = lower.split("/");
  const zerosPrivate = lower.startsWith(".zeros/")
    ? lower.slice(".zeros/".length)
    : null;
  return (
    components.some((component) =>
      ["node_modules", ".ssh", ".aws", ".azure"].includes(component),
    ) ||
    basename === ".env" ||
    basename.startsWith(".env.") ||
    basename === ".npmrc" ||
    basename === ".pypirc" ||
    basename === ".netrc" ||
    basename === ".git-credentials" ||
    basename === "id_rsa" ||
    basename === "id_ed25519" ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename.endsWith(".p12") ||
    basename.endsWith(".pfx") ||
    basename === "credentials" ||
    basename === "credentials.json" ||
    lower === ".zeros/settings.local.toml" ||
    lower.startsWith(".zeros/runtime/") ||
    lower.startsWith(".zeros/credentials/") ||
    lower.startsWith(".zeros/secrets/") ||
    (zerosPrivate !== null &&
      (zerosPrivate.endsWith(".db") ||
        zerosPrivate.endsWith(".db-wal") ||
        zerosPrivate.endsWith(".db-shm") ||
        zerosPrivate.endsWith(".sock") ||
        zerosPrivate.endsWith(".socket")))
  );
}

function splitNull(source: Buffer): string[] {
  if (source.length === 0) return [];
  if (source.at(-1) !== 0) throw new Error("git path output is invalid");
  const values: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  for (let end = 0; end < source.length; end += 1) {
    if (source[end] !== 0) continue;
    let value: string;
    try {
      value = decoder.decode(source.subarray(start, end));
    } catch {
      throw new Error("git path output is not valid UTF-8");
    }
    values.push(normalizedPath(value));
    start = end + 1;
  }
  return values;
}

function validateSymlinkTarget(relativePath: string, bytes: Buffer): void {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("cloud checkpoint symlink target is not valid UTF-8");
  }
  if (
    bytes.length < 1 ||
    bytes.length > 4_096 ||
    value.length < 1 ||
    value.length > 4_096 ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    // eslint-disable-next-line no-control-regex -- link targets reject C0 and DEL
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("cloud checkpoint symlink target is unsafe");
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(relativePath), value),
  );
  if (
    resolved === "." ||
    resolved === ".." ||
    resolved.startsWith("../") ||
    path.posix.isAbsolute(resolved)
  ) {
    throw new Error("cloud checkpoint symlink target escaped the repository");
  }
  normalizedPath(resolved);
  if (
    resolved.toLocaleLowerCase("en-US") === ".zeros" ||
    secretLike(resolved)
  ) {
    throw new Error("cloud checkpoint symlink target is excluded");
  }
}

async function gitBuffer(root: string, args: string[]): Promise<Buffer> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    env: {
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return Buffer.from(result.stdout);
}

async function gitText(root: string, args: string[]): Promise<string> {
  return (await gitBuffer(root, args)).toString("utf8").trim();
}

type NamedDirectoryBinding = {
  absolutePath: string;
  stat: Stats;
};

type LinuxDirectoryBinding = NamedDirectoryBinding & {
  handle: FileHandle;
};

type CaptureRoot = {
  root: string;
  binding: NamedDirectoryBinding;
  linux: LinuxDirectoryBinding | null;
};

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableEntry(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sameStableDirectory(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function noFollowFlag(): number {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error("no-follow cloud checkpoint capture is unavailable");
  }
  return fsConstants.O_NOFOLLOW;
}

function nonBlockingFlag(): number {
  if (!Number.isInteger(fsConstants.O_NONBLOCK)) {
    throw new Error("non-blocking cloud checkpoint capture is unavailable");
  }
  return fsConstants.O_NONBLOCK;
}

function linuxDirectoryFlags(): number {
  if (!Number.isInteger(fsConstants.O_DIRECTORY)) {
    throw new Error("secure Linux cloud checkpoint capture is unavailable");
  }
  return fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | noFollowFlag();
}

function linuxDescriptorChild(handle: FileHandle, component: string): string {
  if (
    component.length < 1 ||
    component === "." ||
    component === ".." ||
    component.includes("/")
  ) {
    throw new Error("cloud checkpoint descriptor component is invalid");
  }
  // `/proc/self/fd/<fd>` is the one intentionally followed magic link: the
  // kernel creates it from a directory descriptor this process already owns.
  // The worker-controlled component is a single final component and every
  // directory/file open applies O_NOFOLLOW, so it cannot redirect traversal.
  return `/proc/self/fd/${handle.fd}/${component}`;
}

async function openLinuxDirectory(
  parent: FileHandle,
  component: string,
  absolutePath: string,
): Promise<LinuxDirectoryBinding> {
  const handle = await fs.open(
    linuxDescriptorChild(parent, component),
    linuxDirectoryFlags(),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      throw new Error("cloud checkpoint parent is not a directory");
    }
    return { absolutePath, handle, stat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openLinuxCaptureRoot(
  root: string,
): Promise<LinuxDirectoryBinding> {
  const filesystemRoot = path.parse(root).root;
  let handle = await fs.open(filesystemRoot, linuxDirectoryFlags());
  let currentPath = filesystemRoot;
  try {
    for (const component of path
      .relative(filesystemRoot, root)
      .split(path.sep)
      .filter(Boolean)) {
      const nextPath = path.join(currentPath, component);
      const next = await openLinuxDirectory(handle, component, nextPath);
      await handle.close();
      handle = next.handle;
      currentPath = nextPath;
    }
    const stat = await handle.stat();
    const [named, anchored] = await Promise.all([
      fs.lstat(root),
      fs.stat(`/proc/self/fd/${handle.fd}`),
    ]);
    if (
      !named.isDirectory() ||
      named.isSymbolicLink() ||
      !sameIdentity(stat, named) ||
      !sameIdentity(stat, anchored)
    ) {
      throw new Error("cloud checkpoint repository root is unsafe");
    }
    return { absolutePath: root, handle, stat };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openCaptureRoot(
  root: string,
  requireDescriptorSafety: boolean,
): Promise<CaptureRoot> {
  const resolved = await fs.realpath(root);
  if (
    resolved !== root ||
    !path.isAbsolute(root) ||
    root === path.parse(root).root
  ) {
    throw new Error("cloud checkpoint repository root is invalid");
  }
  if (process.platform === "linux") {
    const linux = await openLinuxCaptureRoot(root);
    return { root, binding: linux, linux };
  }
  if (requireDescriptorSafety) {
    throw new Error(
      "privileged cloud checkpoint capture requires Linux descriptor safety",
    );
  }
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("cloud checkpoint repository root is unsafe");
  }
  return {
    root,
    binding: { absolutePath: root, stat },
    linux: null,
  };
}

async function withCaptureRoot<T>(
  root: string,
  requireDescriptorSafety: boolean,
  operation: (captureRoot: CaptureRoot, commandRoot: string) => Promise<T>,
): Promise<T> {
  const captureRoot = await openCaptureRoot(root, requireDescriptorSafety);
  const commandRoot = captureRoot.linux
    ? `/proc/${process.pid}/fd/${captureRoot.linux.handle.fd}`
    : captureRoot.root;
  try {
    return await operation(captureRoot, commandRoot);
  } finally {
    await captureRoot.linux?.handle.close().catch(() => undefined);
  }
}

async function verifyDirectoryBindings(
  bindings: readonly NamedDirectoryBinding[],
): Promise<void> {
  for (const binding of bindings) {
    let current: Stats;
    try {
      current = await fs.lstat(binding.absolutePath);
    } catch (error) {
      throw new Error("cloud checkpoint parent changed during scan", {
        cause: error,
      });
    }
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameIdentity(current, binding.stat)
    ) {
      throw new Error("cloud checkpoint parent changed during scan");
    }
  }
}

function scannedEntry(
  relativePath: string,
  entryType: "file" | "symlink",
  mode: 33188 | 33261 | 40960,
  bytes: Buffer,
): ScannedEntry {
  return {
    path: relativePath,
    entryType,
    mode,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    bytes,
  };
}

async function readLinuxBoundLeaf(
  leafPath: string,
  relativePath: string,
  parentHandle: FileHandle,
  verifyParents: () => Promise<void>,
): Promise<ScannedEntry> {
  let bytes: Buffer | null = null;
  let identityHandle: FileHandle | null = null;
  let dataHandle: FileHandle | null = null;
  try {
    // Open an identity-only descriptor before inspecting the leaf. O_PATH does
    // not perform device I/O, and O_NOFOLLOW binds a symlink itself rather than
    // its target. Every later Linux operation is checked against this inode.
    identityHandle = await fs.open(leafPath, LINUX_O_PATH | noFollowFlag());
    const initial = await identityHandle.stat();

    if (initial.isSymbolicLink()) {
      // Node has no readlinkat(fd, "") binding. A symlink payload is immutable,
      // so changing it requires replacing the parent entry; the pinned parent's
      // nanosecond ctime/mtime closes an otherwise possible ABA replacement.
      const parentBefore = await parentHandle.stat({ bigint: true });
      bytes = await fs.readlink(leafPath, { encoding: "buffer" });
      validateSymlinkTarget(relativePath, bytes);
      await verifyParents();
      const [namedAfter, pinnedAfter, parentAfter] = await Promise.all([
        fs.lstat(leafPath),
        identityHandle.stat(),
        parentHandle.stat({ bigint: true }),
      ]);
      if (
        !namedAfter.isSymbolicLink() ||
        !pinnedAfter.isSymbolicLink() ||
        !sameStableEntry(namedAfter, initial) ||
        !sameStableEntry(pinnedAfter, initial) ||
        !sameStableDirectory(parentAfter, parentBefore)
      ) {
        throw new Error("cloud checkpoint symlink changed during scan");
      }
      return scannedEntry(relativePath, "symlink", 40960, bytes);
    }

    if (!initial.isFile()) {
      throw new Error("cloud checkpoint path type is unsupported");
    }
    if (initial.size > MAX_FILE_BYTES || initial.nlink !== 1) {
      throw new Error("cloud checkpoint file is unsupported or too large");
    }

    // This intentionally follows only the process-owned procfs magic link for
    // the already-pinned O_PATH descriptor, never the mutable workspace name.
    dataHandle = await fs.open(
      `/proc/self/fd/${identityHandle.fd}`,
      fsConstants.O_RDONLY,
    );
    const opened = await dataHandle.stat();
    if (!opened.isFile() || !sameStableEntry(opened, initial)) {
      throw new Error("cloud checkpoint file changed during scan");
    }
    bytes = await dataHandle.readFile();
    await verifyParents();
    const [after, pinnedAfter, namedAfter] = await Promise.all([
      dataHandle.stat(),
      identityHandle.stat(),
      fs.lstat(leafPath),
    ]);
    if (
      !after.isFile() ||
      !pinnedAfter.isFile() ||
      !namedAfter.isFile() ||
      after.nlink !== 1 ||
      after.size > MAX_FILE_BYTES ||
      bytes.length !== after.size ||
      !sameStableEntry(after, opened) ||
      !sameStableEntry(pinnedAfter, opened) ||
      !sameStableEntry(namedAfter, opened)
    ) {
      throw new Error("cloud checkpoint file changed during scan");
    }
    const mode = (opened.mode & 0o111) === 0 ? 33188 : 33261;
    return scannedEntry(relativePath, "file", mode, bytes);
  } catch (error) {
    bytes?.fill(0);
    throw error;
  } finally {
    await dataHandle?.close().catch(() => undefined);
    await identityHandle?.close().catch(() => undefined);
  }
}

async function readPortableBoundLeaf(
  leafPath: string,
  relativePath: string,
  verifyParents: () => Promise<void>,
): Promise<ScannedEntry> {
  let bytes: Buffer | null = null;
  let handle: FileHandle | null = null;
  try {
    try {
      // Open before inspecting the mutable pathname. O_NOFOLLOW turns a final
      // symlink into ELOOP, while O_NONBLOCK prevents a raced FIFO from
      // stalling before the descriptor type is rejected below.
      handle = await fs.open(
        leafPath,
        fsConstants.O_RDONLY | noFollowFlag() | nonBlockingFlag(),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
      const before = await fs.lstat(leafPath);
      if (!before.isSymbolicLink()) {
        throw new Error("cloud checkpoint symlink changed during scan");
      }
      bytes = await fs.readlink(leafPath, { encoding: "buffer" });
      validateSymlinkTarget(relativePath, bytes);
      await verifyParents();
      let after: Stats;
      try {
        after = await fs.lstat(leafPath);
      } catch (error) {
        throw new Error("cloud checkpoint symlink changed during scan", {
          cause: error,
        });
      }
      if (!after.isSymbolicLink() || !sameStableEntry(after, before)) {
        throw new Error("cloud checkpoint symlink changed during scan");
      }
      return scannedEntry(relativePath, "symlink", 40960, bytes);
    }

    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new Error("cloud checkpoint path type is unsupported");
    }
    if (opened.size > MAX_FILE_BYTES || opened.nlink !== 1) {
      throw new Error("cloud checkpoint file is unsupported or too large");
    }
    const namedBefore = await fs.lstat(leafPath);
    if (!namedBefore.isFile() || !sameStableEntry(namedBefore, opened)) {
      throw new Error("cloud checkpoint file changed during scan");
    }
    bytes = await handle.readFile();
    await verifyParents();
    const [after, namedAfter] = await Promise.all([
      handle.stat(),
      fs.lstat(leafPath),
    ]);
    if (
      !after.isFile() ||
      !namedAfter.isFile() ||
      after.nlink !== 1 ||
      after.size > MAX_FILE_BYTES ||
      bytes.length !== after.size ||
      !sameStableEntry(after, opened) ||
      !sameStableEntry(namedAfter, opened)
    ) {
      throw new Error("cloud checkpoint file changed during scan");
    }
    const mode = (opened.mode & 0o111) === 0 ? 33188 : 33261;
    return scannedEntry(relativePath, "file", mode, bytes);
  } catch (error) {
    bytes?.fill(0);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readLinuxEntry(
  captureRoot: CaptureRoot,
  rootBinding: LinuxDirectoryBinding,
  relativePath: string,
): Promise<ScannedEntry> {
  const components = relativePath.split("/");
  const openedParents: LinuxDirectoryBinding[] = [];
  let parent = rootBinding;
  try {
    for (const component of components.slice(0, -1)) {
      const absolutePath = path.join(parent.absolutePath, component);
      const opened = await openLinuxDirectory(
        parent.handle,
        component,
        absolutePath,
      );
      openedParents.push(opened);
      parent = opened;
    }
    const leaf = components.at(-1)!;
    return await readLinuxBoundLeaf(
      linuxDescriptorChild(parent.handle, leaf),
      relativePath,
      parent.handle,
      () => verifyDirectoryBindings([captureRoot.binding, ...openedParents]),
    );
  } finally {
    for (const binding of openedParents.reverse()) {
      await binding.handle.close().catch(() => undefined);
    }
  }
}

async function readPortableEntry(
  captureRoot: CaptureRoot,
  relativePath: string,
): Promise<ScannedEntry> {
  const components = relativePath.split("/");
  const bindings: NamedDirectoryBinding[] = [captureRoot.binding];
  let current = captureRoot.root;
  for (const component of components.slice(0, -1)) {
    current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("cloud checkpoint parent is unsafe");
    }
    bindings.push({ absolutePath: current, stat });
  }
  return readPortableBoundLeaf(
    path.join(captureRoot.root, ...components),
    relativePath,
    () => verifyDirectoryBindings(bindings),
  );
}

async function readEntry(
  captureRoot: CaptureRoot,
  relativePath: string,
): Promise<ScannedEntry> {
  const linux = captureRoot.linux;
  return linux
    ? readLinuxEntry(captureRoot, linux, relativePath)
    : readPortableEntry(captureRoot, relativePath);
}

async function scanCloudWorkspaceChangesOnce(
  root: string,
  baseCommit: string | null,
  includeRepositorySettings: boolean,
  requireDescriptorSafety: boolean,
): Promise<CloudWorkspaceChangeScan> {
  return withCaptureRoot(
    root,
    requireDescriptorSafety,
    async (captureRoot, commandRoot) => {
      const revision = baseCommit ?? "HEAD";
      const [commit, tracked, changed, untracked] = await Promise.all([
        gitText(commandRoot, ["rev-parse", "--verify", `${revision}^{commit}`]),
        gitBuffer(commandRoot, ["ls-files", "-z", "--cached", "--"]),
        gitBuffer(commandRoot, [
          "diff",
          "--name-only",
          "-z",
          "--no-ext-diff",
          "--no-renames",
          revision,
          "--",
        ]),
        gitBuffer(commandRoot, [
          "ls-files",
          "-z",
          "--others",
          "--exclude-standard",
          "--",
        ]),
      ]);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
        throw new Error("cloud checkpoint Git base is invalid");
      }
      let headRef: string | null = null;
      try {
        const candidate = await gitText(commandRoot, [
          "symbolic-ref",
          "-q",
          "HEAD",
        ]);
        headRef =
          candidate.length > 0 && candidate.length <= 512 ? candidate : null;
      } catch {
        headRef = null;
      }
      // The durable projection is the complete safe working tree, not merely the
      // dirty overlay. This keeps a receive-only folder useful without copying
      // `.git` and makes a revert-to-HEAD distinguishable from a tracked deletion.
      // `changed` remains in the union because an index-staged deletion no longer
      // appears in `ls-files --cached` but must still become a tombstone.
      const paths = [
        ...new Set([
          ...splitNull(tracked),
          ...splitNull(changed),
          ...splitNull(untracked),
        ]),
      ]
        .filter(
          (entry) =>
            !secretLike(entry) &&
            (includeRepositorySettings ||
              entry.toLocaleLowerCase("en-US") !== ".zeros/settings.toml"),
        )
        .sort((left, right) =>
          Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
        );
      if (paths.length > MAX_FILES) {
        throw new Error("cloud checkpoint contains too many files");
      }
      const collisionKeys = new Set<string>();
      const entries = new Map<string, ScannedEntry>();
      const deletions = new Set<string>();
      let totalBytes = 0;
      try {
        for (const relativePath of paths) {
          const collision = relativePath
            .normalize("NFKC")
            .toLocaleLowerCase("en-US");
          if (collisionKeys.has(collision)) {
            throw new Error("cloud checkpoint contains a path collision");
          }
          collisionKeys.add(collision);
          try {
            const entry = await readEntry(captureRoot, relativePath);
            totalBytes += entry.sizeBytes;
            if (totalBytes > MAX_TOTAL_BYTES) {
              entry.bytes.fill(0);
              throw new Error("cloud checkpoint is too large");
            }
            entries.set(relativePath, entry);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            deletions.add(relativePath);
          }
        }
        await verifyDirectoryBindings([captureRoot.binding]);
        const fingerprint = createHash("sha256")
          .update(commit)
          .update("\0")
          .update(headRef ?? "")
          .update("\0")
          .update(
            JSON.stringify(
              [...entries.values()].map(({ bytes: _bytes, ...entry }) => entry),
            ),
          )
          .update("\0")
          .update(JSON.stringify([...deletions]))
          .digest("hex");
        return {
          gitBaseCommit: commit,
          gitHeadRef: headRef,
          entries,
          deletions,
          fingerprint,
          totalBytes,
        };
      } catch (error) {
        for (const entry of entries.values()) entry.bytes.fill(0);
        throw error;
      }
    },
  );
}

/** Capture the working-tree overlay relative to an exact Git base. Production
 * durability uses HEAD by default; local→cloud copy passes a full remote base
 * commit and requests a second byte-for-byte scan so concurrent edits cannot
 * create a torn import. */
export async function scanCloudWorkspaceChanges(
  root: string,
  options: {
    baseCommit?: string;
    verifyStable?: boolean;
    includeRepositorySettings?: boolean;
    /** Privileged cloud-engine capture has no pathname-only fallback. */
    requireDescriptorSafety?: boolean;
  } = {},
): Promise<CloudWorkspaceChangeScan> {
  const baseCommit = options.baseCommit ?? null;
  if (
    baseCommit !== null &&
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)
  ) {
    throw new Error("cloud checkpoint Git base is invalid");
  }
  const includeRepositorySettings = options.includeRepositorySettings !== false;
  const first = await scanCloudWorkspaceChangesOnce(
    root,
    baseCommit,
    includeRepositorySettings,
    options.requireDescriptorSafety === true,
  );
  if (!options.verifyStable) return first;
  let confirmation: CloudWorkspaceChangeScan | null = null;
  try {
    confirmation = await scanCloudWorkspaceChangesOnce(
      root,
      baseCommit,
      includeRepositorySettings,
      options.requireDescriptorSafety === true,
    );
    if (confirmation.fingerprint !== first.fingerprint) {
      throw new Error("cloud checkpoint changed while it was being captured");
    }
    return first;
  } catch (error) {
    for (const entry of first.entries.values()) entry.bytes.fill(0);
    throw error;
  } finally {
    if (confirmation) {
      for (const entry of confirmation.entries.values()) entry.bytes.fill(0);
    }
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() !==
    "application/json"
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("cloud durability response is invalid");
  }
  const declared = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declared) &&
    (declared < 0 || declared > MAX_JSON_BYTES)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("cloud durability response is too large");
  }
  if (!response.body) {
    throw new Error("cloud durability response is invalid");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_JSON_BYTES) {
        chunk.value.fill(0);
        await reader.cancel().catch(() => undefined);
        throw new Error("cloud durability response is too large");
      }
      chunks.push(
        Buffer.from(
          chunk.value.buffer,
          chunk.value.byteOffset,
          chunk.value.byteLength,
        ),
      );
    }
    const bytes = Buffer.concat(chunks, total);
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } finally {
      bytes.fill(0);
    }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

export class CloudWorkspaceDurabilityRuntime {
  private readonly fetch: typeof fetch;
  private active: Promise<void> | null = null;

  constructor(
    private readonly repositoryRoot: string,
    dependencies: { fetch?: typeof fetch } = {},
  ) {
    this.fetch = dependencies.fetch ?? globalThis.fetch;
  }

  checkpoint(
    directive: CloudCheckpointDirective,
    authority: CloudDurabilityAuthority,
  ): Promise<void> {
    if (this.active) {
      return Promise.reject(
        new Error("cloud checkpoint is already in progress"),
      );
    }
    const task = this.runCheckpoint(directive, authority).finally(() => {
      if (this.active === task) this.active = null;
    });
    this.active = task;
    return task;
  }

  private endpoint(
    authority: CloudDurabilityAuthority,
    pathname: string,
  ): string {
    const origin = new URL(authority.heartbeatEndpoint).origin;
    return `${origin}${pathname}`;
  }

  private scope(authority: CloudDurabilityAuthority): Record<string, string> {
    return {
      workspaceId: authority.workspaceId,
      organizationId: authority.organizationId,
      generation: String(authority.generation),
      engineInstanceId: authority.engineInstanceId,
    };
  }

  private async request(
    authority: CloudDurabilityAuthority,
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const response = await this.fetch(url, {
      ...init,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${authority.heartbeatToken}`,
        "user-agent": "zeros-cloud-engine",
        ...init.headers,
      },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("cloud durability request was rejected");
    }
    return response;
  }

  private async loadProjection(authority: CloudDurabilityAuthority): Promise<{
    currentRevision: number;
    entries: Map<string, ProjectionEntry>;
  }> {
    let afterPath: string | null = null;
    let revision: number | null = null;
    const entries = new Map<string, ProjectionEntry>();
    const seenCursors = new Set<string>();
    for (let page = 0; page < 100_000; page += 1) {
      const url = new URL(this.endpoint(authority, CONTENT_HEAD_PATH));
      for (const [key, value] of Object.entries(this.scope(authority))) {
        url.searchParams.set(key, value);
      }
      url.searchParams.set("limit", "200");
      if (afterPath !== null) {
        url.searchParams.set(
          "after",
          Buffer.from(afterPath, "utf8").toString("base64url"),
        );
      }
      const raw = await boundedJson(
        await this.request(authority, url.toString(), { method: "GET" }),
      );
      if (
        !isRecord(raw) ||
        !exactKeys(raw, [
          "checkpointId",
          "currentRevision",
          "durableRevision",
          "entries",
          "nextAfterPath",
        ]) ||
        !Number.isSafeInteger(raw.currentRevision) ||
        Number(raw.currentRevision) < 0 ||
        !Array.isArray(raw.entries) ||
        raw.entries.length > 200 ||
        !(raw.nextAfterPath === null || typeof raw.nextAfterPath === "string")
      ) {
        throw new Error("cloud durability projection is invalid");
      }
      if (revision === null) revision = Number(raw.currentRevision);
      else if (revision !== raw.currentRevision) {
        throw new Error(
          "cloud durability projection changed during pagination",
        );
      }
      for (const candidate of raw.entries) {
        if (
          !isRecord(candidate) ||
          !exactKeys(candidate, [
            "blobId",
            "contentSha256",
            "entryType",
            "mode",
            "operation",
            "path",
            "sizeBytes",
          ])
        ) {
          throw new Error("cloud durability projection is invalid");
        }
        if (typeof candidate.path !== "string") {
          throw new Error("cloud durability projection is invalid");
        }
        const entryPath = normalizedPath(candidate.path);
        if (entries.has(entryPath))
          throw new Error("cloud durability projection is invalid");
        const blobId = candidate.blobId;
        const contentSha256 = candidate.contentSha256;
        if (candidate.operation === "delete") {
          if (
            candidate.entryType !== null ||
            candidate.mode !== null ||
            candidate.blobId !== null ||
            candidate.contentSha256 !== null ||
            candidate.sizeBytes !== null
          ) {
            throw new Error("cloud durability projection is invalid");
          }
          entries.set(entryPath, {
            operation: "delete",
            path: entryPath,
            entryType: null,
            mode: null,
            blobId: null,
            contentSha256: null,
            sizeBytes: null,
          });
        } else if (
          candidate.operation === "upsert" &&
          typeof blobId === "string" &&
          UUID_PATTERN.test(blobId) &&
          typeof contentSha256 === "string" &&
          SHA256_PATTERN.test(contentSha256) &&
          Number.isSafeInteger(candidate.sizeBytes) &&
          ((candidate.entryType === "symlink" &&
            candidate.mode === 40960 &&
            Number(candidate.sizeBytes) >= 1 &&
            Number(candidate.sizeBytes) <= 4_096) ||
            (candidate.entryType === "file" &&
              (candidate.mode === 33188 || candidate.mode === 33261) &&
              Number(candidate.sizeBytes) >= 0 &&
              Number(candidate.sizeBytes) <= MAX_FILE_BYTES))
        ) {
          entries.set(entryPath, {
            operation: "upsert",
            path: entryPath,
            entryType: candidate.entryType as "file" | "symlink",
            mode: candidate.mode as 33188 | 33261 | 40960,
            blobId,
            contentSha256,
            sizeBytes: Number(candidate.sizeBytes),
          });
        } else {
          throw new Error("cloud durability projection is invalid");
        }
      }
      if (raw.nextAfterPath === null) {
        return { currentRevision: revision, entries };
      }
      const next = normalizedPath(raw.nextAfterPath);
      if (seenCursors.has(next) || !entries.has(next)) {
        throw new Error("cloud durability projection cursor is invalid");
      }
      seenCursors.add(next);
      afterPath = next;
    }
    throw new Error("cloud durability projection exceeded its page bound");
  }

  private async upload(
    authority: CloudDurabilityAuthority,
    entry: ScannedEntry,
  ): Promise<ProjectionEntry> {
    const url = new URL(this.endpoint(authority, BLOB_PATH));
    for (const [key, value] of Object.entries(this.scope(authority))) {
      url.searchParams.set(key, value);
    }
    const raw = await boundedJson(
      await this.request(authority, url.toString(), {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(entry.bytes),
      }),
    );
    const blobId = isRecord(raw) ? raw.id : null;
    if (
      !isRecord(raw) ||
      typeof blobId !== "string" ||
      !UUID_PATTERN.test(blobId) ||
      raw.plaintextSha256 !== entry.contentSha256 ||
      raw.sizeBytes !== entry.sizeBytes
    ) {
      throw new Error("cloud durability blob response is invalid");
    }
    return {
      operation: "upsert",
      path: entry.path,
      entryType: entry.entryType,
      mode: entry.mode,
      blobId,
      contentSha256: entry.contentSha256,
      sizeBytes: entry.sizeBytes,
    };
  }

  private async postJson(
    authority: CloudDurabilityAuthority,
    pathname: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    return boundedJson(
      await this.request(authority, this.endpoint(authority, pathname), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  private async runCheckpoint(
    directive: CloudCheckpointDirective,
    authority: CloudDurabilityAuthority,
  ): Promise<void> {
    if (
      !UUID_PATTERN.test(directive.id) ||
      !Number.isSafeInteger(directive.deadlineAtMs) ||
      directive.deadlineAtMs <= Date.now()
    ) {
      throw new Error("cloud checkpoint directive is invalid");
    }
    // This runtime is constructed only for the privileged cloud engine. Local
    // desktop forks call the scanner directly and may use the portable path
    // verifier; an authority-bearing checkpoint may never fall back to it.
    if (process.platform !== "linux") {
      throw new Error(
        "privileged cloud checkpoint capture requires Linux descriptor safety",
      );
    }
    let projection = await this.loadProjection(authority);
    let finalScan: CloudWorkspaceChangeScan | null = null;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const scan = await scanCloudWorkspaceChanges(this.repositoryRoot, {
          requireDescriptorSafety: true,
        });
        const mutations: Array<Record<string, unknown>> = [];
        const deletedPaths = new Set<string>();
        for (const [entryPath, prior] of projection.entries) {
          if (prior.operation === "delete" && !scan.entries.has(entryPath)) {
            deletedPaths.add(entryPath);
          } else if (
            prior.operation === "upsert" &&
            !scan.entries.has(entryPath)
          ) {
            mutations.push({ operation: "delete", path: entryPath });
            deletedPaths.add(entryPath);
          } else if (secretLike(entryPath)) {
            mutations.push({ operation: "delete", path: entryPath });
          } else {
            void prior;
          }
        }
        for (const entryPath of scan.deletions) {
          if (!deletedPaths.has(entryPath)) {
            mutations.push({ operation: "delete", path: entryPath });
            deletedPaths.add(entryPath);
          }
        }
        for (const entry of scan.entries.values()) {
          const prior = projection.entries.get(entry.path);
          if (
            prior &&
            prior.operation === "upsert" &&
            prior.entryType === entry.entryType &&
            prior.mode === entry.mode &&
            prior.contentSha256 === entry.contentSha256 &&
            prior.sizeBytes === entry.sizeBytes
          ) {
            continue;
          }
          const uploaded = await this.upload(authority, entry);
          mutations.push(uploaded);
        }
        const confirmation = await scanCloudWorkspaceChanges(
          this.repositoryRoot,
          { requireDescriptorSafety: true },
        );
        for (const entry of scan.entries.values()) entry.bytes.fill(0);
        if (confirmation.fingerprint !== scan.fingerprint) {
          for (const entry of confirmation.entries.values())
            entry.bytes.fill(0);
          continue;
        }
        if (mutations.length === 0 && projection.currentRevision === 0) {
          mutations.push({
            operation: "delete",
            path: ".zeros-empty-baseline",
          });
        }
        // A directive may be redelivered after an ambiguous response. Binding
        // the key to its exact revision keeps only the same request replayable.
        for (let offset = 0; offset < mutations.length; offset += 10_000) {
          const chunk = mutations.slice(offset, offset + 10_000);
          const expectedRevision = projection.currentRevision;
          const raw = await this.postJson(authority, CONTENT_APPEND_PATH, {
            ...this.scope(authority),
            expectedRevision,
            idempotencyKey: `checkpoint.${directive.id}.revision.${expectedRevision}.chunk.${offset / 10_000}`,
            gitBaseCommit: confirmation.gitBaseCommit,
            gitHeadRef: confirmation.gitHeadRef,
            mutations: chunk,
          });
          if (!isRecord(raw) || !Number.isSafeInteger(raw.revision)) {
            throw new Error("cloud durability append response is invalid");
          }
          projection.currentRevision = Number(raw.revision);
        }
        if (mutations.length === 0) {
          const expectedRevision = projection.currentRevision;
          const raw = await this.postJson(authority, CONTENT_APPEND_PATH, {
            ...this.scope(authority),
            expectedRevision,
            idempotencyKey: `checkpoint.${directive.id}.revision.${expectedRevision}.metadata`,
            gitBaseCommit: confirmation.gitBaseCommit,
            gitHeadRef: confirmation.gitHeadRef,
            mutations: [],
          });
          if (!isRecord(raw) || !Number.isSafeInteger(raw.revision)) {
            throw new Error("cloud durability append response is invalid");
          }
          projection.currentRevision = Number(raw.revision);
        }
        const settled = await scanCloudWorkspaceChanges(this.repositoryRoot, {
          requireDescriptorSafety: true,
        });
        if (settled.fingerprint !== confirmation.fingerprint) {
          for (const entry of confirmation.entries.values())
            entry.bytes.fill(0);
          for (const entry of settled.entries.values()) entry.bytes.fill(0);
          projection = await this.loadProjection(authority);
          continue;
        }
        for (const entry of confirmation.entries.values()) entry.bytes.fill(0);
        finalScan = settled;
        break;
      }
      if (!finalScan)
        throw new Error("cloud checkpoint could not quiesce the working tree");
      const manifestBytes = Buffer.from(
        JSON.stringify({
          version: 1,
          audience: "zeros-cloud-workspace-checkpoint-manifest-v1",
          gitBaseCommit: finalScan.gitBaseCommit,
          gitHeadRef: finalScan.gitHeadRef,
          entries: [...finalScan.entries.values()].map(
            ({ bytes: _bytes, ...entry }) => entry,
          ),
          deletions: [...finalScan.deletions],
        }),
        "utf8",
      );
      if (manifestBytes.length > MAX_FILE_BYTES) {
        throw new Error("cloud checkpoint manifest is too large");
      }
      const manifestEntry: ScannedEntry = {
        path: "checkpoint-manifest.json",
        entryType: "file",
        mode: 33188,
        contentSha256: createHash("sha256").update(manifestBytes).digest("hex"),
        sizeBytes: manifestBytes.length,
        bytes: manifestBytes,
      };
      const manifest = await this.upload(authority, manifestEntry);
      manifestBytes.fill(0);
      const committed = await this.postJson(authority, CHECKPOINT_PATH, {
        ...this.scope(authority),
        requestId: directive.id,
        idempotencyKey: `checkpoint.${directive.id}.commit`,
        contentRevision: projection.currentRevision,
        reason: directive.reason,
        manifestBlobId: manifest.blobId,
        artifactBlobId: null,
        inclusionPolicy: {
          version: 1,
          basis: "complete-safe-working-tree",
          ignored: "excluded",
          secretLike: "excluded",
          maxFileBytes: MAX_FILE_BYTES,
          maxTotalBytes: MAX_TOTAL_BYTES,
        },
        fileCount: finalScan.entries.size,
        totalBytes: finalScan.totalBytes,
        integritySha256: manifest.contentSha256,
      });
      if (
        !isRecord(committed) ||
        typeof committed.checkpointId !== "string" ||
        !UUID_PATTERN.test(committed.checkpointId)
      ) {
        throw new Error("cloud checkpoint commit response is invalid");
      }
    } finally {
      if (finalScan) {
        for (const entry of finalScan.entries.values()) entry.bytes.fill(0);
      }
    }
  }
}
