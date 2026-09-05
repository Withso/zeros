import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_BATCH_MUTATIONS = 10_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_BATCH_BYTES = 512 * 1024 * 1024;

export type CloudReplicaMutation = {
  revision: number;
  sequence: number;
  path: string;
  operation: "upsert" | "delete";
  entryType: "file" | "symlink" | null;
  mode: 33188 | 33261 | 40960 | null;
  blobId: string | null;
  contentSha256: string | null;
  sizeBytes: number | null;
};

export type CloudReplicaLocalEntry = {
  path: string;
  portablePathKey: string;
  revision: number;
  entryType: "file" | "symlink";
  mode: 33188 | 33261 | 40960;
  contentSha256: string;
  sizeBytes: number;
};

export type CloudReplicaApplyJournal = {
  path: string;
  operation: "upsert" | "delete";
  fromRevision: number;
  toRevision: number;
  stagePath: string | null;
  expectedPreviousSha256: string | null;
  nextContentSha256: string | null;
  state: "staged" | "committing" | "applied" | "failed";
  errorCode: string | null;
};

export interface CloudReplicaLocalStateStore {
  entry(path: string): CloudReplicaLocalEntry | null;
  entryByPortablePath(portablePathKey: string): CloudReplicaLocalEntry | null;
  journal(value: CloudReplicaApplyJournal): void;
  commitEntry(value: CloudReplicaLocalEntry): void;
  commitDeletion(path: string): void;
  divergence(value: {
    path: string;
    expectedSha256: string | null;
    observedSha256: string | null;
    cloudSha256: string | null;
  }): void;
  manifestSha256(): string;
}

export class CloudReplicaApplyError extends Error {
  constructor(
    public readonly code:
      | "invalid_batch"
      | "path_rejected"
      | "unsupported_local_type"
      | "blob_integrity_failed"
      | "symlink_rejected"
      | "local_divergence"
      | "apply_failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CloudReplicaApplyError";
  }
}

function portablePathKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

const EXCLUDED_COMPONENTS = new Set([
  ".git",
  "node_modules",
  ".ssh",
  ".aws",
  ".azure",
]);

function secretLike(component: string): boolean {
  const lower = component.toLocaleLowerCase("en-US");
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower === ".npmrc" ||
    lower === ".pypirc" ||
    lower === ".netrc" ||
    lower === ".git-credentials" ||
    lower === "id_rsa" ||
    lower === "id_ed25519" ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key") ||
    lower.endsWith(".p12") ||
    lower.endsWith(".pfx") ||
    lower === "credentials" ||
    lower === "credentials.json"
  );
}

function enginePrivatePath(relativePath: string): boolean {
  const lower = relativePath.toLocaleLowerCase("en-US");
  if (lower === ".zeros") return true;
  if (!lower.startsWith(".zeros/")) return false;
  const rest = lower.slice(".zeros/".length);
  return (
    rest === "settings.local.toml" ||
    rest.startsWith("runtime/") ||
    rest.startsWith("credentials/") ||
    rest.startsWith("secrets/") ||
    rest.endsWith(".db") ||
    rest.endsWith(".db-wal") ||
    rest.endsWith(".db-shm") ||
    rest.endsWith(".sock") ||
    rest.endsWith(".socket")
  );
}

export function normalizeCloudReplicaPath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    // eslint-disable-next-line no-control-regex -- replica paths reject C0 and DEL
    /[\u0000-\u001f\u007f]/u.test(value) ||
    path.posix.normalize(value) !== value ||
    enginePrivatePath(value)
  ) {
    throw new CloudReplicaApplyError(
      "path_rejected",
      "Replica path is invalid",
    );
  }
  const components = value.split("/");
  if (
    components.some(
      (component) =>
        component.length < 1 ||
        component === "." ||
        component === ".." ||
        EXCLUDED_COMPONENTS.has(component.toLocaleLowerCase("en-US")) ||
        secretLike(component),
    )
  ) {
    throw new CloudReplicaApplyError(
      "path_rejected",
      "Replica path is excluded from local sync",
    );
  }
  return value;
}

