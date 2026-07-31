import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDesignFrame,
  DESIGN_DIRECTORY_NAME,
  initializeDesignDocument,
  readDesignFrameRenderIdentity,
} from "../document";
import { readDesignProtocolResource } from "../protocol-resource";

describe("design protocol resources", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-protocol-"));
    await initializeDesignDocument(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves runtime-injected HTML with relative CSS/assets and response CSP", async () => {
    const frame = await createDesignFrame(root, { title: "Protocol" });
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "assets", "pixel.png"),
      Buffer.from("89504e470d0a1a0a", "hex"),
    );
    const target = path.join(root, DESIGN_DIRECTORY_NAME, frame.file);
    const tokens = path.join(root, DESIGN_DIRECTORY_NAME, "tokens.css");
    await writeFile(
      tokens,
      `${await readFile(tokens, "utf8")}\n.preview { background-image: url("./assets/pixel.png"); }\n`,
    );
    const source = await readFile(target, "utf8");
    await writeFile(
      target,
      source.replace(
        "</main>",
        '<img data-oid="pixel" src="./assets/pixel.png" alt="Pixel"></main>',
      ),
    );
    const identity = await readDesignFrameRenderIdentity(root, frame.file);

    const response = await readDesignProtocolResource(root, {
      path: frame.file,
      sourceVersion: identity.sourceVersion,
    });
    const body = response.body.toString("utf8");

    expect(response.status).toBe(200);
    expect(response.mimeType).toContain("text/html");
    expect(response.headers["Content-Security-Policy"]).toContain(
      "connect-src 'none'",
    );
    expect(response.headers["Content-Security-Policy"]).toContain(
      "img-src zeros-design:",
    );
    expect(response.headers["Cross-Origin-Resource-Policy"]).toBe(
      "cross-origin",
    );
    expect(response.headers["Cache-Control"]).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(body).toContain('href="./tokens.css?v=');
    expect(body).toContain('src="./assets/pixel.png?v=');
    expect(body).not.toContain("data:image/png");
    expect(body).toContain("data-zeros-design-runtime");
    expect(body).toContain(identity.sourceVersion);

    const css = await readDesignProtocolResource(root, {
      path: "tokens.css",
      sourceVersion: identity.sourceVersion,
    });
    expect(css.status).toBe(200);
    expect(css.mimeType).toContain("text/css");
    expect(css.body.toString("utf8")).toContain("@property --bg1");
    expect(css.body.toString("utf8")).toContain(
      `url("./assets/pixel.png?v=${identity.sourceVersion}")`,
    );

    const asset = await readDesignProtocolResource(root, {
      path: "assets/pixel.png",
      sourceVersion: identity.sourceVersion,
    });
    expect(asset.status).toBe(200);
    expect(asset.mimeType).toBe("image/png");
  });

  it("keeps legacy document plumbing non-selectable in the rendered frame", async () => {
    const frame = await createDesignFrame(root, { title: "Legacy ids" });
    const target = path.join(root, DESIGN_DIRECTORY_NAME, frame.file);
    await writeFile(
      target,
      `<!doctype html>
<html data-oid="legacy-html">
  <head data-oid="legacy-head">
    <meta data-oid="legacy-meta" name="zeros-frame" content="width=800,height=600,title=Legacy ids">
    <link data-oid="legacy-link" rel="stylesheet" href="./tokens.css">
    <style data-oid="legacy-style">main { padding: 16px; }</style>
    <title data-oid="legacy-title">Legacy ids</title>
  </head>
  <body data-oid="legacy-body"><main data-oid="legacy-main">Visible</main></body>
</html>`,
      "utf8",
    );
    const identity = await readDesignFrameRenderIdentity(root, frame.file);

    const response = await readDesignProtocolResource(root, {
      path: frame.file,
      sourceVersion: identity.sourceVersion,
    });
    const rendered = response.body.toString("utf8");

    expect(rendered).not.toMatch(
      /<(?:html|head|meta|link|title|style|body)\b[^>]*\bdata-oid=/i,
    );
    expect(rendered).toContain('<main data-oid="legacy-main">Visible</main>');
    expect(rendered).toContain("main { padding: 16px; }");
  });

  it("rejects stale generations, traversal, and symlink escapes", async () => {
    const frame = await createDesignFrame(root, { title: "Safe" });
    const stale = await readDesignProtocolResource(root, {
      path: frame.file,
      sourceVersion: "aaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(stale.status).toBe(409);

    const traversal = await readDesignProtocolResource(root, {
      path: "../package.json",
      sourceVersion: null,
    });
    expect(traversal.status).toBe(404);

    const outside = path.join(root, "outside.png");
    await writeFile(outside, Buffer.from("outside"));
    await symlink(
      outside,
      path.join(root, DESIGN_DIRECTORY_NAME, "assets", "escape.png"),
    );
    const escaped = await readDesignProtocolResource(root, {
      path: "assets/escape.png",
      sourceVersion: null,
    });
    expect(escaped.status).toBe(404);
  });

  it("expands bounded zd components only in the served document", async () => {
    await mkdir(path.join(root, DESIGN_DIRECTORY_NAME, "components"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "components", "card.html"),
      `<!doctype html><html><head><style>zd-card > article { padding: var(--space-2); }</style></head><body><article><slot data-zd-attr="label">Card</slot><slot></slot></article></body></html>`,
    );
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "components", "badge.html"),
      `<!doctype html><html><body><span class="badge"><slot data-zd-attr="label">Badge</slot></span></body></html>`,
    );
    const frame = await createDesignFrame(root, { title: "Components" });
    const target = path.join(root, DESIGN_DIRECTORY_NAME, frame.file);
    const source = (await readFile(target, "utf8")).replace(
      "</main>",
      '<zd-card data-oid="card" label="Shipping"><zd-badge label="Featured"></zd-badge></zd-card></main>',
    );
    await writeFile(target, source);
    const identity = await readDesignFrameRenderIdentity(root, frame.file);

    const response = await readDesignProtocolResource(root, {
      path: frame.file,
      sourceVersion: identity.sourceVersion,
    });
    const rendered = response.body.toString("utf8");
    expect(rendered).toContain("<zd-card");
    expect(rendered).toContain(
      '<article>Shipping<zd-badge label="Featured"><span class="badge">Featured</span></zd-badge></article>',
    );
    expect(rendered.match(/class="badge"/g)).toHaveLength(1);
    expect(rendered).toContain('data-zeros-component="card"');
    expect(await readFile(target, "utf8")).toBe(source);
  });
});
