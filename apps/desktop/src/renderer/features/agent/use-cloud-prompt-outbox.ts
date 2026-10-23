import { useEffect, useMemo, useRef } from "react";
import { CloudV2PromptSchema } from "@zeros/protocol/cloud-v2-prompts";
import { cloudPromptApi } from "../../platform/cloud-prompt-api";
import { subscribeCloudPromptErasure } from "../../platform/cloud-prompt-erasure";
import { cloudScopedId, cloudWorkspaceKey, parseCloudScopedId, parseCloudWorkspaceKey, type CloudWorkspaceTarget } from "../../platform/bridge/cloud-workspace-key";
import { cloudCatalogGeneration, cloudWorkspaceOwnerGeneration, cloudWorkspaceDocument, subscribeCloudWorkspaces } from "../../state/cloud-workspace-catalog";
import { useWorkspaceStore } from "../../state/workspace-store";
import { CONTROL_PLANE_URL } from "../team/control-plane";
import { getOrganizationStoreGeneration, getTeamStoreState, subscribeOrganizationSnapshots } from "../team/team-store";
import { hasCloudWorkspaceAccountAccess } from "../team/cloud-workspace-account-access";
import { CloudPromptCoordinator } from "./cloud-prompt-coordinator";
import { createCloudPromptJournal } from "./cloud-prompt-journal";
import { promptTerminal, promptOwnerKey, type CloudPromptChannel, type CloudPromptOwner, type PromptJournalRecord } from "./cloud-prompt-channel";
import { cloudPromptView, cloudPromptSessionPatch, cloudPromptHasLegacyActivity } from "./cloud-prompt-presentation";
import { cloudTurnEnding, cloudTurnStart } from "./cloud-turn-presentation";
import { BLANK, useSessionsStore } from "./sessions-store";
import type { QueuedEditPayload } from "./sessions-context";
import type { BridgeMessage } from "../../platform/bridge/messages";
import { accountPresentationOwner, getAccountPresentationOwner } from "../../platform/account-presentation-cache";
import { noteLocalChatPrompt } from "./chat-transcript-summaries-cache";

/** Process-owned delivery, independent of React's retained chat surfaces and
 * the current bridge. Hooks only subscribe it to exact account/catalog changes. */
export class CloudPromptRuntime {
  constructor(private readonly historyChanged: (chatId: string) => void = () => {}) {}
  private readonly journal = createCloudPromptJournal();
  private coordinator = new CloudPromptCoordinator(this.journal, () => this.scheduleReconcile());
  private owners: CloudPromptOwner[] = [];
  private restoredAccount?: string;
  private readonly restored = new Set<string>();
  private readonly channels = new Map<string, CloudPromptChannel>();
  private readonly stopFlights = new Map<string, { id: string; promise: Promise<boolean> }>();
  private activeChat?: string | null;
  private queued = false;
  private stopped = false;
  private cleanups: (() => void)[] = [];