function boundedRoot(value: string): string {
  const resolved = path.resolve(value);
  if (
    !path.isAbsolute(value) ||
    resolved === path.parse(resolved).root ||
    value !== resolved ||
    // eslint-disable-next-line no-control-regex -- replica roots reject C0 and DEL
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new CloudReplicaApplyError(
      "path_rejected",
      "Replica root is invalid",
    );
  }
  return resolved;
}

function targetPath(root: string, relative: string): string {
  const target = path.resolve(root, ...relative.split("/"));
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new CloudReplicaApplyError(
      "path_rejected",
      "Replica path escaped its root",
    );
  }
  return target;
}

async function existingType(
  target: string,
): Promise<"file" | "symlink" | "directory" | "other" | "missing"> {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function hashFile(
  target: string,
  expected: { dev: number; ino: number; size: number; nlink: number },
): Promise<string | null> {
  if (expected.size > MAX_BATCH_BYTES || expected.nlink < 1) return null;
  const handle = await open(
    target,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.size !== expected.size
    ) {
      return null;
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, opened.size - offset),
        offset,
      );
      if (bytesRead < 1) return null;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      return null;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function observedEntry(target: string): Promise<{
  type: "file" | "symlink" | "directory" | "other" | "missing";
  sha256: string | null;
  sizeBytes: number | null;
}> {
  const type = await existingType(target);
  if (type === "missing" || type === "directory" || type === "other") {
    return { type, sha256: null, sizeBytes: null };
  }
  if (type === "symlink") {
    const value = await readlink(target, { encoding: "buffer" });
    return {
      type,
      sha256: createHash("sha256").update(value).digest("hex"),
      sizeBytes: value.length,
    };
  }
  const stat = await lstat(target);
  return {
    type,
    sha256: await hashFile(target, stat),
    sizeBytes: stat.size <= MAX_BATCH_BYTES ? stat.size : null,
  };
}

export type CloudReplicaObservedEntry = Awaited<
  ReturnType<typeof observedEntry>
> & {
  mode: 33188 | 33261 | 40960 | null;
};

/** Read one projected path without following a leaf or parent symlink. Used by
 * the periodic convergence scanner so a local edit is visible before the next
 * cloud mutation attempts replacement. */
export async function inspectCloudReplicaEntry(
  rootPath: string,
  relativePath: string,
): Promise<CloudReplicaObservedEntry> {
  const root = boundedRoot(rootPath);
  const relative = normalizeCloudReplicaPath(relativePath);
  const rootReal = await realpath(root);
  if (rootReal !== root) {
    throw new CloudReplicaApplyError(
      "path_rejected",
      "Replica root cannot be a symbolic link",
    );
  }
  let parent = root;
  for (const component of relative.split("/").slice(0, -1)) {
    parent = path.join(parent, component);
    let stat;
    try {
      stat = await lstat(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { type: "missing", sha256: null, sizeBytes: null, mode: null };
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { type: "other", sha256: null, sizeBytes: null, mode: null };
    }
    const physical = await realpath(parent);
    if (physical !== parent || !physical.startsWith(`${root}${path.sep}`)) {
      throw new CloudReplicaApplyError(
        "path_rejected",
        "Replica parent escaped its root",
      );
    }
  }
  const observed = await observedEntry(targetPath(root, relative));
  if (observed.type === "file") {
    const stat = await lstat(targetPath(root, relative));
    return {
      ...observed,
      mode: (stat.mode & 0o111) === 0 ? 33188 : 33261,
    };
  }
  return {
    ...observed,
    mode: observed.type === "symlink" ? 40960 : null,
  };
}

async function ensureSafeParents(
  root: string,
  relative: string,
): Promise<void> {
  const rootReal = await realpath(root);
  if (rootReal !== root) {
    throw new CloudReplicaApplyError(
      "path_rejected",
      "Replica root cannot be a symbolic link",
    );
  }
  const parts = relative.split("/").slice(0, -1);
  let current = root;
  for (const component of parts) {
    current = path.join(current, component);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new CloudReplicaApplyError(
          "path_rejected",
          "Replica parent is not a real directory",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: 0o700 });
    }
    const currentReal = await realpath(current);
    if (
      currentReal !== current ||
      !currentReal.startsWith(`${rootReal}${path.sep}`)
    ) {
      throw new CloudReplicaApplyError(
        "path_rejected",
        "Replica parent escaped its root",
      );
    }
  }
}

