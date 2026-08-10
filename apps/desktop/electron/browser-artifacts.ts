import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PER_TASK = 40;

export interface BrowserScreenshotArtifact {
  kind: "browser-screenshot";
  path: string;
  mimeType: "image/jpeg";
  size: number;
  url: string;
  title: string;
  capturedAt: number;
}

export interface BrowserTraceEvent {
  at: number;
  type: string;
  detail: string;
}

export interface BrowserTraceArtifact {
  kind: "browser-trace";
  path: string;
  mimeType: "application/json";
  size: number;
  url: string;
  title: string;
  eventCount: number;
  capturedAt: number;
}

export interface PersistBrowserTraceInput {
  root: string;
  taskId: string;
  events: BrowserTraceEvent[];
  url: string;
  title: string;
  capturedAt?: number;
}

export interface PersistBrowserScreenshotInput {
  root: string;
  taskId: string;
  jpeg: Buffer;
  url: string;
  title: string;
  capturedAt?: number;
}

export interface BrowserArtifactLimits {
  maxBytes?: number;
  maxPerTask?: number;
}

/** Persist screenshot evidence outside the transient WebContents lease. The
 * task id is hashed before becoming a directory name, files are private to the
 * current user, and each task bucket is bounded so repeated QA cannot grow the
 * app-data directory indefinitely. */
export async function persistBrowserScreenshot(
  input: PersistBrowserScreenshotInput,
  limits: BrowserArtifactLimits = {},
): Promise<BrowserScreenshotArtifact> {
  if (!isAbsolute(input.root)) {
    throw new Error("Browser artifact root must be an absolute path.");
  }
  if (!TASK_ID_PATTERN.test(input.taskId)) {
    throw new Error("Browser artifact task binding is invalid.");
  }
  const maxBytes = boundedPositiveInteger(
    limits.maxBytes ?? DEFAULT_MAX_BYTES,
    "size limit",
  );
  const maxPerTask = boundedPositiveInteger(
    limits.maxPerTask ?? DEFAULT_MAX_PER_TASK,
    "retention limit",
  );
  if (input.jpeg.length < 1 || input.jpeg.length > maxBytes) {
    throw new Error(
      `Browser screenshot size must be between 1 and ${maxBytes} bytes.`,
    );
  }
  const parsedUrl = new URL(input.url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("Browser screenshot URL must use http(s).");
  }

  const bucket = createHash("sha256")
    .update(input.taskId)
    .digest("hex")
    .slice(0, 24);
  const directory = join(input.root, bucket);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const capturedAt = input.capturedAt ?? Date.now();
  const filename = `${String(capturedAt).padStart(16, "0")}-${randomUUID()}.jpg`;
  const artifactPath = join(directory, filename);
  await writeFile(artifactPath, input.jpeg, { flag: "wx", mode: 0o600 });
  await pruneTaskBucket(directory, maxPerTask);

  return {
    kind: "browser-screenshot",
    path: artifactPath,
    mimeType: "image/jpeg",
    size: input.jpeg.length,
    url: parsedUrl.href,
    title: input.title.trim().replace(/\s+/g, " ").slice(0, 512),
    capturedAt,
  };
}

export async function persistBrowserTrace(
  input: PersistBrowserTraceInput,
  limits: BrowserArtifactLimits = {},
): Promise<BrowserTraceArtifact> {
  validateRootAndTask(input.root, input.taskId);
  const maxBytes = boundedPositiveInteger(
    limits.maxBytes ?? DEFAULT_MAX_BYTES,
    "size limit",
  );
  const maxPerTask = boundedPositiveInteger(
    limits.maxPerTask ?? DEFAULT_MAX_PER_TASK,
    "retention limit",
  );
  const parsedUrl = validatedWebUrl(input.url, "trace");
  const capturedAt = input.capturedAt ?? Date.now();
  const events = input.events.slice(-2_000).map((event) => ({
    at: Number.isFinite(event.at) ? event.at : capturedAt,
    type: event.type.trim().replace(/\s+/g, " ").slice(0, 80),
    detail: event.detail.trim().replace(/\s+/g, " ").slice(0, 2_000),
  }));
  const bytes = Buffer.from(
    JSON.stringify(
      {
        version: 1,
        url: parsedUrl.href,
        title: input.title.trim().replace(/\s+/g, " ").slice(0, 512),
        capturedAt,
        events,
      },
      null,
      2,
    ),
  );
  if (bytes.length < 1 || bytes.length > maxBytes) {
    throw new Error(`Browser trace exceeds ${maxBytes} bytes.`);
  }
  const directory = await taskDirectory(input.root, input.taskId);
  const filename = `${String(capturedAt).padStart(16, "0")}-${randomUUID()}.json`;
  const artifactPath = join(directory, filename);
  await writeFile(artifactPath, bytes, { flag: "wx", mode: 0o600 });
  await pruneTaskBucket(directory, maxPerTask, "json");
  return {
    kind: "browser-trace",
    path: artifactPath,
    mimeType: "application/json",
    size: bytes.length,
    url: parsedUrl.href,
    title: input.title.trim().replace(/\s+/g, " ").slice(0, 512),
    eventCount: events.length,
    capturedAt,
  };
}

async function pruneTaskBucket(
  directory: string,
  maxPerTask: number,
  extension = "jpg",
) {
  const entries = (await readdir(directory))
    .filter((name) =>
      new RegExp(`^\\d{16}-[0-9a-f-]+\\.${extension}$`, "i").test(name),
    )
    .sort();
  const excess = entries.slice(0, Math.max(0, entries.length - maxPerTask));
  await Promise.all(
    excess.map((name) => unlink(join(directory, name)).catch(() => undefined)),
  );
}

function validateRootAndTask(root: string, taskId: string): void {
  if (!isAbsolute(root)) {
    throw new Error("Browser artifact root must be an absolute path.");
  }
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error("Browser artifact task binding is invalid.");
  }
}

function validatedWebUrl(value: string, label: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Browser ${label} URL must use http(s).`);
  }
  return parsed;
}

async function taskDirectory(root: string, taskId: string): Promise<string> {
  validateRootAndTask(root, taskId);
  const bucket = createHash("sha256").update(taskId).digest("hex").slice(0, 24);
  const directory = join(root, bucket);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Browser artifact ${label} is invalid.`);
  }
  return value;
}
