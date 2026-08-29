#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const CODESIGN = "/usr/bin/codesign";
const DITTO = "/usr/bin/ditto";
const HDIUTIL = "/usr/bin/hdiutil";

function fail(message) {
  throw new Error(message);
}

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      fail(`expected --name value arguments; received ${JSON.stringify(argv)}`);
    }
    if (values.has(name)) fail(`duplicate argument: ${name}`);
    values.set(name, value);
  }

  const required = ["--dmg", "--zip", "--app-name", "--bundle-id", "--team-id"];
  for (const name of required) {
    if (!values.has(name)) fail(`missing required argument: ${name}`);
  }
  for (const name of values.keys()) {
    if (!required.includes(name)) fail(`unknown argument: ${name}`);
  }

  const appName = values.get("--app-name");
  const bundleId = values.get("--bundle-id");
  const teamId = values.get("--team-id");
  if (basename(appName) !== appName || !appName.endsWith(".app")) {
    fail("--app-name must be one top-level .app bundle name");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(bundleId)) {
    fail("--bundle-id is not a valid reverse-DNS identifier");
  }
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    fail("--team-id must be a ten-character Apple team identifier");
  }

  return {
    dmg: resolve(values.get("--dmg")),
    zip: resolve(values.get("--zip")),
    appName,
    bundleId,
    teamId,
  };
}

export function parseCodeSignMetadata(output) {
  const metadata = {
    authorities: [],
    cdHash: undefined,
    flags: undefined,
    identifier: undefined,
    teamIdentifier: undefined,
    timestamp: undefined,
  };

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("CodeDirectory ")) {
      const match = line.match(/\bflags=([^ ]+)/);
      metadata.flags = match?.[1];
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    switch (key) {
      case "Authority":
        metadata.authorities.push(value);
        break;
      case "CDHash":
        metadata.cdHash = value;
        break;
      case "Identifier":
        metadata.identifier = value;
        break;
      case "TeamIdentifier":
        metadata.teamIdentifier = value;
        break;
      case "Timestamp":
        metadata.timestamp = value;
        break;
      default:
        break;
    }
  }
  return metadata;
}

export function assertExpectedMetadata(metadata, expected, label) {
  if (metadata.identifier !== expected.bundleId) {
    fail(
      `${label}: expected bundle identifier ${expected.bundleId}, got ${metadata.identifier ?? "none"}`,
    );
  }
  if (metadata.teamIdentifier !== expected.teamId) {
    fail(
      `${label}: expected Apple team ${expected.teamId}, got ${metadata.teamIdentifier ?? "none"}`,
    );
  }
  if (!metadata.flags?.includes("runtime")) {
    fail(`${label}: hardened runtime flag is missing`);
  }
  if (!metadata.cdHash) fail(`${label}: code-directory hash is missing`);
  if (!metadata.timestamp)
    fail(`${label}: secure signing timestamp is missing`);

  const developerId = metadata.authorities.find((authority) =>
    authority.startsWith("Developer ID Application:"),
  );
  if (!developerId || !developerId.includes(`(${expected.teamId})`)) {
    fail(
      `${label}: expected Developer ID Application authority for ${expected.teamId}`,
    );
  }
}

export function findNonOwnerWritable(root, limit = 20) {
  const failures = [];
  const pending = [root];
  while (pending.length > 0 && failures.length < limit) {
    const current = pending.pop();
    const stat = lstatSync(current);
    if (stat.isDirectory() || stat.isFile()) {
      if ((stat.mode & 0o200) === 0) failures.push(current);
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current))
        pending.push(join(current, entry));
    }
  }
  return failures;
}

