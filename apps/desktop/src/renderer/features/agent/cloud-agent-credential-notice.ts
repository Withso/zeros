import { CloudAgentCredentialRunInfoSchema, type CloudAgentBootScope, type CloudAgentCredentialRunInfo, type CloudAgentInitialAdoption } from "@zeros/protocol/cloud-agent-bootstrap";
import type { CloudAgentCredentialBinding } from "./cloud-agent-credentials-card";

type Provider = CloudAgentCredentialRunInfo["provider"];
export interface CloudAgentCredentialUse {
  readonly version: 1;
  readonly scope: CloudAgentBootScope;
  readonly conversationId: string;
  readonly commandId: string;
  readonly turnId: string;
  readonly executionId: string;
  readonly credentialRun: CloudAgentCredentialRunInfo;
  readonly nativeStage: "native_write" | "native_acceptance_ack" | "sdk_run_created";
  /** Original actual-use cursor, minted once by the exact native-flight
   * producer. Later ACK delivery/replay must never allocate a new use order. */
  readonly firstUseSequence: number;
  readonly eventSequence: number;
}
export interface CloudAgentCredentialNoticeContext {
  readonly binding: CloudAgentCredentialBinding;
  readonly conversationId: string;
  readonly initialAdoptions?: readonly CloudAgentInitialAdoption[];
}
export interface CloudAgentCredentialNoticeState {
  readonly context: CloudAgentCredentialNoticeContext;
  readonly initial: Readonly<Record<Provider, CloudAgentInitialAdoption>>;
  readonly last: Readonly<Partial<Record<Provider, { readonly adoptionId: string; readonly runKey: string; readonly firstUseSequence: number }>>>;
  readonly eventSequence: number;
  readonly notice: CloudAgentCredentialUse | undefined;
}

export function cloudAgentCredentialNoticeState(context: CloudAgentCredentialNoticeContext): CloudAgentCredentialNoticeState {
  const initial: Record<Provider, CloudAgentInitialAdoption> = {
    claude: { provider: "claude", status: "unknown" }, codex: { provider: "codex", status: "unknown" }, cursor: { provider: "cursor", status: "unknown" },
  };
  for (const value of context.initialAdoptions ?? []) initial[value.provider] = Object.freeze({ ...value });
  return Object.freeze({ context: Object.freeze({ binding: Object.freeze({ ...context.binding }), conversationId: context.conversationId }),
    initial: Object.freeze(initial), last: Object.freeze({}), eventSequence: 0, notice: undefined });
}

export function sameCloudAgentCredentialNoticeContext(a: CloudAgentCredentialNoticeContext, b: CloudAgentCredentialNoticeContext): boolean {
  return a.conversationId === b.conversationId && a.binding.mode === "boot-owner-v1" && b.binding.mode === a.binding.mode &&
    a.binding.fundingScope === "workspace-roles-v1" && b.binding.fundingScope === a.binding.fundingScope &&
    sameScope(a.binding, b.binding);
}

function sameScope(a: CloudAgentBootScope, b: CloudAgentBootScope): boolean {
  return a.organizationId === b.organizationId && a.workspaceId === b.workspaceId && a.generation === b.generation &&
    a.engineInstanceId === b.engineInstanceId && a.bootId === b.bootId && a.writerEpoch === b.writerEpoch &&
    a.fundingOwnerUserId === b.fundingOwnerUserId && a.fundingOwnerEpoch === b.fundingOwnerEpoch;
}

/** Structural scope check for presentation; never execution authority. */
export function cloudAgentCredentialUseMatchesContext(current: CloudAgentCredentialNoticeContext, use: CloudAgentCredentialUse): boolean {
  const run = use.credentialRun;
  return current.binding.mode === "boot-owner-v1" && current.binding.fundingScope === "workspace-roles-v1" &&
    sameScope(current.binding, use.scope) && use.version === 1 && use.conversationId === current.conversationId &&
    CloudAgentCredentialRunInfoSchema.safeParse(run).success &&
    !!use.commandId && !!use.turnId && !!use.executionId && Number.isSafeInteger(use.eventSequence) && use.eventSequence > 0 &&
    Number.isSafeInteger(use.firstUseSequence) && use.firstUseSequence > 0 && use.firstUseSequence <= use.eventSequence &&
    ["native_write", "native_acceptance_ack", "sdk_run_created"].includes(use.nativeStage) &&
    run.bootId === use.scope.bootId && run.writerEpoch === use.scope.writerEpoch &&
    run.fundingOwnerUserId === use.scope.fundingOwnerUserId && run.fundingOwnerEpoch === use.scope.fundingOwnerEpoch;
}

/** Only W4's validated actual-native-use event enters here. Selected receipt or
 * cache data is audit intent, never an input to the actual-use baseline. State
 * has three provider slots and one notice; old peers/runs cannot grow it. */
export function applyCloudAgentCredentialUse(state: CloudAgentCredentialNoticeState, current: CloudAgentCredentialNoticeContext,
  use: CloudAgentCredentialUse): CloudAgentCredentialNoticeState {
  return reduceCloudAgentCredentialUse(state, current, use, false);
}

/** A bounded authenticated snapshot preserves original use order independently
 * of ACK delivery. Live delivery still requires an advancing event cursor. */
export function restoreCloudAgentCredentialUse(state: CloudAgentCredentialNoticeState, current: CloudAgentCredentialNoticeContext,
  use: CloudAgentCredentialUse): CloudAgentCredentialNoticeState {
  return reduceCloudAgentCredentialUse(state, current, use, true);
}

function reduceCloudAgentCredentialUse(state: CloudAgentCredentialNoticeState, current: CloudAgentCredentialNoticeContext,
  use: CloudAgentCredentialUse, restoring: boolean): CloudAgentCredentialNoticeState {
  const run = use.credentialRun;
  if (!sameCloudAgentCredentialNoticeContext(state.context, current) || !cloudAgentCredentialUseMatchesContext(current, use) ||
      (!restoring && use.eventSequence <= state.eventSequence)) return state;
  const eventSequence = Math.max(state.eventSequence, use.eventSequence);
  const prior = state.last[run.provider];
  const runKey = JSON.stringify([use.commandId, use.turnId, use.executionId]);
  if (prior) {
    if (prior.firstUseSequence === use.firstUseSequence || prior.runKey === runKey) {
      if (prior.runKey !== runKey || prior.firstUseSequence !== use.firstUseSequence || prior.adoptionId !== run.adoptionId) return state;
      return eventSequence === state.eventSequence ? state : Object.freeze({ ...state, eventSequence });
    }
    if (use.firstUseSequence < prior.firstUseSequence) return eventSequence === state.eventSequence ? state : Object.freeze({ ...state, eventSequence });
  }
  const baseline = state.initial[run.provider];
  const changed = prior ? prior.adoptionId !== run.adoptionId : baseline.status === "missing" ||
    (baseline.status === "known" && baseline.adoptionId !== run.adoptionId);
  const notice = changed && (!state.notice || use.firstUseSequence > state.notice.firstUseSequence) ?
    Object.freeze({ ...use, scope: Object.freeze({ ...use.scope }), credentialRun: Object.freeze({ ...run }) }) : state.notice;
  return Object.freeze({ ...state, eventSequence, notice,
    last: Object.freeze({ ...state.last, [run.provider]: Object.freeze({ adoptionId: run.adoptionId, runKey, firstUseSequence: use.firstUseSequence }) }) });
}
