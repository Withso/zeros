import { z } from "zod";

// Same immutable identifier grammar as base publication and the registry.
const baseId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const policySchema = z.object({
  version: z.literal(1),
  defaultBaseImageId: baseId,
  candidate: z.object({
    baseImageId: baseId,
    organizationIds: z.array(z.string().uuid().transform(value => value.toLowerCase())).max(16)
      .refine(values => new Set(values).size === values.length),
  }).strict().nullable(),
}).strict().refine(value => value.candidate?.baseImageId !== value.defaultBaseImageId);

export type CloudRuntimeBaseRollout = z.infer<typeof policySchema>;

/** Server configuration only. Registration and qualification do not promote
 * a candidate. A present but invalid policy must never become legacy discovery. */
export function loadRuntimeBaseRollout(value: string | undefined): CloudRuntimeBaseRollout | undefined {
  if (value === undefined) return undefined;
  try {
    if (Buffer.byteLength(value, "utf8") > 4096) throw new Error();
    return policySchema.parse(JSON.parse(value));
  } catch {
    // Operator input may contain private values; neither JSON nor Zod's error
    // text belongs in the process's startup diagnostics.
    throw new Error("Invalid cloud runtime environment: CLOUD_RUNTIME_BASE_ROLLOUT_JSON");
  }
}

/** The caller supplies the authorized/locked build row's organization, never
 * a request override. Undefined retains the original newest-base behavior. */
export function runtimeBaseForOrganization(policy: CloudRuntimeBaseRollout | undefined, organizationId: string): string | undefined {
  if (!policy) return undefined;
  return policy.candidate?.organizationIds.includes(organizationId.toLowerCase())
    ? policy.candidate.baseImageId : policy.defaultBaseImageId;
}
