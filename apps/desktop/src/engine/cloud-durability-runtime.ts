import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONTENT_HEAD_PATH = "/internal/v1/cloud-workspaces/engine/content/head";
const CONTENT_APPEND_PATH = "/internal/v1/cloud-workspaces/engine/content/append";
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
  return source
    .subarray(0, -1)
    .toString("utf8")
    .split("\0")
    .map(normalizedPath);
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

async function readEntry(root: string, relativePath: string): Promise<ScannedEntry> {
  const absolute = path.join(root, ...relativePath.split("/"));
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("cloud checkpoint path escaped the repository");
  }
  const before = await fs.lstat(absolute);
  let bytes: Buffer;
  let entryType: "file" | "symlink";
  let mode: 33188 | 33261 | 40960;
  if (before.isSymbolicLink()) {
    entryType = "symlink";
    mode = 40960;
    bytes = Buffer.from(await fs.readlink(absolute), "utf8");
    if (bytes.length > 4_096) {
      bytes.fill(0);
      throw new Error("cloud checkpoint symlink is too large");
    }
  } else if (before.isFile()) {
    if (before.size > MAX_FILE_BYTES || before.nlink !== 1) {
      throw new Error("cloud checkpoint file is unsupported or too large");
    }
    entryType = "file";
    mode = (before.mode & 0o111) === 0 ? 33188 : 33261;
    const handle = await fs.open(
      absolute,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        opened.nlink !== 1
      ) {
        throw new Error("cloud checkpoint file changed during scan");
      }
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } else {
    throw new Error("cloud checkpoint path type is unsupported");
  }
  const after = await fs.lstat(absolute);
  if (
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) {
    bytes.fill(0);
    throw new Error("cloud checkpoint file changed during scan");
  }
  return {
    path: relativePath,
    entryType,
    mode,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    bytes,
  };
}

async function scanCloudWorkspaceChangesOnce(
  root: string,
  baseCommit: string | null,
  includeRepositorySettings: boolean,
): Promise<CloudWorkspaceChangeScan> {
  const resolved = await fs.realpath(root);
  if (resolved !== root || !path.isAbsolute(root)) {
    throw new Error("cloud checkpoint repository root is invalid");
  }
  const revision = baseCommit ?? "HEAD";
  const [commit, tracked, changed, untracked] = await Promise.all([
    gitText(root, ["rev-parse", "--verify", `${revision}^{commit}`]),
    gitBuffer(root, ["ls-files", "-z", "--cached", "--"]),
    gitBuffer(root, [
      "diff",
      "--name-only",
      "-z",
      "--no-ext-diff",
      "--no-renames",
      revision,
      "--",
    ]),
    gitBuffer(root, ["ls-files", "-z", "--others", "--exclude-standard", "--"]),
  ]);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new Error("cloud checkpoint Git base is invalid");
  }
  let headRef: string | null = null;
  try {
    const candidate = await gitText(root, ["symbolic-ref", "-q", "HEAD"]);
    headRef = candidate.length > 0 && candidate.length <= 512 ? candidate : null;
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
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
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
        const entry = await readEntry(root, relativePath);
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
  );
  if (!options.verifyStable) return first;
  let confirmation: CloudWorkspaceChangeScan | null = null;
  try {
    confirmation = await scanCloudWorkspaceChangesOnce(
      root,
      baseCommit,
      includeRepositorySettings,
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
  if (Number.isFinite(declared) && (declared < 0 || declared > MAX_JSON_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("cloud durability response is too large");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  try {
    if (bytes.length > MAX_JSON_BYTES) throw new Error("cloud durability response is too large");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    bytes.fill(0);
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
    if (this.active) return this.active;
    const task = this.runCheckpoint(directive, authority).finally(() => {
      if (this.active === task) this.active = null;
    });
    this.active = task;
    return task;
  }

  private endpoint(authority: CloudDurabilityAuthority, pathname: string): string {
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
    for (;;) {
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
        throw new Error("cloud durability projection changed during pagination");
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
        if (entries.has(entryPath)) throw new Error("cloud durability projection is invalid");
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
      if (next === afterPath || !entries.has(next)) {
        throw new Error("cloud durability projection cursor is invalid");
      }
      afterPath = next;
    }
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
    let projection = await this.loadProjection(authority);
    let finalScan: CloudWorkspaceChangeScan | null = null;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const scan = await scanCloudWorkspaceChanges(this.repositoryRoot);
        const mutations: Array<Record<string, unknown>> = [];
        const deletedPaths = new Set<string>();
        for (const [entryPath, prior] of projection.entries) {
          if (prior.operation === "delete" && !scan.entries.has(entryPath)) {
            deletedPaths.add(entryPath);
          } else if (prior.operation === "upsert" && !scan.entries.has(entryPath)) {
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
        const confirmation = await scanCloudWorkspaceChanges(this.repositoryRoot);
        for (const entry of scan.entries.values()) entry.bytes.fill(0);
        if (confirmation.fingerprint !== scan.fingerprint) {
          for (const entry of confirmation.entries.values()) entry.bytes.fill(0);
          continue;
        }
        if (mutations.length === 0 && projection.currentRevision === 0) {
          mutations.push({ operation: "delete", path: ".zeros-empty-baseline" });
        }
        for (let offset = 0; offset < mutations.length; offset += 10_000) {
          const chunk = mutations.slice(offset, offset + 10_000);
          const raw = await this.postJson(authority, CONTENT_APPEND_PATH, {
            ...this.scope(authority),
            expectedRevision: projection.currentRevision,
            idempotencyKey: `checkpoint.${directive.id}.${offset / 10_000}`,
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
          const raw = await this.postJson(authority, CONTENT_APPEND_PATH, {
            ...this.scope(authority),
            expectedRevision: projection.currentRevision,
            idempotencyKey: `checkpoint.${directive.id}.metadata`,
            gitBaseCommit: confirmation.gitBaseCommit,
            gitHeadRef: confirmation.gitHeadRef,
            mutations: [],
          });
          if (!isRecord(raw) || !Number.isSafeInteger(raw.revision)) {
            throw new Error("cloud durability append response is invalid");
          }
          projection.currentRevision = Number(raw.revision);
        }
        const settled = await scanCloudWorkspaceChanges(this.repositoryRoot);
        if (settled.fingerprint !== confirmation.fingerprint) {
          for (const entry of confirmation.entries.values()) entry.bytes.fill(0);
          for (const entry of settled.entries.values()) entry.bytes.fill(0);
          projection = await this.loadProjection(authority);
          continue;
        }
        for (const entry of confirmation.entries.values()) entry.bytes.fill(0);
        finalScan = settled;
        break;
      }
      if (!finalScan) throw new Error("cloud checkpoint could not quiesce the working tree");
      const manifestBytes = Buffer.from(
        JSON.stringify({
          version: 1,
          audience: "zeros-cloud-workspace-checkpoint-manifest-v1",
          gitBaseCommit: finalScan.gitBaseCommit,
          gitHeadRef: finalScan.gitHeadRef,
          entries: [...finalScan.entries.values()].map(({ bytes: _bytes, ...entry }) => entry),
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
