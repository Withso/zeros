import { requireCheck } from "./contracts";

export type WorkerQualificationProfile = "smoke" | "full";
export { RELEASE_CANARY_SMOKE_MODELS as SMOKE_MODELS } from "../../apps/control-plane/src/cloud-workspaces/release-canary-contract";

export function workerQualificationProfile(files: string[], requested = "auto"): WorkerQualificationProfile {
  requireCheck(["auto", "smoke", "full"].includes(requested), "Invalid worker canary profile");
  const nativeInputs = /^(?:apps\/desktop\/src\/engine\/agents\/|apps\/desktop\/src\/engine\/cloud-runtime-attestation\.ts$|packages\/protocol\/src\/cloud-(?:agent|mcp)|scripts\/cloud-workspace-validation\/(?:config\.ts$|sandbox\/|lib\/native-)|scripts\/zsr-qualification\/|scripts\/(?:build-zsr-supervisor|codegen-codex(?:-lib)?)\.|third_party\/|patches\/|catalogs\/|(?:package\.json|pnpm-lock\.yaml)$)/;
  return requested === "full" || files.some(file => nativeInputs.test(file)) ? "full" : "smoke";
}
