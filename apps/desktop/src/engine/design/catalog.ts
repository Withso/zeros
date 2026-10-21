import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  DESIGN_CATALOG_BATCH_BYTES,
  DESIGN_CATALOG_BATCH_ENTRIES,
  DESIGN_CATALOG_DESCRIPTOR_LIMIT,
  designCatalogBatchSchema,
  designCatalogFrameSchema,
  designCatalogOwnerSchema,
  type DesignCatalogRead,
  type DesignCatalogBatch,
  type DesignCatalogFailure,
  type DesignCatalogFrame,
  type DesignCatalogOwner,
  type DesignCatalogPage,
  type DesignCatalogReply,
} from "@zeros/protocol/design-catalog";
import { portableDesignName } from "@zeros/protocol/design-path";
import type { CanvasDocument } from "./document-model";

export interface DesignCatalogAdmission {
  connectionId: string;
  authority: string;
  authorized: () => boolean;
}

export interface DesignCatalogSnapshot {
  owner: DesignCatalogOwner;
  binding: string;
  revision: string;
  pages: DesignCatalogPage[];
  frames: DesignCatalogFrame[];
}

export class DesignCatalogError extends Error {
  constructor(readonly reason: DesignCatalogFailure["reason"]) {
    super(`Design catalog ${reason}.`);
  }
}

export function projectDesignCatalog(
  canvas: Pick<CanvasDocument, "frames" | "frame_info" | "pages">,
): Pick<DesignCatalogSnapshot, "pages" | "frames"> {
  const entries = Object.entries(canvas.frames);
  if (entries.length > DESIGN_CATALOG_DESCRIPTOR_LIMIT)
    throw new DesignCatalogError("too-large");
  const fileById = new Map(
    Object.entries(canvas.frame_info).map(([file, info]) => [info.id, file]),
  );
  const pages = canvas.pages;
  if (!pages?.length || pages.length > 64 || fileById.size !== entries.length)
    throw new DesignCatalogError("unsupported-layout");
  const seen = new Set<string>();
  const sources = new Set<string>();
  const frames: DesignCatalogFrame[] = [];
  for (const page of pages) {
    for (const [order, id] of page.frames.entries()) {
      const source = fileById.get(id);
      const geometry = source ? canvas.frames[source] : undefined;
      const info = source ? canvas.frame_info[source] : undefined;
      if (
        !source ||
        !geometry ||
        !info ||
        seen.has(id) ||
        sources.has(portableDesignName(source))
      )
        throw new DesignCatalogError("stale");
      seen.add(id);
      sources.add(portableDesignName(source));
      frames.push(
        designCatalogFrameSchema.parse({
          id,
          pageId: page.id,
          source,
          title: info.title,
          kind: info.kind === "text" ? "text" : "html",
          x: geometry.x,
          y: geometry.y,
          width: geometry.w,
          height: geometry.h,
          z: geometry.z,
          order,
          preparation: "unprepared",
        }),
      );
    }
  }
  if (frames.length !== entries.length) throw new DesignCatalogError("stale");
  return {
    pages: pages.map((page) => ({
      id: page.id,
      title: page.title,
      folder: page.folder ?? "",
      count: page.frames.length,
    })),
    frames,
  };
}

interface Session {
  connectionId: string;
  authority: string;
  intent: number;
  directoryId: string;
  nonce: string;
  expiresAt: number;
  bytes: number;
  readers: number;
  snapshot?: DesignCatalogSnapshot;
}

export class DesignCatalogReader {
  private readonly secret = randomBytes(32);
  private readonly sessions = new Map<string, Session>();
  private running = 0;
  private retainedBytes = 0;

  constructor(
    private readonly options: {
      now?: () => number;
      ttlMs?: number;
      maxSessions?: number;
      maxBytes?: number;
      maxReads?: number;
    } = {},
  ) {}

  retire(connectionId: string): void {
    for (const [key, session] of this.sessions)
      if (session.connectionId === connectionId) this.retireSession(key);
  }

  private releaseSnapshot(session: Session): void {
    this.retainedBytes -= session.bytes;
    session.bytes = 0;
    session.snapshot = undefined;
  }

  private retireSession(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    if (session.readers === 0) this.releaseSnapshot(session);
  }

  private binding(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("hex");
  }

  private cursor(key: string, session: Session, offset: number): string {
    const body = `${session.nonce}.${offset}`;
    return `${body}.${this.binding(`${key}\0${body}`)}`;
  }

