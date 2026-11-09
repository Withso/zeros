import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "parse5";
import { describe, expect, it } from "vitest";

import { designLayerCount, designNodeRecords, healDesignOids } from "../node-identities";
import { configureSharedDesignParsesForTests, parseDesignSource, withSharedDesignParses } from "../shared-parse";

describe("design layer count", () => {
  const count = (body: string) => {
    const document = parse(`<!doctype html><html><head></head><body>${body}</body></html>`);
    return { nodes: designNodeRecords(document).length, layers: designLayerCount(document) };
  };

  it("lists nothing under a new frame's seeded shell", () => {
    expect(count('<main data-oid="m" data-zeros-frame-root></main>')).toEqual({
      nodes: 1,
      layers: 0,
    });
    expect(
      count('<main data-oid="m" data-zeros-frame-root><p data-oid="p">Hi</p></main>'),
    ).toEqual({ nodes: 2, layers: 1 });
  });

  it("keeps unmarked or shared roots as real layers, like the runtime", () => {
    // An authored main without the marker is a layer even when it is empty.
    expect(count('<main data-oid="m"></main>')).toEqual({ nodes: 1, layers: 1 });
    // A marked shell with an identified sibling is not the frame row.
    expect(
      count('<main data-oid="m" data-zeros-frame-root></main><aside data-oid="a"></aside>'),
    ).toEqual({ nodes: 2, layers: 2 });
    expect(count("")).toEqual({ nodes: 0, layers: 0 });
  });
});

/** Everything a reader can see of a tree, in a stable key order. */
function canonical(node: unknown): unknown {
  const sorted = (value: unknown): unknown => value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])])) : value;
  const record = node as Record<string, unknown> & { attrs?: Array<Record<string, unknown>>; childNodes?: unknown[]; content?: unknown };
  return { nodeName: record.nodeName, tagName: record.tagName, namespaceURI: record.namespaceURI,
    attrs: record.attrs?.map((attribute) => [attribute.name, attribute.value, attribute.prefix ?? null, attribute.namespace ?? null]),
    value: record.value, data: record.data, location: sorted(record.sourceCodeLocation),
    content: record.content ? canonical(record.content) : undefined, childNodes: record.childNodes?.map(canonical) };
}

describe("healing ids", () => {
  const frame = (body: string) => `<!doctype html>\n<html lang="en">\n<head><title>t</title></head>\n<body>\n${body}\n</body>\n</html>`;

  it("hands back the healed text's own tree, patched instead of parsed again", () => {
    const sources = [
      '<main><p>a</p><img src="a.png"><br><input disabled></main>',
      '<main data-oid="m"><p data-oid="m">duplicate</p><b data-oid>bare</b><i data-oid=x data-oid=y>unquoted</i></main>',
      '<section\n  class="multi"\n  title=">"\n>lines<svg viewBox="0 0 2 2"><path d="M0 0h2"/></svg><span class=u>v</span></section>',
      '<div><template><em>in a template</em></template><img src="b.png"/><custom-el></custom-el><!-- c --></div>',
    ];
    for (const source of sources.map(frame)) {
      const healed = healDesignOids(source);
      expect(healed.changed, source).toBe(true);
      expect(healed.document, source).toBeDefined();
      expect(canonical(healed.document), source).toEqual(canonical(parse(healed.html, { sourceCodeLocationInfo: true })));
    }
  });

  it("hands back exactly a fresh parse for every frame of the repository's own Design documents", () => {
    // A parse5 upgrade that records locations differently must fail here,
    // not make patched trees differ silently.
    const root = path.resolve(__dirname, "../../../../../..");
    const files = ["Zeros - Design", "styles/Artifacts"].flatMap((folder) =>
      readdirSync(path.join(root, folder), { recursive: true, encoding: "utf8" })
        .filter((file) => file.endsWith(".html")).map((file) => path.join(root, folder, file)));
    let patched = 0;
    for (const file of files) {
      const healed = healDesignOids(readFileSync(file, "utf8"));
      if (!healed.changed || !healed.document) continue;
      patched++;
      const fresh = JSON.stringify(canonical(parse(healed.html, { sourceCodeLocationInfo: true })));
      expect(JSON.stringify(canonical(healed.document)) === fresh, file).toBe(true);
    }
    expect(patched).toBeGreaterThan(20);
  });

  it("parses the healed text again when an edit could change how the rest tokenizes", () => {
    // An unquoted value may end in "/", which an insertion before it would split off.
    for (const source of [frame("<main><img src=a/></main>"), frame("<main><p>x</p></main>").replace(/\n/g, "\r\n")]) {
      const healed = healDesignOids(source);
      expect(healed.changed, source).toBe(true);
      expect(healed.document, source).toBeUndefined();
    }
  });

  it("leaves a tree an earlier reader holds as it was, and has the healed text parsed", async () => {
    const source = frame("<main><p>a</p></main>");
    await withSharedDesignParses(async () => {
      const held = parseDesignSource(source);
      const before = canonical(held);
      const healed = healDesignOids(source);
      expect(healed.changed).toBe(true);
      expect(canonical(held)).toEqual(before);
      expect(healed.document).toBeUndefined();
    });
  });

  it("never patches a tree shared frozen for tests", async () => {
    configureSharedDesignParsesForTests({ freeze: true });
    try {
      const healed = await withSharedDesignParses(async () => healDesignOids(frame("<main><p>a</p></main>")));
      expect(healed.changed).toBe(true);
      expect(healed.document).toBeUndefined();
    } finally {
      configureSharedDesignParsesForTests({});
    }
  });
});

