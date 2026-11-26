import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { developmentHome, systemEnvironment } from "./state.mjs";

export const PROFILE_NAME = "zeros-dev-env.json";

export function mainProfileCheckout(root) {
  const list = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
    cwd: root, env: systemEnvironment(), encoding: "utf8", stdio: "pipe",
  });
  const first = list.split("\0", 1)[0];
  if (!first.startsWith("worktree ")) throw new Error("Could not locate the main Dev checkout");
  return fs.realpathSync(first.slice("worktree ".length));
}

export function assertIgnoredProfileDestination(root) {
  const git = args => execFileSync("git", args, { cwd: root, env: systemEnvironment(), encoding: "utf8", stdio: "pipe" });
  try {
    if (fs.realpathSync(git(["rev-parse", "--show-toplevel"]).trimEnd()) !== fs.realpathSync(root) || git(["ls-files", "-z", "--", PROFILE_NAME])) throw new Error();
    git(["check-ignore", "--no-index", "-q", "--", PROFILE_NAME]);
  } catch { throw new Error("The checkout must ignore an untracked zeros-dev-env.json before importing credentials; existing files were preserved"); }
}

// lstat deliberately counts dangling links as present. A broken or unsafe
// preferred profile must fail, never silently select another set of credentials.
export function profileExists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export function developmentProfilePath(root, { env = process.env, homeDir = os.homedir() } = {}) {
  if (env.ZEROS_DEV_PROFILE_PATH) return path.resolve(env.ZEROS_DEV_PROFILE_PATH);
  const directory = path.join(homeDir, ".zeros-dev");
  const candidates = [
    ...(root ? [path.join(root, PROFILE_NAME), path.join(root, ".env.zeros-dev.json")] : []),
    path.join(directory, PROFILE_NAME), path.join(directory, "development.json"),
  ];
  let file = candidates.find(profileExists);
  if (!file && root && fs.lstatSync(path.join(root, ".git"), { throwIfNoEntry: false })?.isFile()) {
    const main = mainProfileCheckout(root);
    const source = path.join(main, PROFILE_NAME);
    if (main !== fs.realpathSync(root) && profileExists(source)) {
      assertIgnoredProfileDestination(main);
      file = source;
    }
  }
  file ??= path.join(directory, PROFILE_NAME);
  if (path.dirname(file) === directory && profileExists(file)) developmentHome(homeDir);
  return file;
}
