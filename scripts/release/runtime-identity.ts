import { RuntimeReleaseSchema, runtimeReleaseIdentity } from "../../apps/control-plane/src/cloud/runtime-release";
import { requireCheck } from "./contracts";
import { RuntimeLiveIdentity, type RuntimePin } from "./runtime-contracts";
import { runtimeJson } from "./runtime-proof";

export function identityPin(raw: any): RuntimePin {
  const parsed = RuntimeLiveIdentity.safeParse(raw);
  requireCheck(parsed.success, "Live runtime release identity is unsupported or unready");
  const worker = raw.worker;
  const release = raw.workerQualified ? RuntimeReleaseSchema.safeParse({ version: 1, sha256: worker.sha256,
    sourceSha: worker.sourceSha, sourceSha256: worker.sourceSha256, qualification: worker.qualification }) : undefined;
  requireCheck(!raw.workerQualified || release?.success, "Live runtime qualification is invalid");
  const pin = { sha256: parsed.data.worker.sha256, release: release?.success ? release.data : null };
  const expected = runtimeReleaseIdentity({ sha256: pin.sha256, ...(pin.release ? { release: pin.release } : {}) });
  requireCheck(runtimeJson({ worker, workerQualified: raw.workerQualified }) === runtimeJson(expected), "Live runtime provenance contradicts its qualification");
  return pin;
}
