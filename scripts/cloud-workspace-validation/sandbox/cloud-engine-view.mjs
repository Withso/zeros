/** Mount inputs are image-owned constants, never paths or commands from an
 * engine request. The host launcher verifies their physical ownership first.
 * Private broker authority, provider login homes and the host shadow/SSH files
 * have no mount in this view. */
export function cloudEngineViewArguments(operation = "serve",version=2) {
  if (!["serve", "qualify"].includes(operation))
    throw new Error("Invalid cloud engine launch operation");
  if(version!==2&&version!==3)throw new Error("Invalid cloud engine profile version");
  const args = [
    "--die-with-parent",
    "--unshare-ipc",
    "--unshare-uts",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--symlink",
    "usr/lib64",
    "/lib64",
    // Keep procfs fully visible: a locked child mask makes the kernel reject
    // fresh proc mounts in private container PID namespaces. VM root is not
    // mapped into the engine; global controls retain host ownership and the
    // kernel denies writes even to namespace root. Qualification verifies
    // those denials as well as host-process and user-namespace isolation.
    "--bind",
    "/proc",
    "/proc",
    "--dev",
    "/dev",
    "--size",
    "536870912",
    "--tmpfs",
    "/dev/shm",
    "--chmod",
    "1777",
    "/dev/shm",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    "/sys/fs/cgroup",
    "/sys/fs/cgroup",
    "--ro-bind",
    "/opt/zeros",
    "/opt/zeros",
    "--ro-bind",
    "/opt/zeros-runtime",
    "/opt/zeros-runtime",
    "--ro-bind",
    "/etc/zeros",
    "/etc/zeros",
    "--ro-bind",
    "/etc/containers/policy.json",
    "/etc/containers/policy.json",
    "--ro-bind",
    "/etc/containers/registries.conf",
    "/etc/containers/registries.conf",
    "--bind",
    "/srv/zeros/workspace",
    "/srv/zeros/workspace",
    "--bind",
    "/srv/zeros/state",
    "/srv/zeros/state",
    "--bind",
    "/srv/zeros/home/agent",
    "/srv/zeros/home/agent",
    "--bind",
    "/srv/zeros/home/capture",
    "/srv/zeros/home/capture",
    "--bind",
    "/run/zeros/engine",
    "/run/zeros",
    "--ro-bind",
    "/run/zeros/view/settings",
    "/srv/zeros/managed-settings",
  ];
  for (const name of [
    "passwd",
    "group",
    "nsswitch.conf",
    "hosts",
    "resolv.conf",
    "ssl",
    "ld.so.cache",
    "alternatives",
  ])
    args.push("--ro-bind", `/etc/${name}`, `/etc/${name}`);
  args.push("--cap-drop", "ALL");
  for (const capability of [
    "CAP_SETUID",
    "CAP_SETGID",
    "CAP_SETPCAP",
    "CAP_KILL",
    "CAP_SYS_ADMIN",
    "CAP_SYS_CHROOT",
    "CAP_DAC_OVERRIDE",
    "CAP_CHOWN",
    "CAP_FOWNER",
  ])
    args.push("--cap-add", capability);
  for (const directory of [
    "/opt",
    "/srv",
    "/srv/zeros",
    "/srv/zeros/home",
    "/run",
    "/etc",
    "/etc/containers",
    "/sys",
    "/sys/fs",
  ])
    args.push("--chmod", "0755", directory);
  args.push(
    "--chmod",
    "1777",
    "/tmp",
    "--remount-ro",
    "/",
    "--chdir",
    "/srv/zeros/workspace",
    "--",
    "/opt/zeros-runtime/cloud-engine-namespace",
  );
  if(version===3)args.push("--v3");
  if (operation === "qualify") args.push("--qualify");
  return args;
}

/** Secrets remain in the child's environment, never bwrap argv or process
 * listings. Every authority-bearing variable is selected explicitly from the
 * existing supervisor contract; ambient provider/loader variables are absent. */
export function cloudEngineViewEnvironment(source, operation = "serve") {
  if (!["serve", "qualify"].includes(operation))
    throw new Error("Invalid cloud engine launch operation");
  const environment = {
    PATH: "/opt/zeros-runtime/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: "/srv/zeros/home/agent",
    USER: "zeros-agent",
    LOGNAME: "zeros-agent",
    LANG: "C.UTF-8",
    SHELL: "/bin/bash",
    ZEROS_DATA_DIR: "/srv/zeros/state",
    ZEROS_WORKSPACES_DIR: "/srv/zeros/state/workspaces",
    ZEROS_USER_SETTINGS_DIR: "/srv/zeros/managed-settings",
    ZEROS_REPO_DIR: "/srv/zeros/workspace",
    ZEROS_PTY_HOST_RUNTIME: "/opt/zeros-runtime/bin/node",
    ZEROS_PTY_HOST_SCRIPT:
      "/opt/zeros/apps/desktop/src/engine/pty/pty-host.cjs",
    ZEROS_CURSOR_HOST_SCRIPT:
      "/opt/zeros/apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs",
    ZEROS_ZSR_SUPERVISOR_RUNTIME: "/opt/zeros-runtime/bin/node",
    ZEROS_ZSR_SUPERVISOR_SCRIPT:
      "/opt/zeros/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs",
    ZEROS_ZSR_BWRAP_PATH: "/usr/bin/bwrap",
    ZEROS_ZSR_SETPRIV_PATH: "/usr/bin/setpriv",
  };
  if (operation === "serve") {
    for (const name of [
      "ZEROS_ACCOUNT_JWT_AUD",
      "ZEROS_ACCOUNT_JWT_CLIENT_ID",
      "ZEROS_ACCOUNT_JWT_CONTRACT",
      "ZEROS_ACCOUNT_JWT_ISS",
      "ZEROS_ACCOUNT_JWT_JWKS_URL",
      "ZEROS_CLOUD_OWNER_SUB",
      "ZEROS_CLOUD_PORT",
      "ZEROS_CLOUD_RUNTIME_B64",
      "ZEROS_CLOUD_SETUP_BOOT",
      "ZEROS_CLOUD_TOKEN",
      "ZEROS_REQUIRE_ACCOUNT",
      "ZEROS_REQUIRE_EXACT_MODEL",
    ])
      if (typeof source[name] === "string") environment[name] = source[name];
  }
  return environment;
}
