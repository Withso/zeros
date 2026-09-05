/**
 * Desktop release/build capability for cloud-workspace client surfaces.
 *
 * This is deliberately distinct from the control plane's
 * CLOUD_WORKSPACES_ENABLED rollout switch. Packaged artifacts bake this value
 * at compile time; an inherited or user-supplied child-process environment
 * cannot override that release decision. Source/dev entrypoints without a
 * compiled value may opt in with the same exact-true environment contract.
 */
export const CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV =
  "ZEROS_CLOUD_WORKSPACES_ENABLED" as const;

declare const __ZEROS_CLOUD_WORKSPACES_ENABLED_BAKED__: boolean | undefined;

type CapabilityEnvironment = Record<string, string | undefined>;

type CloudWorkspaceDesktopCapabilityOptions = {
  environment?: CapabilityEnvironment;
  /** Test/build injection. Omit to consume the compile-time replacement. */
  bakedCapability?: boolean;
};

function compiledCapability(): boolean | undefined {
  return typeof __ZEROS_CLOUD_WORKSPACES_ENABLED_BAKED__ === "boolean"
    ? __ZEROS_CLOUD_WORKSPACES_ENABLED_BAKED__
    : undefined;
}

export function cloudWorkspaceDesktopCapabilityEnabled(
  options: CloudWorkspaceDesktopCapabilityOptions = {},
): boolean {
  const baked = options.bakedCapability ?? compiledCapability();
  if (typeof baked === "boolean") return baked;
  const environment = options.environment ?? process.env;
  return environment[CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV] === "true";
}

/** Pin the value inherited by a spawned local engine to the release decision. */
export function seedCloudWorkspaceDesktopCapabilityEnvironment(
  options: CloudWorkspaceDesktopCapabilityOptions = {},
): boolean {
  const environment = options.environment ?? process.env;
  const enabled = cloudWorkspaceDesktopCapabilityEnabled({
    ...options,
    environment,
  });
  environment[CLOUD_WORKSPACES_DESKTOP_CAPABILITY_ENV] = enabled
    ? "true"
    : "false";
  return enabled;
}

/** Construct the paired desktop runtimes as one gated capability boundary. */
export function createCloudWorkspaceDesktopPipelines<Replica, Fork>(options: {
  cloudWorker: boolean;
  capabilityEnabled?: () => boolean;
  createReplica: () => Replica;
  createFork: (replica: Replica) => Fork;
}): { replica: Replica | null; fork: Fork | null } {
  const enabled =
    options.capabilityEnabled ?? cloudWorkspaceDesktopCapabilityEnabled;
  if (options.cloudWorker || !enabled()) {
    return { replica: null, fork: null };
  }
  const replica = options.createReplica();
  return { replica, fork: options.createFork(replica) };
}
