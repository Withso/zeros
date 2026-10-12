import * as nativeFs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { CLOUD_GIT_EXEC_ROOT } from "./cloud-runtime-assets.mjs";

/** Native Git helpers remain native. Only LFS selects the immutable runtime.
 * This derived sibling is outside the archive's hashed tree and is already
 * visible in older residents' read-only installation-parent mount. No provider
 * system file or user profile is changed. */
export function prepareCloudGitExecPath(runtime, { filesystem: fs = nativeFs, gitDirectory } = {}) {
  const fail = () => { throw new Error("Unsafe cloud Git executable projection"); };
  if (runtime.profile !== "v4" || !/^r1-[a-f0-9]{64}$/.test(runtime.runtimeId) ||
      runtime.root !== `/opt/zeros-infra/${runtime.runtimeId}` || runtime.binRoot !== `${runtime.root}/bin`) fail();
  const protect = (file, directory = false, singleLink = false) => {
    if (fs.realpathSync(file) !== file) fail();
    for (let current = file; ; current = path.dirname(current)) {
      const info = fs.lstatSync(current);
      if (info.uid !== 0 || info.mode & 0o7022 || info.isSymbolicLink() ||
          (current === file && !directory ? !info.isFile() || singleLink && info.nlink !== 1 : !info.isDirectory())) fail();
      if (current === "/") break;
    }
  };
  if (gitDirectory === undefined) {
    // Boat's qualified non-agent Git is an explicit trusted system input.
    // Ask that exact executable with no inherited Git configuration or PATH.
    const git = fs.realpathSync("/usr/bin/git"); protect(git);
    const result = spawnSync(git, ["--exec-path"], { cwd: "/", encoding: "utf8", timeout: 1000,
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) fail();
    gitDirectory = result.stdout.trim();
  }
  if (!["/usr/lib/git-core", "/usr/libexec/git-core"].includes(gitDirectory)) fail();
  protect(gitDirectory, true);
  protect(`${runtime.binRoot}/git-lfs`, false, true);
  const names = fs.readdirSync(gitDirectory).sort();
  if (names.length > 512 || names.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/.test(name)) ||
      ["git", "git-sh-setup", "git-remote-https"].some(name => !names.includes(name))) fail();
  const links = new Map();
  for (const name of names) {
    if (name === "git-lfs") continue;
    const source = `${gitDirectory}/${name}`, target = fs.realpathSync(source);
    if (!target.startsWith("/usr/")) fail();
    protect(target, fs.lstatSync(target).isDirectory());
    links.set(name, source);
  }
  links.set("git-lfs", `${runtime.binRoot}/git-lfs`);
  protect(path.dirname(CLOUD_GIT_EXEC_ROOT), true);
  try { fs.mkdirSync(CLOUD_GIT_EXEC_ROOT, { mode: 0o755 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  protect(CLOUD_GIT_EXEC_ROOT, true);
  // The host's private umask can leave a fresh or interrupted parent at 0700.
  // Repair only this validated owned directory; the host umask stays private.
  fs.chmodSync(CLOUD_GIT_EXEC_ROOT, 0o755);
  protect(CLOUD_GIT_EXEC_ROOT, true);
  if ((fs.lstatSync(CLOUD_GIT_EXEC_ROOT).mode & 0o7777) !== 0o755) fail();
  const destination = `${CLOUD_GIT_EXEC_ROOT}/${runtime.runtimeId}`;
  const verify = (complete) => {
    protect(destination, true);
    const present = fs.readdirSync(destination);
    if (complete && present.length !== links.size || present.some(name => !links.has(name))) fail();
    for (const name of present) {
      const target = links.get(name);
      const file = `${destination}/${name}`, info = fs.lstatSync(file);
      if (!info.isSymbolicLink() || info.uid !== 0 || info.nlink !== 1 || fs.readlinkSync(file) !== target) fail();
    }
  };
  try { fs.mkdirSync(destination, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  verify(false);
  // Boat restores directory renames imperfectly. Keep this derived directory
  // at its final path and create each link atomically. A partial restore can
  // reconstruct missing links, but an unexpected existing entry must refuse.
  // Concurrent root launches publish the same targets and verify the full set.
  for (const [name, target] of links) {
    try { fs.symlinkSync(target, `${destination}/${name}`); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  verify(true);
  fs.chmodSync(destination, 0o555);
  return destination;
}
