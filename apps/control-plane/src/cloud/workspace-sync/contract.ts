import { z } from "zod";

// Mirrored from packages/protocol/src/workspace-sync.ts; the CP deploys alone.
export const SYNC_FEATURE = "sync-v1";
export const SYNC_HEADER = "x-zeros-sync";
export const SYNC_WANTED_HEADER = "x-zeros-sync-wanted";
export const SyncFlagSchema = z.object({ syncing: z.boolean() }).strict();
export const SyncWantedFlagSchema = z.object({ syncing: z.boolean().optional(), wanted: z.boolean().optional() }).strict()
  .refine(value => value.syncing !== undefined || value.wanted !== undefined);
export type SyncFlags = z.infer<typeof SyncWantedFlagSchema>;
export const SyncGrantReplySchema = z.object({
  url: z.string().url().refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
    } catch { return false; }
  }, "Invalid route"),
  portAuth: z.string().regex(/^[A-Za-z0-9._~+/=-]{16,8192}$/),
  grant: z.string().regex(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/).max(4096),
  expiresAt: z.string().datetime(),
}).strict();
export type SyncGrantReply = z.infer<typeof SyncGrantReplySchema>;

export const DeviceSyncConnectionSchema = z.object({
  workspaceId: z.string().uuid(),
  repository: z.string().min(3).max(201).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  number: z.number().int().positive().nullable(),
  name: z.string().min(1).max(120),
  syncWanted: z.boolean(),
  syncing: z.boolean().optional(),
}).passthrough();
export const DeviceSyncConnectionsReplySchema = z.object({
  connections: z.array(DeviceSyncConnectionSchema).max(200),
  nextCursor: z.string().uuid().nullable(),
}).passthrough();
export type DeviceSyncConnectionsReply = z.infer<typeof DeviceSyncConnectionsReplySchema>;
