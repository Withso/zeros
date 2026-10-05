export function localInstanceStateRoot(slug: string, home?: string): string;
export function localInstanceBundlePaths(identity: {
  slug: string;
  name: string;
  home?: string;
}): {
  stateRoot: string;
  bundlePath: string;
  versionMarker: string;
  legacyBundleRoot: string;
};