  async read(
    input: DesignCatalogRead,
    admission: DesignCatalogAdmission,
    source: {
      open: () => Promise<DesignCatalogSnapshot>;
      validate: (snapshot: DesignCatalogSnapshot) => Promise<boolean>;
    },
  ): Promise<DesignCatalogReply> {
    const now = () => this.options.now?.() ?? Date.now();
    const startedAt = now();
    for (const [key, session] of this.sessions)
      if (session.expiresAt <= startedAt) this.retireSession(key);
    const key = JSON.stringify([admission.connectionId, input.workspaceId]);
    const unavailable = (
      reason: DesignCatalogFailure["reason"],
    ): DesignCatalogFailure => ({
      kind: "design-catalog",
      version: 1,
      status: "unavailable",
      reason,
    });
    if (!admission.authorized()) return unavailable("authority-lost");
    const previous = this.sessions.get(key);
    if (
      previous &&
      previous.authority === admission.authority &&
      input.intent < previous.intent
    )
      return unavailable("superseded");
    if (
      previous &&
      previous.authority === admission.authority &&
      previous.intent === input.intent &&
      previous.directoryId !== input.directoryId
    )
      return unavailable("superseded");
    let offset = 0;
    let session: Session;
    if (input.cursor !== undefined) {
      if (
        !previous?.snapshot ||
        previous.authority !== admission.authority ||
        previous.intent !== input.intent ||
        previous.directoryId !== input.directoryId
      )
        return unavailable("expired");
      const match = /^([a-f0-9]{32})\.([1-9][0-9]{0,4})\.([a-f0-9]{64})$/.exec(
        input.cursor,
      );
      if (!match || match[1] !== previous.nonce) return unavailable("expired");
      offset = Number(match[2]);
      const expected = this.cursor(key, previous, offset);
      if (
        expected.length !== input.cursor.length ||
        !timingSafeEqual(Buffer.from(expected), Buffer.from(input.cursor)) ||
        offset >= previous.snapshot.frames.length
      )
        return unavailable("expired");
      session = previous;
    } else {
      session = {
        connectionId: admission.connectionId,
        authority: admission.authority,
        intent: input.intent,
        directoryId: input.directoryId,
        nonce: randomBytes(16).toString("hex"),
        expiresAt: startedAt + (this.options.ttlMs ?? 60_000),
        bytes: 0,
        readers: 0,
      };
      this.retireSession(key);
      this.sessions.set(key, session);
      while (this.sessions.size > (this.options.maxSessions ?? 16))
        this.retireSession(this.sessions.keys().next().value!);
    }
    const assertCurrent = () => {
      if (!admission.authorized())
        throw new DesignCatalogError("authority-lost");
      if (this.sessions.get(key) !== session)
        throw new DesignCatalogError("superseded");
      if (session.expiresAt <= now()) throw new DesignCatalogError("expired");
    };
    if (this.running >= (this.options.maxReads ?? 4))
      return unavailable("busy");
    this.running++;
    session.readers++;
    try {
      if (!session.snapshot) {
        const snapshot = await source.open();
        assertCurrent();
        designCatalogOwnerSchema.parse(snapshot.owner);
        if (
          snapshot.owner.workspaceId !== input.workspaceId ||
          snapshot.owner.directoryId !== input.directoryId
        )
          throw new DesignCatalogError("stale");
        if (snapshot.frames.length > DESIGN_CATALOG_DESCRIPTOR_LIMIT)
          throw new DesignCatalogError("too-large");
        const bytes = Buffer.byteLength(JSON.stringify(snapshot)) * 2;
        if (
          bytes >
          Math.min(8 * 1024 * 1024, this.options.maxBytes ?? 32 * 1024 * 1024)
        )
          throw new DesignCatalogError("too-large");
        for (const [oldKey] of this.sessions) {
          if (
            this.retainedBytes + bytes <=
            (this.options.maxBytes ?? 32 * 1024 * 1024)
          )
            break;
          if (oldKey !== key) this.retireSession(oldKey);
        }
        if (
          this.retainedBytes + bytes >
          (this.options.maxBytes ?? 32 * 1024 * 1024)
        )
          throw new DesignCatalogError("busy");
        session.snapshot = snapshot;
        session.bytes = bytes;
        this.retainedBytes += bytes;
      }
      if (!(await source.validate(session.snapshot)))
        throw new DesignCatalogError("stale");
      assertCurrent();
      const snapshot = session.snapshot;
      const batch: DesignCatalogBatch = {
        kind: "design-catalog",
        version: 1,
        status: "ready",
        owner: snapshot.owner,
        binding: this.binding(snapshot.binding),
        revision: snapshot.revision,
        intent: input.intent,
        pages: snapshot.pages,
        total: snapshot.frames.length,
        offset,
        frames: [],
        coverage: "partial",
        nextCursor: null,
      };
      const limit = input.limit ?? DESIGN_CATALOG_BATCH_ENTRIES;
      const byteLimit = DESIGN_CATALOG_BATCH_BYTES - 1024;
      let frameBytes = 0;
      do {
        const frame = snapshot.frames[offset + batch.frames.length];
        if (frame) {
          frameBytes +=
            Buffer.byteLength(JSON.stringify(frame)) +
            (batch.frames.length ? 1 : 0);
          batch.frames.push(frame);
        }
        const end = offset + batch.frames.length;
        batch.nextCursor =
          end < snapshot.frames.length ? this.cursor(key, session, end) : null;
        batch.coverage =
          offset === 0 && end === snapshot.frames.length
            ? "complete"
            : "partial";
        if (
          Buffer.byteLength(JSON.stringify({ ...batch, frames: [] })) +
            frameBytes >
          byteLimit
        ) {
          batch.frames.pop();
          if (!batch.frames.length) throw new DesignCatalogError("too-large");
          batch.nextCursor = this.cursor(
            key,
            session,
            offset + batch.frames.length,
          );
          batch.coverage = "partial";
          break;
        }
        if (!frame) break;
      } while (
        batch.frames.length < limit &&
        offset + batch.frames.length < snapshot.frames.length
      );
      const result = designCatalogBatchSchema.parse(batch);
      assertCurrent();
      return result;
    } catch (error) {
      if (this.sessions.get(key) === session) this.retireSession(key);
      if (error instanceof DesignCatalogError) return unavailable(error.reason);
      throw error;
    } finally {
      this.running--;
      session.readers--;
      if (session.readers === 0 && this.sessions.get(key) !== session)
        this.releaseSnapshot(session);
    }
  }
}
