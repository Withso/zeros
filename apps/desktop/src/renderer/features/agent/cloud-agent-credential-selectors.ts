import { z } from "zod";
import { CloudAgentBootConversationSchema, CloudAgentBootIdentitySchema, CloudAgentCredentialRunInfoSchema,
  type CloudAgentBootConversation } from "@zeros/protocol/cloud-agent-bootstrap";
import { cloudScopedId, cloudWorkspaceKey, parseCloudScopedId } from "../../platform/bridge/cloud-workspace-key";
import { applyCloudAgentCredentialUse, restoreCloudAgentCredentialUse, cloudAgentCredentialNoticeState, type CloudAgentCredentialNoticeState } from "./cloud-agent-credential-notice";

const identity = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const sequence = z.number().int().positive().safe();
/** Native-use presentation data only. Authority is the already authenticated
 * exact peer, checked separately by the receiver before any store mutation. */
export const CloudAgentCredentialActualUseSchema = z.object({
  version: z.literal(1), scope: CloudAgentBootIdentitySchema, conversationId: identity,
  commandId: z.uuid(), turnId: identity, executionId: identity, credentialRun: CloudAgentCredentialRunInfoSchema,
  nativeStage: z.enum(["native_write", "sdk_run_created", "native_acceptance_ack"]),
  firstUseSequence: sequence, eventSequence: sequence,
}).strict().superRefine((use, context) => {
  const run = use.credentialRun, scope = use.scope;
  if (use.firstUseSequence > use.eventSequence || run.bootId !== scope.bootId || run.writerEpoch !== scope.writerEpoch ||
      run.fundingOwnerUserId !== scope.fundingOwnerUserId || run.fundingOwnerEpoch !== scope.fundingOwnerEpoch)
    context.addIssue({ code: "custom", message: "Native use binding is inconsistent" });
});
export type CloudAgentCredentialActualUse = z.infer<typeof CloudAgentCredentialActualUseSchema>;
export interface CloudAgentCredentialEntry {
  readonly binding: CloudAgentBootConversation;
  readonly state: CloudAgentCredentialNoticeState;
}
export function sameCloudAgentBootBinding(a: CloudAgentBootConversation, b: CloudAgentBootConversation): boolean {
  return Object.keys(CloudAgentBootIdentitySchema.shape).every(key => a[key as keyof typeof a] === b[key as keyof typeof b]);
}
export function cloudAgentCredentialEntry(chatId: string, raw: unknown, previous?: CloudAgentCredentialEntry): CloudAgentCredentialEntry | null {
  const target = parseCloudScopedId(chatId), parsed = CloudAgentBootConversationSchema.safeParse(raw);
  if (!target || !parsed.success || target.organizationId !== parsed.data.organizationId || target.workspaceId !== parsed.data.workspaceId) return null;
  const binding = parsed.data;
  if (previous && sameCloudAgentBootBinding(previous.binding, binding)) {
    // The initial adoption is immutable for this boot. Cache refresh cannot
    // reinterpret unavailable bootstrap metadata as absence/change evidence.
    if (JSON.stringify(previous.binding.initialAdoptions) !== JSON.stringify(binding.initialAdoptions) ||
        binding.cacheRevision < previous.binding.cacheRevision || binding.desiredCacheRevision < previous.binding.desiredCacheRevision) return null;
    if (binding.cacheRevision === previous.binding.cacheRevision && binding.desiredCacheRevision === previous.binding.desiredCacheRevision) return previous;
    return Object.freeze({ ...previous, binding: freezeBinding(binding) });
  }
  const immutable = freezeBinding(binding);
  return Object.freeze({ binding: immutable, state: cloudAgentCredentialNoticeState({ binding: immutable, conversationId: target.id,
    initialAdoptions: immutable.initialAdoptions }) });
}
function freezeBinding(binding: CloudAgentBootConversation): CloudAgentBootConversation {
  return Object.freeze({ ...binding, initialAdoptions: Object.freeze(binding.initialAdoptions.map(value => Object.freeze(value))) }) as CloudAgentBootConversation;
}
export function cloudAgentCredentialEntryUse(entry: CloudAgentCredentialEntry, raw: unknown): CloudAgentCredentialEntry {
  const parsed = CloudAgentCredentialActualUseSchema.safeParse(raw);
  if (!parsed.success || !sameCloudAgentBootBinding(entry.binding, { ...entry.binding, ...parsed.data.scope })) return entry;
  const next = applyCloudAgentCredentialUse(entry.state, entry.state.context, parsed.data);
  return next === entry.state ? entry : Object.freeze({ ...entry, state: next });
}
export function cloudAgentCredentialSnapshot(chatId: string, binding: unknown, values: unknown, previous?: CloudAgentCredentialEntry): CloudAgentCredentialEntry | null {
  if (!Array.isArray(values) || values.length > 6) return null;
  let entry = cloudAgentCredentialEntry(chatId, binding, previous);
  if (!entry) return null;
  const parsed = z.array(CloudAgentCredentialActualUseSchema).max(6).safeParse(values);
  if (!parsed.success) return null;
  const providers = new Map<string, Set<string>>();
  const originalUses = new Map<number, string>();
  for (const [provider, prior] of Object.entries(entry.state.last)) if (prior)
    originalUses.set(prior.firstUseSequence, JSON.stringify([provider, prior.runKey, prior.adoptionId]));
  for (const use of parsed.data) {
    if (!sameCloudAgentBootBinding(entry.binding, { ...entry.binding, ...use.scope }) || use.conversationId !== entry.state.context.conversationId) return null;
    const keys = providers.get(use.credentialRun.provider) ?? new Set();
    const key = JSON.stringify([use.commandId, use.turnId, use.executionId, use.firstUseSequence]);
    if (keys.has(key) || keys.size >= 2) return null;
    const original = JSON.stringify([use.credentialRun.provider, JSON.stringify([use.commandId, use.turnId, use.executionId]), use.credentialRun.adoptionId]);
    if (originalUses.has(use.firstUseSequence) && originalUses.get(use.firstUseSequence) !== original) return null;
    originalUses.set(use.firstUseSequence, original);
    keys.add(key); providers.set(use.credentialRun.provider, keys);
  }
  for (const use of parsed.data.sort((a, b) => a.firstUseSequence - b.firstUseSequence)) {
    const state = restoreCloudAgentCredentialUse(entry.state, entry.state.context, use);
    if (state !== entry.state) entry = Object.freeze({ ...entry, state });
  }
  return entry;
}

