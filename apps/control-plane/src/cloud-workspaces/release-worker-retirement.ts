import { HttpError } from "../authz.js";

export const RELEASE_WORKER_IMAGES_RETIRED =
  "v3 release worker images are retired; v4 runtime bundles are the supported artifact";

/** Historical cleanup and receipt parsing remain available. This refusal must
 * precede credential preparation and provider access for a new v3 canary. */
export function refuseRetiredReleaseWorker(): never {
  throw new HttpError(409, "release_worker_images_retired", RELEASE_WORKER_IMAGES_RETIRED);
}
