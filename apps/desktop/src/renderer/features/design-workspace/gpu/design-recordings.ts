import { DESIGN_RECORDINGS_KNOWN_CHUNKS, DESIGN_RECORDINGS_RENDER_FRAMES, type DesignRecording, type DesignRecordingLayer,
  type DesignRecordingTypeface, type DesignRecordingsReadReply, type DesignRecordingsReply } from "./design-recordings-wire";
import type { DesignRecordingChunks } from "./design-recording-chunks";

export interface DesignRecordingsOwner {
  readonly workspaceId: string;
  readonly directoryId: string;
  readonly theme: string | null;
  /** The scheme frames are drawn in: a frame's light and dark recordings differ. */
  readonly colorScheme: "light" | "dark";
}

export function designRecordingsOwnerKey(owner: DesignRecordingsOwner): string {
  return JSON.stringify([owner.workspaceId, owner.directoryId, owner.theme, owner.colorScheme]);
}

/** A frame the canvas shows. Without a version the frame is still being
 * prepared: only its newest stored recording can cover it. */
export interface DesignRecordingDemand {
  readonly file: string;
  readonly sourceVersion?: string;
}

export interface DesignRecordingsSource {
  read(owner: DesignRecordingsOwner, frames: readonly DesignRecordingDemand[], knownChunks: readonly string[],
    signal: AbortSignal): Promise<DesignRecordingsReadReply>;
  render(owner: DesignRecordingsOwner, frames: ReadonlyArray<{ file: string; sourceVersion: string }>,
    knownChunks: readonly string[], signal: AbortSignal): Promise<DesignRecordingsReply>;
}

export interface DesignAdoptedRecording {
  readonly file: string;
  readonly sourceVersion: string;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly pipeline: string;
  readonly layers: readonly DesignRecordingLayer[];
  /** Externalized fonts the layers reference, in first-use order. */
  readonly typefaces: readonly string[];
  /** Content identity: equal recordings share one picture and one raster. */
  readonly key: string;
}

export type DesignPresentedRecording = DesignAdoptedRecording & { readonly current: boolean };

/** One timed step: its duration in ms, ending at epoch ms `at`. */
export interface DesignRecordingsTiming { readonly at: number; readonly ms: number }

/** One deferral per ask keeps a reply within one bridge frame; a frame that
 * never fits fails instead of being asked forever. */
const MAX_DEFERRALS = 4;
/** A transport or engine error is not a verdict on the frame. */
const RETRY_AFTER_ERROR_MS = 2_000;
/** A retryable failure is the attempt's, not the frame's: asked again after
 * each of these, then kept until the frame's version changes. */
const RETRY_FAILED_MS = [2_000, 4_000, 8_000];
const MAX_FRAMES_PER_OWNER = 8_192;
/** A stored-recording lookup is cheap; ask for more frames at once. */
const READ_FRAMES = 256;
const MAX_OWNERS = 4;
const MAX_TIMING_SAMPLES = 1_024;
const EMPTY: ReadonlySet<string> = new Set();

interface FrameState {
  wanted: string | undefined;
  confirmed: DesignAdoptedRecording | null;
  /** The engine stores no recording of this version (or, for an unprepared
   * frame, none at all): record it, or wait for a version. */
  storedMissing: string | null | undefined;
  failed: { version: string | null; error: string; retryable?: true } | null;
  /** Retryable failures of the wanted version so far. */
  retries: number;
  /** The engine reported this version's source moved on: wait for the new one. */
  superseded: string | null;
  retryAt: number;
  deferrals: number;
  pending: Request | null;
  /** The confirmed recording's bytes left the chunk cache. */
  stale: boolean;
}

interface Request {
  readonly op: "read" | "render";
  readonly files: readonly string[];
  readonly controller: AbortController;
  release(): void;
}

interface OwnerState {
  readonly key: string;
  readonly owner: DesignRecordingsOwner;
  readonly frames: Map<string, FrameState>;
  readonly typefaces: Map<string, DesignRecordingTypeface>;
  order: readonly string[];
  replied: boolean;
  pipeline: string | null;
  readonly inFlight: Set<Request>;
  retryTimer: unknown;
  /** Frames whose current version failed, stable until it changes. */
  failed: ReadonlySet<string>;
}

