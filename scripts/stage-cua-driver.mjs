#!/usr/bin/env node
// Stage the pinned Cua computer-use driver executable.
//
// `@trycua/cua-driver` (npm) is only the SDK: the process that actually owns
// the macOS event and capture APIs is the separate `cua-driver` executable
// published on the matching GitHub release. electron/computer-use/driver.ts
// resolves it as `Resources/cua-driver` when packaged and `binaries/cua-driver`
// in a checkout (see cuaDriverBinaryPath), and refuses computer use when the
// executable is missing — so a checkout stages it with `pnpm stage:cua-driver`
// and beforePack stages it for every packaging entrypoint.
//
// Supply chain: the tarball URL, version, and SHA-256 are pinned here and must
// move together with the `@trycua/cua-driver` dependency in package.json. The
// upstream binary carries a Developer ID (hardened runtime) signature; the
// staged copy is thinned to arm64 with `lipo`, which preserves that signature,
// and the signature is verified again after thinning. The app ships macOS
// arm64 only, so the x86_64 slice would be dead weight.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const filename = fileURLToPath(import.meta.url);

export const CUA_DRIVER_VERSION = "0.34.1";
export const CUA_DRIVER_TAG = `cua-driver-rs-v${CUA_DRIVER_VERSION}`;
const ARCHIVE_NAME = `cua-driver-rs-${CUA_DRIVER_VERSION}-darwin-universal-binary.tar.gz`;
const ARCHIVE_URL = `https://github.com/trycua/cua/releases/download/${CUA_DRIVER_TAG}/${ARCHIVE_NAME}`;
const ARCHIVE_SHA256 =
  "52de49b5046df19245ad02ff9aa89ce9caf69e84988e1d0fac677611dd83e48c";

// Keep in sync with scripts/check-packaging-paths.mjs (CUA_STAGED) and the
// extraResources entry in electron-builder.yml.
export const STAGED_BINARY = "binaries/cua-driver";
export const STAGED_VERSION_FILE = "binaries/cua-driver-version.txt";

/** The release asset's code-signing authority, re-checked after `lipo`. */
const EXPECTED_AUTHORITY =
  "Developer ID Application: Cua AI, Inc. (YCK386LBJ7)";

export function assertNpmPackagesPinned(
  manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")),
) {
  const pinned = manifest.dependencies?.["@trycua/cua-driver"];
  if (pinned !== CUA_DRIVER_VERSION) {
    throw new Error(
      `[stage-cua-driver] package.json pins @trycua/cua-driver ${pinned ?? "(missing)"} ` +
        `but this script stages ${CUA_DRIVER_VERSION}. The SDK and its driver ` +
        `executable are released together; move both pins and the SHA-256 in one change.`,
    );
  }
  // electron-builder's pnpm collector looks for an optional dependency only
  // under the repository root's node_modules and silently skips it when it
  // is absent there, which pnpm guarantees for a transitive one. Declaring the
  // SDK's own macOS platform package at the root links it there.
  const platform =
    manifest.optionalDependencies?.["@trycua/cua-driver-darwin-arm64"];
  if (platform !== CUA_DRIVER_VERSION) {
    throw new Error(
      `[stage-cua-driver] package.json optionalDependencies pins ` +
        `@trycua/cua-driver-darwin-arm64 ${platform ?? "(missing)"}, expected ` +
        `${CUA_DRIVER_VERSION}. Without it at the SDK's exact version the ` +
        `packaged app cannot load the SDK's native library.`,
    );
  }
}

async function downloadVerified(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(
      `[stage-cua-driver] download failed (${response.status}): ${url}`,
    );
  }
  const hash = createHash("sha256");
  const { writeFile } = await import("node:fs/promises");
  const bytes = new Uint8Array(await response.arrayBuffer());
  hash.update(bytes);
  const digest = hash.digest("hex");
  if (digest !== ARCHIVE_SHA256) {
    throw new Error(
      `[stage-cua-driver] SHA-256 mismatch for ${ARCHIVE_NAME}: got ${digest}, ` +
        `expected ${ARCHIVE_SHA256}. Do not bypass: re-review the upstream ` +
        `release and update the pin deliberately.`,
    );
  }
  await writeFile(destination, bytes);
}

/** `codesign` exists on macOS only; staging is a macOS-only path anyway. */
function verifySignature(binary) {
  const verify = spawn("codesign", ["--verify", "--strict", binary]);
  if (verify.status !== 0) {
    throw new Error(
      `[stage-cua-driver] signature verification failed for the staged driver: ` +
        `${verify.stderr || verify.stdout || `status ${verify.status}`}`,
    );
  }
  const details = spawn("codesign", ["-dv", "--verbose=2", binary]);
  if (!`${details.stderr}\n${details.stdout}`.includes(EXPECTED_AUTHORITY)) {
    throw new Error(
      `[stage-cua-driver] the staged driver is not signed by ${EXPECTED_AUTHORITY}`,
    );
  }
}

// `codesign -dv` reports on stderr even on success, so both streams must be
// captured regardless of exit status — execFileSync drops stderr on success.
function spawn(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error) : ""),
  };
}

export async function stageCuaDriver({ quiet = false } = {}) {
  assertNpmPackagesPinned();
  const work = mkdtempSync(join(tmpdir(), "zeros-cua-driver-"));
  try {
    const archive = join(work, ARCHIVE_NAME);
    await downloadVerified(ARCHIVE_URL, archive);
    // The tarball's entries are flat (cua-driver, the .node runtime, the
    // dylib, a cursor helper, an ABI header); only the executable is staged.
    execFileSync("tar", ["-xzf", archive, "-C", work, "cua-driver"]);
    const universal = join(work, "cua-driver");
    const staged = join(repoRoot, STAGED_BINARY);
    const scratch = `${staged}.tmp`;
    mkdirSync(dirname(staged), { recursive: true });
    // Thin to the one architecture the app ships. lipo rewrites in place only
    // with -output; keep the universal original untouched for hashing above.
    execFileSync("lipo", ["-thin", "arm64", universal, "-output", scratch]);
    const info = execFileSync("lipo", ["-info", scratch], { encoding: "utf8" });
    if (!/arm64/.test(info) || /x86_64/.test(info)) {
      throw new Error(
        `[stage-cua-driver] thinned driver is not arm64-only: ${info.trim()}`,
      );
    }
    chmodSync(scratch, 0o755);
    verifySignature(scratch);
    renameSync(scratch, staged);
    writeFileSync(
      join(repoRoot, STAGED_VERSION_FILE),
      `${CUA_DRIVER_VERSION}\n`,
      "utf8",
    );
    const size = statSync(staged).size;
    if (!quiet) {
      console.log(
        `[stage-cua-driver] ${CUA_DRIVER_TAG} → ${STAGED_BINARY} ` +
          `(${(size / 1024 / 1024).toFixed(1)} MiB, arm64, ${EXPECTED_AUTHORITY})`,
      );
    }
    return { binaryPath: staged, version: CUA_DRIVER_VERSION, size };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(filename)) {
  stageCuaDriver().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
