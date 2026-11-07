import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { designPageCatalogSchema } from "@zeros/protocol/design-pages";
import { decodeCanvasFile, encodeCanvasFile } from "../canvas-file";
import { pagedCanvasFixture } from "./frame-limit-fixtures";
import * as previous from "./fixtures/previous-design-limits.mjs";

const canvas = (pages: number, perPage: number, version: 1 | 2 = 2) =>
  JSON.stringify(pagedCanvasFixture(pages, perPage, { version }), null, 2) + "\n";

describe("per-page frame admission across releases", () => {
  it("pins the actual previous codec artifact", () => {
    const manifest = JSON.parse(readFileSync(new URL("./fixtures/previous-design-limits.provenance.json", import.meta.url), "utf8"));
    const bytes = readFileSync(new URL("./fixtures/previous-design-limits.mjs", import.meta.url));
    expect(manifest.revision).toBe("2435964e1bdde90623da1042449a6438131f5582");
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.sha256);
  });

  it("makes an older build fail closed, never truncate, on a directory past its 256-frame cap", () => {
    const zCreep = pagedCanvasFixture(1, 10);
    zCreep.frames[Object.keys(zCreep.frames)[0]!]!.z = 300;
    for (const source of [canvas(1, 300), canvas(2, 200), canvas(1, 300, 1), JSON.stringify(zCreep)]) {
      const version = JSON.parse(source).version as 1 | 2;
      expect(() => previous.decodeCanvasFile(source, { version })).toThrow(/Invalid Design canvas frame geometry or metadata/);
      expect(Object.keys(decodeCanvasFile(source, { version }).frames as object).length).toBe(
        Object.keys(JSON.parse(source).frames).length,
      );
    }
    const large = pagedCanvasFixture(26, 1_000);
    const catalog = large.pages.map((page) => ({
      id: page.id, title: page.title, folder: page.folder!,
      frameIds: page.frames, frameFiles: page.frames.map((id) => large.frames[id]!.source),
    }));
    expect(previous.designPageCatalogSchema.safeParse(catalog).success).toBe(false);
    expect(designPageCatalogSchema.safeParse(catalog).success).toBe(true);
  });

  it("keeps both builds reading and writing identical bytes within the old limits", () => {
    for (const [pages, perPage, version] of [[1, 256, 1], [1, 256, 2], [3, 80, 2]] as const) {
      const source = canvas(pages, perPage, version);
      const current = decodeCanvasFile(source, { version });
      const old = previous.decodeCanvasFile(source, { version });
      expect(current).toEqual(old);
      expect(encodeCanvasFile(current, { version })).toBe(source);
      expect(previous.encodeCanvasFile(old, { version })).toBe(source);
    }
  });
});
