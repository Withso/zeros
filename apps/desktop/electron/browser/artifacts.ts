import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PER_SESSION = 40;

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

interface BrowserArtifactLimits {
  maxBytes?: number;
  maxPerSession?: number;
}

interface BrowserArtifactInput {
  root: string;
  browserSessionId: string;
  url: string;
  title: string;
  capturedAt?: number;
}

/** Evidence survives the transient WebContents lease, but never uses a
 * provider-native id as its owner or directory name. */
export async function persistBrowserScreenshot(
  input: BrowserArtifactInput & { jpeg: Buffer },
  limits: BrowserArtifactLimits = {},
): Promise<BrowserScreenshotArtifact> {
  validateRootAndSession(input.root, input.browserSessionId);
  const maxBytes = boundedPositiveInteger(
    limits.maxBytes ?? DEFAULT_MAX_BYTES,
    "size limit",
  );
  const maxPerSession = boundedPositiveInteger(
    limits.maxPerSession ?? DEFAULT_MAX_PER_SESSION,
    "retention limit",
  );
  if (input.jpeg.length < 1 || input.jpeg.length > maxBytes) {
    throw new Error(
      `Browser screenshot size must be between 1 and ${maxBytes} bytes.`,
    );
  }
  const url = validatedWebUrl(input.url, "screenshot");
  const directory = await sessionDirectory(input.root, input.browserSessionId);
  const capturedAt = input.capturedAt ?? Date.now();
  const filename = `${String(capturedAt).padStart(16, "0")}-${randomUUID()}.jpg`;
  const artifactPath = join(directory, filename);
  await writeFile(artifactPath, input.jpeg, { flag: "wx", mode: 0o600 });
  await pruneSessionBucket(directory, maxPerSession, "jpg");
  return {
    kind: "browser-screenshot",
    path: artifactPath,
    mimeType: "image/jpeg",
    size: input.jpeg.length,
    url: url.href,
    title: boundedTitle(input.title),
    capturedAt,
  };
}

export async function persistBrowserTrace(
  input: BrowserArtifactInput & { events: BrowserTraceEvent[] },
  limits: BrowserArtifactLimits = {},
): Promise<BrowserTraceArtifact> {
  validateRootAndSession(input.root, input.browserSessionId);
  const maxBytes = boundedPositiveInteger(
    limits.maxBytes ?? DEFAULT_MAX_BYTES,
    "size limit",
  );
  const maxPerSession = boundedPositiveInteger(
    limits.maxPerSession ?? DEFAULT_MAX_PER_SESSION,
    "retention limit",
  );
  const url = validatedWebUrl(input.url, "trace");
  const capturedAt = input.capturedAt ?? Date.now();
  const events = input.events.slice(-2_000).map((event) => ({
    at: Number.isFinite(event.at) ? event.at : capturedAt,
    type: event.type.trim().replace(/\s+/g, " ").slice(0, 80),
    detail: event.detail.trim().replace(/\s+/g, " ").slice(0, 2_000),
  }));
  const title = boundedTitle(input.title);
  const bytes = Buffer.from(
    JSON.stringify(
      { version: 1, url: url.href, title, capturedAt, events },
      null,
      2,
    ),
  );
  if (bytes.length < 1 || bytes.length > maxBytes) {
    throw new Error(`Browser trace exceeds ${maxBytes} bytes.`);
  }
  const directory = await sessionDirectory(input.root, input.browserSessionId);
  const filename = `${String(capturedAt).padStart(16, "0")}-${randomUUID()}.json`;
  const artifactPath = join(directory, filename);
  await writeFile(artifactPath, bytes, { flag: "wx", mode: 0o600 });
  await pruneSessionBucket(directory, maxPerSession, "json");
  return {
    kind: "browser-trace",
    path: artifactPath,
    mimeType: "application/json",
    size: bytes.length,
    url: url.href,
    title,
    eventCount: events.length,
    capturedAt,
  };
}

function validateRootAndSession(root: string, browserSessionId: string): void {
  if (!isAbsolute(root)) {
    throw new Error("Browser artifact root must be an absolute path.");
  }
  if (!SESSION_ID_PATTERN.test(browserSessionId)) {
    throw new Error("Browser artifact session identity is invalid.");
  }
}

async function sessionDirectory(root: string, browserSessionId: string) {
  const bucket = createHash("sha256")
    .update(browserSessionId)
    .digest("hex")
    .slice(0, 24);
  const directory = join(root, bucket);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

async function pruneSessionBucket(
  directory: string,
  maxPerSession: number,
  extension: "jpg" | "json",
) {
  const entries = (await readdir(directory))
    .filter((name) =>
      new RegExp(`^\\d{16}-[0-9a-f-]+\\.${extension}$`, "i").test(name),
    )
    .sort();
  const excess = entries.slice(0, Math.max(0, entries.length - maxPerSession));
  await Promise.all(
    excess.map((name) => unlink(join(directory, name)).catch(() => undefined)),
  );
}

function validatedWebUrl(value: string, label: string): URL {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Browser ${label} URL must use http(s).`);
  }
  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

function boundedTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 512);
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Browser artifact ${label} is invalid.`);
  }
  return value;
}
