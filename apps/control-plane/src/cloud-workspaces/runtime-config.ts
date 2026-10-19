import { z } from "zod";
import { loadRuntimeBaseRollout, type CloudRuntimeBaseRollout } from "./runtime-base-rollout.js";

const schema = z.object({
  CLOUD_RUNTIME_QUALIFICATION_MODE: z.enum(["full", "smoke"]).default("full"),
  CLOUD_RUNTIME_QUALIFICATION_ENABLED: z.enum(["true", "false"]).default("false"),
  CLOUD_RUNTIME_STAGING_ENABLED: z.enum(["true", "false"]).default("false"),
  CLOUD_RUNTIME_IMAGES_ENABLED: z.enum(["true", "false"]).default("false"),
});

export type CloudRuntimeQualificationMode = "full" | "smoke";
export type CloudRuntimeConfig = {
  qualificationMode: CloudRuntimeQualificationMode;
  qualificationEnabled?: boolean;
  stagingEnabled?: boolean;
  /** Produce runtime images and start new Computer builders from them. */
  imagesEnabled?: boolean;
  /** Explicit new-build default and bounded organization candidate selection. */
  baseRollout?: CloudRuntimeBaseRollout;
};

export function loadCloudRuntimeConfig(env: NodeJS.ProcessEnv = process.env): CloudRuntimeConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid cloud runtime environment: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  const baseRollout = loadRuntimeBaseRollout(env.CLOUD_RUNTIME_BASE_ROLLOUT_JSON);
  return { qualificationMode: parsed.data.CLOUD_RUNTIME_QUALIFICATION_MODE,
    qualificationEnabled: parsed.data.CLOUD_RUNTIME_QUALIFICATION_ENABLED === "true",
    stagingEnabled: parsed.data.CLOUD_RUNTIME_STAGING_ENABLED === "true",
    imagesEnabled: parsed.data.CLOUD_RUNTIME_IMAGES_ENABLED === "true",
    ...(baseRollout ? { baseRollout } : {}) };
}

// Credential discovery, foreground admission, action admission and renewal all
// use the same qualification mode as v2 workspace creation.
export function cloudRuntimeQualificationMode(): CloudRuntimeQualificationMode {
  return loadCloudRuntimeConfig().qualificationMode;
}
