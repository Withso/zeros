import {
  DESIGN_CATALOG_BATCH_BYTES,
  DESIGN_CATALOG_BATCH_ENTRIES,
  DESIGN_CATALOG_DESCRIPTOR_LIMIT,
  designCatalogOwnerSchema,
  type DesignCatalogBatch,
  type DesignCatalogFailure,
  type DesignCatalogFrame,
  type DesignCatalogOwner,
  type DesignCatalogPage,
} from "@zeros/protocol/design-catalog";
import { portableDesignName } from "@zeros/protocol/design-path";
import { bridgeDesignCatalog } from "../../../platform/bridge/design-catalog-bridge";
import type { WorkspaceRuntimeClient } from "../../../platform/bridge/workspace-runtime-client";

export interface DesignCatalogReadAuthority {
  readonly owner: Readonly<DesignCatalogOwner>;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface CoherentDesignCatalog {
  readonly kind: "coherent-design-catalog";
  readonly owner: Readonly<DesignCatalogOwner>;
  readonly binding: string;
  readonly revision: string;
  readonly pages: readonly Readonly<DesignCatalogPage>[];
  readonly frames: readonly Readonly<DesignCatalogFrame>[];
}

export interface DesignCatalogReadLimits {
  readonly maxOwners: number;
  readonly maxReads: number;
  readonly maxOwnedDescriptors: number;
  readonly maxBytes: number;
  readonly maxSnapshotBytes: number;
  readonly maxRoundTrips: number;
  readonly maxTransferBytes: number;
  readonly maxDurationMs: number;
}

type FailureReason =
  | DesignCatalogFailure["reason"]
  | "cancelled"
  | "retired"
  | "invalid"
  | "transport";
export type DesignCatalogAssemblyResult =
  | { status: "coherent"; catalog: CoherentDesignCatalog }
  | { status: "unavailable"; reason: FailureReason };

const LIMITS: DesignCatalogReadLimits = {
  maxOwners: 4,
  maxReads: 4,
  maxOwnedDescriptors: 40_000,
  maxBytes: 32 * 1024 * 1024,
  maxSnapshotBytes: 8 * 1024 * 1024,
  maxRoundTrips: 10_000,
  maxTransferBytes: 32 * 1024 * 1024,
  maxDurationMs: 60_000,
};
const RESPONSE_RESERVE = DESIGN_CATALOG_BATCH_BYTES * 8;
const unavailable = (reason: FailureReason): DesignCatalogAssemblyResult => ({
  status: "unavailable",
  reason,
});
const same = <T extends object>(a: T, b: T) => {
  const keys = Object.keys(a) as (keyof T)[];
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key])
  );
};

interface Entry {
  authority: DesignCatalogReadAuthority;
  owner: Readonly<DesignCatalogOwner>;
  metadataBytes: number;
  binding: string | null;
  intent: number;
  catalog: CoherentDesignCatalog | null;
  catalogBytes: number;
  authoritative: boolean;
  publicationSignal?: AbortSignal;
  active: ReadTask | null;
  stop: () => void;
}
interface ReadTask {
  entry: Entry;
  intent: number;
  signal?: AbortSignal;
  promise: Promise<DesignCatalogAssemblyResult>;
  resolve: (value: DesignCatalogAssemblyResult) => void;
  retired: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  stop: () => void;
  started: number;
  header: Pick<
    DesignCatalogBatch,
    "owner" | "binding" | "revision" | "pages" | "total"
  > | null;
  frames: Readonly<DesignCatalogFrame>[];
  ids: Set<string>;
  sources: Set<string>;
  cursors: Set<string>;
  cursorBytes: number;
  dataBytes: number;
  reserved: boolean;
}

export class DesignCatalogReadAdapter {
  private readonly limits: DesignCatalogReadLimits;
  private readonly entries = new Map<DesignCatalogReadAuthority, Entry>();
  private readonly work = new Set<ReadTask>();

  constructor(
    private readonly bridge: WorkspaceRuntimeClient,
    limits: Partial<DesignCatalogReadLimits> = {},
  ) {
    const configured = { ...LIMITS };
    for (const key of Object.keys(LIMITS) as (keyof DesignCatalogReadLimits)[])
      if (Object.hasOwn(limits, key)) configured[key] = limits[key]!;
    if (
      Object.entries(LIMITS).some(([key, max]) => {
        const value = configured[key as keyof DesignCatalogReadLimits];
        return !Number.isSafeInteger(value) || value < 1 || value > max;
      })
    )
      throw new RangeError("Design catalog consumer limits are invalid.");
    this.limits = Object.freeze(configured);
  }

