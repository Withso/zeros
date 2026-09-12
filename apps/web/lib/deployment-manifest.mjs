export const DEPLOYMENT_MANIFEST_PATH = "/zeros-deployment.json";

/** Build the public, non-secret proof of the exact Pages source revision. */
export function createDeploymentManifest(commitSha, surface) {
  const normalizedSha = String(commitSha || "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(normalizedSha)) {
    throw new TypeError(
      "deployment manifest requires a 40-character Git commit SHA",
    );
  }
  if (surface !== "app" && surface !== "ops") {
    throw new TypeError("deployment manifest surface must be app or ops");
  }
  return {
    version: 1,
    commitSha: normalizedSha,
    surface,
  };
}
