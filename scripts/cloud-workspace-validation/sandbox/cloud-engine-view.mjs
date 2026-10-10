import runtimeLayout from "./runtime-layout.json" with { type: "json" };
import { resolveCloudRuntime } from "./cloud-runtime-root.mjs";
import { isCloudComputerRepositoryDirectory } from "./cloud-computer-checkout.mjs";
import { CLOUD_ENGINE_MUTABLE_LAYOUT } from "./prepare-cloud-image-files.mjs";

/** Credential-free alias metadata for engine-owned publication and policy.
 * The launcher supplies only a primary from its validated private admission. */
export function cloudEngineWorkspacePaths(primaryRepository) {
  if (!isCloudComputerRepositoryDirectory(primaryRepository)) throw new Error("Invalid cloud engine repository projection");
  return { schema: "zeros.cloud-workspace-paths/v1", workspaceRoot: "/srv/zeros/workspace",
    repositoryAlias: `/srv/zeros/${primaryRepository.slice("/srv/zeros/files/".length)}` };
}

/** Current runtime projection; the immutable base marker remains a legacy reader. */
export function cloudEngineWorkerProjection(runtime) {
  if (runtime?.profile !== "v4") throw new Error("Invalid cloud engine profile version");
  return { version: 4, backend: "cloud-worker", profile: "zeros-cloud-worker-v4", uid: 10003, gid: 10003,
    toolchain: { node: runtime.node,
      supervisor: `${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/host-process-supervisor.mjs` } };
}

/** Mount inputs are image-owned constants, never paths or commands from an
 * engine request. The host launcher verifies their physical ownership first.
 * Private broker authority, provider login homes and the host shadow/SSH files
 * have no mount in this view. */
export function cloudEngineViewArguments(operation = "serve",version=4,runtime=resolveCloudRuntime(),viewDirectory,primaryRepository,residentHostId,placement) {
  if (!["serve", "qualify", "resident", "probe-cursor"].includes(operation))
    throw new Error("Invalid cloud engine launch operation");
  if(version!==4 || runtime.profile!=="v4")throw new Error("Invalid cloud engine profile version");
  if (residentHostId !== undefined && (!["serve", "resident"].includes(operation) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(residentHostId)))
    throw new Error("Invalid resident service projection");
  if((!/^\/run\/zeros\/view\/runtime-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(viewDirectory??"")))
    throw new Error("Invalid cloud engine runtime projection");
  if (primaryRepository !== undefined && !isCloudComputerRepositoryDirectory(primaryRepository))
    throw new Error("Invalid cloud engine repository projection");
  let common;
  if (placement !== undefined) {
    const expected = `${runtime.cgroupRoot}/engine-runtime/`;
    const suffix = typeof placement === "string" && placement.startsWith(expected) ? placement.slice(expected.length) : "";
    if (!/^(?:engine-|engine-workload-)[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}@(0|[1-9][0-9]{0,19}):[1-9][0-9]{0,19}$/.test(suffix))
      throw new Error("Invalid original cloud engine placement");
    common = `${runtime.cgroupRoot}/engine-runtime`;
  }
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
    // kernel denies writes; the engine also drops every capability before exec. Qualification verifies
    // those denials without claiming per-agent isolation.
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
    // All other cgroups, including /host and its ancestor, remain read-only.
    // Only this same-user tree exposes migration controls; limits stay root-owned.
    ...(common ? ["--bind", common, common] : []),
    ...[
      // The resident remains pinned, but future shells need the selected
      // immutable runtime's binaries. No mutable facade/host authority is
      // exposed by this root-owned, read-only installation parent.
      ...(operation === "resident" ? ["--ro-bind", "/opt/zeros-infra", "/opt/zeros-infra"] : ["--ro-bind", runtime.root, runtime.root]),
      "--ro-bind", `${viewDirectory}/facade`, "/opt/zeros",
      "--symlink", "/opt/zeros", "/zeros",
      "--ro-bind", `${viewDirectory}/etc`, "/etc/zeros",
    ],
    "--bind",
    // One mount permits atomic attachment publication from an engine-private
    // sibling. The checked v4 repos/<owner>/<name> subtree is also writable at
    // /srv/zeros/repos; Files and managed Git still use only the primary root.
    // Broker authority remains outside this projection.
    runtimeLayout.engineFilesRoot,
    "/srv/zeros",
    // v4 setup must stage within the files bind to avoid EXDEV and retain
    // Boat persistence. Its private seed/home are never engine-visible.
    ...[".zeros-setup", ".zeros-engine-setup"].flatMap(name => [
      "--tmpfs", `/srv/zeros/${name}`, "--chmod", "0000", `/srv/zeros/${name}`,
      "--remount-ro", `/srv/zeros/${name}`,
    ]),
    // The source is the admitted host clone. No mount is installed beneath
    // the host's files bind; this alias belongs only to this engine namespace.
    ...(primaryRepository ? ["--bind", primaryRepository, "/srv/zeros/workspace"] : []),
    "--bind",
    "/srv/zeros/state",
    "/srv/zeros/state",
    "--bind",
    CLOUD_ENGINE_MUTABLE_LAYOUT.agentHome,
    "/srv/zeros/home/agent",
    "--bind",
    CLOUD_ENGINE_MUTABLE_LAYOUT.captureHome,
    "/srv/zeros/home/capture",
    "--bind",
    "/run/zeros/engine",
    "/run/zeros",
    ...(common ? [
      "--bind", "/run/zeros/workload-custody", "/run/zeros/workload-custody",
      // The pinned root publisher fills this one file before the C transition
      // remounts it read-only and removes every root control alias.
      "--bind", `${viewDirectory}/etc/cloud-workload-custody.json`, "/etc/zeros/cloud-workload-custody.json",
    ] : []),
    "--ro-bind", `${viewDirectory}/active-runtime.json`, "/run/zeros/active-runtime.json",
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
  // Retain the empty Codex mount point for old runtime compatibility.
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
    // These capabilities exist only during the trusted namespace construction.
    // The fixed C transition drops the entire bounding set before engine exec.
    "CAP_SETFCAP",
  ])
    args.push("--cap-add", capability);
  for (const directory of [
    "/opt",
    "/opt/zeros-infra",
    "/srv",
    "/srv/zeros",
    "/srv/zeros/home",
    "/run",
    "/etc",
    "/etc/codex",
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
    runtime.engineNamespace,
  );
  args.push("--runtime-id",runtime.runtimeId);
  if (placement !== undefined) args.push("--engine-scope", placement);
  if (operation === "qualify") args.push("--qualify");
  if (operation === "resident") args.push("--resident");
  if (operation === "probe-cursor") args.push("--probe-cursor");
  return args;
}

/** Secrets remain in the child's environment, never bwrap argv or process
 * listings. Every authority-bearing variable is selected explicitly from the
 * existing supervisor contract; ambient provider/loader variables are absent. */
export function cloudEngineViewEnvironment(source, operation = "serve", runtime=resolveCloudRuntime()) {
  if (!["serve", "qualify", "resident", "probe-cursor"].includes(operation) || runtime.profile !== "v4")
    throw new Error("Invalid cloud engine launch operation");
  const environment = {
    PATH: `${runtime.binRoot}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: "/srv/zeros/home/agent",
    USER: "zeros-engine",
    LOGNAME: "zeros-engine",
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
    ZEROS_RIPGREP_PATH: `${runtime.workerRoot}/binaries/rg`,
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
