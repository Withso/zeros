import { describe, expect, it } from "vitest";

import { parse } from "parse5";

import { createDesignWebDocumentState } from "../revision";
import { isDeclarativeShadowTemplate } from "../shadow";
import { mutateDesignNodeStyles } from "../css";
import {
  healDesignHtmlIdentities,
  mutateDesignNodeAttributeSource,
  mutateDesignNodeDeleteSource,
  mutateDesignNodeDuplicateSource,
  mutateDesignNodeMoveSource,
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

  it("copies a host's shadow layers with fresh identities", () => {
    const healed = healDesignHtmlIdentities(SOURCE).source;
    const ids = shadowIds(healed);
    const copied = mutateDesignNodeDuplicateSource(healed, "host", "host-copy");
    const projection = parseDesignWebProjection({ documentId: "doc", revision: "r2", entryFile: "page/diff.html", source: copied });
    expect(projection.diagnostics).toEqual([]);
    const copies = projection.nodes.filter((node) => node.tag === "pre");
    expect(copies).toHaveLength(2);
    expect(copies.map((node) => node.parentId)).toEqual(["host", "host-copy"]);
    expect(() => mutateDesignNodeDuplicateSource(healed, "sheet", ids.span)).toThrow(/already exists/);
  });

  it("names the shadow root when a move targets its content", () => {
    const ids = shadowIds(healDesignHtmlIdentities(SOURCE).source);
    const healed = healDesignHtmlIdentities(SOURCE).source;
    expect(() => mutateDesignNodeMoveSource(healed, ids.pre, "sheet", null)).toThrow(/inside a shadow root/);
    expect(() => mutateDesignNodeMoveSource(healed, "host", ids.pre, null)).toThrow(/inside a shadow root/);
  });

  it("projects only the open shadow roots the HTML parser attaches", () => {
    const source = `<!doctype html><html><body><main data-oid="sheet">
<ul><li data-oid="row"><template shadowrootmode="open"><span>inert</span></template><a data-oid="link">Link</a></li></ul>
<div data-oid="twice"><template shadowrootmode="open"><b>first</b></template><template shadowrootmode="open"><i>second</i></template></div>
<x-closed data-oid="closed"><template shadowrootmode="closed"><button>Buy</button></template></x-closed>
<div data-oid="spaced"><template shadowrootmode=" open "><u>x</u></template></div>
<p data-oid="para"><template shadowrootmode="OPEN"><em>shown</em></template></p>
</main></body></html>`;
    const projection = parseDesignWebProjection({ documentId: "doc", revision: "r1", entryFile: "page/hosts.html", source });
    expect(projection.nodes.map((node) => node.tag)).toEqual(["main", "ul", "li", "a", "div", "b", "x-closed", "div", "p", "em"]);
    const healed = healDesignHtmlIdentities(source).source;
    expect(healed).toContain("<span>inert</span>");
    expect(healed).toContain("<i>second</i>");
    expect(healed).toContain("<button>Buy</button>");
    expect(healed).toContain("<u>x</u>");
  });

  it("attaches roots to custom elements by the name rule, in linear time", () => {
    const attaches = (tag: string) => {
      type Element = Parameters<typeof isDeclarativeShadowTemplate>[0];
      const document = parse(`<!doctype html><body><${tag}><template shadowrootmode="open"><b>x</b></template></${tag}>`);
      const html = document.childNodes[1] as Element;
      const host = (html.childNodes[1] as Element).childNodes[0] as Element;
      return isDeclarativeShadowTemplate(host.childNodes[0] as Element);
    };
    expect(["x-card", "a-", "my-\u00e9lan"].map(attaches)).toEqual([true, true, true]);
    expect(["font-face", "xcard"].map(attaches)).toEqual([false, false]);
    // A backtracking name pattern takes seconds on this input; a linear one,
    // milliseconds. The test's own bound catches the former.
    expect(attaches(`a-${"-".repeat(60_000)}!`)).toBe(false);
  }, 2_000);

  it("heals identities inside rendered shadow roots only", () => {
    const healed = healDesignHtmlIdentities(SOURCE).source;
    expect(healed).toMatch(/<pre data-diff="" data-oid="o-[a-f0-9]{8}">/);
    expect(healed).toContain("<template><p>inert</p></template>");
  });
});
