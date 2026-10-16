#!/usr/bin/env node
// Stage the pinned AXe iOS Simulator tool.
//
// AXe (MIT, https://github.com/cameroncooke/AXe) streams simulator screens and
// sends the user's touches, keys and buttons to them. It is not on npm: the
// release tarball holds the `axe` executable, the idb frameworks it links
// (FBSimulatorControl and friends, MIT) and a resource bundle, all in one
// directory. electron/devices/axe.ts resolves `Resources/axe/axe` when
// packaged and `binaries/axe/axe` in a checkout (see axeBinaryPath), and the
// Simulator tab says it can't show devices when the tool is missing, so a
// checkout stages it with `pnpm stage:axe` and beforePack stages it for every
// packaging entrypoint.
//
// Supply chain: the tarball URL, version and SHA-256 are pinned here. Every
// Mach-O in it carries a Developer ID (hardened runtime) signature; the staged
// copy is thinned to arm64 with `lipo`, which keeps each slice's signature,
// and every signature is verified again after thinning. The app ships macOS
// arm64 only. Its reviewed terms are in third_party/axe/.
//
// Zeros' own zeros-simulator-hid, which sends the user's input in about a
// millisecond where each AXe command takes a second, links AXe's frameworks,
// so scripts/build-simulator-hid.mjs builds it into the same folder before
// the folder is put in place. beforePack passes --require-simulator-hid, so
// a package never ships without it; a checkout warns and keeps AXe alone.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSimulatorHid } from "./build-simulator-hid.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const filename = fileURLToPath(import.meta.url);

export const AXE_VERSION = "1.8.0";
const ARCHIVE_NAME = `AXe-macOS-v${AXE_VERSION}-universal.tar.gz`;
const ARCHIVE_URL = `https://github.com/cameroncooke/AXe/releases/download/v${AXE_VERSION}/${ARCHIVE_NAME}`;
const ARCHIVE_SHA256 =
  "7b76340b72e90d0f211bc7c4636f15009076eff07acef2f2b632b175debd8834";

// Keep in sync with scripts/check-packaging-paths.mjs (AXE_STAGED) and the
// extraResources entry in electron-builder.yml.
export const STAGED_DIRECTORY = "binaries/axe";
export const STAGED_VERSION_FILE = "binaries/axe-version.txt";

const EXPECTED_AUTHORITY =
  "Developer ID Application: Cameron Cooke (BR6WD3M6ZD)";
const FRAMEWORKS = [
  "FBControlCore",
  "FBDeviceControl",
  "FBSimulatorControl",
  "XCTestBootstrap",
];