  private current(entry: Entry): boolean {
    try {
      return (
        !entry.authority.signal.aborted &&
        entry.authority.isCurrent() &&
        same(entry.owner, entry.authority.owner)
      );
    } catch {
      return false;
    }
  }

  peek(authority: DesignCatalogReadAuthority): CoherentDesignCatalog | null {
    const entry = this.entries.get(authority);
    if (!entry) return null;
    if (!this.current(entry)) {
      this.retire(authority);
      return null;
    }
    this.entries.delete(authority);
    this.entries.set(authority, entry);
    return entry.catalog;
  }

  isAuthoritative(
    authority: DesignCatalogReadAuthority,
    catalog: CoherentDesignCatalog,
  ): boolean {
    const current = this.peek(authority);
    const entry = this.entries.get(authority);
    return (
      current === catalog &&
      entry?.authoritative === true &&
      !entry.publicationSignal?.aborted
    );
  }

  retire(authority: DesignCatalogReadAuthority): void {
    const entry = this.entries.get(authority);
    if (!entry) return;
    this.entries.delete(authority);
    entry.stop();
    entry.catalog = null;
    entry.catalogBytes = 0;
    entry.authoritative = false;
    entry.publicationSignal = undefined;
    for (const task of this.work)
      if (task.entry === entry) this.cancel(task, "retired");
  }

  getUsage() {
    const owners = new Set([
      ...this.entries.values(),
      ...[...this.work].map((task) => task.entry),
    ]);
    let descriptors = 0,
      bytes = 0;
    for (const entry of owners) {
      bytes += entry.metadataBytes + entry.catalogBytes;
      descriptors += entry.catalog?.frames.length ?? 0;
    }
    for (const task of this.work) {
      descriptors += task.frames.length;
      bytes +=
        task.dataBytes +
        task.cursorBytes +
        (task.reserved ? RESPONSE_RESERVE : 0);
    }
    return {
      owners: owners.size,
      reads: this.work.size,
      retiredReads: [...this.work].filter((task) => task.retired).length,
      descriptors,
      bytes,
    };
  }

  private fits(
    bytes: number,
    descriptors: number,
    owners: number,
    except?: Entry,
  ): boolean {
    const within = () => {
      const usage = this.getUsage();
      return (
        usage.bytes + bytes <= this.limits.maxBytes &&
        usage.descriptors + descriptors <= this.limits.maxOwnedDescriptors &&
        usage.owners + owners <= this.limits.maxOwners
      );
    };
    for (const entry of this.entries.values()) {
      if (within()) return true;
      if (entry !== except && !entry.active) this.retire(entry.authority);
    }
    return within();
  }

  private cancel(task: ReadTask, reason: FailureReason): void {
    if (task.retired) return;
    task.retired = true;
    task.stop();
    if (task.timer !== null) clearTimeout(task.timer);
    task.timer = null;
    task.resolve(unavailable(reason));
  }

