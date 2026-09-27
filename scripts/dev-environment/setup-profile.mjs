import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { hostedProfileIssues } from "./hosted-profile.mjs";
import { PROFILE_NAME, profileExists } from "./profile-path.mjs";
import { developmentHome, readPrivateJson, systemEnvironment, writePrivateFile } from "./state.mjs";

// Transfers (AirDrop, encrypted vault downloads, etc.) may arrive mode 0644.
// Only the explicit import may restrict their mode; inspection is read-only.
function transferredProfile(file, restrict = false) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.nlink !== 1 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error();
    if (stat.size > 128 * 1024) return { issues: ["Dev profile must be smaller than 128 KiB"] };
    const buffer = Buffer.alloc(128 * 1024 + 1);
    let length = 0, count;
    while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    if (length > 128 * 1024) return { issues: ["Dev profile must be smaller than 128 KiB"] };
    const bytes = buffer.subarray(0, length);
    let profile;
    try { profile = JSON.parse(bytes.toString("utf8")); }
    catch { return { issues: ["Dev profile contains invalid JSON; contents withheld"] }; }
    const issues = hostedProfileIssues(profile);
    if (containsPlaceholder(profile)) issues.push("Dev profile still contains example placeholders; fill them before import");
    if (!issues.length && restrict) fs.fchmodSync(fd, 0o600);
    return { profile, bytes, issues };
  } catch { return { issues: ["Dev profile must be a readable, user-owned regular file, without filesystem links"] }; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function containsPlaceholder(value) {
  if (typeof value === "string") return /YOUR_|GENERATE_32_|^your-/i.test(value);
  return value && typeof value === "object" && Object.values(value).some(containsPlaceholder);
}

export function inspectDevelopmentProfile(file) {
  return { issues: transferredProfile(file).issues };
}

function git(root, args) {
  try { return execFileSync("git", args, { cwd: root, env: systemEnvironment(), encoding: "utf8", stdio: "pipe" }); }
  catch { throw new Error("Could not verify the Dev profile's Git destination; no credential output was retained"); }
}

function assertIgnoredDestination(root) {
  if (git(root, ["ls-files", "-z", "--", PROFILE_NAME])) throw new Error("Refusing to import a tracked Dev profile");
  try { git(root, ["check-ignore", "--no-index", "-q", "--", PROFILE_NAME]); }
  catch { throw new Error("The checkout must ignore zeros-dev-env.json before importing credentials; update its .gitignore first"); }
}

function assertSameProfile(file, profile) {
  if (profileExists(file) && !isDeepStrictEqual(readPrivateJson(file), profile)) {
    throw new Error("An existing profile differs. It was preserved, including its registry key. Reconcile the profiles before retrying; never replace the registry key while environments exist.");
  }
}

/** Seed the main clone as well as this worktree, so Files to copy works for
 * future local/cloud workspaces. Never provision services or generate new keys. */
export function importDevelopmentProfile({ root, source, homeDir = os.homedir() }) {
  const candidate = transferredProfile(source, true);
  if (candidate.issues.length) throw new Error(candidate.issues.join("\n"));
  const checkout = fs.realpathSync(root);
  if (fs.realpathSync(git(checkout, ["rev-parse", "--show-toplevel"]).trimEnd()) !== checkout) {
    throw new Error("Run Dev setup from the repository root");
  }
  const first = git(checkout, ["worktree", "list", "--porcelain", "-z"]).split("\0")[0];
  if (!first.startsWith("worktree ")) throw new Error("Could not locate the main checkout for future workspace profiles");
  const main = fs.realpathSync(first.slice("worktree ".length));
  const checkouts = [...new Set([main, checkout])];
  const directory = developmentHome(homeDir);
  const files = [path.join(directory, PROFILE_NAME), ...checkouts.map(p => path.join(p, PROFILE_NAME))];
  for (const cwd of checkouts) assertIgnoredDestination(cwd);
  // Detect stale copies before making any destination authoritative. Version 1
  // files can still be selected explicitly for legacy tunnel cleanup.
  for (const file of [...files, path.join(directory, "development.json"), ...checkouts.map(p => path.join(p, ".env.zeros-dev.json"))]) {
    assertSameProfile(file, candidate.profile);
  }
  const secured = transferredProfile(source, true);
  if (secured.issues.length || !isDeepStrictEqual(candidate.profile, secured.profile)) {
    throw new Error("Dev profile changed during import; retry after saving the file");
  }
  for (const file of files) {
    // Non-overwriting publication also preserves a concurrent install's keys.
    if (!profileExists(file)) writePrivateFile(file, secured.bytes, { create: true });
    assertSameProfile(file, candidate.profile);
  }
  return { files };
}