async function downloadVerified(url, destination) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`[stage-axe] download failed (${response.status}): ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== ARCHIVE_SHA256) {
    throw new Error(
      `[stage-axe] SHA-256 mismatch for ${ARCHIVE_NAME}: got ${digest}, ` +
        `expected ${ARCHIVE_SHA256}. Do not bypass: re-review the upstream ` +
        `release and update the pin deliberately.`,
    );
  }
  await writeFile(destination, bytes);
}

// `codesign -dv` reports on stderr even on success, so both streams must be
// captured regardless of exit status.
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

function verifySignature(target) {
  const verify = spawn("codesign", ["--verify", "--strict", "--deep", target]);
  if (verify.status !== 0) {
    throw new Error(
      `[stage-axe] signature verification failed for ${target}: ` +
        `${verify.stderr || verify.stdout || `status ${verify.status}`}`,
    );
  }
  const details = spawn("codesign", ["-dv", "--verbose=2", target]);
  if (!`${details.stderr}\n${details.stdout}`.includes(EXPECTED_AUTHORITY)) {
    throw new Error(
      `[stage-axe] ${target} is not signed by ${EXPECTED_AUTHORITY}`,
    );
  }
}

/** Regular files only: framework `Versions/Current` links point at the
 * thinned originals. */
function machOFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const file = join(directory, entry);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) files.push(...machOFiles(file));
    else if (spawn("lipo", ["-archs", file]).status === 0) files.push(file);
  }
  return files;
}

/** electron-builder copies only files and symlinks into the app, so an empty
 * directory never arrives there and a link into it dangles, which fails the
 * signing pass when it stats the link. The release ships an empty
 * `Versions/A/Frameworks` behind several frameworks' `Frameworks` link;
 * framework signatures seal neither, so removing both keeps them valid. */
export function pruneEmptyDirectories(directory) {
  // A pass can check a link before it empties the directory the link points
  // into, so repeat until a pass removes nothing.
  let removed;
  do {
    removed = pruneOnce(directory);
  } while (removed > 0);
}

function pruneOnce(directory) {
  let removed = 0;
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      if (!existsSync(path)) {
        unlinkSync(path);
        removed += 1;
      }
    } else if (stat.isDirectory()) {
      removed += pruneOnce(path);
      if (readdirSync(path).length === 0) {
        rmdirSync(path);
        removed += 1;
      }
    }
  }
  return removed;
}

export async function stageAxe({ quiet = false, requireSimulatorHid = false } = {}) {
  const work = mkdtempSync(join(tmpdir(), "zeros-axe-"));
  const staged = join(repoRoot, STAGED_DIRECTORY);
  mkdirSync(dirname(staged), { recursive: true });
  // Beside the destination, so the final rename never crosses volumes.
  const unpacked = mkdtempSync(`${staged}.staging-`);
  try {
    const archive = join(work, ARCHIVE_NAME);
    await downloadVerified(ARCHIVE_URL, archive);
    execFileSync("tar", ["-xzf", archive, "-C", unpacked]);
    if (!existsSync(join(unpacked, "axe"))) {
      throw new Error(
        "[stage-axe] the release archive no longer contains `axe`",
      );
    }
    for (const name of FRAMEWORKS) {
      if (!existsSync(join(unpacked, "Frameworks", `${name}.framework`))) {
        throw new Error(
          `[stage-axe] the release archive no longer contains ${name}.framework`,
        );
      }
    }
    pruneEmptyDirectories(unpacked);

    for (const file of machOFiles(unpacked)) {
      const archs = execFileSync("lipo", ["-archs", file], {
        encoding: "utf8",
      }).trim();
      if (!archs.split(/\s+/).includes("arm64")) {
        throw new Error(
          `[stage-axe] ${relative(unpacked, file)} has no arm64 slice (${archs})`,
        );
      }
      if (archs !== "arm64") {
        execFileSync("lipo", [
          "-thin",
          "arm64",
          file,
          "-output",
          `${file}.thin`,
        ]);
        renameSync(`${file}.thin`, file);
      }
    }
    verifySignature(join(unpacked, "axe"));
    for (const name of FRAMEWORKS) {
      verifySignature(join(unpacked, "Frameworks", `${name}.framework`));
    }
    const version = execFileSync(join(unpacked, "axe"), ["--version"], {
      encoding: "utf8",
    }).trim();
    if (version !== AXE_VERSION) {
      throw new Error(
        `[stage-axe] staged axe reports ${version}, expected ${AXE_VERSION}`,
      );
    }
    let helper = false;
    try {
      buildSimulatorHid({ axeDirectory: unpacked, quiet: true });
      helper = true;
    } catch (error) {
      if (requireSimulatorHid) throw error;
      console.warn(
        `${error instanceof Error ? error.message : String(error)}\n` +
          "[stage-axe] staged AXe without zeros-simulator-hid: simulator input " +
          "will take about a second per touch. Fix the build, then run " +
          "pnpm build:simulator-hid.",
      );
    }

    const previous = `${staged}.previous`;
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(staged)) renameSync(staged, previous);
    renameSync(unpacked, staged);
    // mkdtemp creates the directory private to this user.
    chmodSync(staged, 0o755);
    rmSync(previous, { recursive: true, force: true });
    writeFileSync(
      join(repoRoot, STAGED_VERSION_FILE),
      `${AXE_VERSION}\n`,
      "utf8",
    );
    if (!quiet) {
      const size = execFileSync("du", ["-sh", staged], { encoding: "utf8" })
        .split("\t")[0]
        .trim();
      console.log(
        `[stage-axe] AXe ${AXE_VERSION}${helper ? " and zeros-simulator-hid" : ""} → ` +
          `${STAGED_DIRECTORY} (${size}, arm64, ${EXPECTED_AUTHORITY})`,
      );
    }
    return { directory: staged, version: AXE_VERSION, simulatorHid: helper };
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(unpacked, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(filename)) {
  stageAxe({
    requireSimulatorHid: process.argv.includes("--require-simulator-hid"),
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
