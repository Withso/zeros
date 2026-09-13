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
  /** Discovery ownership, independent of an MCP server's network transport. */
  sourceId?: string;
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
export interface ExtensionSource {
  id: string;
  kind: "local" | "account" | "session";
  state:
    | "complete"
    | "partial"
    | "unsupported"
    | "needs-auth"
    | "requires-session";
  detail?: string;
}
export interface ExtensionInventory {
  /** Provider-reported display identity, distinct from the Zeros scope picker. */
  account?: { label: string };
  /** Opaque provider/account/session identity. Never a credential or email. */
  identity?: string;
  /** Completeness is per source: an unsupported account API is not an empty account. */
  sources?: ExtensionSource[];
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

/** Credential-free view of connections in one admitted agent execution. */
export const sessionToolQuerySchema = z
  .object({
    workspaceId: z.string().min(1).max(4096),
    agentId: z.enum(NATIVE_PROVIDERS),
    sessionId: z.string().min(1).max(256),
  })
  .strict();
export const sessionToolAuthSchema = sessionToolQuerySchema.extend({
  toolId: z.string().min(1).max(512),
});
export type SessionToolQuery = z.infer<typeof sessionToolQuerySchema>;
export const sessionToolsSnapshotSchema = z
  .object({
    state: z.enum(["ready", "pending", "partial", "unsupported"]),
    detail: z.string().max(1000).optional(),
    entries: z
      .array(
        z
          .object({
            id: z.string().min(1).max(512),
            name: z.string().min(1).max(512),
            status: z.enum(["connected", "connecting", "needs-auth", "error"]),
            canAuthenticate: z.boolean().optional(),
            detail: z.string().max(1000).optional(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type SessionToolsSnapshot = z.infer<typeof sessionToolsSnapshotSchema>;

export const SESSION_TOOL_GROUPS = ["plugins", "apps", "mcp"] as const;
export type SessionToolGroupKind = (typeof SESSION_TOOL_GROUPS)[number];

/** Inventory is opt-in through tools.session.inventory. The legacy list
 * response remains unchanged for clients whose connection schema is strict. */
export const sessionToolInventoryEntrySchema = z
  .object({
    id: z.string().min(1).max(512),
    name: z.string().min(1).max(512),
    status: z.enum([
      "connected",
      "connecting",
      "needs-auth",
      "error",
      "available",
      "unavailable",
      "disabled",
      "enabled",
      "loaded",
      "unverified",
    ]),
    detail: z.string().max(1000).optional(),
    canAuthenticate: z.boolean().optional(),
  })
  .strict();
export type SessionToolInventoryEntry = z.infer<
  typeof sessionToolInventoryEntrySchema
>;

export const sessionToolGroupSchema = z
  .object({
    kind: z.enum(SESSION_TOOL_GROUPS),
    state: z.enum(["ready", "partial", "unsupported"]),
    detail: z.string().max(1000).optional(),
    entries: z.array(sessionToolInventoryEntrySchema).max(1000),
  })
  .strict();
export type SessionToolGroup = z.infer<typeof sessionToolGroupSchema>;
export const sessionToolsInventorySnapshotSchema =
  sessionToolsSnapshotSchema.extend({
    groups: z
      .array(sessionToolGroupSchema)
      .max(3)
      .refine(
        (groups) =>
          new Set(groups.map((group) => group.kind)).size === groups.length,
        "Duplicate tool inventory group",
      )
      .optional(),
  });
export type SessionToolsInventorySnapshot = z.infer<
  typeof sessionToolsInventorySnapshotSchema
>;

/** Older engines and providers without category inventory still expose their
 * confirmed MCP connections. An unavailable inventory is never a zero count. */
export function sessionToolGroups(
  snapshot: SessionToolsInventorySnapshot,
): SessionToolGroup[] {
  return SESSION_TOOL_GROUPS.map(
    (kind) =>
      snapshot.groups?.find((group) => group.kind === kind) ??
      (kind === "mcp"
        ? {
            kind,
            state: snapshot.state === "ready" ? "ready" : "partial",
            entries: snapshot.entries,
            ...(snapshot.detail ? { detail: snapshot.detail } : {}),
          }
        : {
            kind,
            state: "unsupported",
            entries: [],
            detail: `This agent does not report ${kind} for this chat.`,
          }),
  );
}