function contentKey(recording: Pick<DesignRecording, "width" | "height" | "scale" | "layers">): string {
  return `${recording.width}x${recording.height}@${recording.scale}|${recording.layers
    .map((layer) => `${layer.x},${layer.y},${layer.width},${layer.height}:${layer.chunks.join(".")}`).join("|")}`;
}

/** Exact-key recordings of the frames each canvas shows. Requests are
 * batched in the canvas's priority order; a reply for an owner that was
 * forgotten, or a frame no longer waiting for that version, cannot replace
 * newer state, and the last confirmed recording paints until its successor
 * is adopted. */
export class DesignRecordings {
  private readonly owners = new Map<string, OwnerState>();
  private readonly listeners = new Set<(key: string, files: readonly string[]) => void>();
  private readonly counts = { read: 0, render: 0, framesRequested: 0, recordingsAdopted: 0, failed: 0, deferred: 0, errors: 0 };
  private readonly samples = { read: [] as DesignRecordingsTiming[], render: [] as DesignRecordingsTiming[],
    adopt: [] as DesignRecordingsTiming[] };
  private readonly settling = new Set<Promise<void>>();

  constructor(private readonly deps: {
    source: DesignRecordingsSource;
    chunks: DesignRecordingChunks;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    /** Requests one owner keeps at the engine once its first reply landed. */
    inFlight?: number;
  }) {}