interface CredentialReceiverStore {
  installCloudAgentBootBinding(chatId: string, binding: unknown): boolean;
  applyCloudAgentCredentialUse(chatId: string, message: unknown, binding: unknown): boolean;
  installCloudAgentCredentialUses(chatId: string, binding: unknown, values: unknown): boolean;
}
interface CredentialReceiverBridge {
  cloudAgentBootBinding?(folder: string): CloudAgentBootConversation | null;
  on(type: string, handler: (message: unknown) => void): () => void;
}
/** One provider-level subscription covers hidden/unmounted chats. It neither
 * opens a peer nor uses selected/audit credentials as evidence of native use. */
export function wireCloudAgentCredentialState(bridge: CredentialReceiverBridge, getStore: () => CredentialReceiverStore): () => void {
  if (!bridge.cloudAgentBootBinding) return () => {};
  const read = bridge.cloudAgentBootBinding.bind(bridge);
  const off = bridge.on("CLOUD_AGENT_CREDENTIAL_USED", message => {
    const use = CloudAgentCredentialActualUseSchema.safeParse((message as { use?: unknown } | null)?.use);
    if (!use.success) return;
    const binding = read(cloudWorkspaceKey(use.data.scope));
    if (!binding || !sameCloudAgentBootBinding(binding, { ...binding, ...use.data.scope })) return;
    const chatId = cloudScopedId(binding, use.data.conversationId);
    const store = getStore();
    if (store.installCloudAgentBootBinding(chatId, binding)) store.applyCloudAgentCredentialUse(chatId, message, binding);
  });
  const snapshots = ["AGENT_SESSION_CREATED", "AGENT_SESSION_LOADED"].map(type => bridge.on(type, message => {
    const snapshot = (message as { cloudSnapshot?: { conversationId?: unknown; cloudCredentialUses?: unknown } } | null)?.cloudSnapshot;
    if (typeof snapshot?.conversationId !== "string" || snapshot.cloudCredentialUses === undefined) return;
    const target = parseCloudScopedId(snapshot.conversationId);
    if (!target) return;
    const binding = read(cloudWorkspaceKey(target));
    if (binding) getStore().installCloudAgentCredentialUses(snapshot.conversationId, binding, snapshot.cloudCredentialUses);
  }));
  return () => { off(); for (const stop of snapshots) stop(); };
}
