import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { DesignRecordingChunks, designRecordingChunkIdOf } from "../gpu/design-recording-chunks";

const bytes = (text: string) => new TextEncoder().encode(text);
const idOf = (data: Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 32);
const wire = (text: string) => ({ id: idOf(bytes(text)), data: Buffer.from(text).toString("base64") });
const text = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : null);

describe("Design recording chunks", () => {
  it("names a chunk by the first 32 hex characters of its SHA-256", async () => {
    expect(await designRecordingChunkIdOf(bytes("font"))).toBe(idOf(bytes("font")));
  });

  it("admits only chunks whose bytes hash to their id and reassembles layers in order", async () => {
    const chunks = new DesignRecordingChunks();
    const a = wire("alpha-"), b = wire("beta-"), forged = { id: wire("gamma").id, data: Buffer.from("tampered").toString("base64") };
    const result = await chunks.admit([a, b, forged, { id: "f".repeat(32), data: "%%%not-base64%%%" }]);
    expect(result.admitted.sort()).toEqual([a.id, b.id].sort());
    expect(result.rejected.sort()).toEqual([forged.id, "f".repeat(32)].sort());
    expect(chunks.has(forged.id)).toBe(false);
    expect(text(chunks.assemble([b.id, a.id, b.id]))).toBe("beta-alpha-beta-");
    // A layer with any missing chunk is incomplete, never a partial picture.
    expect(chunks.assemble([a.id, forged.id])).toBeNull();
    expect(chunks.usage()).toMatchObject({ count: 2, bytes: 11, rejected: 2 });
  });

  it("stores each chunk once however often it travels", async () => {
    const chunks = new DesignRecordingChunks();
    const font = wire("embedded-font-bytes");
    await chunks.admit([font]);
    await chunks.admit([font]);
    expect(chunks.usage()).toMatchObject({ count: 1, bytes: 19, received: 2 });
  });

  it("evicts the least recently used chunks beyond its byte budget, never a leased one", async () => {
    const chunks = new DesignRecordingChunks({ budgetBytes: 10 });
    const [a, b, c] = [wire("aaaa"), wire("bbbb"), wire("cccc")];
    await chunks.admit([a, b]);
    const release = chunks.lease([a.id]);
    // Using b keeps it warm; a is older but leased by an in-flight request.
    chunks.assemble([b.id]);
    await chunks.admit([c]);
    // Admission alone never evicts: the reply being adopted may need them.
    expect(chunks.usage().bytes).toBe(12);
    chunks.trim();
    expect(chunks.has(a.id)).toBe(true);
    expect(chunks.has(b.id)).toBe(false);
    expect(chunks.has(c.id)).toBe(true);
    expect(chunks.usage().bytes).toBe(8);
    release();
    // Releasing twice must not drop another request's lease.
    const other = chunks.lease([a.id]);
    release();
    await chunks.admit([wire("dddd"), wire("eeee")]);
    chunks.trim();
    expect(chunks.has(a.id)).toBe(true);
    other();
    await chunks.admit([wire("ffff")]);
    chunks.trim();
    expect(chunks.has(a.id)).toBe(false);
    expect(chunks.usage().bytes).toBeLessThanOrEqual(10);
  });

  it("evicts chunks no adopted recording references before referenced ones", async () => {
    const chunks = new DesignRecordingChunks({ budgetBytes: 8 });
    const [kept, orphan, fresh, later] = [wire("kkkk"), wire("oooo"), wire("ffff"), wire("gggg")];
    await chunks.admit([kept]);
    chunks.reference([kept.id]);
    // The orphan (a superseded or failed reply's chunk) is newer, so least
    // recently used order alone would evict the referenced chunk first.
    await chunks.admit([orphan, fresh]);
    chunks.reference([fresh.id]);
    chunks.trim();
    expect([chunks.has(kept.id), chunks.has(orphan.id), chunks.has(fresh.id)]).toEqual([true, false, true]);
    // With only referenced chunks left, the least recently used goes.
    await chunks.admit([later]);
    chunks.reference([later.id]);
    chunks.trim();
    expect([chunks.has(kept.id), chunks.has(fresh.id), chunks.has(later.id)]).toEqual([false, true, true]);
    expect(chunks.usage().bytes).toBe(8);
  });

  it("claims preferred chunks first, then the most shared, within the request limit and only chunks it holds", async () => {
    const chunks = new DesignRecordingChunks();
    const [font, logo, page, own] = [wire("font"), wire("logo"), wire("page"), wire("own")];
    await chunks.admit([font, logo, page, own]);
    chunks.reference([font.id, logo.id, page.id]);
    chunks.reference([font.id, logo.id]);
    chunks.reference([font.id]);
    expect(chunks.known([own.id, "0".repeat(32)], 3)).toEqual([own.id, font.id, logo.id]);
    chunks.unreference([font.id]);
    chunks.unreference([font.id]);
    chunks.unreference([page.id]);
    expect(chunks.known([], 2)).toEqual([logo.id, font.id]);
  });
});
