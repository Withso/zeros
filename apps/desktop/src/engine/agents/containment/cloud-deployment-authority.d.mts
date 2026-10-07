export function isCloudEngineIdMap(source: unknown): boolean;
export function cloudEngineIdMapVersion(source: unknown): 2|3|null;
export function hasCloudEngineUserNamespace(version?:4): boolean;
export function cloudProfileIdentityMapVersion(version: number): 3|null;
export function isReadOnlyCloudMount(
  candidate: string,
  source: string,
): boolean;
export function isCloudDeploymentOwner(candidate: string, uid: number): boolean;
