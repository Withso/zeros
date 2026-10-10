import { z } from "zod";
import { clone, FixtureRefusal, parse, ScopeSchema, sha256 } from "./contracts";

// Durable records have no package schema. Mirror internal-routes.ts's exact
// GET/POST envelopes, including nested error.code and offset timestamps.
const KindSchema = z.enum(["workspace", "chat", "message", "turn", "agent_session", "run", "terminal", "design_transaction", "metadata"]);
const MutationSchema = z.object({ entityKind: KindSchema, entityId: z.string().min(1).max(255), operation: z.enum(["upsert", "tombstone"]),
  schemaVersion: z.number().int().min(1).max(65_535), document: z.record(z.string(), z.unknown()).optional(), occurredAt: z.string().datetime({ offset: true }) }).strict()
  .refine(value => value.operation === "upsert" ? value.document !== undefined : value.document === undefined);
export const RecordAppendSchema = ScopeSchema.extend({ expectedRevision: z.number().int().safe().nonnegative(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/), mutations: z.array(MutationSchema).min(1).max(100) }).strict();
export const RecordHeadSchema = ScopeSchema.extend({ generation: z.coerce.number().int().safe().positive(), limit: z.coerce.number().int().min(1).max(10).optional(),
  afterEntityKind: KindSchema.optional(), afterEntityId: z.string().min(1).max(255).optional() }).strict()
  .refine(value => (value.afterEntityKind === undefined) === (value.afterEntityId === undefined));
type Entry = { entityKind: z.infer<typeof KindSchema>; entityId: string; revision: number; schemaVersion: number; document: Record<string, unknown> | null; tombstonedAt: string | null };
const key = (entry: { entityKind: string; entityId: string }) => `${entry.entityKind}\0${entry.entityId}`;
const entityControl = /[\u0000-\u001f\u007f]/u;
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function inspectDocument(value: unknown, state: { nodes: number }, depth = 0): void {
  if (++state.nodes > 20_000 || depth > 32) throw new FixtureRefusal("invalid_input", 422);
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (Array.isArray(value)) { for (const entry of value) inspectDocument(entry, state, depth + 1); return; }
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new FixtureRefusal("invalid_input", 422);
  for (const [key, entry] of Object.entries(value)) {
    if (!key.length || key.length > 256 || ["__proto__", "constructor", "prototype"].includes(key)) throw new FixtureRefusal("invalid_input", 422);
    inspectDocument(entry, state, depth + 1);
  }
}

export class FixtureRecords {
  private revision = 0;
  private headReads = 0;
  private readonly entries = new Map<string, Entry>();
  private readonly receipts = new Map<string, { hash: string; firstRevision: number; lastRevision: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  head(raw: unknown) {
    const input = parse(RecordHeadSchema, raw, "invalid_request");
    if (input.afterEntityId && entityControl.test(input.afterEntityId)) throw new FixtureRefusal("invalid_input", 422);
    this.headReads++;
    const cursor = input.afterEntityKind === undefined ? null : key({ entityKind: input.afterEntityKind, entityId: input.afterEntityId! });
    const ordered = [...this.entries.values()].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0).filter(entry => cursor === null || key(entry) > cursor);
    const limit = input.limit ?? 10, entries = ordered.slice(0, limit), last = entries.at(-1);
    return clone({ currentRevision: this.revision, entries, next: ordered.length > limit && last ? { entityKind: last.entityKind, entityId: last.entityId } : null });
  }
  append(raw: unknown) {
    const input = parse(RecordAppendSchema, raw, "invalid_request");
    const { idempotencyKey } = input;
    const mutations = input.mutations.map(mutation => {
      const occurredAt = new Date(mutation.occurredAt);
      if (entityControl.test(mutation.entityId) || Math.abs(occurredAt.getTime() - this.now()) > 24 * 60 * 60_000)
        throw new FixtureRefusal("invalid_input", 422);
      if (mutation.document) {
        inspectDocument(mutation.document, { nodes: 0 });
        if (Buffer.byteLength(canonicalJson(mutation.document)) > 512 * 1024) throw new FixtureRefusal("invalid_input", 422);
      }
      return { ...mutation, occurredAt: occurredAt.toISOString() };
    });
    if (Buffer.byteLength(canonicalJson(mutations)) > 2 * 1024 * 1024) throw new FixtureRefusal("invalid_input", 422);
    const hash = sha256(canonicalJson({ expectedRevision: input.expectedRevision, mutations }));
    const previous = this.receipts.get(idempotencyKey);
    if (previous) {
      if (previous.hash !== hash) throw new FixtureRefusal("idempotency_conflict");
      return { firstRevision: previous.firstRevision, lastRevision: previous.lastRevision, currentRevision: this.revision, replayed: true };
    }
    if (this.revision !== input.expectedRevision) throw new FixtureRefusal("revision_conflict");
    if (this.receipts.size >= 200_000 || this.entries.size + mutations.filter(mutation => !this.entries.has(key(mutation))).length > 16_384)
      throw new FixtureRefusal("record_limit", 422);
    const firstRevision = this.revision + 1;
    for (const mutation of mutations) this.entries.set(key(mutation), { entityKind: mutation.entityKind, entityId: mutation.entityId, revision: ++this.revision,
      schemaVersion: mutation.schemaVersion, document: mutation.operation === "upsert" ? clone(mutation.document!) : null,
      tombstonedAt: mutation.operation === "tombstone" ? mutation.occurredAt : null });
    this.receipts.set(idempotencyKey, { hash, firstRevision, lastRevision: this.revision });
    return { firstRevision, lastRevision: this.revision, currentRevision: this.revision, replayed: false };
  }
  inspect() { return { recordRevision: this.revision, recordHeadReads: this.headReads, recordEntityCount: this.entries.size }; }
}
