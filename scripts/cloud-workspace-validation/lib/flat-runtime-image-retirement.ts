// The flat /opt/zeros-runtime OCI recipe still installs the retired v3 worker
// profile, which the v4-only image metadata step rejects at the end of an
// expensive build. Its publisher and receipt steps refuse before any build,
// registry or receipt work; the v4 runtime bundle is the supported artifact.
export const FLAT_RUNTIME_IMAGE_RETIRED =
  "Flat OCI runtime images are retired; publish the v4 runtime bundle with cloud-runtime-bundle.yml.";

export function refuseRetiredFlatRuntimeImage(): void {
  console.error(FLAT_RUNTIME_IMAGE_RETIRED);
  process.exitCode = 1;
}
