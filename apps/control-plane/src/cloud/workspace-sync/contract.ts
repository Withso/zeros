import { z } from "zod";

// Mirrored from packages/protocol/src/workspace-sync.ts; the CP deploys alone.
export const SYNC_FEATURE = "sync-v1";
export const SYNC_HEADER = "x-zeros-sync";
export const SyncFlagSchema = z.object({ syncing: z.boolean() }).strict();
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
