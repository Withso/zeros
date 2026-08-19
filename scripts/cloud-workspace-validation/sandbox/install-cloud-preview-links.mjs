#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUTPUT = "/run/zeros/cloud-preview-links.json";
const MAX_ENCODED_BYTES = 256 * 1024;
const MAX_LINKS = 64;
const MAX_URL_BYTES = 4 * 1024;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 60_000;
const MIN_REMAINING_MS = 5_000;

function exactKeys(value, expected) {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function validPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function parseLink(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (
    !exactKeys(value, ["port", "signedUrl"]) ||
    !validPort(value.port) ||
    typeof value.signedUrl !== "string" ||
    Buffer.byteLength(value.signedUrl, "utf8") > MAX_URL_BYTES
  ) {
    return null;
  }
  try {
    const signedUrl = new URL(value.signedUrl);
    if (
      signedUrl.protocol !== "https:" ||
      signedUrl.username ||
      signedUrl.password ||
      signedUrl.pathname !== "/" ||
      signedUrl.hash ||
      signedUrl.searchParams.has("__zsr_cap") ||
      !signedUrl.hostname.startsWith(`${value.port}-`)
    ) {
      return null;
    }
    return {
      port: value.port,
      signedUrl: signedUrl.toString(),
    };
  } catch {
    return null;
  }
}

export function parseCloudPreviewLinkPayload(encoded, now = Date.now()) {
  if (
    typeof encoded !== "string" ||
    encoded.length < 2 ||
    Buffer.byteLength(encoded, "utf8") > MAX_ENCODED_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw new Error("cloud preview link payload is invalid");
  }
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) {
    throw new Error("cloud preview link payload is not canonical");
  }
  let parsed;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } finally {
    decoded.fill(0);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("cloud preview link document is invalid");
  }
  if (
    !exactKeys(parsed, [
      "audience",
      "expiresAt",
      "generation",
      "issuedAt",
      "links",
      "version",
    ]) ||
    parsed.version !== 1 ||
    parsed.audience !== "zeros-cloud-preview-v1" ||
    typeof parsed.generation !== "string" ||
    !/^[A-Za-z0-9_-]{20,64}$/.test(parsed.generation) ||
    !Number.isSafeInteger(parsed.issuedAt) ||
    !Number.isSafeInteger(parsed.expiresAt) ||
    parsed.issuedAt > now + CLOCK_SKEW_MS ||
    parsed.expiresAt - now < MIN_REMAINING_MS ||
    parsed.expiresAt <= parsed.issuedAt ||
    parsed.expiresAt - parsed.issuedAt > MAX_LIFETIME_MS + CLOCK_SKEW_MS ||
    !Array.isArray(parsed.links) ||
    parsed.links.length < 1 ||
    parsed.links.length > MAX_LINKS
  ) {
    throw new Error("cloud preview link document has an unsupported contract");
  }
  const links = parsed.links.map(parseLink);
  if (links.some((link) => link === null)) {
    throw new Error("cloud preview link document contains an invalid link");
  }
  if (
    new Set(links.map((link) => link.port)).size !== links.length ||
    new Set(links.map((link) => new URL(link.signedUrl).origin)).size !==
      links.length
  ) {
    throw new Error("cloud preview links must use unique ports and origins");
  }
  return {
    version: 1,
    audience: "zeros-cloud-preview-v1",
    generation: parsed.generation,
    issuedAt: parsed.issuedAt,
    expiresAt: parsed.expiresAt,
    links,
  };
}

function assertPrivateDirectory(directory, expectedUid) {
  if (!path.isAbsolute(directory) || realpathSync(directory) !== directory) {
    throw new Error("cloud preview runtime directory is not canonical");
  }
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error("cloud preview runtime directory is not private");
  }
}

function assertReplaceableOutput(output, expectedUid) {
  if (!existsSync(output)) return;
  const stat = lstatSync(output);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== expectedUid ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    realpathSync(output) !== output
  ) {
    throw new Error("existing cloud preview state is not replaceable");
  }
}

export function installCloudPreviewLinkPayload(
  encoded,
  { output = OUTPUT, expectedUid = 0, now = Date.now() } = {},
) {
  if (
    !path.isAbsolute(output) ||
    !Number.isInteger(expectedUid) ||
    expectedUid < 0
  ) {
    throw new Error("cloud preview installer options are invalid");
  }
  const directory = path.dirname(output);
  assertPrivateDirectory(directory, expectedUid);
  assertReplaceableOutput(output, expectedUid);
  const document = parseCloudPreviewLinkPayload(encoded, now);
  const serialized = `${JSON.stringify(document)}\n`;
  const temporary = path.join(
    directory,
    `.cloud-preview-links-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, serialized, { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, output);
    const directoryDescriptor = openSync(directory, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  return document;
}

const direct =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (direct) {
  const encoded = process.env.ZEROS_CLOUD_PREVIEW_LINKS_B64 ?? "";
  delete process.env.ZEROS_CLOUD_PREVIEW_LINKS_B64;
  try {
    if (process.platform !== "linux" || process.geteuid?.() !== 0) {
      throw new Error("root Linux coordinator required");
    }
    installCloudPreviewLinkPayload(encoded);
    process.stdout.write("installed cloud preview ingress\n");
  } catch {
    process.stderr.write("cloud preview ingress installation rejected\n");
    process.exit(1);
  }
}
