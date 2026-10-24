import { CLOUD_V2_MAX_PROMPT_BYTES, CloudV2PromptSchema, type CloudV2Prompt, type CloudV2PromptReceipt,
  type CloudV2PromptState, type CloudV2PromptStatus } from "@zeros/protocol/cloud-v2-prompts";
import { withCloudTurnPresentation, type CloudTurnPresentation } from "./cloud-turn-presentation";

export interface CloudPromptOwner {
  backend: string; accountId: string; organizationId: string; workspaceId: string; chatId: string;
}
export const promptOwnerKey = (owner: CloudPromptOwner) => JSON.stringify([
  owner.backend, owner.accountId, owner.organizationId, owner.workspaceId, owner.chatId,
]);
export const promptTerminal = (state?: CloudV2PromptState) => !!state && ["completed", "failed", "cancelled", "interrupted"].includes(state);
export interface PromptJournalEntry {
  payload: CloudV2Prompt;
  order: number;
  phase: "pending" | "uncertain" | "saved" | "refused";
  receipt?: CloudV2PromptReceipt;
  state?: CloudV2PromptState;
  failure?: string;
  cancelRequested?: boolean;
  /** Client-only feedback; never used to admit, retry or retire delivery. */
  presentation?: CloudTurnPresentation;
  updatedAt: number;
}
export interface PromptJournalRecord {
  version: 1; owner: CloudPromptOwner; entries: PromptJournalEntry[];
  nextOrder: number; epoch: string; cursor: string;
  /** Saved before the first Stop POST; a lost reply retries this exact epoch. */
  stop?: { id: string; before: number; throughEpoch?: string; turnId?: string | null; requestedAt?: number; state?: "pending" | "unconfirmed" | "failed" };
}
export const emptyPromptJournal = (owner: CloudPromptOwner): PromptJournalRecord => ({ version: 1, owner, entries: [], nextOrder: 0, epoch: "0", cursor: "0" });
export interface CloudPromptJournal {
  read(owner: CloudPromptOwner): Promise<PromptJournalRecord>;
  change(owner: CloudPromptOwner, update: (record: PromptJournalRecord) => PromptJournalRecord): Promise<PromptJournalRecord>;
  owners(pendingOnly?: boolean): Promise<CloudPromptOwner[]>;
  erase(owner: CloudPromptOwner): Promise<void>;
}
export interface CloudPromptApi {
  enqueue(payload: CloudV2Prompt): Promise<CloudV2PromptReceipt>;
  list(after: string, includePayload: boolean): Promise<{ epoch: string; items: CloudV2PromptStatus[]; nextAfter: string | null }>;
  stop(throughEpoch: string): Promise<{ chatId: string; epoch: string }>;
}
const httpStatus = (error: unknown) => Number(error && typeof error === "object" && "status" in error ? error.status : 0);
const definitive = (error: unknown) => httpStatus(error) >= 400 && httpStatus(error) < 500 && ![408, 425, 429].includes(httpStatus(error));
const refusal = (error: unknown) => [401, 403].includes(httpStatus(error))
  ? "This message wasn't sent. Check your cloud access and retry."
  : "This message wasn't accepted. Retry to send it again.";
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** One exact account/workspace/conversation. HTTPS receipt ownership is
 * independent of the live execution. A failed request never invents another
 * message ID; a possibly consumed provider turn is never automatically retried.
 * Scheduling lives with the app's bounded coordinator, not a retained view. */
