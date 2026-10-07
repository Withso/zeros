import { z } from "zod";

/** Mirror the narrow control-plane read at the native trust boundary. No
 * renderer imports or provider/VM queries belong in this contract. */
export const cloudDetectedPortsSchema = z.object({
  version: z.literal(1), organizationId: z.string().uuid(), workspaceId: z.string().uuid(), generation: z.number().int().safe().positive(),
  status: z.string().min(1).max(64),
  observedAt: z.string().datetime().nullable(),
  ports: z.array(z.object({
    port: z.number().int().min(1024).max(65535), protocol: z.literal("tcp"), processLabel: z.string().max(120).nullable(),
    health: z.enum(["observed", "healthy", "unhealthy", "closed"]), observedAt: z.string().datetime(), closedAt: z.string().datetime().nullable(),
  }).strict()).max(128).nullable(),
}).strict().refine(value => (value.ports === null) === (value.observedAt === null), "Port observation state needs its timestamp");
export type CloudDetectedPorts = z.infer<typeof cloudDetectedPortsSchema>;
