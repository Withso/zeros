import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { hasCloudEngineUserNamespace, isCloudDeploymentOwner } from "./cloud-runtime-root.mjs";

import {
  PreviewGateway,
  type BoundaryPreviewGateway,
  type BoundaryPreviewGatewayFactory,
  type PreviewNavigation,
  type PreviewTarget,
} from "./preview-gateway";

export const CLOUD_PREVIEW_LINKS_PATH = "/run/zeros/cloud-preview-links.json";
export const MAX_CLOUD_PREVIEW_LINKS = 64;
const MAX_LINK_FILE_BYTES = 128 * 1024;
const MAX_LINK_URL_BYTES = 4 * 1024;
const MAX_LINK_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 60_000;
const MIN_REMAINING_LIFETIME_MS = 5_000;

export interface CloudPreviewLink {
  readonly port: number;
  readonly signedUrl: string;
}

export interface CloudPreviewLinks {
  readonly version: 1;
  readonly audience: "zeros-cloud-preview-v1";
  readonly generation: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly links: readonly CloudPreviewLink[];
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function parseLink(value: unknown): CloudPreviewLink | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ["port", "signedUrl"]) ||
    !validPort(record.port) ||
    typeof record.signedUrl !== "string" ||
    Buffer.byteLength(record.signedUrl, "utf8") > MAX_LINK_URL_BYTES
  ) {
    return null;
  }
  try {
    const signedUrl = new URL(record.signedUrl);
    if (
      signedUrl.protocol !== "https:" ||
      signedUrl.username ||
      signedUrl.password ||
      signedUrl.pathname !== "/" ||
      signedUrl.hash ||
      signedUrl.searchParams.has("__zsr_cap") ||
      !signedUrl.hostname.startsWith(`${record.port}-`)
    ) {
      return null;
    }
    return {
      port: record.port,
      signedUrl: signedUrl.toString(),
    };
  } catch {
    return null;
  }
}

function validateCloudPreviewLinks(
  parsed: unknown,
  now: number,
): CloudPreviewLinks {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("cloud preview link document is invalid");
  }
  const value = parsed as Record<string, unknown>;
  if (
    !exactKeys(value, [
      "audience",
      "expiresAt",
      "generation",
      "issuedAt",
      "links",
      "version",
    ]) ||
    value.version !== 1 ||
    value.audience !== "zeros-cloud-preview-v1" ||
    typeof value.generation !== "string" ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(value.generation) ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    Number(value.issuedAt) > now + CLOCK_SKEW_MS ||
    Number(value.expiresAt) - now < MIN_REMAINING_LIFETIME_MS ||
    Number(value.expiresAt) <= Number(value.issuedAt) ||
    Number(value.expiresAt) - Number(value.issuedAt) >
      MAX_LINK_LIFETIME_MS + CLOCK_SKEW_MS ||
    !Array.isArray(value.links) ||
    value.links.length < 1 ||
    value.links.length > MAX_CLOUD_PREVIEW_LINKS
  ) {
    throw new Error("cloud preview link document has an unsupported contract");
  }
  const links = value.links.map(parseLink);
  if (links.some((link) => link === null)) {
    throw new Error("cloud preview link document contains an invalid link");
  }
  const normalized = links as CloudPreviewLink[];
  if (
    new Set(normalized.map((link) => link.port)).size !== normalized.length ||
    new Set(normalized.map((link) => new URL(link.signedUrl).origin)).size !==
      normalized.length
  ) {
    throw new Error("cloud preview links must use unique ports and origins");
  }
  return {
    version: 1,
    audience: "zeros-cloud-preview-v1",
    generation: value.generation,
    issuedAt: Number(value.issuedAt),
    expiresAt: Number(value.expiresAt),
    links: normalized,
  };
}

export function parseCloudPreviewLinks(
  source: string,
  now = Date.now(),
): CloudPreviewLinks {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("cloud preview link document is invalid JSON");
  }
  return validateCloudPreviewLinks(parsed, now);
}

function privateStateFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === 10003 && stat.gid === 10003 &&
    (stat.mode & 0o7777) === 0o600;
}

