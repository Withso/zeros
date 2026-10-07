// Plain-Node entry points share the CP retirement contract without loading
// backend code or preparing provider authority.
export const NATIVE_AGENT_CANARY_RETIREMENT = Object.freeze({
  status: 409,
  code: "release_worker_images_retired",
  message: "v3 release worker images are retired; v4 runtime bundles are the supported artifact",
});

export function refuseRetiredDevNativeCanary() {
  throw Object.assign(new Error(NATIVE_AGENT_CANARY_RETIREMENT.message), NATIVE_AGENT_CANARY_RETIREMENT);
}