function run(command, args, { capture = false, allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const detail = capture
      ? `\n${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd()
      : "";
    fail(`${command} exited with status ${result.status}${detail}`);
  }
  return result;
}

export function cleanupVerificationScratch(
  { attached, mount, scratch, priorFailure },
  dependencies = {},
) {
  const detach =
    dependencies.detach ??
    ((mountpoint) => {
      const result = run(HDIUTIL, ["detach", mountpoint, "-quiet"], {
        allowFailure: true,
        capture: true,
      });
      return {
        status: result.status,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
      };
    });
  const remove = dependencies.remove ?? rmSync;
  const report = dependencies.report ?? console.error;

  let detachFailure;
  if (attached) {
    try {
      const outcome = detach(mount);
      if (outcome.status !== 0) {
        detachFailure = new Error(
          `hdiutil detach exited with status ${outcome.status}` +
            (outcome.output ? `: ${outcome.output}` : ""),
        );
      }
    } catch (error) {
      detachFailure = error;
    }
  }

  if (detachFailure) {
    const detail =
      detachFailure instanceof Error
        ? detachFailure.message
        : String(detachFailure);
    const message =
      `could not detach the verification DMG (${detail}); ` +
      `preserved scratch directory ${scratch}`;
    if (priorFailure) {
      report(`::warning::${message}`);
      return;
    }
    fail(message);
  }

  remove(scratch, { recursive: true, force: true });
}

function resolveApp(root, appName, label) {
  const app = join(root, appName);
  if (!existsSync(app) || !lstatSync(app).isDirectory()) {
    fail(`${label}: expected ${appName} at the artifact root`);
  }
  const realRoot = realpathSync(root);
  const realApp = realpathSync(app);
  if (!realApp.startsWith(`${realRoot}${sep}`)) {
    fail(`${label}: app bundle escapes its extraction root`);
  }
  return app;
}

function verifyApp(app, expected, label) {
  console.log(`Verifying ${label}: ${app}`);

  // First validate the complete nested seal. Then separately require the root
  // bundle to chain to Apple and the exact Zeros team. Applying -R with --deep
  // would incorrectly require helper apps to share the root bundle identifier.
  run(CODESIGN, ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const requirement =
    `anchor apple generic and certificate leaf[subject.OU] = "${expected.teamId}" ` +
    `and identifier "${expected.bundleId}"`;
  run(CODESIGN, ["--verify", "--strict", `-R=${requirement}`, app]);

  const display = run(CODESIGN, ["--display", "--verbose=4", app], {
    capture: true,
  });
  const metadata = parseCodeSignMetadata(
    `${display.stdout ?? ""}\n${display.stderr ?? ""}`,
  );
  assertExpectedMetadata(metadata, expected, label);

  const readOnly = findNonOwnerWritable(app);
  if (readOnly.length > 0) {
    fail(
      `${label}: packaged entries without owner-write would break in-place updates:\n` +
        readOnly.join("\n"),
    );
  }
  return metadata;
}

export function verifyReleaseArtifacts(options) {
  if (process.platform !== "darwin") {
    fail("macOS release artifacts must be verified on macOS");
  }
  for (const [label, path] of [
    ["DMG", options.dmg],
    ["ZIP", options.zip],
  ]) {
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      fail(`${label} artifact does not exist: ${path}`);
    }
  }

  const scratch = mkdtempSync(join(tmpdir(), "zeros-macos-release-verify-"));
  const mount = join(scratch, "dmg");
  const extracted = join(scratch, "zip");
  mkdirSync(mount);
  mkdirSync(extracted);
  let attached = false;
  let priorFailure;

  try {
    run(HDIUTIL, [
      "attach",
      options.dmg,
      "-readonly",
      "-nobrowse",
      "-quiet",
      "-mountpoint",
      mount,
    ]);
    attached = true;
    run(DITTO, ["-x", "-k", options.zip, extracted]);

    const expected = {
      bundleId: options.bundleId,
      teamId: options.teamId,
    };
    const dmgMetadata = verifyApp(
      resolveApp(mount, options.appName, "DMG"),
      expected,
      "DMG app",
    );
    const zipMetadata = verifyApp(
      resolveApp(extracted, options.appName, "ZIP"),
      expected,
      "updater ZIP app",
    );
    if (dmgMetadata.cdHash !== zipMetadata.cdHash) {
      fail(
        `DMG and updater ZIP contain different signed roots (${dmgMetadata.cdHash} != ${zipMetadata.cdHash})`,
      );
    }

    console.log(
      `✓ DMG + updater ZIP: Developer ID ${options.teamId} · ${options.bundleId} · ` +
        "matching code directory · hardened runtime · secure timestamp · owner-writable",
    );
  } catch (error) {
    priorFailure = error;
    throw error;
  } finally {
    cleanupVerificationScratch({
      attached,
      mount,
      scratch,
      priorFailure,
    });
  }
}

const isMain =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    verifyReleaseArtifacts(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(
      `::error::${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
