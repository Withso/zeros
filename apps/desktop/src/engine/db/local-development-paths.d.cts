export type DevelopmentLayout = "v2" | "legacy";

export interface DevelopmentPaths {
  instance: string;
  layout: DevelopmentLayout;
  sharedDataDir: string;
  registryPath: string;
  dataDir: string;
  cacheDir: string;
  sessionDataDir: string;
  logDir: string;
  stateRoot: string;
  visibleRoot: string;
  workspacesRoot: string;
  designWorkspacesRoot: string;
  bundleDir: string;
  bundleId: string;
  preferencesFile: string | null;
  httpStorageDir: string | null;
  webKitDir: string | null;
  savedStateDir: string | null;
}

export interface DevelopmentContainers {
  home: string;
  appData: string;
  cache: string;
  logs: string | null;
  preferences: string | null;
  httpStorages: string | null;
  webKit: string | null;
  savedState: string | null;
  sharedDataDir: string;
  dataInstances: string;
  cacheInstances: string;
  bundles: string;
  logInstances: string | null;
  stateInstances: string;
  visibleInstances: string;
  legacyBundles: string;
}

type PlatformInput = {
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
};

export const FAMILY_ID: "com.zeros.local";
export const SESSION_MOVED_MARKER: ".zeros-session-relocated";
export function effectiveSessionDataDir(roots: DevelopmentPaths): string;
export const RESERVED_INSTANCE_IDS: readonly ["alpha", "default"];
export function sanitizeInstanceId(raw: unknown): string;
export function developmentInstanceId(
  env?: Record<string, string | undefined>,
): string;
export function isReservedInstanceId(instance: string): boolean;
export function developmentLayout(
  instance: string,
  env?: Record<string, string | undefined>,
): DevelopmentLayout;
export function developmentPaths(
  input: PlatformInput & {
    instance: string;
    layout?: DevelopmentLayout;
    cacheRoot?: string;
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
  home: string;
  stateRoot: string;
  bundleDir: string;
  bundlePath: string;
  versionMarker: string;
  legacyBundleRoot: string;
};
