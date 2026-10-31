import { describe, expect, it } from "vitest";

import { createDesignWebDocumentState } from "../revision";
import { mutateDesignNodeStyles } from "../css";
import {
  healDesignHtmlIdentities,
  mutateDesignNodeAttributeSource,
  mutateDesignNodeDeleteSource,
  mutateDesignNodeDuplicateSource,
  mutateDesignNodeTextSource,
  parseDesignWebProjection,
} from "../html";

const SOURCE = `<!doctype html><html><head><title>Diff</title></head><body>
<main data-oid="sheet"><diffs-container data-oid="host"><template shadowrootmode="open"><pre data-diff=""><span>const value = 1;</span></pre></template></diffs-container><template><p>inert</p></template></main>
</body></html>`;

function shadowIds(source: string): { pre: string; span: string } {
  const nodes = parseDesignWebProjection({ documentId: "doc", revision: "r1", entryFile: "page/diff.html", source }).nodes;
  return {
    pre: nodes.find((node) => node.tag === "pre")!.id,
    span: nodes.find((node) => node.tag === "span")!.id,
  };
}

describe("declarative shadow content", () => {
  it("projects rendered shadow content under its host and skips inert templates", () => {
    const projection = parseDesignWebProjection({ documentId: "doc", revision: "r1", entryFile: "page/diff.html", source: SOURCE });
    expect(projection.nodes.map((node) => node.tag)).toEqual(["main", "diffs-container", "pre", "span"]);
    const host = projection.nodes.find((node) => node.id === "host")!;
    const ids = shadowIds(SOURCE);
    expect(host.childIds).toEqual([ids.pre]);
    expect(projection.nodes.find((node) => node.id === ids.span)?.parentId).toBe(ids.pre);
  });

  it("restyles, retexts and re-attributes shadow layers in place", () => {
    const healed = healDesignHtmlIdentities(SOURCE).source;
    const ids = shadowIds(healed);
    const state = createDesignWebDocumentState({
      documentId: "doc",
      entryFile: "page/diff.html",
      files: { "page/diff.html": healed },
      frames: { "page/diff.html": { x: 0, y: 0, width: 400, height: 300, z: 0 } },
    });
    const styled = mutateDesignNodeStyles(state, { nodeId: ids.pre, scope: "inline", styles: { "background-color": "rgb(157, 51, 51)" } });
    expect(styled.files["page/diff.html"]).toMatch(/<pre data-diff="" data-oid="[^"]+" style="background-color:\s?rgb\(157, 51, 51\);?">/);
    const retexted = mutateDesignNodeTextSource(healed, ids.span, "const value = 2;");
    expect(retexted).toMatch(/<span data-oid="[^"]+">const value = 2;<\/span>/);
    const labelled = mutateDesignNodeAttributeSource(healed, ids.pre, "title", "Diff");
    expect(labelled).toMatch(/<pre data-diff="" data-oid="[^"]+" title="Diff">/);
  });

  it("refuses structural edits inside a shadow root", () => {
    const ids = shadowIds(SOURCE);
    expect(() => mutateDesignNodeDeleteSource(SOURCE, ids.pre)).toThrow(/inside a shadow root/);
    expect(() => mutateDesignNodeDuplicateSource(SOURCE, ids.pre, "copy")).toThrow();
  });

  it("heals identities inside rendered shadow roots only", () => {
    const healed = healDesignHtmlIdentities(SOURCE).source;
    expect(healed).toMatch(/<pre data-diff="" data-oid="o-[a-f0-9]{8}">/);
    expect(healed).toContain("<template><p>inert</p></template>");
  });
});
