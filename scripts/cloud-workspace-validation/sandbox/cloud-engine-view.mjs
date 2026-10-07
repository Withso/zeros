import runtimeLayout from "./runtime-layout.json" with { type: "json" };
import { resolveCloudRuntime } from "./cloud-runtime-root.mjs";
import { isCloudComputerRepositoryDirectory } from "./cloud-computer-checkout.mjs";

/** Credential-free alias metadata for engine-owned publication and policy.
 * The launcher supplies only a primary from its validated private admission. */
export function cloudEngineWorkspacePaths(primaryRepository) {
  if (!isCloudComputerRepositoryDirectory(primaryRepository)) throw new Error("Invalid cloud engine repository projection");
  return { schema: "zeros.cloud-workspace-paths/v1", workspaceRoot: "/srv/zeros/workspace",
    repositoryAlias: `/srv/zeros/${primaryRepository.slice("/srv/zeros/files/".length)}` };
}

/** Mount inputs are image-owned constants, never paths or commands from an
 * engine request. The host launcher verifies their physical ownership first.
 * Private broker authority, provider login homes and the host shadow/SSH files
 * have no mount in this view. */
export function cloudEngineViewArguments(operation = "serve",version=2,runtime=resolveCloudRuntime(),viewDirectory,primaryRepository,residentHostId) {
  if (!["serve", "qualify", "qualify-agent", "resident"].includes(operation))
    throw new Error("Invalid cloud engine launch operation");
  if(![2,3,4].includes(version)||(version===4)!==(runtime.profile==="v4"))throw new Error("Invalid cloud engine profile version");
  if(operation==="qualify-agent"&&version<3)throw new Error("Native agent qualification requires v3 or v4");
  if(operation==="resident"&&version!==4)throw new Error("Resident workloads require v4");
  if (residentHostId !== undefined && (version !== 4 || !["serve", "resident"].includes(operation) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(residentHostId)))
    throw new Error("Invalid resident service projection");
  if(version===4&&(!/^\/run\/zeros\/view\/runtime-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(viewDirectory??"")))
    throw new Error("Invalid cloud engine runtime projection");
  if (primaryRepository !== undefined && (version !== 4 || !isCloudComputerRepositoryDirectory(primaryRepository)))
    throw new Error("Invalid cloud engine repository projection");
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
    ...(residentHostId ? ["--bind", `/run/zeros/resident-workloads/${residentHostId}`, "/tmp/zeros-resident"] : []),
    "--ro-bind",
    "/sys/fs/cgroup",
    "/sys/fs/cgroup",
    ...(version === 4 ? [
      // The resident remains pinned, but future shells need the selected
      // immutable runtime's binaries. No mutable facade/host authority is
      // exposed by this root-owned, read-only installation parent.
      ...(operation === "resident" ? ["--ro-bind", "/opt/zeros-infra", "/opt/zeros-infra"] : ["--ro-bind", runtime.root, runtime.root]),
      "--ro-bind", `${viewDirectory}/facade`, "/opt/zeros",
      "--symlink", "/opt/zeros", "/zeros",
      "--ro-bind", `${viewDirectory}/etc`, "/etc/zeros",
    ] : [
      "--ro-bind", runtime.workerRoot, runtime.workerRoot,
      "--ro-bind", runtime.root, runtime.root,
      "--ro-bind", "/etc/zeros", "/etc/zeros",
    ]),
    "--ro-bind",
    "/etc/containers/policy.json",
    "/etc/containers/policy.json",
    "--ro-bind",
    "/etc/containers/registries.conf",
    "/etc/containers/registries.conf",
    "--bind",
    // One mount permits atomic attachment publication from an engine-private
    // sibling. The checked v4 repos/<owner>/<name> subtree is also writable at
    // /srv/zeros/repos; Files and managed Git still use only the primary root.
    // Broker authority remains outside this projection.
    runtimeLayout.engineFilesRoot,
    "/srv/zeros",
    // v4 setup must stage within the files bind to avoid EXDEV and retain
    // Boat persistence. Its private seed/home are never engine-visible.
    ...(version === 4 ? ["--tmpfs", "/srv/zeros/.zeros-setup", "--chmod", "0000", "/srv/zeros/.zeros-setup",
      "--remount-ro", "/srv/zeros/.zeros-setup"] : []),
    // The source is the admitted host clone. No mount is installed beneath
    // the host's files bind; this alias belongs only to this engine namespace.
    ...(primaryRepository ? ["--bind", primaryRepository, "/srv/zeros/workspace"] : []),
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
    ...(version === 4 ? ["--ro-bind", `${viewDirectory}/active-runtime.json`, "/run/zeros/active-runtime.json"] : []),
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
  // Empty mount point for the native provider view's Codex system
  // configuration. That view's root is this read-only one, so it cannot
  // create the directory itself.
  args.push("--dir", "/etc/codex");
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
    // Nested UID-0 maps require SETFCAP on Linux >=5.12. The native
    // transition retains it only for namespace root mapped to host UID 10003;
    // inherited NoNewPrivs prevents file capabilities adding privilege on exec.
    "CAP_SETFCAP",
  ])
    args.push("--cap-add", capability);
  for (const directory of [
    "/opt",
    ...(version === 4 ? ["/opt/zeros-infra"] : []),
    "/srv",
    "/srv/zeros",
    "/srv/zeros/home",
    "/run",
    "/etc",
    "/etc/codex",
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
    operation === "qualify-agent" ? runtime.workerRoot : "/srv/zeros/workspace",
    "--",
    runtime.engineNamespace,
  );
  if(version===3)args.push("--v3");
  if(version===4)args.push("--runtime-id",runtime.runtimeId);
  if (operation === "qualify") args.push("--qualify");
  if (operation === "qualify-agent") args.push("--qualify-agent");
  if (operation === "resident") args.push("--resident");
  return args;
}

