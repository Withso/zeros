import { z } from 'zod';

const positive = z.number().int().positive().safe();

function canonicalUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('?') || value.includes('#')) return;
  try {
    const parsed = new URL(value);
    if (parsed.toString() !== value || parsed.username || parsed.password || parsed.search || parsed.hash) return;
    return parsed;
  } catch { return; }
}

/** Cloud workspace v2: the control plane relays this socket to the workspace
 * worker. The ticket subprotocol is short-lived and refreshed per connection. */
export const CloudV2ConnectionTargetSchema = z.object({
  kind: z.literal('cloud'), runtimeId: z.uuid(), organizationId: z.uuid(), workspaceId: z.uuid(),
  generation: positive, authorityEpoch: positive, engineInstanceId: z.uuid(), connectionSequence: positive,
  url: z.string().max(2048), expiresAt: positive,
  channel: z.literal('v2-websocket'),
  protocols: z.tuple([z.literal('zeros.cloud.v2'), z.string().regex(/^ticket\.zw2c_[A-Za-z0-9_-]{43}$/)]),
}).strict().superRefine((value, context) => {
  const url = canonicalUrl(value.url);
  const secure = url?.protocol === 'wss:';
  const loopback = url?.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (!url || (!secure && !loopback) || url.pathname !== `/v2/cloud/workspaces/${value.workspaceId}/bridge`)
    context.addIssue({ code: 'custom', message: 'Cloud v2 connection target is invalid' });
});
export type CloudV2ConnectionTarget = z.infer<typeof CloudV2ConnectionTargetSchema>;

/** Secret-bearing, connection-lifetime-only data. Never persist or use its
 * URL or ticket as keyed workspace identity. Local owns its own transport. */
export const CloudRuntimeConnectionTargetSchema = CloudV2ConnectionTargetSchema;
export type CloudRuntimeConnectionTarget = Readonly<CloudV2ConnectionTarget>;

export const RuntimeConnectionTargetSchema = z.union([
  z.object({ kind: z.literal('local') }).strict(), CloudV2ConnectionTargetSchema,
]);
export type RuntimeConnectionTarget = Readonly<z.infer<typeof RuntimeConnectionTargetSchema>>;