  read(
    authority: DesignCatalogReadAuthority,
    intent: number,
    signal?: AbortSignal,
  ): Promise<DesignCatalogAssemblyResult> {
    const owner = designCatalogOwnerSchema.safeParse(authority.owner);
    if (!owner.success || !Number.isSafeInteger(intent) || intent < 0)
      return Promise.resolve(unavailable("invalid"));
    if (signal?.aborted) return Promise.resolve(unavailable("cancelled"));
    let entry = this.entries.get(authority);
    if (entry && !this.current(entry)) this.retire(authority);
    try {
      if (authority.signal.aborted || !authority.isCurrent())
        return Promise.resolve(unavailable("retired"));
    } catch {
      return Promise.resolve(unavailable("retired"));
    }
    for (const candidate of this.entries.values())
      if (!this.current(candidate)) this.retire(candidate.authority);
    entry = this.entries.get(authority);
    if (!entry) {
      const metadataBytes = JSON.stringify(owner.data).length * 2 + 128;
      if (!this.fits(metadataBytes, 0, 1))
        return Promise.resolve(unavailable("busy"));
      entry = {
        authority,
        owner: Object.freeze(owner.data),
        metadataBytes,
        binding: null,
        intent: -1,
        catalog: null,
        catalogBytes: 0,
        authoritative: false,
        active: null,
        stop: () => {},
      };
      const abort = () => this.retire(authority);
      authority.signal.addEventListener("abort", abort, { once: true });
      entry.stop = () => authority.signal.removeEventListener("abort", abort);
      this.entries.set(authority, entry);
    }
    if (intent < entry.intent)
      return Promise.resolve(unavailable("superseded"));
    if (intent === entry.intent) {
      if (
        entry.active &&
        !entry.active.retired &&
        entry.active.signal === signal
      )
        return entry.active.promise;
      if (
        entry.authoritative &&
        entry.catalog &&
        entry.publicationSignal === signal &&
        !entry.publicationSignal?.aborted
      )
        return Promise.resolve({ status: "coherent", catalog: entry.catalog });
      return Promise.resolve(unavailable("superseded"));
    }
    entry.intent = intent;
    entry.authoritative = false;
    if (entry.active) this.cancel(entry.active, "superseded");
    if (
      this.work.size >= this.limits.maxReads ||
      !this.fits(RESPONSE_RESERVE, 0, 0, entry)
    )
      return Promise.resolve(unavailable("busy"));
    let resolve!: ReadTask["resolve"];
    const promise = new Promise<DesignCatalogAssemblyResult>((done) => {
      resolve = done;
    });
    const task: ReadTask = {
      entry,
      intent,
      signal,
      promise,
      resolve,
      retired: false,
      timer: null,
      stop: () => {},
      started: performance.now(),
      header: null,
      frames: [],
      ids: new Set(),
      sources: new Set(),
      cursors: new Set(),
      cursorBytes: 0,
      dataBytes: 0,
      reserved: true,
    };
    const abort = () => this.cancel(task, "cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    task.stop = () => signal?.removeEventListener("abort", abort);
    task.timer = setTimeout(
      () => this.cancel(task, "expired"),
      this.limits.maxDurationMs,
    );
    entry.active = task;
    this.work.add(task);
    void this.run(task);
    return promise;
  }

  private async run(task: ReadTask): Promise<void> {
    const entry = task.entry;
    let cursor: string | undefined;
    let transferBytes = 0;
    try {
      for (let trip = 0; trip < this.limits.maxRoundTrips; trip++) {
        if (task.retired) return;
        if (
          !this.current(entry) ||
          this.entries.get(entry.authority) !== entry ||
          entry.active !== task
        ) {
          this.cancel(task, "retired");
          return;
        }
        if (performance.now() - task.started >= this.limits.maxDurationMs) {
          this.cancel(task, "expired");
          return;
        }
        if (!task.reserved && !this.fits(RESPONSE_RESERVE, 0, 0, entry)) {
          this.cancel(task, "too-large");
          return;
        }
        task.reserved = true;
        const reply = await bridgeDesignCatalog(
          this.bridge,
          {
            version: 1,
            workspaceId: entry.owner.workspaceId,
            directoryId: entry.owner.directoryId,
            intent: task.intent,
            ...(cursor !== undefined ? { cursor } : {}),
            limit: DESIGN_CATALOG_BATCH_ENTRIES,
          },
          entry.owner,
        );
        if (task.retired) return;
        if (
          !this.current(entry) ||
          this.entries.get(entry.authority) !== entry ||
          entry.active !== task
        ) {
          this.cancel(task, "retired");
          return;
        }
        if (performance.now() - task.started >= this.limits.maxDurationMs) {
          this.cancel(task, "expired");
          return;
        }
        if (reply.status === "unavailable") {
          this.cancel(task, reply.reason);
          return;
        }
        if (entry.binding !== null && entry.binding !== reply.binding) {
          this.retire(entry.authority);
          return;
        }
        transferBytes += new TextEncoder().encode(
          JSON.stringify(reply),
        ).byteLength;
        if (transferBytes > this.limits.maxTransferBytes) {
          this.cancel(task, "too-large");
          return;
        }
        const previous = task.header;
        if (
          reply.offset !== task.frames.length ||
          (previous &&
            (reply.binding !== previous.binding ||
              reply.revision !== previous.revision ||
              reply.total !== previous.total ||
              !same(reply.owner, previous.owner) ||
              reply.pages.length !== previous.pages.length ||
              reply.pages.some(
                (page, index) => !same(page, previous.pages[index]!),
              )))
        ) {
          this.cancel(task, "invalid");
          return;
        }
        if (reply.nextCursor !== null && task.cursors.has(reply.nextCursor)) {
          this.cancel(task, "invalid");
          return;
        }
        const added = reply.frames.reduce(
          (sum, frame, index) =>
            sum +
            JSON.stringify(frame).length * 2 +
            (task.frames.length + index ? 2 : 0),
          0,
        );
        const header = previous ?? {
          owner: Object.freeze(reply.owner),
          binding: reply.binding,
          revision: reply.revision,
          pages: reply.pages.map((page) => Object.freeze(page)),
          total: reply.total,
        };
        const base = previous
          ? 0
          : JSON.stringify({
              kind: "coherent-design-catalog",
              owner: header.owner,
              binding: header.binding,
              revision: header.revision,
              pages: header.pages,
              frames: [],
            }).length * 2;
        const cursorBytes = reply.nextCursor?.length
          ? reply.nextCursor.length * 2
          : 0;
        if (
          task.frames.length + reply.frames.length >
            DESIGN_CATALOG_DESCRIPTOR_LIMIT ||
          task.dataBytes + task.cursorBytes + base + added + cursorBytes >
            this.limits.maxSnapshotBytes ||
          !this.fits(base + added + cursorBytes, reply.frames.length, 0, entry)
        ) {
          this.cancel(task, "too-large");
          return;
        }
        for (const frame of reply.frames) {
          const source = portableDesignName(frame.source);
          if (task.ids.has(frame.id) || task.sources.has(source)) {
            this.cancel(task, "invalid");
            return;
          }
          task.ids.add(frame.id);
          task.sources.add(source);
        }
        task.header = header;
        entry.binding = header.binding;
        task.dataBytes += base + added;
        task.cursorBytes += cursorBytes;
        task.frames.push(...reply.frames.map((frame) => Object.freeze(frame)));
        if (reply.nextCursor !== null) {
          task.cursors.add(reply.nextCursor);
          cursor = reply.nextCursor;
          task.reserved = false;
          continue;
        }
        if (task.frames.length !== header.total) {
          this.cancel(task, "invalid");
          return;
        }
        const old = entry.catalog;
        const byId = new Map(old?.frames.map((frame) => [frame.id, frame]));
        const frames = task.frames.map((frame) => {
          const previousFrame = byId.get(frame.id);
          return previousFrame && same(previousFrame, frame)
            ? previousFrame
            : frame;
        });
        const pages = header.pages.map((page, index) =>
          old?.pages[index] && same(old.pages[index]!, page)
            ? old.pages[index]!
            : page,
        );
        const stableFrames =
          old?.frames.length === frames.length &&
          frames.every((frame, index) => frame === old.frames[index])
            ? old.frames
            : Object.freeze(frames);
        const stablePages =
          old?.pages.length === pages.length &&
          pages.every((page, index) => page === old.pages[index])
            ? old.pages
            : Object.freeze(pages);
        if (
          old &&
          old.revision === header.revision &&
          (old.frames !== stableFrames || old.pages !== stablePages)
        ) {
          this.cancel(task, "invalid");
          return;
        }
        const catalog: CoherentDesignCatalog = Object.freeze({
          kind: "coherent-design-catalog",
          owner: header.owner,
          binding: header.binding,
          revision: header.revision,
          pages: stablePages,
          frames: stableFrames,
        });
        entry.catalog = catalog;
        entry.catalogBytes = task.dataBytes;
        entry.authoritative = true;
        entry.publicationSignal = task.signal;
        task.resolve({ status: "coherent", catalog });
        return;
      }
      this.cancel(task, "too-large");
    } catch {
      this.cancel(task, "transport");
    } finally {
      task.stop();
      if (task.timer !== null) clearTimeout(task.timer);
      task.timer = null;
      this.work.delete(task);
      if (entry.active === task) entry.active = null;
      task.frames = [];
      task.header = null;
      task.ids.clear();
      task.sources.clear();
      task.cursors.clear();
    }
  }
}
