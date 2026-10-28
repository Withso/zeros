import { DESIGN_LAZY_PREPARATION_CAPABILITY, designCatalogOwnerSchema, type DesignCatalogOwner } from "@zeros/protocol/design-catalog";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";
import { getActiveBridge } from "../../../platform/bridge/active-bridge";
import { isCloudWorkspace } from "../../../platform/bridge/cloud-workspace-key";
import { workspaceOp } from "../../../platform/bridge/workspace-bridge";
import { isDesignWorkspaceSnapshotWire, type DesignWorkspaceSnapshotWire } from "../../../platform/bridge/design-bridge";
import { DesignCatalogReadAdapter } from "./design-catalog-read-adapter";

let intent = 0;
const readers = new WeakMap<RuntimeClient, DesignCatalogReadAdapter>();
/** An unsupported/legacy layout gets one aggregate read through the ordinary
 * keyed snapshot cache. Transport/authority failures never cause a scan. */
export async function readDesignNavigation(workspaceId: string, previous?: DesignWorkspaceSnapshotWire): Promise<DesignWorkspaceSnapshotWire | null> {
  if (isCloudWorkspace(workspaceId)) return null;
  const bridge = getActiveBridge();
  if (!bridge?.supportsEngineCapability?.(DESIGN_LAZY_PREPARATION_CAPABILITY, workspaceId)) return null;
  const controller = new AbortController();
  const off = bridge.onStatusChange((status) => { if (status !== "connected") controller.abort(); });
  let reader = readers.get(bridge);
  if (!reader) readers.set(bridge, (reader = new DesignCatalogReadAdapter(bridge)));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await workspaceOp(bridge, "design.navigation.read", { workspaceId }, 15_000) as {
        unavailable?: string; snapshot?: DesignWorkspaceSnapshotWire; owner?: DesignCatalogOwner; catalogRevision?: string;
      };
      controller.signal.throwIfAborted();
      if (getActiveBridge() !== bridge) throw new Error("Design navigation connection was retired.");
      if (raw.unavailable === "unsupported-layout" || raw.unavailable === "unsettled") return null;
      if (raw.unavailable === "stale" && attempt === 0) continue;
      const owner = designCatalogOwnerSchema.parse(raw.owner);
      if (owner.placement !== "local" || owner.workspaceId !== workspaceId ||
        !isDesignWorkspaceSnapshotWire(raw.snapshot) || raw.snapshot.directoryId !== owner.directoryId ||
        raw.snapshot.frames.length !== 0 || !/^[a-f0-9]{64}$/.test(raw.catalogRevision ?? ""))
        throw new Error("Invalid Design navigation response.");
      const authority = { owner, signal: controller.signal,
        isCurrent: () => getActiveBridge() === bridge && !controller.signal.aborted };
      const result = await reader.read(authority, ++intent);
      reader.retire(authority);
      controller.signal.throwIfAborted();
      if (result.status !== "coherent") {
        if (result.reason === "unsupported-layout" || result.reason === "unsettled") return null;
        if (result.reason === "stale" && attempt === 0) continue;
        throw new Error(`Design catalog is ${result.reason}.`);
      }
      if (result.catalog.revision !== raw.catalogRevision) {
        if (attempt === 0) continue;
        throw new Error("The Design catalog changed while opening.");
      }
      const descriptions = result.catalog.frames.map((frame) => ({
        preparation: "unprepared" as const, file: frame.source, frameId: frame.id, pageId: frame.pageId,
        title: frame.title, kind: frame.kind === "text" ? "text" as const : "frame" as const,
        x: frame.x, y: frame.y, width: frame.width, height: frame.height, z: frame.z,
      }));
      const available = new Map(descriptions.map((frame) => [frame.file, frame]));
      if (raw.snapshot.pages?.length !== result.catalog.pages.length || result.catalog.pages.some((page, index) => {
        const summary = raw.snapshot!.pages![index];
        const files = descriptions.filter((frame) => frame.pageId === page.id).map((frame) => frame.file);
        return !summary || summary.id !== page.id || summary.folder !== page.folder || summary.title !== page.title ||
          summary.frameFiles.length !== files.length || summary.frameFiles.some((file, offset) => file !== files[offset]);
      })) throw new Error("Invalid Design catalog page membership.");
      // Keep confirmed same-owner pixels only. They stay unprepared until the
      // source/dependency read finishes, even when metadata revision is equal.
      const frames = previous?.directoryId === owner.directoryId && previous.lint.workspacePath === raw.snapshot.lint.workspacePath
        ? previous.frames.filter((frame) => {
          const description = available.get(frame.file);
          return description && description.frameId === frame.frameId;
        }) : [];
      return { ...raw.snapshot, frames, preparation: { revision: result.catalog.revision, epoch: ++intent,
        descriptions, current: [], errors: {} } };
    }
    throw new Error("The Design catalog changed while opening.");
  } finally { controller.abort(); off(); }
}