  available(chatId: string): boolean { return this.context(chatId) !== null; }
  private context(chatId: string): CloudPromptOwner | null {
    const chat = useWorkspaceStore.getState().chats.find(chat => chat.id === chatId), slot = useSessionsStore.getState().sessions[chatId];
    const target = parseCloudWorkspaceKey(chat?.folder ?? slot?.cwd), native = parseCloudScopedId(chatId);
    const accountId = getTeamStoreState().me?.user.id;
    if (!target || !native || native.organizationId !== target.organizationId || native.workspaceId !== target.workspaceId ||
        !CONTROL_PLANE_URL || !accountId || !this.allowed(target)) return null;
    return { ...target, backend: CONTROL_PLANE_URL, accountId, chatId: native.id };
  }
  private allowed(target: CloudWorkspaceTarget): boolean {
    const doc = cloudWorkspaceDocument(target);
    return hasCloudWorkspaceAccountAccess(target.organizationId) && doc?.capabilities.promptOutbox === 1 &&
      !doc.deletedAt && !["deleting", "deleted"].includes(doc.status);
  }
  private channel(owner: CloudPromptOwner): CloudPromptChannel {
    const account = getOrganizationStoreGeneration(), catalog = cloudCatalogGeneration(), generation = cloudWorkspaceOwnerGeneration(owner), chatId = cloudScopedId(owner, owner.chatId);
    const channel = this.coordinator.channel(owner, cloudPromptApi(owner, owner.chatId), () => !this.stopped &&
      account === getOrganizationStoreGeneration() && catalog === cloudCatalogGeneration() &&
      generation !== undefined && generation === cloudWorkspaceOwnerGeneration(owner) &&
      CONTROL_PLANE_URL === owner.backend && getTeamStoreState().me?.user.id === owner.accountId && this.allowed(owner),
    record => this.publish(chatId, record));
    this.channels.set(promptOwnerKey(owner), channel);
    if (!this.owners.some(value => promptOwnerKey(value) === promptOwnerKey(owner))) this.owners.push(owner);
    for (const [key, value] of this.channels) if (!this.coordinator.owns(value)) this.channels.delete(key);
    return channel;
  }
  private publish(chatId: string, record: PromptJournalRecord): void {
    const state = useSessionsStore.getState(), slot = state.sessions[chatId];
    if (!slot || slot.cwd !== cloudWorkspaceKey(record.owner)) return;
    const refusedStop = record.stop?.state === "failed" ? record.stop.id : undefined;
    const retained = refusedStop ? Object.fromEntries(Object.entries(slot.cloudTurnPresentations ?? {}).map(([id, value]) =>
      [id, value.source === "stop" && value.operationId === refusedStop ? { startedAt: value.startedAt, status: "running" as const, source: "send" as const } : value])) : slot.cloudTurnPresentations;
    let view = cloudPromptView({ ...record, entries: record.entries.map(entry => {
      const presentation = retained?.[entry.payload.userMessageId];
      return presentation ? { ...entry, presentation } : entry;
    }) }, cloudWorkspaceDocument(record.owner)?.status ?? "stopped", slot.cloudOutbox);
    if (view.pendingId && cloudPromptHasLegacyActivity(slot, view)) view = { ...view, pendingId: undefined };
    if (view === slot.cloudOutbox) return;
    if (view.pendingId && !view.presentations?.[view.pendingId]) {
      const row = view.rows.find(row => row.id === view.pendingId)!;
      const wasQueued = slot.cloudOutbox?.rows.some(value => value.id === row.id) && slot.cloudOutbox.pendingId !== row.id;
      view = { ...view, presentations: { ...view.presentations, [row.id]: { startedAt: wasQueued ? Date.now() : row.createdAt, status: "running", source: "send" } } };
    }
    const patch = cloudPromptSessionPatch({ ...slot, cloudTurnPresentations: retained }, view);
    const pendingId = view.pendingId && !cloudTurnEnding({ ...slot, ...patch }, view.pendingId) ? view.pendingId : null;
    // One publication owns both the saved bubble and its first-frame pending
    // turn. Never consume a legacy sender's independent pending owner.
    const ownsPending = !state.pendingLocalTurns[chatId] || view.rows.some(row => row.id === state.pendingLocalTurns[chatId]);
    state.patchSession(chatId, patch, ownsPending ? pendingId : undefined);
    const channel = this.channels.get(promptOwnerKey(record.owner));
    if (channel) for (const [id, value] of Object.entries(patch.cloudTurnPresentations ?? {})) {
      if (value !== slot.cloudTurnPresentations?.[id]) void channel.rememberPresentation(id, value).catch(() => {});
    }
    if (record.entries.some(entry => promptTerminal(entry.state) && entry.state !== slot.cloudOutbox?.states[entry.payload.userMessageId])) {
      this.historyChanged(chatId);
    }
    if (!view.stopId && !view.activeId && slot.foregroundTurnId && promptTerminal(view.states[slot.foregroundTurnId])) {
      state.setCancelling(chatId, false);
    }
  }
  async send(chatId: string, input: QueuedEditPayload, options: { id?: string; autoAction?: string; mode?: "prompt" | "steer"; accepted?: () => void; committed?: () => void; deferDelivery?: boolean } = {}): Promise<void> {
    const owner = this.context(chatId); if (!owner) throw new Error("Cloud message delivery is unavailable for this conversation.");
    const chat = useWorkspaceStore.getState().chats.find(chat => chat.id === chatId), state = useSessionsStore.getState();
    const slot = state.sessions[chatId], agentId = chat?.agentId ?? slot?.agentId;
    if (agentId !== "codex" && agentId !== "claude" && agentId !== "cursor") throw new Error("Choose an agent before sending.");
    if (!slot) state.setSession(chatId, { ...BLANK, cwd: cloudWorkspaceKey(owner), agentId, transcriptState: "resident" });
    const channel = this.channel(owner), id = options.id ?? crypto.randomUUID(), startedAt = Date.now();
    // Freeze selection and rich input before any attachment read or network yield.
    const selection = { agentId, ...(chat?.model ? { model: chat.model } : {}), ...(chat?.effort ? { effort: chat.effort } : {}) };
    const frozen = structuredClone({ text: input.text, displayText: input.displayText, attachments: input.attachments,
      bubbleAttachments: input.bubbleAttachments, segments: input.segments });
    await channel.enqueue(async () => {
      if (input.cloudQueue && !input.cloudQueue.prepareDurable) throw new Error("Restore this saved draft in the composer before sending it.");
      const prepared = await input.cloudQueue?.prepareDurable?.() ?? frozen;
      return CloudV2PromptSchema.parse({ chatId: owner.chatId, userMessageId: id, ...selection, mode: options.mode ?? "prompt", startedAt,
        prompt: [{ type: "text", text: prepared.text }, ...(prepared.attachments ?? [])],
        bubble: { retryText: prepared.text, displayText: prepared.displayText ?? prepared.text, attachments: prepared.bubbleAttachments,
          segments: prepared.segments, ...(options.autoAction ? { autoAction: options.autoAction } : {}) } });
    });
    if (this.coordinator.owns(channel)) {
      const saved = channel.snapshot.entries.find(entry => entry.payload.userMessageId === id)?.payload;
      if (saved && getAccountPresentationOwner() === accountPresentationOwner(owner.backend, owner.accountId))
        noteLocalChatPrompt({ chatId, folder: cloudWorkspaceKey(owner), promptId: id, at: startedAt,
          text: saved.bubble?.displayText ?? frozen.displayText ?? frozen.text,
          title: chat?.title, agentId, agentName: chat?.agentName });
      options.committed?.();
    }
    if (options.deferDelivery) return;
    // The optimistic bubble already exists. Finish the foreground send after
    // its HTTPS attempt, independently of bridge readiness and provider work.
    // Only a committed receipt is cloud acceptance; a lost reply keeps the
    // exact private attempt visibly unconfirmed until same-id repair succeeds.
    await this.coordinator.flush(channel);
    if (channel.snapshot.entries.find(entry => entry.payload.userMessageId === id)?.receipt) options.accepted?.();
  }
  async stop(chatId: string): Promise<boolean> {
    const owner = this.context(chatId); if (!owner) return false;
    const state = useSessionsStore.getState(), stop = state.presentCloudStop(chatId);
    const channel = this.channel(owner), slot = useSessionsStore.getState().sessions[chatId];
    const key = promptOwnerKey(owner), existing = this.stopFlights.get(key);
    if (existing && existing.id === stop?.operationId) return existing.promise;
    const current = () => this.coordinator.owns(channel) && useSessionsStore.getState().sessions[chatId]?.cloudStop?.operationId === stop?.operationId;
    const unconfirmed = () => {
      if (!stop || !current()) return;
      const store = useSessionsStore.getState(), slot = store.sessions[chatId]!;
      store.patchSession(chatId, { cloudStop: { ...slot.cloudStop!, state: "unconfirmed" } });
      void channel.unconfirmedStop(stop.operationId).catch(() => {});
    };
    const promise = (async () => {
      const timer = setTimeout(unconfirmed, 15_000);
      let prepared = channel.snapshot.stop?.throughEpoch !== undefined;
      try {
        await channel.stop(stop ? { id: stop.operationId, turnId: stop.turnId, requestedAt: stop.requestedAt ?? Date.now(),
          startedAt: slot && stop.turnId ? cloudTurnStart(slot, stop.turnId) : Date.now() } : undefined);
        prepared = true;
        await this.coordinator.flush(channel); return true;
      } catch {
        if (prepared) unconfirmed();
        else if (stop && current()) {
          const store = useSessionsStore.getState();
          store.rejectCloudStopPresentation(chatId, stop.operationId);
          store.patchSession(chatId, { cloudStop: { ...store.sessions[chatId]!.cloudStop!, state: "failed", preparing: false } });
        }
        return false;
      } finally { clearTimeout(timer); if (this.stopFlights.get(key)?.id === stop?.operationId) this.stopFlights.delete(key); }
    })();
    if (stop) this.stopFlights.set(key, { id: stop.operationId, promise });
    return promise;
  }
  async confirmStop(chatId: string): Promise<boolean> {
    const owner = this.context(chatId); if (!owner) return false;
    const channel = this.channel(owner), deadline = Date.now() + 15_000;
    let done = false, timer: ReturnType<typeof setTimeout> | undefined;
    const confirmation = (async () => {
      await channel.stop();
      do {
        try { await this.coordinator.flush(channel); if (!done) await channel.refresh(); } catch { return false; }
        if (done || !this.coordinator.owns(channel)) return false;
        if (!channel.pending) return true;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (!done && Date.now() < deadline);
      return false;
    })();
    try {
      return await Promise.race([confirmation, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 15_000); })]);
    } finally { done = true; clearTimeout(timer); }
  }
  async recover(chatId: string, messageId: string, retry = false): Promise<boolean> {
    const owner = this.context(chatId); if (!owner) return false;
    const channel = this.channel(owner); await channel.refresh();
    const entry = channel.snapshot.entries.find(entry => entry.payload.userMessageId === messageId);
    if (!entry) return false;
    if (entry.phase === "pending" || entry.phase === "uncertain" || entry.phase === "saved" && !promptTerminal(entry.state)) {
      this.coordinator.wake(channel); return true;
    }
    if (entry.state === "completed") return true;
    if (!retry) return false;
    const chat = useWorkspaceStore.getState().chats.find(chat => chat.id === chatId);
    await channel.enqueue(async () => ({ ...entry.payload, userMessageId: crypto.randomUUID(), startedAt: Date.now(), mode: "prompt",
      model: chat?.model ?? entry.payload.model, effort: chat?.effort || undefined }));
    this.coordinator.wake(channel); return true;
  }
  refresh(chatId: string): void { const owner = this.context(chatId); if (owner) this.coordinator.wake(this.channel(owner), true); }
  observe(raw: BridgeMessage): void {
    if (raw.type === "ENGINE_READY") {
      this.coordinator.refreshPending();
      const chatId = useWorkspaceStore.getState().activeChatId;
      if (chatId && this.available(chatId)) { this.refresh(chatId); this.historyChanged(chatId); }
      return;
    }
    if (raw.type !== "AGENT_SESSION_UPDATE" || !raw.chatId) return;
    const owner = this.context(raw.chatId); if (!owner) return;
    const update = raw.notification.update, state = useSessionsStore.getState(), slot = state.sessions[raw.chatId];
    if (!slot) return;
    if (update.sessionUpdate === "turn_state" && update.turnId) {
      const known = slot.cloudOutbox?.rows.some(row => row.id === update.turnId);
      if (known && !cloudTurnEnding(slot, update.turnId) && !promptTerminal(slot.cloudOutbox?.states[update.turnId])) {
        // A headless delivery creates/adopts its own route. The authenticated
        // worker's exact chat+message identity authorizes this route handoff;
        // a late terminal event for another message cannot replace it.
        const executionId = raw.executionId ?? raw.notification.executionId ?? raw.notification.sessionId;
        if (update.state === "running" || !slot.executionId) state.patchSession(raw.chatId, { executionId, sessionId: executionId });
      }
      this.coordinator.wake(this.channel(owner));
    } else if (update.sessionUpdate === "user_message_recorded") this.coordinator.wake(this.channel(owner));
  }
  start(): () => void {
    if (this.stopped) { this.stopped = false; this.coordinator = new CloudPromptCoordinator(this.journal, () => this.scheduleReconcile()); this.restoredAccount = undefined; }
    const reconcile = () => this.scheduleReconcile();
    this.cleanups = [subscribeCloudWorkspaces(reconcile), subscribeOrganizationSnapshots(reconcile),
      useWorkspaceStore.subscribe((state, previous) => { if (state.activeChatId !== previous.activeChatId || state.chats !== previous.chats) reconcile(); }),
      useSessionsStore.subscribe((state, previous) => {
        // Stream chunks do not rescan conversations or start network reads.
        for (const [key, slot] of Object.entries(state.sessions)) {
          const old = previous.sessions[key];
          if (slot.cloudTurnPresentations !== old?.cloudTurnPresentations) {
            const owner = this.context(key), channel = owner && this.channels.get(promptOwnerKey(owner));
            if (channel && this.coordinator.owns(channel)) for (const [id, value] of Object.entries(slot.cloudTurnPresentations ?? {})) {
              if (value !== old?.cloudTurnPresentations?.[id]) void channel.rememberPresentation(id, value).catch(() => {});
            }
          }
          if (!old || slot.cwd !== old.cwd || slot.agentId !== old.agentId || old.cloudOutbox && !slot.cloudOutbox ||
              cloudPromptHasLegacyActivity(old) && !cloudPromptHasLegacyActivity(slot)) { reconcile(); break; }
        }
      }),
      subscribeCloudPromptErasure(target => {
        const accountId = getTeamStoreState().me?.user.id;
        const matches = (owner: CloudPromptOwner) => owner.backend === CONTROL_PLANE_URL && owner.accountId === accountId &&
          owner.organizationId === target.organizationId && owner.workspaceId === target.workspaceId && (!target.chatId || owner.chatId === target.chatId);
        for (const [key, channel] of this.channels) if (matches(channel.owner)) {
          this.channels.delete(key); this.restored.delete(key); void this.coordinator.erase(channel.owner).catch(() => {});
        }
        this.owners = this.owners.filter(owner => !matches(owner));
        void this.journal.owners().then(owners => Promise.all(owners.filter(matches).map(owner => this.coordinator.erase(owner)))).catch(() => {});
      })];
    const online = () => this.coordinator.refreshPending();
    window.addEventListener("online", online); this.cleanups.push(() => window.removeEventListener("online", online));
    reconcile();
    return () => { this.stopped = true; for (const stop of this.cleanups.splice(0)) stop(); this.coordinator.stop(); };
  }
  private scheduleReconcile(): void {
    if (this.queued || this.stopped) return;
    this.queued = true;
    queueMicrotask(() => { this.queued = false; if (!this.stopped) void this.reconcile().catch(() => {}); });
  }
  private async reconcile(): Promise<void> {
    const account = `${getOrganizationStoreGeneration()}:${cloudCatalogGeneration()}:${getTeamStoreState().me?.user.id ?? ""}`;
    if (account !== this.restoredAccount) {
      this.restoredAccount = account;
      this.restored.clear(); this.channels.clear();
      try { this.owners = await this.journal.owners(true); } catch { this.owners = []; this.restoredAccount = undefined; }
      if (account !== this.restoredAccount || this.stopped) return;
      this.activeChat = undefined;
    }
    for (const [key, channel] of this.channels) if (!this.coordinator.owns(channel)) {
      this.channels.delete(key); this.restored.delete(key);
    }
    for (const owner of this.owners) {
      const key = promptOwnerKey(owner);
      if (owner.backend !== CONTROL_PLANE_URL || owner.accountId !== getTeamStoreState().me?.user.id) continue;
      if (!this.allowed(owner)) { this.restored.delete(key); continue; }
      if (!this.restored.has(key)) {
        // A full scheduler resumes the remainder when a job finishes. No chat
        // view needs to be mounted for a restored batch to make progress.
        let channel: CloudPromptChannel;
        try { channel = this.channel(owner); } catch { break; }
        this.coordinator.wake(channel); this.restored.add(key);
      }
    }
    const chatId = useWorkspaceStore.getState().activeChatId;
    const active = chatId && this.available(chatId) ? chatId : null;
    if (active !== this.activeChat) { this.activeChat = active; if (active) this.refresh(active); }
    for (const channel of this.channels.values()) {
      const scoped = cloudScopedId(channel.owner, channel.owner.chatId);
      if (channel.hasSnapshot && this.context(scoped)) this.publish(scoped, channel.snapshot);
    }
  }
}

export function useCloudPromptOutbox(historyChanged?: (chatId: string) => void): CloudPromptRuntime {
  const history = useRef(historyChanged); history.current = historyChanged;
  const runtime = useMemo(() => new CloudPromptRuntime(chatId => history.current?.(chatId)), []);
  useEffect(() => runtime.start(), [runtime]);
  return runtime;
}
