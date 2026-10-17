/**
 * Cloud-only engine entry to the shared S1 capability verifier. The engine
 * verifies with the exact source the control plane's `api` and `realtime`
 * use (bundled at build time, no runtime dependency on the control-plane
 * package). Only cloud-mode modules import this file; a Local Personal or
 * organization-local engine never constructs a verifier.
 */
export {
  CAPABILITY_KEY_REFRESH_INTERVAL_MS,
  CAPABILITY_MAX_KEYS,
  CAPABILITY_OUTAGE_DETECT_MS,
  CAPABILITY_OUTAGE_GRACE_MS,
  CAPABILITY_RECOVERY_RENEWAL_MS,
  CAPABILITY_REVOCATION_RETENTION_MS,
  CapabilityKeySetError,
  CapabilityOutageMonitor,
  CapabilityVerifier,
  capabilityEpochEntries,
  capabilityEpochSubject,
  capabilityProofMessage,
  type CapabilityPin,
  type CapabilityProof,
  type CapabilityPublicJwk,
  type CapabilityRoute,
  type CapabilitySessionClosure,
  type CapabilityVerifierOptions,
  type CapabilityVerifyContext,
  type CapabilityVerifyFailure,
  type CapabilityVerifyResult,
  type CapabilityVerifySuccess,
} from "../../../control-plane/src/cloud-workspaces/capability-verifier.js";
