import { z } from "zod";

// Mirrored in the desktop facade. Control-plane cannot import @zeros/protocol.
export const CloudWorkspaceRenameInputSchema = z.object({
  // Reject controls before whitespace normalization.
  // eslint-disable-next-line no-control-regex
  name: z.string().refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Name contains unsupported characters")
    .transform(value => value.trim()).pipe(z.string().min(1).max(120)),
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type CloudWorkspaceRenameInput = z.infer<typeof CloudWorkspaceRenameInputSchema>;

export const CloudWorkspaceDetectedPortsSchema = z.object({
  version: z.literal(1), organizationId: z.string().uuid(), workspaceId: z.string().uuid(),
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), status: z.string().min(1).max(64),
  observedAt: z.string().datetime().nullable(),
  ports: z.array(z.object({
    port: z.number().int().min(1024).max(65535), protocol: z.literal("tcp"),
    processLabel: z.string().max(120).nullable(), health: z.enum(["observed", "healthy", "unhealthy", "closed"]),
    observedAt: z.string().datetime(), closedAt: z.string().datetime().nullable(),
  }).strict()).max(128).nullable(),
}).strict().refine(value => (value.ports === null) === (value.observedAt === null), "Port observation state needs its timestamp");
export type CloudWorkspaceDetectedPorts = z.infer<typeof CloudWorkspaceDetectedPortsSchema>;

export function cloudWorkspaceDisplayLabel(value: string | null): string | null {
  // eslint-disable-next-line no-control-regex
  const label = value?.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return label || null;
}
