import { z } from "zod";

const schema = z.object({
  CLOUD_RUNTIME_QUALIFICATION_MODE: z.enum(["full", "smoke"]).default("full"),
  CLOUD_RUNTIME_QUALIFICATION_ENABLED: z.enum(["true", "false"]).default("false"),
  CLOUD_RUNTIME_STAGING_ENABLED: z.enum(["true", "false"]).default("false"),
});

export type CloudRuntimeQualificationMode = "full" | "smoke";
export type CloudRuntimeConfig = {
  qualificationMode: CloudRuntimeQualificationMode;
  qualificationEnabled?: boolean;
  stagingEnabled?: boolean;
};

export function loadCloudRuntimeConfig(env: NodeJS.ProcessEnv = process.env): CloudRuntimeConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) throw new Error(`Invalid cloud runtime environment: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
  return { qualificationMode: parsed.data.CLOUD_RUNTIME_QUALIFICATION_MODE,
    qualificationEnabled: parsed.data.CLOUD_RUNTIME_QUALIFICATION_ENABLED === "true",
    stagingEnabled: parsed.data.CLOUD_RUNTIME_STAGING_ENABLED === "true" };
}

// Credential discovery, foreground admission, action admission and renewal all
// use the same qualification mode as v2 workspace creation.
export function cloudRuntimeQualificationMode(): CloudRuntimeQualificationMode {
  return loadCloudRuntimeConfig().qualificationMode;
}
