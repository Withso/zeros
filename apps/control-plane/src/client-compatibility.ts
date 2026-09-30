import type { MiddlewareHandler } from "hono";

type ReleaseChannel = "alpha" | "beta" | "production";
type DesktopVersion = { core: number[]; prerelease: string[] };
type Release = { version: string; publishedAt: string; sourceSha: string };
type ReleaseLedger = {
  version: 1;
  channel: ReleaseChannel;
  releases: Release[];
};
export type ClientUpgradeRequired = {
  code: "client_upgrade_required";
  message: string;
  minimumVersion: string;
  latestVersion: string;
};

const CACHE_MS = 5 * 60 * 1000;
const FAILURE_CACHE_MS = 30_000;
const FETCH_TIMEOUT_MS = 3_000;
const MAX_LEDGER_BYTES = 65_536;
const SUPPORT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function parseVersion(value: string): DesktopVersion | null {
  if (value.length > 128) return null;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(
      value,
    );
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  const prerelease = match[4]?.split(".") ?? [];
  if (
    core.some((part) => !Number.isSafeInteger(part)) ||
    prerelease.some((part) => /^0\d+$/.test(part))
  )
    return null;
  return { core, prerelease };
}

function compareVersions(left: DesktopVersion, right: DesktopVersion): number {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index])
      return left.core[index]! - right.core[index]!;
  }
  if (!left.prerelease.length || !right.prerelease.length)
    return Number(!left.prerelease.length) - Number(!right.prerelease.length);
  for (
    let index = 0;
    index < Math.max(left.prerelease.length, right.prerelease.length);
    index += 1
  ) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric)
      return (
        leftPart.length - rightPart.length || (leftPart < rightPart ? -1 : 1)
      );
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function releaseLedgerUrl(channel: ReleaseChannel): string {
  const base = "https://github.com/withso/zeros/releases";
  return channel === "production"
    ? `${base}/latest/download/release-ledger.json`
    : `${base}/download/${channel}/${channel}-release-ledger.json`;
}

export function validateReleaseLedgerUrl(
  value: string | undefined,
): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    )
      return url.href;
  } catch {}
  throw new Error(
    "Invalid environment: DESKTOP_RELEASE_LEDGER_URL must be a credential-free HTTPS URL without query or fragment",
  );
}

function parseLedger(value: unknown, channel: ReleaseChannel): ReleaseLedger {
  if (!value || typeof value !== "object") throw new Error("invalid ledger");
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    raw.channel !== channel ||
    !Array.isArray(raw.releases) ||
    !raw.releases.length ||
    raw.releases.length > 200
  )
    throw new Error("invalid ledger");
  const releases: Release[] = [];
  let previousVersion: DesktopVersion | null = null;
  let previousDate = -Infinity;
  for (const value of raw.releases) {
    if (!value || typeof value !== "object") throw new Error("invalid release");
    const rawRelease = value as Record<string, unknown>;
    const version =
      typeof rawRelease.version === "string"
        ? parseVersion(rawRelease.version)
        : null;
    const publishedAt = rawRelease.publishedAt;
    const sourceSha = rawRelease.sourceSha;
    const date =
      typeof publishedAt === "string" ? Date.parse(publishedAt) : NaN;
    if (
      !version ||
      typeof publishedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(
        publishedAt,
      ) ||
      !Number.isFinite(date) ||
      typeof sourceSha !== "string" ||
      !/^[\da-f]{40}$/i.test(sourceSha) ||
      date < previousDate ||
      (previousVersion && compareVersions(previousVersion, version) >= 0)
    )
      throw new Error("invalid release");
    const canonicalDate = publishedAt.replace(
      /(?:\.(\d{1,3}))?Z$/,
      (_match, fraction: string | undefined) =>
        `.${(fraction ?? "").padEnd(3, "0")}Z`,
    );
    if (new Date(date).toISOString() !== canonicalDate)
      throw new Error("invalid release date");
    releases.push({
      version: rawRelease.version as string,
      publishedAt,
      sourceSha,
    });
    previousVersion = version;
    previousDate = date;
  }
  return { version: 1, channel, releases };
}