export interface DesignPreparationDemand { workspaceId: string; files: readonly string[] }
export interface DesignPreparationDeps {
  snapshot(workspaceId: string): DesignWorkspaceSnapshotWire | undefined;
  publish(workspaceId: string, snapshot: DesignWorkspaceSnapshotWire): void;
  canPrepare(workspaceId: string): boolean;
  prepare(workspaceId: string, directoryId: string, revision: string, files: readonly string[]): Promise<{
    frames: DesignWorkspaceSnapshotWire["frames"]; errors: Array<{ file: string; message: string }>; catalogRevision: string;
  }>;
}

type PreparationReply = Awaited<ReturnType<DesignPreparationDeps["prepare"]>>;
type Demand = { token: object; input: DesignPreparationDemand; activation: number };
const BATCH_SIZE = 16;
const MAX_REVALIDATED_FRAMES = 256;

/** Only engine results for this exact catalog become prepared generations. */
function applyPreparedFrames(snapshot: DesignWorkspaceSnapshotWire, files: readonly string[], result: PreparationReply, requested = new Set(files)): DesignWorkspaceSnapshotWire {
  const preparation = snapshot.preparation!;
  if (result.catalogRevision !== preparation.revision ||
    result.frames.length + result.errors.length !== files.length ||
    new Set([...result.frames, ...result.errors].map(frame => frame.file)).size !== files.length ||
    [...result.frames, ...result.errors].some(frame => !files.includes(frame.file)))
    throw new Error("Incomplete Design preparation response.");
  const descriptions = new Map(preparation.descriptions.map(frame => [frame.file, frame]));
  if (result.frames.some(frame => {
    const description = descriptions.get(frame.file);
    return !description || (["frameId", "pageId", "title", "x", "y", "width", "height", "z"] as const)
      .some(key => description[key] !== frame[key]) || (description.kind ?? "frame") !== (frame.kind ?? "frame");
  })) throw new Error("Design preparation belongs to different metadata.");
  const frames = result.frames.filter(frame => requested.has(frame.file));
  const byFile = new Map(snapshot.frames.map(frame => [frame.file, frame]));
  for (const frame of frames) byFile.set(frame.file, frame);
  return { ...snapshot,
    frames: preparation.descriptions.flatMap(frame => byFile.get(frame.file) ?? []),
    preparation: { ...preparation, current: [...new Set([...preparation.current, ...frames.map(frame => frame.file)])],
      errors: { ...preparation.errors, ...Object.fromEntries(result.errors.filter(frame => requested.has(frame.file)).map(frame => [frame.file, frame.message])) } },
  };
}

function pendingFiles(snapshot: DesignWorkspaceSnapshotWire, demand: Demand): string[] {
  const preparation = snapshot.preparation!;
  const available = new Set(preparation.descriptions.map(frame => frame.file));
  const current = new Set(preparation.current);
  return [...new Set(demand.input.files)].filter(file => available.has(file) && !current.has(file) && !Object.hasOwn(preparation.errors, file));
}

/** One bounded preparation lane, latest demand only. A retired reply cannot
 * publish over a watcher, mutation response, page or directory replacement. */
export class DesignFramePreparation {
  private demand: Demand | null = null;
  private activation = 0;
  private running: Promise<PreparationReply> | null = null;
  private revalidating = 0;
  private preparations = 0;
  constructor(private readonly deps: DesignPreparationDeps) {}
  usage() { return { running: this.running ? 1 : 0, prepared: this.preparations, demanded: this.demand?.input.files.length ?? 0 }; }
  setDemand(token: object, input: DesignPreparationDemand | null): void {
    if (!input) { if (this.demand?.token === token) this.demand = null; return; }
    const activation = this.demand?.token === token && this.demand.input.workspaceId === input.workspaceId
      ? this.demand.activation : ++this.activation;
    this.demand = { token, input, activation };
    this.pump();
  }
  resume(): void { this.pump(); }