  subscribe(listener: (key: string, files: readonly string[]) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Replaces the owner's demand. Frames left out keep their confirmed
   * recordings but are no longer requested; a request none of whose frames
   * is still demanded is cancelled. */
  demand(owner: DesignRecordingsOwner, frames: readonly DesignRecordingDemand[]): void {
    const state = this.state(owner);
    const order: string[] = [];
    for (const frame of frames) {
      let entry = state.frames.get(frame.file);
      if (!entry) {
        entry = { wanted: frame.sourceVersion, confirmed: null, storedMissing: undefined, failed: null, retries: 0, superseded: null,
          retryAt: 0, deferrals: 0, pending: null, stale: false };
        state.frames.set(frame.file, entry);
      } else if (entry.wanted !== frame.sourceVersion) {
        entry.wanted = frame.sourceVersion;
        entry.deferrals = 0;
        entry.retries = 0;
        // The old version's retry wait doesn't hold back the new version.
        if (entry.failed?.retryable) entry.retryAt = 0;
      }
      order.push(frame.file);
    }
    state.order = order;
    const demanded = new Set(order);
    for (const request of [...state.inFlight])
      if (request.files.every((file) => !demanded.has(file))) request.controller.abort(new Error("Design recordings no longer shown."));
    this.prune(state, demanded);
    this.pump(state);
  }

  recording(owner: DesignRecordingsOwner, file: string): DesignPresentedRecording | null {
    const state = this.owners.get(designRecordingsOwnerKey(owner));
    const entry = state?.frames.get(file);
    if (!state || !entry?.confirmed) return null;
    return { ...entry.confirmed, current: this.current(state, entry) };
  }

  failure(owner: DesignRecordingsOwner, file: string): string | null {
    return this.owners.get(designRecordingsOwnerKey(owner))?.frames.get(file)?.failed?.error ?? null;
  }

  /** Demanded frames whose wanted version failed to record. */
  failedFiles(owner: DesignRecordingsOwner): ReadonlySet<string> {
    return this.owners.get(designRecordingsOwnerKey(owner))?.failed ?? EMPTY;
  }

  /** A layer's picture bytes, or null when its chunks left the cache; the
   * recording is then read again (claiming what is still held). */
  layerBytes(owner: DesignRecordingsOwner, file: string, layer: number): Uint8Array | null {
    const state = this.owners.get(designRecordingsOwnerKey(owner));
    const entry = state?.frames.get(file);
    const chunks = entry?.confirmed?.layers[layer]?.chunks;
    if (!state || !entry || !chunks) return null;
    const bytes = this.deps.chunks.assemble(chunks);
    if (bytes && bytes.length === entry.confirmed!.layers[layer]!.bytes) return bytes;
    this.markStale(state, (other) => other === entry);
    return null;
  }

  /** An externalized font's bytes for this owner, or null when its chunks left
   * the cache (the recordings using it are then read again). Callers verify
   * the content id before handing the bytes to CanvasKit. */
  typefaceBytes(owner: DesignRecordingsOwner, id: string): Uint8Array | null {
    const state = this.owners.get(designRecordingsOwnerKey(owner));
    const typeface = state?.typefaces.get(id);
    if (!state || !typeface) return null;
    const bytes = this.deps.chunks.assemble(typeface.chunks);
    if (bytes && bytes.length === typeface.bytes) return bytes;
    this.markStale(state, (entry) => !!entry.confirmed?.typefaces.includes(id));
    return null;
  }

  private markStale(state: OwnerState, matches: (entry: FrameState) => boolean): void {
    let changed = false;
    for (const entry of state.frames.values()) if (entry.confirmed && !entry.stale && matches(entry)) { entry.stale = true; changed = true; }
    if (changed) this.pump(state);
  }

  forgetWorkspaces(workspaceIds: readonly string[]): void {
    const removed = new Set(workspaceIds);
    for (const state of [...this.owners.values()]) if (removed.has(state.owner.workspaceId)) this.drop(state);
  }

  /** Bench timings: each answered request's round trip by operation, and
   * adopting its reply (chunk admission, hash checks, adoption). */
  timings(): Readonly<Record<"read" | "render" | "adopt", readonly DesignRecordingsTiming[]>> {
    return this.samples;
  }

  usage() {
    let inFlight = 0, frames = 0;
    for (const state of this.owners.values()) { inFlight += state.inFlight.size; frames += state.frames.size; }
    return { ...this.counts, owners: this.owners.size, frames, inFlight };
  }

  private state(owner: DesignRecordingsOwner): OwnerState {
    const key = designRecordingsOwnerKey(owner);
    let state = this.owners.get(key);
    if (state) {
      this.owners.delete(key);
      this.owners.set(key, state);
      return state;
    }
    state = { key, owner, frames: new Map(), typefaces: new Map(), order: [], replied: false, pipeline: null, inFlight: new Set(),
      retryTimer: null, failed: new Set() };
    this.owners.set(key, state);
    for (const other of this.owners.values()) {
      if (this.owners.size <= MAX_OWNERS) break;
      if (other !== state && !other.order.length && !other.inFlight.size) this.drop(other);
    }
    return state;
  }

  private drop(state: OwnerState): void {
    if (this.owners.get(state.key) !== state) return;
    this.owners.delete(state.key);
    for (const request of state.inFlight) request.controller.abort(new Error("Design recordings owner removed."));
    state.inFlight.clear();
    if (state.retryTimer !== null) this.deps.clearTimer?.(state.retryTimer);
    for (const entry of state.frames.values())
      if (entry.confirmed) this.deps.chunks.unreference(entry.confirmed.layers.flatMap((layer) => layer.chunks));
    for (const typeface of state.typefaces.values()) this.deps.chunks.unreference(typeface.chunks);
    state.frames.clear();
    state.typefaces.clear();
  }

  private prune(state: OwnerState, demanded: ReadonlySet<string>): void {
    if (state.frames.size <= MAX_FRAMES_PER_OWNER) return;
    for (const [file, entry] of state.frames) {
      if (state.frames.size <= MAX_FRAMES_PER_OWNER) break;
      if (demanded.has(file) || entry.pending) continue;
      if (entry.confirmed) this.deps.chunks.unreference(entry.confirmed.layers.flatMap((layer) => layer.chunks));
      state.frames.delete(file);
    }
  }

  private current(state: OwnerState, entry: FrameState): boolean {
    const confirmed = entry.confirmed;
    return !!confirmed && entry.wanted !== undefined && confirmed.sourceVersion === entry.wanted &&
      (state.pipeline === null || confirmed.pipeline === state.pipeline);
  }

  private need(state: OwnerState, entry: FrameState, now: number): "read" | "render" | null {
    if (entry.pending || entry.retryAt > now) return null;
    const version = entry.wanted ?? null;
    // A retryable failure is asked again once its wait (retryAt) is over.
    if (entry.failed && entry.failed.version === version && !entry.failed.retryable) return null;
    if (version !== null && entry.superseded === version) return null;
    if (version === null) return entry.stale || !entry.confirmed && entry.storedMissing !== null ? "read" : null;
    if (this.current(state, entry) && !entry.stale) return null;
    // A recording of another pipeline is still stored; only a new render replaces it.
    const otherPipeline = !!entry.confirmed && entry.confirmed.sourceVersion === version && !this.current(state, entry);
    return entry.storedMissing === version || otherPipeline ? "render" : "read";
  }

  private pump(state: OwnerState): void {
    if (this.owners.get(state.key) !== state) return;
    const now = this.deps.now?.() ?? Date.now();
    const limit = state.replied ? Math.max(1, this.deps.inFlight ?? 2) : 1;
    let nextRetry = Infinity;
    while (state.inFlight.size < limit) {
      let op: "read" | "render" | null = null;
      const files: string[] = [];
      for (const file of state.order) {
        const entry = state.frames.get(file)!;
        const need = this.need(state, entry, now);
        if (!need) {
          if (entry.retryAt > now) nextRetry = Math.min(nextRetry, entry.retryAt);
          continue;
        }
        op ??= need;
        if (need !== op) continue;
        files.push(file);
        if (files.length >= (op === "read" ? READ_FRAMES : DESIGN_RECORDINGS_RENDER_FRAMES)) break;
      }
      if (!op || !files.length) break;
      this.send(state, op, files);
    }
    if (nextRetry !== Infinity && state.retryTimer === null && this.deps.setTimer) {
      state.retryTimer = this.deps.setTimer(() => { state.retryTimer = null; this.pump(state); },
        Math.max(0, nextRetry - now));
    }
  }

  private send(state: OwnerState, op: "read" | "render", files: string[]): void {
    const entries = files.map((file) => state.frames.get(file)!);
    const frames = files.map((file, index) => {
      const version = entries[index]!.wanted;
      return version === undefined ? { file } : { file, sourceVersion: version };
    });
    // Chunks of the frames' previous recordings first: a re-recorded frame
    // usually repeats most of its bytes; then the most shared (fonts).
    const preferred = [...entries.flatMap((entry) => entry.confirmed?.layers.flatMap((layer) => layer.chunks) ?? []),
      ...[...state.typefaces.values()].flatMap((typeface) => typeface.chunks)];
    const known = this.deps.chunks.known(preferred, DESIGN_RECORDINGS_KNOWN_CHUNKS);
    const releaseKnown = this.deps.chunks.lease(known);
    const controller = new AbortController();
    const request: Request = { op, files, controller, release: releaseKnown };
    for (const entry of entries) entry.pending = request;
    state.inFlight.add(request);
    this.counts[op]++;
    this.counts.framesRequested += files.length;
    const sent = performance.now();
    const reply = op === "read"
      ? this.deps.source.read(state.owner, frames, known, controller.signal)
      : this.deps.source.render(state.owner, frames as Array<{ file: string; sourceVersion: string }>, known, controller.signal);
    const finish = () => {
      releaseKnown();
      state.inFlight.delete(request);
      for (const file of files) {
        const entry = state.frames.get(file);
        if (entry?.pending === request) entry.pending = null;
      }
      this.pump(state);
    };
    // Only a received reply joins `settled`: a request still at the engine
    // is not work this renderer can finish.
    void reply.then(
      (result) => {
        const received = performance.now();
        this.sample(op, received - sent);
        return this.track(this.adopt(state, request, result).finally(() => { this.sample("adopt", performance.now() - received); finish(); }));
      },
      (error: unknown) => this.track(Promise.resolve().then(() => this.settleError(state, request, error)).finally(finish)),
    );
  }

  private sample(series: keyof DesignRecordings["samples"], ms: number): void {
    const samples = this.samples[series];
    samples.push({ at: performance.timeOrigin + performance.now(), ms });
    if (samples.length > MAX_TIMING_SAMPLES) samples.splice(0, samples.length - MAX_TIMING_SAMPLES);
  }

  private track(work: Promise<void>): Promise<void> {
    const tracked = work.catch(() => {}).finally(() => this.settling.delete(tracked));
    this.settling.add(tracked);
    return tracked;
  }

  /** Resolves once every reply received so far has been adopted, including
   * requests those adoptions started. */
  async settled(): Promise<void> {
    // A reply resolved in this task still has its reaction queued.
    await Promise.resolve();
    while (this.settling.size) await Promise.allSettled([...this.settling]);
  }

  private async adopt(state: OwnerState, request: Request, reply: DesignRecordingsReply | DesignRecordingsReadReply): Promise<void> {
    if (this.owners.get(state.key) !== state || request.controller.signal.aborted) return;
    // Chunks claimed in knownChunks stay leased by the request until it settles.
    const { rejected, release } = await this.deps.chunks.admit(reply.chunks, { lease: true });
    try {
      if (this.owners.get(state.key) !== state || request.controller.signal.aborted) return;
      this.adoptVerified(state, request, reply, new Set(rejected));
    } finally { release(); }
  }

  private adoptVerified(state: OwnerState, request: Request, reply: DesignRecordingsReply | DesignRecordingsReadReply,
    rejected: ReadonlySet<string>): void {
    const asked = new Set(request.files);
    const changed: string[] = [];
    const render = "pipeline" in reply;
    // Only recordings show which pipeline draws now; a reply that recorded
    // nothing (every frame stale or failed) is no evidence of a change.
    if (render && reply.recordings.length && state.pipeline !== reply.pipeline) state.pipeline = reply.pipeline;
    state.replied = true;
    for (const typeface of reply.typefaces) if (!state.typefaces.has(typeface.id) &&
      !typeface.chunks.some((id) => rejected.has(id)) && typeface.chunks.every((id) => this.deps.chunks.has(id))) {
      state.typefaces.set(typeface.id, typeface);
      this.deps.chunks.reference(typeface.chunks);
    }
    for (const recording of reply.recordings) {
      const entry = state.frames.get(recording.file);
      if (!entry || !asked.has(recording.file)) continue;
      const version = entry.wanted;
      // A newer demand for this frame owns its state; an older generation may
      // only cover a frame that has nothing confirmed yet.
      const wanted = version === undefined || recording.sourceVersion === version;
      if (!wanted && entry.confirmed) continue;
      const chunks = recording.layers.flatMap((layer) => layer.chunks);
      const typefaces = [...new Set(recording.layers.flatMap((layer) => layer.typefaces))];
      const corrupt = chunks.some((id) => rejected.has(id)) ||
        typefaces.some((id) => reply.typefaces.some((typeface) => typeface.id === id && typeface.chunks.some((chunk) => rejected.has(chunk))));
      if (corrupt) {
        entry.failed = { version: version ?? null, error: "A recording chunk did not match its content hash." };
        this.counts.failed++;
        continue;
      }
      if (chunks.some((id) => !this.deps.chunks.has(id)) || typefaces.some((id) => !state.typefaces.has(id))) {
        entry.stale = true;
        continue;
      }
      const pipeline = render ? (reply as DesignRecordingsReply).pipeline : (recording as typeof recording & { pipeline: string }).pipeline;
      const adopted: DesignAdoptedRecording = { file: recording.file, sourceVersion: recording.sourceVersion,
        width: recording.width, height: recording.height, scale: recording.scale, pipeline,
        layers: recording.layers, typefaces, key: contentKey(recording) };
      this.deps.chunks.reference(chunks);
      if (entry.confirmed) this.deps.chunks.unreference(entry.confirmed.layers.flatMap((layer) => layer.chunks));
      entry.confirmed = adopted;
      entry.stale = false;
      entry.storedMissing = undefined;
      if (wanted) { entry.failed = null; entry.retries = 0; }
      this.counts.recordingsAdopted++;
      changed.push(recording.file);
    }
    if (render) {
      const renderReply = reply as DesignRecordingsReply;
      const now = this.deps.now?.() ?? Date.now();
      for (const { file, error, retryable } of renderReply.failed) {
        const entry = state.frames.get(file);
        if (!entry || !asked.has(file)) continue;
        // Failed at once, so the canvas covers the frame meanwhile.
        const retry = retryable === true && entry.retries < RETRY_FAILED_MS.length;
        entry.failed = retry ? { version: entry.wanted ?? null, error, retryable: true } : { version: entry.wanted ?? null, error };
        if (retry) entry.retryAt = now + RETRY_FAILED_MS[entry.retries++]!;
        this.counts.failed++;
      }
      for (const { file, sourceVersion } of renderReply.stale) {
        const entry = state.frames.get(file);
        if (entry && asked.has(file) && entry.wanted && entry.wanted !== sourceVersion) entry.superseded = entry.wanted;
      }
    }
    for (const deferred of reply.deferred) {
      const file = typeof deferred === "string" ? deferred : deferred.file;
      const entry = state.frames.get(file);
      if (!entry || !asked.has(file)) continue;
      this.counts.deferred++;
      // The engine always answers a request's first frame when it fits, so a
      // later frame was merely left for the next request: it moves up.
      if (file !== request.files[0]) continue;
      if (++entry.deferrals >= MAX_DEFERRALS)
        entry.failed = { version: entry.wanted ?? null, error: "The engine kept deferring this frame's recording." };
    }
    if ("missing" in reply) for (const file of reply.missing) {
      const entry = state.frames.get(file);
      if (entry && asked.has(file)) entry.storedMissing = entry.wanted ?? null;
    }
    // A reopen's known failures fail at once for their version, or for a
    // frame that has none yet; another version is recorded as usual.
    if ("missing" in reply) for (const { file, sourceVersion, error } of reply.failed ?? []) {
      const entry = state.frames.get(file);
      if (!entry || !asked.has(file) || entry.wanted !== undefined && entry.wanted !== sourceVersion) continue;
      entry.failed = { version: entry.wanted ?? null, error };
      this.counts.failed++;
    }
    this.publish(state, changed);
  }

  /** Confirmed recordings this renderer can't draw: CanvasKit rejected the
   * picture, or a font it uses failed its content check. One of the wanted
   * version fails that version like an engine failure, so the canvas covers
   * the frame another way; an older cover is only dropped, and the wanted
   * version is still asked for. */
  failUndrawable(owner: DesignRecordingsOwner, reason: (recording: DesignAdoptedRecording) => string | null): void {
    const state = this.owners.get(designRecordingsOwnerKey(owner));
    if (!state) return;
    const changed: string[] = [];
    for (const [file, entry] of state.frames) {
      const confirmed = entry.confirmed;
      const error = confirmed ? reason(confirmed) : null;
      if (!confirmed || error === null) continue;
      this.deps.chunks.unreference(confirmed.layers.flatMap((layer) => layer.chunks));
      entry.confirmed = null;
      entry.stale = false;
      if (entry.wanted === undefined || entry.wanted === confirmed.sourceVersion) {
        entry.failed = { version: entry.wanted ?? null, error };
        this.counts.failed++;
      }
      changed.push(file);
    }
    if (!changed.length) return;
    this.publish(state, changed);
    this.pump(state);
  }

  private publish(state: OwnerState, changed: readonly string[]): void {
    const failed = new Set([...state.frames].filter(([, entry]) => entry.failed && entry.failed.version === (entry.wanted ?? null))
      .map(([file]) => file));
    const failedChanged = failed.size !== state.failed.size || [...failed].some((file) => !state.failed.has(file));
    if (failedChanged) state.failed = failed;
    if (changed.length || failedChanged) for (const listener of [...this.listeners]) listener(state.key, changed);
  }

  private settleError(state: OwnerState, request: Request, error: unknown): void {
    if (this.owners.get(state.key) !== state || request.controller.signal.aborted) return;
    this.counts.errors++;
    const retryAt = (this.deps.now?.() ?? Date.now()) + RETRY_AFTER_ERROR_MS;
    for (const file of request.files) {
      const entry = state.frames.get(file);
      if (entry) entry.retryAt = retryAt;
    }
    void error;
  }
}