function validateMutation(
  mutation: CloudReplicaMutation,
): CloudReplicaMutation {
  const normalizedPath = normalizeCloudReplicaPath(mutation.path);
  if (
    !Number.isSafeInteger(mutation.revision) ||
    mutation.revision < 1 ||
    !Number.isSafeInteger(mutation.sequence) ||
    mutation.sequence < 1
  ) {
    throw new CloudReplicaApplyError(
      "invalid_batch",
      "Replica revision is invalid",
    );
  }
  if (mutation.operation === "delete") {
    if (
      mutation.entryType !== null ||
      mutation.mode !== null ||
      mutation.blobId !== null ||
      mutation.contentSha256 !== null ||
      mutation.sizeBytes !== null
    ) {
      throw new CloudReplicaApplyError(
        "invalid_batch",
        "Replica deletion is invalid",
      );
    }
  } else if (
    !["file", "symlink"].includes(mutation.entryType ?? "") ||
    ![33188, 33261, 40960].includes(mutation.mode ?? 0) ||
    (mutation.entryType === "symlink") !== (mutation.mode === 40960) ||
    typeof mutation.blobId !== "string" ||
    typeof mutation.contentSha256 !== "string" ||
    !SHA256_PATTERN.test(mutation.contentSha256) ||
    !Number.isSafeInteger(mutation.sizeBytes) ||
    mutation.sizeBytes! < 0 ||
    mutation.sizeBytes! > MAX_FILE_BYTES
  ) {
    throw new CloudReplicaApplyError(
      "invalid_batch",
      "Replica upsert is invalid",
    );
  }
  return { ...mutation, path: normalizedPath };
}

function safeSymlinkTarget(
  root: string,
  linkPath: string,
  bytes: Uint8Array,
): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CloudReplicaApplyError(
      "symlink_rejected",
      "Replica symbolic-link target is not UTF-8",
    );
  }
  if (
    value.length < 1 ||
    value.length > 4_096 ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    // eslint-disable-next-line no-control-regex -- symlink targets reject C0 and DEL
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new CloudReplicaApplyError(
      "symlink_rejected",
      "Replica symbolic-link target is invalid",
    );
  }
  const resolved = path.resolve(path.dirname(linkPath), ...value.split("/"));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new CloudReplicaApplyError(
      "symlink_rejected",
      "Replica symbolic link escapes its root",
    );
  }
  const relativeTarget = path
    .relative(root, resolved)
    .split(path.sep)
    .join("/");
  if (relativeTarget && relativeTarget !== ".") {
    normalizeCloudReplicaPath(relativeTarget);
  }
  return value;
}

type StagedMutation = {
  mutation: CloudReplicaMutation;
  stagePath: string | null;
};

/** Apply a complete, ordered server page to a receive-only local projection.
 * It never uploads. Every target is checked against the last server-applied
 * state immediately before replacement; an unexpected local edit is retained
 * and surfaced as divergence. */
export class CloudReplicaApplyEngine {
  constructor(
    private readonly store: CloudReplicaLocalStateStore,
    private readonly fetchBlob: (blobId: string) => Promise<Uint8Array>,
  ) {}

