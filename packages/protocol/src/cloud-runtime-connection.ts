import { z } from 'zod';
import { CloudActorRuntimeGrantSchema } from './cloud-actors';
import { CloudAgentBootScopeSchema } from './cloud-agent-bootstrap';

const applicationPort = z.number().int().min(1024).max(65535);
const positive = z.number().int().positive().safe();
const actorToken = z.string().regex(/^zwa_[A-Za-z0-9_-]{43}$/);
const sshToken = z.string().regex(/^zws_[A-Za-z0-9_-]{43}$/);
const boatHost = /^([a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?)-([1-9][0-9]{3,4})\.on\.boat\.dev$/;

function canonicalUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('?') || value.includes('#')) return;
  try {
    const parsed = new URL(value);
    if (parsed.toString() !== value || parsed.username || parsed.password || parsed.search || parsed.hash) return;
    return parsed;
  } catch { return; }
}

/** Structure only: the CP independently verifies the owned Boat resource,
 * its exact published endpoint and current authority after discovery. This
 * predicate neither authorizes a socket nor proves redirect behavior. */
export function isCloudDirectProviderUrl(value: unknown, remotePort?: number): value is string {
  const url = canonicalUrl(value);
  if (!url || url.protocol !== 'wss:' || url.port || url.pathname !== '/ws') return false;
  const match = boatHost.exec(url.hostname);
  if (!match) return false;
  const port = Number(match[2]);
  return port >= 1024 && port <= 65535 && port !== 22222 &&
    (remotePort === undefined || Number.isSafeInteger(remotePort) && remotePort === port);
}

export const CloudDirectProviderEndpointSchema = z.object({
  version: z.literal(1), provider: z.literal('boat'),
  url: z.string().refine(value => isCloudDirectProviderUrl(value), 'Invalid direct provider endpoint'),
}).strict();
export type CloudDirectProviderEndpoint = z.infer<typeof CloudDirectProviderEndpointSchema>;

type BoundScope = { organizationId: string; workspaceId: string; generation: number; engineInstanceId: string };
function scopeMatches(scope: z.infer<typeof CloudAgentBootScopeSchema>, parent: BoundScope): boolean {
  return scope.organizationId === parent.organizationId && scope.workspaceId === parent.workspaceId &&
    scope.generation === parent.generation && scope.engineInstanceId === parent.engineInstanceId;
}

/** New metadata is returned only after explicit direct-provider negotiation.
 * The unchanged public actor grant remains the one-use credential; bootScope
 * is nonsecret binding metadata, not client-selected funding/actor authority. */
export const CloudActorConnectionGrantSchema = CloudActorRuntimeGrantSchema.extend({
  bootScope: CloudAgentBootScopeSchema.optional(),
  directProvider: CloudDirectProviderEndpointSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.bootScope && !scopeMatches(value.bootScope, value) ||
      value.directProvider && (!value.bootScope || !isCloudDirectProviderUrl(value.directProvider.url, value.remotePort)))
    context.addIssue({ code: 'custom', message: 'Direct provider grant binding is inconsistent' });
});
export type CloudActorConnectionGrant = z.infer<typeof CloudActorConnectionGrantSchema>;

const target = z.object({
  kind: z.literal('cloud'), runtimeId: z.uuid(), organizationId: z.uuid(), workspaceId: z.uuid(),
  generation: positive, authorityEpoch: positive, engineInstanceId: z.uuid(), connectionSequence: positive,
  url: z.string().max(2048), expiresAt: positive,
}).strict();

/** Existing configured CP-origin and 5s/16min admission freshness checks
 * remain at the desktop boundary. This shared schema fixes channel/shape and
 * forbids URL bearers; it cannot choose the deployment's CP origin. */
export const CloudControlPlaneConnectionTargetSchema = target.extend({
  channel: z.literal('control-plane-websocket'), cloudToken: actorToken,
  bootScope: CloudAgentBootScopeSchema.optional(),
}).strict().superRefine((value, context) => {
  const url = canonicalUrl(value.url);
  const secure = url?.protocol === 'wss:';
  const loopback = url?.protocol === 'ws:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (!url || (!secure && !loopback) || url.pathname !== '/v1/cloud-workspaces/bridge' ||
      value.bootScope && !scopeMatches(value.bootScope, value))
    context.addIssue({ code: 'custom', message: 'Control-plane connection target is invalid' });
});

export const CloudSshConnectionTargetSchema = target.extend({
  channel: z.literal('electron-ssh-tunnel'), cloudToken: sshToken,
}).strict().superRefine((value, context) => {
  const url = canonicalUrl(value.url);
  if (!url || url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port ||
      !applicationPort.safeParse(Number(url.port)).success || url.pathname !== '/ws')
    context.addIssue({ code: 'custom', message: 'SSH connection target is invalid' });
});

export const CloudDirectProviderConnectionTargetSchema = target.extend({
  channel: z.literal('direct-provider-websocket'), cloudToken: actorToken,
  remotePort: applicationPort, bootScope: CloudAgentBootScopeSchema,
}).strict().superRefine((value, context) => {
  if (!scopeMatches(value.bootScope, value) || !isCloudDirectProviderUrl(value.url, value.remotePort))
    context.addIssue({ code: 'custom', message: 'Direct provider connection target is invalid' });
});
export type CloudDirectProviderConnectionTarget = z.infer<typeof CloudDirectProviderConnectionTargetSchema>;

export const CloudRuntimeConnectionTargetSchema = z.discriminatedUnion('channel', [
  CloudControlPlaneConnectionTargetSchema, CloudSshConnectionTargetSchema, CloudDirectProviderConnectionTargetSchema,
]);
/** Secret-bearing, connection-lifetime-only data. Never persist or use its
 * URL/token as keyed workspace identity. Local owns its existing transport. */
export type CloudRuntimeConnectionTarget = Readonly<z.infer<typeof CloudRuntimeConnectionTargetSchema>>;

export const RuntimeConnectionTargetSchema = z.union([
  z.object({ kind: z.literal('local') }).strict(), CloudRuntimeConnectionTargetSchema,
]);
export type RuntimeConnectionTarget = Readonly<z.infer<typeof RuntimeConnectionTargetSchema>>;
