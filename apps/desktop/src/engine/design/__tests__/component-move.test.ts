import { describe, expect, it } from "vitest";
import { designMainFromComponentSource } from "../component-move";

const card = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Card</title>
<link rel="stylesheet" href="tokens.css">
<style>
zd-card { display: block; background: url(assets/grain.png); }
</style>
</head>
<body>
<article class="card" data-zid="card">
<p class="eyebrow" data-zid="card-meta"><slot data-zd-attr="meta">Card &amp; co</slot></p>
<h3 data-zid="card-title"><slot data-zd-attr="heading">Untitled "card"</slot></h3>
<div class="card-body" data-zid="card-body"><slot>Children of the instance fill this slot.</slot></div>
</article>
</body>
</html>
`;

describe("designMainFromComponentSource", () => {
  it("turns attribute slots into text options, ids into layer ids, and rebases Design-root URLs to the frame", () => {
    const main = designMainFromComponentSource("card", card, "library/card.html");
    // The default slot stays, and is a layer of the main like any other.
    expect(main.replace(/<slot data-oid="o-[0-9a-f]+">/, "<slot>")).toBe(card
      .replace("<head>\n", [
        "<head>",
        "<template data-zd-options>",
        '<zd-option name="meta" type="text" default="Card &amp; co"></zd-option>',
        '<zd-option name="heading" type="text" default="Untitled &quot;card&quot;"></zd-option>',
        "</template>\n",
      ].join("\n"))
      .replace('href="tokens.css"', 'href="../tokens.css"')
      .replace("url(assets/grain.png)", "url(../assets/grain.png)")
      .replaceAll("data-zid=", "data-oid=")
      .replace('<slot data-zd-attr="meta">Card &amp; co</slot>', "{{ meta }}")
      .replace('<slot data-zd-attr="heading">Untitled "card"</slot>', "{{ heading }}"));
  });

  it("gives every layer an id and keeps a frame at the Design root unchanged in its URLs", () => {
    const plain = '<!doctype html>\n<html>\n<head>\n<title>Dot</title>\n<link rel="stylesheet" href="tokens.css">\n</head>\n<body><span class="dot"><b>x</b></span></body>\n</html>\n';
    const main = designMainFromComponentSource("dot", plain, "dot.html");
    expect(main).toContain('href="tokens.css"');
    expect(main).toMatch(/<span class="dot" data-oid="[^"]+"><b data-oid="[^"]+">x<\/b><\/span>/);
  });

  it("adds a declared option to a templated definition and rebases its own stylesheet links from its file", () => {
    const templated = [
      "<!doctype html>", "<html>", "  <head>", "    <title>Tag</title>", "    <template data-zd-options>",
      '<zd-option name="tone" type="choice" choices="a b" default="a"></zd-option>', "    </template>",
      '    <link rel="stylesheet" href="../tokens.css">', "  </head>",
      '  <body><i data-zid="tag" data-tone="{{ tone }}"><slot data-zd-attr="label">Tag</slot></i></body>', "</html>", "",
    ].join("\n");
    expect(designMainFromComponentSource("tag", templated, "library/tag.html")).toBe(templated
      .replace("    </template>", '<zd-option name="label" type="text" default="Tag"></zd-option>\n    </template>')
      .replace('data-zid="tag"', 'data-oid="tag"')
      .replace('<slot data-zd-attr="label">Tag</slot>', "{{ label }}"));
  });

  it("refuses what an option cannot hold, with a message that says what to change", () => {
    const body = (inner: string) => `<!doctype html>\n<html><head><title>X</title></head><body><p data-zid="x">${inner}</p></body></html>`;
    expect(() => designMainFromComponentSource("x", body('<slot data-zd-attr="title">T</slot>'), "x.html"))
      .toThrow(/"title" slot cannot become an option \(title is reserved and cannot name an option\.\) Rename it/);
    expect(() => designMainFromComponentSource("x", body('<slot data-zd-attr="label"><b data-zid="b">T</b></slot>'), "x.html"))
      .toThrow(/holds markup/);
    expect(() => designMainFromComponentSource("x", body("{{ not an option }}"), "x.html")).toThrow(/contains "\{\{"/);
    expect(() => designMainFromComponentSource("x", body('<script>1</script>'), "x.html")).toThrow(/scripts and event handlers/);
  });
});