/** Secrets remain in the child's environment, never bwrap argv or process
 * listings. Every authority-bearing variable is selected explicitly from the
 * existing supervisor contract; ambient provider/loader variables are absent. */
export function cloudEngineViewEnvironment(source, operation = "serve", runtime=resolveCloudRuntime()) {
  if (!["serve", "qualify", "qualify-agent", "resident"].includes(operation) ||
    operation === "resident" && runtime.profile !== "v4")
    throw new Error("Invalid cloud engine launch operation");
  const environment = {
    PATH: `${runtime.binRoot}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: "/srv/zeros/home/agent",
    USER: "zeros-agent",
    LOGNAME: "zeros-agent",
    LANG: "C.UTF-8",
    SHELL: "/bin/bash",
    ZEROS_DATA_DIR: "/srv/zeros/state",
    ZEROS_WORKSPACES_DIR: "/srv/zeros/state/workspaces",
    ZEROS_USER_SETTINGS_DIR: "/srv/zeros/managed-settings",
    ZEROS_REPO_DIR: "/srv/zeros/workspace",
    ZEROS_ATTACHMENT_TEMP_DIR: "/srv/zeros/attachment-staging",
    ZEROS_PTY_HOST_RUNTIME: runtime.node,
    ZEROS_PTY_HOST_SCRIPT:
      `${runtime.workerRoot}/apps/desktop/src/engine/pty/pty-host.cjs`,
    ZEROS_CURSOR_HOST_SCRIPT:
      `${runtime.workerRoot}/apps/desktop/src/engine/agents/adapters/cursor-sdk/host/cursor-host.cjs`,
    ZEROS_ZSR_SUPERVISOR_RUNTIME: runtime.node,
    ZEROS_ZSR_SUPERVISOR_SCRIPT:
      `${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs`,
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
      "ZEROS_RESIDENT_PTY_B64",
    ])
      if (typeof source[name] === "string") environment[name] = source[name];
  }
  return environment;
}
