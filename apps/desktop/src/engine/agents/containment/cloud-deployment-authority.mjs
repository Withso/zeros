// Kept as the existing import boundary. The copied VM resolver must use the
// same namespace/ownership evidence without a second helper implementation.
export {
  cloudEngineIdMapVersion,
  cloudProfileIdentityMapVersion,
  isCloudEngineIdMap,
  hasCloudEngineUserNamespace,
  isCloudEngineSecurityStatus,
  isReadOnlyCloudMount,
  isCloudDeploymentOwner,
} from "./cloud-runtime-root.mjs";
