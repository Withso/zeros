import { parse } from "parse5";
import { describe, expect, it } from "vitest";

import { designLayerCount, designNodeRecords } from "../node-identities";

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
