import { CloudCommandFailureError, cloudCommandFailureCode, decodeCloudCommandFailure,
  type CloudCommandFailureCause } from "@zeros/protocol/cloud-commands";

/** Only closed diagnoses cross a cloud boundary. Rebuild typed inner errors
 * so their message/cause cannot retain provider prose or credential material. */
export function cloudCodexFailure(error: unknown, fallback: CloudCommandFailureCause): CloudCommandFailureError {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const inner = decodeCloudCommandFailure(code);
  if (inner) return new CloudCommandFailureError(inner);
  const native = decodeCloudCommandFailure(cloudCommandFailureCode(error, fallback.stage));
  return new CloudCommandFailureError(native && native.category !== "rejected" ? native : fallback);
}
