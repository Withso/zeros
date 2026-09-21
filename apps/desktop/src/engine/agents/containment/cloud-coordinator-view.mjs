import path from "node:path";

export const CLOUD_COORDINATOR_UID = 10004;
export const CLOUD_COORDINATOR_HOME = "/home/zeros-agent";
export const CLOUD_COORDINATOR_CWD = "/srv/zeros/workspace";
const PRIVATE_ROOT = "/run/zeros/coordinators";

/** Only an engine-created, one-execution directory can enter this view. The
 * model never chooses a mount, uid, executable override or control endpoint. */
export function cloudCoordinatorArguments(directory, command, args = [], history) {
  if (typeof directory !== "string" || path.dirname(directory) !== PRIVATE_ROOT ||
    !/^[a-f0-9]{32}$/.test(path.basename(directory))) throw new Error("Invalid private coordinator directory");
  if (typeof command !== "string" || !path.isAbsolute(command) || command.includes("\0") ||
    path.resolve(command) !== command ||
    !(command.startsWith("/opt/zeros/") || command.startsWith("/opt/zeros-runtime/") || command.startsWith("/usr/")) ||
    !Array.isArray(args) || args.some(arg => typeof arg !== "string" || arg.includes("\0")))
    throw new Error("Invalid private coordinator command");
  const output = ["--die-with-parent", "--new-session", "--unshare-ipc", "--unshare-uts", "--unshare-pid"];
  // The engine deliberately uses umask 077. Synthetic mount ancestors must
  // still be traversable after dropping UID; no private host parent is bound.
  for(const directory of ["/opt","/etc","/home","/srv","/srv/zeros"])
    output.push("--perms","0755","--dir",directory);
  output.push("--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/sbin", "/sbin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    "--ro-bind", "/opt/zeros", "/opt/zeros", "--ro-bind", "/opt/zeros-runtime", "/opt/zeros-runtime",
    "--dev", "/dev", "--proc", "/proc",
    "--perms", "1777", "--size", "67108864", "--tmpfs", "/tmp",
    "--perms", "1777", "--size", "67108864", "--tmpfs", "/dev/shm",
    "--bind", `${directory}/home`, CLOUD_COORDINATOR_HOME,
    "--bind", `${directory}/scratch`, CLOUD_COORDINATOR_CWD);
  if(history){
    const destinations={claude:".claude/projects",cursor:".cursor/zeros-store",codex:".codex/sessions"};
    if(!Object.hasOwn(destinations,history.provider)||typeof history.directory!=="string"||
      !new RegExp(`^/srv/zeros/state/native-agent-history/[a-f0-9]{64}/${history.provider}$`).test(history.directory))
      throw new Error("Invalid private coordinator history");
    output.push("--bind",history.directory,`${CLOUD_COORDINATOR_HOME}/${destinations[history.provider]}`);
  }
  for (const name of ["passwd", "group", "nsswitch.conf", "hosts", "resolv.conf", "ssl", "ld.so.cache", "alternatives"])
    output.push("--ro-bind", `/etc/${name}`, `/etc/${name}`);
  output.push("--cap-drop", "ALL", "--cap-add", "CAP_SETUID", "--cap-add", "CAP_SETGID", "--cap-add", "CAP_SETPCAP",
    "--chdir", "/", "--remount-ro", "/", "--", "/usr/bin/setpriv",
    `--reuid=${CLOUD_COORDINATOR_UID}`, `--regid=${CLOUD_COORDINATOR_UID}`, "--clear-groups",
    "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--no-new-privs",
    "--securebits=+noroot,+noroot_locked,+no_setuid_fixup,+no_setuid_fixup_locked", "--",
    "/usr/bin/env", `--chdir=${CLOUD_COORDINATOR_CWD}`, "--", command, ...args);
  return output;
}

/** Complete allowlisted environment; neither caller env nor the engine's HOME,
 * keys, proxy routing, loader knobs or control-plane authority are inherited. */
export function cloudCoordinatorEnvironment(material, model, settings = {}) {
  if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model))
    throw new Error("Invalid private coordinator model");
  const env = {
    PATH: "/opt/zeros-runtime/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: CLOUD_COORDINATOR_HOME, USER: "zeros-coordinator", LOGNAME: "zeros-coordinator",
    LANG: "C.UTF-8", SHELL: "/bin/bash", TMPDIR: "/tmp",
    XDG_CONFIG_HOME: `${CLOUD_COORDINATOR_HOME}/.config`,
    XDG_CACHE_HOME: `${CLOUD_COORDINATOR_HOME}/.cache`,
    XDG_DATA_HOME: `${CLOUD_COORDINATOR_HOME}/.local/share`,
    ZEROS_REQUIRE_EXACT_MODEL: "1",
  };
  if(["low","medium","high","xhigh"].includes(settings.ZEROS_THINKING_EFFORT))env.ZEROS_THINKING_EFFORT=settings.ZEROS_THINKING_EFFORT;
  if(settings.ZEROS_FAST_MODE==="1"||settings.ZEROS_FAST_MODE==="0")env.ZEROS_FAST_MODE=settings.ZEROS_FAST_MODE;
  switch (material.kind) {
    case "claude-api-key": env.ANTHROPIC_API_KEY = material.apiKey; break;
    case "claude-setup-token": env.CLAUDE_CODE_OAUTH_TOKEN = material.accessToken; break;
    case "cursor-api-key": env.CURSOR_API_KEY = material.apiKey; break;
    case "codex-api-key": env.OPENAI_API_KEY = material.apiKey; break;
    case "codex-chatgpt": break; // External app-server login; never synthesize managed auth.json.
    default: throw new Error("Invalid private coordinator credential");
  }
  if (material.kind.startsWith("claude-")) {
    env.ANTHROPIC_MODEL = model; env.CLAUDE_CONFIG_DIR = `${CLOUD_COORDINATOR_HOME}/.claude`;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  } else if (material.kind.startsWith("cursor-")) {
    env.CURSOR_MODEL = model;
    env.ZEROS_CURSOR_STATE_ROOT = `${CLOUD_COORDINATOR_HOME}/.cursor/zeros-store`;
  }
  else { env.OPENAI_MODEL = model; env.CODEX_HOME = `${CLOUD_COORDINATOR_HOME}/.codex`; }
  return env;
}
