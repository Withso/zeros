import { z } from "zod";

export const EXTENSION_CATEGORIES = [
  "mcp",
  "skills",
  "plugins",
  "apps",
] as const;
export const EXTENSION_PROVIDERS = [
  "zeros",
  "claude",
  "codex",
  "cursor",
] as const;
const NATIVE_PROVIDERS = ["claude", "codex", "cursor"] as const;
export type ExtensionCategory = (typeof EXTENSION_CATEGORIES)[number];
export type ExtensionProvider = (typeof EXTENSION_PROVIDERS)[number];

export const extensionQuerySchema = z.object({
  category: z.enum(EXTENSION_CATEGORIES),
  provider: z.enum(EXTENSION_PROVIDERS),
  repoRoot: z.string().min(1).optional(),
});
export type ExtensionQuery = z.infer<typeof extensionQuerySchema>;

export function extensionProviders(
  category: ExtensionCategory,
): readonly ExtensionProvider[] {
  return category === "mcp" || category === "skills"
    ? EXTENSION_PROVIDERS
    : NATIVE_PROVIDERS;
}

export interface ExtensionEntry {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  /** Configuration inventory is not proof a server is connected or callable. */
  status:
    | "available"
    | "configured"
    | "disabled"
    | "found"
    | "needs-auth"
    | "unavailable";
  /** Provider-reported limitation or guidance; never raw server errors or credentials. */
  statusDetail?: string;
  components?: string[];
  body?: string;
  revision?: string;
}
export interface ExtensionInventory {
  /** Missing entries cannot be interpreted as removal after a partial read. */
  partial?: boolean;
  entries: ExtensionEntry[];
  warnings: string[];
  note?: string;
}

export const zerosSkillSchema = z.object({
  name: z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9-]{0,63}$/,
      "Use lowercase letters, numbers, and hyphens.",
    ),
  description: z.string().trim().min(1).max(1000),
  body: z
    .string()
    .trim()
    .min(1)
    .max(64 * 1024),
});
export const saveZerosSkillSchema = zerosSkillSchema.extend({
  repoRoot: z.string().min(1).optional(),
  /** Compare-and-save prevents an editor from replacing a changed skill. */
  expectedRevision: z.string().nullable(),
});
export const removeZerosSkillSchema = z.object({
  repoRoot: z.string().min(1).optional(),
  name: zerosSkillSchema.shape.name,
  expectedRevision: z.string(),
});
export type ZerosSkillInput = z.infer<typeof zerosSkillSchema>;