async function readLedger(
  response: Response,
  channel: ReleaseChannel,
): Promise<ReleaseLedger> {
  if (
    !response.ok ||
    Number(response.headers.get("content-length")) > MAX_LEDGER_BYTES ||
    !response.body
  )
    throw new Error("ledger unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_LEDGER_BYTES) {
        void reader.cancel().catch(() => {});
        throw new Error("ledger too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return parseLedger(JSON.parse(text), channel);
}

type CompatibilityOptions = {
  deploymentChannel?: ReleaseChannel | "development";
  ledgerUrl?: string | null;
  fetch?: typeof fetch;
  now?: () => number;
  warn?: (message: string) => void;
};

export class ClientCompatibility {
  private readonly cache = new Map<
    ReleaseChannel,
    {
      until: number;
      ledger: ReleaseLedger | null;
      pending: Promise<ReleaseLedger | null> | null;
    }
  >();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;

  constructor(private readonly options: CompatibilityOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? console.warn;
  }

  private async ledger(channel: ReleaseChannel): Promise<ReleaseLedger | null> {
    let entry = this.cache.get(channel);
    if (entry?.pending) return entry.pending;
    if (entry && entry.until > this.now()) return entry.ledger;
    entry ??= { until: 0, ledger: null, pending: null };
    this.cache.set(channel, entry);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const url =
      this.options.deploymentChannel === channel && this.options.ledgerUrl
        ? this.options.ledgerUrl
        : releaseLedgerUrl(channel);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("ledger timeout"));
      }, FETCH_TIMEOUT_MS);
    });
    const read = Promise.resolve()
      .then(() =>
        this.fetch(url, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        }),
      )
      .then((response) => readLedger(response, channel));
    entry.pending = Promise.race([read, timeout])
      .catch(() => {
        this.warn(
          `[client-compatibility] ${channel} release ledger unavailable; allowing desktop requests`,
        );
        return null;
      })
      .then((ledger) => {
        entry.ledger = ledger;
        entry.until = this.now() + (ledger ? CACHE_MS : FAILURE_CACHE_MS);
        return ledger;
      })
      .finally(() => {
        clearTimeout(timer);
        entry.pending = null;
      });
    return entry.pending;
  }

  async check(
    header: string | undefined,
  ): Promise<ClientUpgradeRequired | null> {
    if (!header || header.length > 160) return null;
    const match = /^desktop\/(alpha|beta|production)\/([^/]+)$/.exec(header);
    if (!match) return null;
    const version = parseVersion(match[2]!);
    if (!version) return null;
    const ledger = await this.ledger(match[1] as ReleaseChannel);
    if (!ledger) return null;
    const latest = ledger.releases[ledger.releases.length - 1]!;
    if (compareVersions(version, parseVersion(latest.version)!) >= 0)
      return null;
    const cutoff = this.now() - SUPPORT_WINDOW_MS;
    const next = ledger.releases.find(
      (release) => compareVersions(version, parseVersion(release.version)!) < 0,
    )!;
    const olderThanLedger =
      compareVersions(version, parseVersion(ledger.releases[0]!.version)!) < 0;
    if (!olderThanLedger && Date.parse(next.publishedAt) > cutoff) return null;
    const minimum = ledger.releases.find(
      (_release, index) =>
        index === ledger.releases.length - 1 ||
        Date.parse(ledger.releases[index + 1]!.publishedAt) > cutoff,
    )!;
    return {
      code: "client_upgrade_required",
      message:
        "This version of Zeros is no longer supported. Update Zeros to continue.",
      minimumVersion: minimum.version,
      latestVersion: latest.version,
    };
  }
}

export function createClientCompatibilityMiddleware(
  compatibility: ClientCompatibility,
): MiddlewareHandler {
  const exemptAuthPaths = new Set([
    "/v1/auth/sign-in",
    "/v1/auth/signin",
    "/v1/auth/login",
    "/v1/auth/refresh",
    "/v1/auth/logout",
    "/v1/auth/token",
  ]);
  return async (context, next) => {
    const path = context.req.path;
    if (
      context.req.method === "OPTIONS" ||
      !path.startsWith("/v1/") ||
      path === "/v1/release-identity" ||
      path === "/v1/engine" ||
      path.startsWith("/v1/engine/") ||
      exemptAuthPaths.has(path)
    )
      return next();
    const error = await compatibility.check(
      context.req.header("X-Zeros-Client"),
    );
    if (!error) return next();
    context.header("Cache-Control", "no-store");
    return context.json({ error }, 426);
  };
}
