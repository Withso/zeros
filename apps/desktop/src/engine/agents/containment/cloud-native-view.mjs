import { lstatSync, realpathSync } from "node:fs";

export const CLOUD_NATIVE_HOME = "/srv/zeros/home/agent";
const stores = Object.freeze({ claude: ".claude/projects", cursor: ".cursor/zeros-store", codex: ".codex/sessions" });
/** Pinned-CLI state that stays writable inside the immutable `.codex`. Codex
 * 0.154 exits unless it can open installation_id read-write at start, fails
 * thread/start without its writer locks, and replaces its bundled system
 * skills under skills/. None is a configuration source, and each mount is
 * private to one process. bwrap mounts them as root before the drop to the
 * worker, so each is world-writable like /tmp; a default tmpfs is root 0755.
 * Organization skills reach Codex via ~/.agents. */
export const CLOUD_CODEX_STATE_DIRECTORIES = Object.freeze(["tmp", "log", "shell_snapshots", ".tmp", "thread-writer-locks", "skills"]);
/** Provider homes whose skills/ receives the organization's read-only skills.
 * The engine creates each for the worker: bwrap would create a missing parent
 * of a mount point root-owned 0700, hiding the skills from the provider. */
export const CLOUD_NATIVE_SKILL_HOMES = Object.freeze([".agents", ".claude", ".cursor", ".codex"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join("\0") === expected.sort().join("\0");
const quote = value => `'${String(value).replaceAll("'", `'"'"'`)}'`;

/** Only an engine-created home and a single locked conversation may overlay
 * the admitted worker filesystem. Workspace, Design and engine-state mounts
 * continue to come from the original actor policy. */
export function cloudNativeHomeMounts(view) {
  if (!keys(view, ["directory", "history", ...(view?.skills === true ? ["skills"] : []), ...(view?.codexConfig === true ? ["codexConfig"] : [])]) ||
      (view.codexConfig === true && view.history?.provider !== "codex") ||
      typeof view.directory !== "string" || !/^\/run\/zeros\/coordinators\/[a-f0-9]{32}$/.test(view.directory) ||
      !keys(view.history, ["provider", "directory"]) || typeof view.history.provider !== "string" || !Object.hasOwn(stores, view.history.provider) ||
      typeof view.history.directory !== "string" ||
      !new RegExp(`^/srv/zeros/state/native-agent-history/[a-f0-9]{64}/${view.history.provider}$`).test(view.history.directory)) {
    throw new Error("Cloud native provider home is invalid");
  }
  return ["--bind", `${view.directory}/home`, CLOUD_NATIVE_HOME,
    ...(view.codexConfig === true ? [
      "--ro-bind", `${view.directory}/codex-config`, `${CLOUD_NATIVE_HOME}/.codex`,
      "--ro-bind", `${view.directory}/codex-config`, "/etc/codex",
      "--bind", `${view.directory}/codex-installation-id`, `${CLOUD_NATIVE_HOME}/.codex/installation_id`,
      ...CLOUD_CODEX_STATE_DIRECTORIES.flatMap(name => ["--perms", "1777", "--tmpfs", `${CLOUD_NATIVE_HOME}/.codex/${name}`]),
    ] : []),
    "--bind", view.history.directory, `${CLOUD_NATIVE_HOME}/${stores[view.history.provider]}`,
    ...(view.skills === true ? CLOUD_NATIVE_SKILL_HOMES.filter(home => view.codexConfig !== true || home !== ".codex").flatMap(home =>
      ["--ro-bind", `${view.directory}/skills`, `${CLOUD_NATIVE_HOME}/${home}/skills`]) : [])];
}

export function assertOwnedCloudNativeHome(view, worker) {
  cloudNativeHomeMounts(view);
  if (!worker || worker.uid !== 10001 || worker.gid !== 10001)
    throw new Error("Cloud native home requires the admitted worker identity");
  const inspect = (directory, uid) => {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid ||
        (stat.mode & 0o077) !== 0 || realpathSync(directory) !== directory)
      throw new Error("Cloud native home is not privately owned");
  };
  for (const directory of ["/run/zeros/coordinators", view.directory,
    "/srv/zeros/state/native-agent-history", view.history.directory.slice(0, view.history.directory.lastIndexOf("/"))]) inspect(directory, 0);
  inspect(`${view.directory}/home`, worker.uid);
  inspect(view.history.directory, worker.uid);
  if (view.codexConfig === true) {
    const directory = `${view.directory}/codex-config`, stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || realpathSync(directory) !== directory)
      throw new Error("Cloud Codex configuration is not engine-owned");
    // Codex makes it 0644 when it opens it; others must never write it.
    const installation = lstatSync(`${view.directory}/codex-installation-id`);
    if (!installation.isFile() || installation.nlink !== 1 || installation.uid !== worker.uid || (installation.mode & 0o022) !== 0)
      throw new Error("Cloud Codex installation state is not privately owned");
  }
  if (view.skills === true) {
    const directory = `${view.directory}/skills`, stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022) || realpathSync(directory) !== directory)
      throw new Error("Cloud skills are not engine-owned");
  }
}

/** The wrapper adds two fixed mounts before the sandbox's command separator.
 * It preserves SRT's filesystem restrictions, namespace setup, privilege drop,
 * command quoting and process ownership. It never evaluates child arguments. */
export function cloudNativeBwrapWrapper(bwrap, view) {
  const mounts = cloudNativeHomeMounts(view);
  if (typeof bwrap !== "string" || !bwrap.startsWith("/") || /[\0\r\n]/.test(bwrap))
    throw new Error("Cloud native sandbox executable is invalid");
  return `#!/bin/bash\nset -eu\nargs=()\nwhile (( $# )) && [[ "$1" != -- ]]; do\n  args+=("$1")\n  shift\ndone\n[[ "\${1-}" == -- ]] || exit 125\nexec ${quote(bwrap)} "\${args[@]}" ${mounts.map(quote).join(" ")} "$@"\n`;
}