  /** Validate a warm surface before publishing its navigation result. The
   * caller's cache retains its confirmed aggregate throughout the source read.
   * Equal catalog metadata never carries old source authority forward. */
  async revalidate(workspaceId: string, navigation: DesignWorkspaceSnapshotWire, isCurrent: () => boolean): Promise<DesignWorkspaceSnapshotWire> {
    if (!navigation.preparation || !navigation.directoryId || isCloudWorkspace(workspaceId)) return navigation;
    let next = navigation;
    this.revalidating++;
    try {
      // The normal document bound caps work even if demand changes constantly.
      for (let attempted = 0; attempted < MAX_REVALIDATED_FRAMES;) {
        const demand = this.demand;
        if (!isCurrent() || demand?.input.workspaceId !== workspaceId) return next;
        const files = pendingFiles(next, demand).slice(0, Math.min(BATCH_SIZE, MAX_REVALIDATED_FRAMES - attempted));
        if (!files.length) break;
        let result: PreparationReply | null;
        try {
          result = await this.prepare(workspaceId, next, files, () => isCurrent() && this.owns(demand));
        } catch (error) {
          // A failed retired read has no more authority than a successful one.
          // Keep current failures actionable, but let a new visit/selection
          // validate its own source instead of inheriting the old error.
          if (isCurrent() && this.owns(demand) && files.some(file => this.demand!.input.files.includes(file))) throw error;
          result = null;
        }
        attempted += files.length;
        if (!isCurrent()) return navigation;
        if (!this.owns(demand)) {
          // A returning A has a new activation, even with the same token and
          // catalog. Its source read cannot adopt the retired visit's reply.
          next = navigation;
          continue;
        }
        if (result) {
          next = applyPreparedFrames(next, files, result, new Set(this.demand!.input.files));
          this.preparations += result.frames.length;
        }
      }
      return next;
    } finally { this.revalidating--; this.pump(); }
  }

  private owns(demand: Demand): boolean {
    return this.demand?.token === demand.token && this.demand.activation === demand.activation;
  }

  private async prepare(workspaceId: string, snapshot: DesignWorkspaceSnapshotWire, files: readonly string[], current: () => boolean): Promise<PreparationReply | null> {
    // Revalidation shares the cold-preparation lane. A retired waiter cannot
    // begin another engine read, including after an A → B → A round trip.
    while (this.running) await this.running.catch(() => {});
    if (!current()) return null;
    const running = this.deps.prepare(workspaceId, snapshot.directoryId!, snapshot.preparation!.revision, files);
    this.running = running;
    try { return await running; }
    finally { if (this.running === running) this.running = null; }
  }

  private pump(): void {
    const demand = this.demand;
    if (this.running || this.revalidating || !demand || !this.deps.canPrepare(demand.input.workspaceId)) return;
    const { workspaceId } = demand.input;
    const snapshot = this.deps.snapshot(workspaceId);
    const preparation = snapshot?.preparation;
    if (!snapshot?.directoryId || !preparation) return;
    const files = pendingFiles(snapshot, demand).slice(0, BATCH_SIZE);
    if (!files.length) return;
    void this.prepare(workspaceId, snapshot, files, () => this.owns(demand) && this.deps.canPrepare(workspaceId)).then(result => {
      const current = this.deps.snapshot(workspaceId);
      if (!result || current?.preparation?.epoch !== preparation.epoch || current.directoryId !== snapshot.directoryId ||
        !this.deps.canPrepare(workspaceId) || !this.owns(demand)) return;
      const requested = new Set(this.demand!.input.files);
      const next = applyPreparedFrames(current, files, result, requested);
      this.preparations += result.frames.filter(frame => requested.has(frame.file)).length;
      this.deps.publish(workspaceId, next);
    }).catch((error: unknown) => {
      const current = this.deps.snapshot(workspaceId);
      if (current?.preparation?.epoch !== preparation.epoch || !this.owns(demand) || !this.deps.canPrepare(workspaceId)) return;
      this.deps.publish(workspaceId, { ...current, preparation: { ...current.preparation,
        errors: { ...current.preparation.errors, ...Object.fromEntries(files.map(file => [file, error instanceof Error ? error.message : "Could not prepare this frame."])) },
      } });
    }).finally(() => { this.pump(); });
  }
}
