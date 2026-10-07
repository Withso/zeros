import { RELEASE_WORKER_IMAGES_RETIRED } from "../../apps/control-plane/src/cloud-workspaces/release-worker-retirement";
import { PromotionError } from "./contracts";

export function refuseRetiredWorkerPromotion(): never {
  throw Object.assign(new PromotionError(RELEASE_WORKER_IMAGES_RETIRED), { code: "release_worker_images_retired" });
}