function assertEngineOwnedPrivateFile(file: string): Stats {
  if (!path.isAbsolute(file) || path.resolve(file) !== file || realpathSync(file) !== file) {
    throw new Error("cloud preview link path is not canonical");
  }
  let cursor = file;
  let leafStat: Stats | undefined;
  for (;;) {
    const stat = lstatSync(cursor);
    const leaf = cursor === file;
    if (
      stat.isSymbolicLink() ||
      (stat.mode & 0o7022) !== 0 ||
      (leaf
        ? !privateStateFile(stat)
        : !stat.isDirectory() || !(stat.uid === 10003 && stat.gid === 10003 ||
            stat.uid === 65534 && stat.gid === 65534 && isCloudDeploymentOwner(cursor, stat.uid)))
    ) {
      throw new Error("cloud preview link state is not engine-owned");
    }
    if (leaf) leafStat = stat;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return leafStat!;
}

export function loadCloudPreviewLinks(
  file = CLOUD_PREVIEW_LINKS_PATH,
  now = Date.now(),
): CloudPreviewLinks {
  let descriptor: number;
  try {
    descriptor = openSync(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("cloud preview link state is unavailable");
    }
    throw error;
  }
  try {
    if (
      process.platform !== "linux" ||
      process.getuid?.() !== 10003 || process.geteuid?.() !== 10003 ||
      process.getgid?.() !== 10003 || process.getegid?.() !== 10003 ||
      !hasCloudEngineUserNamespace(4)
    ) {
      throw new Error("cloud preview links require the non-root cloud engine");
    }
    const stat = fstatSync(descriptor);
    const current = assertEngineOwnedPrivateFile(file);
    if (
      !privateStateFile(stat) ||
      stat.dev !== current.dev ||
      stat.ino !== current.ino
    ) {
      throw new Error("cloud preview link state is not engine-owned");
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < 2 || stat.size > MAX_LINK_FILE_BYTES) {
      throw new Error("cloud preview link state has an invalid size");
    }
    // Read the same no-follow descriptor with an independent byte bound, so
    // a growing inode cannot turn the initial size check into an unbounded read.
    const buffer = Buffer.alloc(MAX_LINK_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const length = readSync(descriptor, buffer, size, buffer.length - size, null);
      if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - size) {
        throw new Error("cloud preview link state has an invalid size");
      }
      if (!length) break;
      size += length;
    }
    const after = fstatSync(descriptor), pathAfter = assertEngineOwnedPrivateFile(file);
    if (size > MAX_LINK_FILE_BYTES || size !== stat.size || size !== after.size ||
      !privateStateFile(after) || stat.dev !== after.dev || stat.ino !== after.ino ||
      after.dev !== pathAfter.dev || after.ino !== pathAfter.ino) {
      throw new Error("cloud preview link state changed while reading");
    }
    return parseCloudPreviewLinks(buffer.toString("utf8", 0, size), now);
  } finally {
    closeSync(descriptor);
  }
}

interface CloudPreviewGatewayFactoryOptions {
  readonly loadLinks?: () => CloudPreviewLinks;
  /** Unit-test seam. Production must accept the provider proxy on 0.0.0.0. */
  readonly listenHost?: "127.0.0.1" | "0.0.0.0";
}

class CloudBoundaryPreviewGateway implements BoundaryPreviewGateway {
  constructor(
    private readonly factory: CloudPreviewGatewayFactory,
    private readonly port: number,
    private readonly displayPort: number,
    private readonly gateway: PreviewGateway,
  ) {}

  async navigation(): Promise<PreviewNavigation> {
    const { link, expiresAt } = this.factory.currentExposure(this.port);
    this.gateway.setExposure({
      publicBaseUrl: link.signedUrl,
      admissionBaseUrl: link.signedUrl,
      expiresAt,
    });
    const navigation = await this.gateway.navigation();
    return {
      url: `http://localhost:${this.displayPort}/`,
      admissionUrl: navigation.admissionUrl,
      expiresAt: navigation.expiresAt,
    };
  }

  close(): Promise<void> {
    return this.gateway.close();
  }
}

/** Allocates one provider-authenticated, dedicated origin per live preview.
 * The API key stays with the external cloud coordinator; the engine receives
 * only engine-owned, short-lived signed links for this bounded port pool. */
export class CloudPreviewGatewayFactory
  implements BoundaryPreviewGatewayFactory
{
  private readonly loadLinks: () => CloudPreviewLinks;
  private readonly listenHost: "127.0.0.1" | "0.0.0.0";
  private readonly reservedPorts = new Set<number>();

  constructor(options: CloudPreviewGatewayFactoryOptions = {}) {
    this.loadLinks = options.loadLinks ?? (() => loadCloudPreviewLinks());
    this.listenHost = options.listenHost ?? "0.0.0.0";
    // Legacy signed-link pools are optional for runtimes that serve previews
    // through user grants at the engine listener. Validate this pool on open
    // and every navigation; its absence must never enable a local fallback or
    // prevent unrelated files, agents and terminals from starting.
  }

  private readLinks(): CloudPreviewLinks {
    const value = this.loadLinks();
    return validateCloudPreviewLinks(value, Date.now());
  }

  currentExposure(port: number): {
    link: CloudPreviewLink;
    expiresAt: number;
  } {
    const document = this.readLinks();
    const link = document.links.find((candidate) => candidate.port === port);
    if (!link) throw new Error("cloud preview grant was rotated or revoked");
    return { link, expiresAt: document.expiresAt };
  }

  async open(target: PreviewTarget): Promise<BoundaryPreviewGateway> {
    const document = this.readLinks();
    for (const link of document.links) {
      if (this.reservedPorts.has(link.port)) continue;
      this.reservedPorts.add(link.port);
      try {
        const gateway = await PreviewGateway.open(target, {
          listenHost: this.listenHost,
          listenPort: link.port,
          exposure: {
            publicBaseUrl: link.signedUrl,
            admissionBaseUrl: link.signedUrl,
            expiresAt: document.expiresAt,
          },
          onClose: () => {
            this.reservedPorts.delete(link.port);
          },
        });
        return new CloudBoundaryPreviewGateway(
          this,
          link.port,
          target.displayPort,
          gateway,
        );
      } catch {
        this.reservedPorts.delete(link.port);
      }
    }
    throw new Error("cloud preview ingress pool is unavailable");
  }
}