  async apply(input: {
    replicaId: string;
    rootPath: string;
    fromRevision: number;
    toRevision: number;
    mutations: readonly CloudReplicaMutation[];
  }): Promise<{ applied: number; toRevision: number; manifestSha256: string }> {
    if (
      input.mutations.length > MAX_BATCH_MUTATIONS ||
      !Number.isSafeInteger(input.fromRevision) ||
      input.fromRevision < 0 ||
      !Number.isSafeInteger(input.toRevision) ||
      input.toRevision < input.fromRevision
    ) {
      throw new CloudReplicaApplyError(
        "invalid_batch",
        "Replica batch is invalid",
      );
    }
    const root = boundedRoot(input.rootPath);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await existingType(root)) !== "directory") {
      throw new CloudReplicaApplyError(
        "path_rejected",
        "Replica root is not a directory",
      );
    }
    const mutations = input.mutations.map(validateMutation);
    let totalBytes = 0;
    const portable = new Map<string, string>();
    const upsertPortablePaths: string[] = [];
    let previousRevision = input.fromRevision;
    let previousSequence = 0;
    for (const mutation of mutations) {
      const expectedSequence =
        mutation.revision === previousRevision ? previousSequence + 1 : 1;
      if (
        mutation.revision <= input.fromRevision ||
        mutation.revision > input.toRevision ||
        mutation.revision < previousRevision ||
        mutation.sequence !== expectedSequence
      ) {
        throw new CloudReplicaApplyError(
          "invalid_batch",
          "Replica page revision sequence is not contiguous",
        );
      }
      previousRevision = mutation.revision;
      previousSequence = mutation.sequence;
      totalBytes += mutation.sizeBytes ?? 0;
      if (totalBytes > MAX_BATCH_BYTES) {
        throw new CloudReplicaApplyError(
          "invalid_batch",
          "Replica batch is too large",
        );
      }
      const key = portablePathKey(mutation.path);
      const prior = portable.get(key);
      if (prior && prior !== mutation.path) {
        throw new CloudReplicaApplyError(
          "path_rejected",
          "Replica paths collide on this filesystem",
        );
      }
      portable.set(key, mutation.path);
      if (mutation.operation === "upsert") upsertPortablePaths.push(key);
      const existing = this.store.entryByPortablePath(key);
      if (existing && existing.path !== mutation.path) {
        throw new CloudReplicaApplyError(
          "path_rejected",
          "Replica path collides with local state",
        );
      }
    }
    upsertPortablePaths.sort();
    for (let index = 1; index < upsertPortablePaths.length; index += 1) {
      if (
        upsertPortablePaths[index]!.startsWith(
          `${upsertPortablePaths[index - 1]!}/`,
        )
      ) {
        throw new CloudReplicaApplyError(
          "path_rejected",
          "Replica paths collide as a file and directory",
        );
      }
    }
    if (
      (mutations.length === 0 && input.toRevision !== input.fromRevision) ||
      (mutations.length > 0 &&
        mutations[mutations.length - 1]!.revision !== input.toRevision)
    ) {
      throw new CloudReplicaApplyError(
        "invalid_batch",
        "Replica page does not end at its declared revision",
      );
    }

    const stageRoot = await mkdtemp(
      path.join(path.dirname(root), `.zeros-replica-stage-${randomUUID()}-`),
    );
    const staged: StagedMutation[] = [];
    try {
      for (let index = 0; index < mutations.length; index += 1) {
        const mutation = mutations[index]!;
        if (mutation.operation === "delete") {
          staged.push({ mutation, stagePath: null });
          continue;
        }
        const bytes = await this.fetchBlob(mutation.blobId!);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (
          bytes.byteLength !== mutation.sizeBytes ||
          digest !== mutation.contentSha256
        ) {
          throw new CloudReplicaApplyError(
            "blob_integrity_failed",
            "Replica blob does not match its durable descriptor",
          );
        }
        const stagedPath = path.join(stageRoot, String(index));
        if (mutation.entryType === "symlink") {
          const linkTarget = safeSymlinkTarget(
            root,
            targetPath(root, mutation.path),
            bytes,
          );
          await symlink(linkTarget, stagedPath);
        } else {
          await writeFile(stagedPath, bytes, {
            mode: mutation.mode === 33261 ? 0o755 : 0o644,
            flag: "wx",
          });
        }
        staged.push({ mutation, stagePath: stagedPath });
      }

      for (const item of staged) {
        const mutation = item.mutation;
        const target = targetPath(root, mutation.path);
        await ensureSafeParents(root, mutation.path);
        const expected = this.store.entry(mutation.path);
        const observed = await observedEntry(target);
        const observedMatchesExpected = expected
          ? observed.type === expected.entryType &&
            observed.sha256 === expected.contentSha256 &&
            observed.sizeBytes === expected.sizeBytes
          : observed.type === "missing" ||
            (mutation.operation === "upsert" &&
              observed.type === mutation.entryType &&
              observed.sha256 === mutation.contentSha256 &&
              observed.sizeBytes === mutation.sizeBytes);
        // Replaying after a crash can observe the next bytes with the SQLite
        // entry still at the previous revision. Exact next-content equality is
        // safe and makes the filesystem/receipt sequence idempotent. The same
        // applies to an already-absent target for a cloud deletion.
        const alreadyApplied =
          mutation.operation === "delete"
            ? observed.type === "missing"
            : observed.type === mutation.entryType &&
              observed.sha256 === mutation.contentSha256 &&
              observed.sizeBytes === mutation.sizeBytes;
        if (!observedMatchesExpected && !alreadyApplied) {
          this.store.divergence({
            path: mutation.path,
            expectedSha256: expected?.contentSha256 ?? null,
            observedSha256: observed.sha256,
            cloudSha256: mutation.contentSha256,
          });
          throw new CloudReplicaApplyError(
            "local_divergence",
            `Local replica path changed: ${mutation.path}`,
          );
        }
        this.store.journal({
          path: mutation.path,
          operation: mutation.operation,
          fromRevision: input.fromRevision,
          toRevision: input.toRevision,
          stagePath: item.stagePath,
          expectedPreviousSha256: expected?.contentSha256 ?? null,
          nextContentSha256: mutation.contentSha256,
          state: "committing",
          errorCode: null,
        });
        try {
          if (mutation.operation === "delete") {
            if (observed.type !== "missing") await unlink(target);
            this.store.commitDeletion(mutation.path);
          } else {
            // Existing content was verified immediately above. POSIX rename is
            // an atomic same-filesystem replacement; local state is advanced
            // only after it succeeds. Windows helpers can recover a journaled
            // committing entry before requesting the next page.
            if (!alreadyApplied) await rename(item.stagePath!, target);
            if (mutation.entryType === "file") {
              await chmod(target, mutation.mode === 33261 ? 0o755 : 0o644);
            }
            this.store.commitEntry({
              path: mutation.path,
              portablePathKey: portablePathKey(mutation.path),
              revision: mutation.revision,
              entryType: mutation.entryType!,
              mode: mutation.mode!,
              contentSha256: mutation.contentSha256!,
              sizeBytes: mutation.sizeBytes!,
            });
          }
          this.store.journal({
            path: mutation.path,
            operation: mutation.operation,
            fromRevision: input.fromRevision,
            toRevision: input.toRevision,
            stagePath: null,
            expectedPreviousSha256: expected?.contentSha256 ?? null,
            nextContentSha256: mutation.contentSha256,
            state: "applied",
            errorCode: null,
          });
        } catch (error) {
          this.store.journal({
            path: mutation.path,
            operation: mutation.operation,
            fromRevision: input.fromRevision,
            toRevision: input.toRevision,
            stagePath: item.stagePath,
            expectedPreviousSha256: expected?.contentSha256 ?? null,
            nextContentSha256: mutation.contentSha256,
            state: "failed",
            errorCode: "filesystem_apply_failed",
          });
          throw new CloudReplicaApplyError(
            "apply_failed",
            "Replica filesystem update did not complete",
            { cause: error },
          );
        }
      }
      return {
        applied: mutations.length,
        toRevision: input.toRevision,
        // This is the complete local projection, not merely a page digest.
        // The server retains it as convergence evidence across retry/page
        // boundaries.
        manifestSha256: this.store.manifestSha256(),
      };
    } finally {
      await rm(stageRoot, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}