export class CloudPromptChannel {
  snapshot: PromptJournalRecord;
  private loaded?: Promise<void>;
  private confirmed = false;
  get hasSnapshot(): boolean { return this.confirmed; }
  private preparing: Promise<unknown> = Promise.resolve();
  private flushing?: Promise<void>;
  private refreshing?: Promise<void>;
  private stopsPreparing = 0;
  constructor(readonly owner: CloudPromptOwner, private readonly journal: CloudPromptJournal, private readonly api: CloudPromptApi,
    private readonly current: () => boolean, private readonly changed: (record: PromptJournalRecord) => void) {
    this.snapshot = emptyPromptJournal(owner);
  }
  private assertOwner(): void { if (!this.current()) throw new Error("The cloud account or owner changed."); }
  private async load(): Promise<void> {
    this.loaded ??= this.journal.read(this.owner).then(value => { this.assertOwner(); this.snapshot = value; this.confirmed = true; this.changed(value); })
      .catch(error => { this.loaded = undefined; throw error; });
    await this.loaded;
  }
  private async edit(update: (record: PromptJournalRecord) => PromptJournalRecord): Promise<void> {
    this.assertOwner();
    const value = await this.journal.change(this.owner, record => { this.assertOwner(); return update(record); });
    if (!this.current()) return;
    this.snapshot = value; this.changed(value);
  }
  private ordered<T>(work: () => Promise<T>): Promise<T> {
    const next = this.preparing.then(work);
    this.preparing = next.catch(() => {}); return next;
  }
  enqueue(prepare: () => Promise<CloudV2Prompt>): Promise<string> {
    // Reserve order before attachment reads can yield. The composer releases
    // its draft only after this transaction commits, never on a cache write.
    return this.ordered(async () => {
      await this.load(); this.assertOwner();
      const payload = CloudV2PromptSchema.parse(await prepare()); this.assertOwner();
      if (payload.chatId !== this.owner.chatId) throw new Error("This message belongs to another conversation.");
      if (new TextEncoder().encode(JSON.stringify(payload)).length > CLOUD_V2_MAX_PROMPT_BYTES) throw new Error("This message is too large. Send fewer attachments.");
      await this.edit(record => {
        const existing = record.entries.find(entry => entry.payload.userMessageId === payload.userMessageId);
        if (existing) { if (!same(existing.payload, payload)) throw new Error("The saved message payload changed."); return record; }
        return { ...record, nextOrder: record.nextOrder + 1, entries: [...record.entries,
          { payload, order: record.nextOrder, phase: "pending", updatedAt: Date.now() }] };
      });
      return payload.userMessageId;
    });
  }
  stop(intent?: { id: string; turnId: string | null; requestedAt: number; startedAt: number }): Promise<void> {
    this.stopsPreparing++;
    return this.ordered(async () => {
      await this.load();
      await this.edit(record => {
        // A confirmed epoch fence may still await native retirement. Retrying
        // its observation cannot advance the epoch across a successor Send.
        if (!record.stop && intent && record.entries.some(entry => entry.cancelRequested && entry.payload.userMessageId === intent.turnId)) return record;
        return { ...record,
        stop: record.stop ? { ...record.stop, state: "pending" } : { id: intent?.id ?? crypto.randomUUID(), before: record.nextOrder,
          ...(intent ? { turnId: intent.turnId, requestedAt: intent.requestedAt } : {}) },
        entries: record.entries.map(entry => ({ ...entry,
          ...(!record.stop && entry.phase === "pending" && !entry.receipt ? { phase: "saved" as const, state: "cancelled" as const, updatedAt: Date.now() } : {}),
          ...(intent && entry.payload.userMessageId === intent.turnId ? { presentation: withCloudTurnPresentation(
            entry.presentation ? { [intent.turnId]: entry.presentation } : undefined, intent.turnId, {
              source: "stop", status: "cancelled", stopReason: "cancelled", operationId: intent.id,
              startedAt: intent.startedAt, endedAt: intent.requestedAt,
            })[intent.turnId] } : {}),
        })),
      }; });
    }).finally(() => { this.stopsPreparing--; });
  }
  rememberPresentation(turnId: string, presentation: CloudTurnPresentation): Promise<void> {
    const entry = this.snapshot.entries.find(entry => entry.payload.userMessageId === turnId);
    if (!entry || same(entry.presentation, presentation)) return Promise.resolve();
    return this.edit(record => ({ ...record, entries: record.entries.map(entry => entry.payload.userMessageId === turnId ? {
      ...entry, presentation: withCloudTurnPresentation(entry.presentation ? { [turnId]: entry.presentation } : undefined, turnId, presentation)[turnId],
    } : entry) }));
  }
  unconfirmedStop(id: string): Promise<void> {
    return this.edit(record => record.stop?.id === id ? { ...record, stop: { ...record.stop, state: "unconfirmed" } } : record);
  }
  get needsDelivery(): boolean {
    return !!this.snapshot.stop || this.snapshot.entries.some(entry => entry.phase === "pending" || entry.phase === "uncertain");
  }
  get pending(): boolean {
    return this.needsDelivery || this.snapshot.entries.some(entry => entry.receipt && !promptTerminal(entry.state));
  }
  private ownsReceipt(receipt: CloudV2PromptReceipt, id?: string): void {
    if (receipt.workspaceId !== this.owner.workspaceId || receipt.chatId !== this.owner.chatId || id && receipt.userMessageId !== id)
      throw new Error("Cloud returned another conversation's receipt.");
  }
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.deliver().finally(() => { this.flushing = undefined; }); return this.flushing;
  }
  private async deliver(): Promise<void> {
    await this.load();
    for (;;) {
      if (!this.current() || this.stopsPreparing) return;
      const fence = this.snapshot.stop;
      const entry = this.snapshot.entries.find(value => (value.phase === "pending" || value.phase === "uncertain") &&
        (!fence || value.order < fence.before));
      if (entry) {
        const id = entry.payload.userMessageId;
        // A crash after this fsync retries the exact payload, including if the
        // control plane committed it before the response was lost.
        await this.edit(record => ({ ...record, entries: record.entries.map(value => value.payload.userMessageId === id
          ? { ...value, phase: "uncertain", updatedAt: Date.now() } : value) }));
        try {
          this.assertOwner(); const receipt = await this.api.enqueue(entry.payload); this.ownsReceipt(receipt, id);
          if (!this.current()) return;
          await this.edit(record => ({ ...record, entries: record.entries.map(value => value.payload.userMessageId === id && !value.receipt
            ? { ...value, receipt, phase: "saved", state: value.state ?? "queued", failure: undefined, updatedAt: Date.now() } : value) }));
        } catch (error) {
          if (!this.current()) return;
          await this.edit(record => ({ ...record, entries: record.entries.map(value => value.payload.userMessageId === id && !value.receipt
            ? { ...value, phase: definitive(error) ? "refused" : "uncertain", failure: definitive(error) ? refusal(error)
              : "Saved on this device. Delivery will resume when connected.", updatedAt: Date.now() } : value) }));
          if (!definitive(error)) return;
        }
        continue;
      }
      if (!fence) return;
      try {
        if (fence.throughEpoch === undefined) {
          const page = await this.api.list("0", false); this.assertOwner();
          await this.edit(record => ({ ...record, epoch: page.epoch, stop: record.stop?.id === fence.id ? { ...record.stop, throughEpoch: page.epoch } : record.stop }));
        }
        const stop = this.snapshot.stop; if (!stop) continue;
        this.assertOwner(); const reply = await this.api.stop(stop.throughEpoch!);
        if (reply.chatId !== this.owner.chatId) throw new Error("Invalid conversation Stop receipt.");
        if (!this.current()) return;
        await this.edit(record => ({ ...record, epoch: reply.epoch, stop: record.stop?.id === stop.id ? undefined : record.stop,
          entries: record.entries.map(value => value.receipt && BigInt(value.receipt.epoch) < BigInt(reply.epoch) && !promptTerminal(value.state)
            ? { ...value, cancelRequested: true, ...(value.state === "queued" || value.state === "inboxed" ? { state: "cancelled" as const } : {}), updatedAt: Date.now() } : value) }));
      } catch (error) {
        if (!this.current()) return;
        await this.edit(record => record.stop?.id === fence.id ? { ...record,
          stop: { ...record.stop, state: definitive(error) ? "failed" : "unconfirmed" },
          entries: definitive(error) ? record.entries.map(entry => entry.presentation?.source === "stop" && entry.presentation.operationId === fence.id
            ? { ...entry, presentation: { startedAt: entry.presentation.startedAt, status: "running", source: "send" } } : entry) : record.entries,
        } : record);
        return; // The persisted fence still precedes every future send.
      }
    }
  }
  refresh(includePayload = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.readStatus(includePayload).finally(() => { this.refreshing = undefined; }); return this.refreshing;
  }
  private async readStatus(includePayload: boolean): Promise<void> {
    await this.load(); this.assertOwner();
    const outstanding = this.snapshot.entries.filter(entry => entry.receipt && !promptTerminal(entry.state)).map(entry => BigInt(entry.receipt!.sequence) - 1n);
    let after = includePayload ? "0" : outstanding.reduce((min, value) => value < min ? value : min, BigInt(this.snapshot.cursor)).toString();
    for (let pages = 0; pages < 100; pages++) {
      this.assertOwner(); let page = await this.api.list(after, includePayload); this.assertOwner();
      // Another device may have sent while this one was open. Fetch its bytes
      // once; routine pending-state polls never retransmit attachment bodies.
      if (!includePayload && page.items.some(row => row.state !== "completed" && !this.snapshot.entries.some(entry => entry.payload.userMessageId === row.receipt.userMessageId))) {
        page = await this.api.list(after, true); this.assertOwner();
      }
      for (const row of page.items) this.ownsReceipt(row.receipt);
      await this.edit(record => {
        // A status read may predate a concurrently committed Stop. Epochs and
        // terminal receipts only move forward; delayed pages cannot revive it.
        if (BigInt(page.epoch) < BigInt(record.epoch)) return record;
        const entries = [...record.entries]; let nextOrder = record.nextOrder, cursor = record.cursor;
        for (const row of page.items) {
          const index = entries.findIndex(value => value.payload.userMessageId === row.receipt.userMessageId), previous = entries[index];
          if (row.payload && (row.payload.chatId !== this.owner.chatId || row.payload.userMessageId !== row.receipt.userMessageId)) throw new Error("Invalid saved cloud message.");
          if (BigInt(row.receipt.sequence) > BigInt(cursor)) cursor = row.receipt.sequence;
          // Completed native history is not retry storage. Importing it can
          // consume the private quota before a newer pending receipt is read.
          if (!previous && row.state === "completed") continue;
          const payload = previous?.payload ?? row.payload; if (!payload) continue;
          if (previous && promptTerminal(previous.state)) continue;
          const rank = { queued: 0, inboxed: 1, dispatching: 2, accepted: 3, completed: 4, failed: 4, cancelled: 4, interrupted: 4 };
          if (previous?.state && rank[previous.state] > rank[row.state]) continue;
          if (previous && previous.state === row.state && previous.cancelRequested === row.cancelRequested && previous.phase === "saved") continue;
          const next: PromptJournalEntry = { ...previous, payload, order: previous?.order ?? nextOrder++, phase: "saved", receipt: row.receipt,
            state: row.state, cancelRequested: row.cancelRequested, failure: undefined, updatedAt: Date.now() };
          if (index < 0) entries.push(next); else entries[index] = next;
        }
        return { ...record, epoch: page.epoch, cursor, entries, nextOrder };
      });
      if (!page.nextAfter) return;
      if (BigInt(page.nextAfter) <= BigInt(after)) throw new Error("Invalid cloud receipt cursor.");
      after = page.nextAfter;
    }
    throw new Error("Too many cloud receipts to load.");
  }
}
