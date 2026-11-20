export type DevelopmentLayout = "v2" | "legacy";

export interface DevelopmentPaths {
  instance: string;
  layout: DevelopmentLayout;
  sharedDataDir: string;
  registryPath: string;
  dataDir: string;
  sessionDataDir: string;
  logDir: string;
  stateRoot: string;
  visibleRoot: string;
  workspacesRoot: string;
  designWorkspacesRoot: string;
  bundleDir: string;
  bundleId: string;
}

export interface DevelopmentContainers {
  home: string;
  appData: string;
  cache: string;
  logs: string | null;
  sharedDataDir: string;
  dataInstances: string;
  bundles: string;
  logInstances: string | null;
  stateInstances: string;
  legacyBundles: string;
}

type PlatformInput = {
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
};

export const FAMILY_ID: "com.zeros.local";
export function isCheckoutInstanceId(instance: string): boolean;
export function developmentLayout(
  env?: Record<string, string | undefined>,
): DevelopmentLayout;
export function developmentPaths(
  input: PlatformInput & {
    instance: string;
    layout?: DevelopmentLayout;
  },
): DevelopmentPaths;
export function developmentContainers(
  input?: PlatformInput,
): DevelopmentContainers;
export function localInstanceStateRoot(slug: string, home?: string): string;
export function localInstanceBundlePaths(identity: {
  slug: string;
  name: string;
  home?: string;
  layout?: DevelopmentLayout;
  platform?: NodeJS.Platform;
}): {
  stateRoot: string;
  bundlePath: string;
  versionMarker: string;
  legacyBundleRoot: string;
};
