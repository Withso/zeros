import type { CloudWorkloadKernelIO } from "./cloud-workload-cgroup.mjs";

/** Decode the bounded internal courier and synchronously enter the original
 * shared workload before target restoration/exec. Throws a closed preparation
 * refusal. Explicit fake IO is a portable test seam, never native proof. */
export function enterCloudHostWorkload(encoded: unknown, io?: CloudWorkloadKernelIO): void;
