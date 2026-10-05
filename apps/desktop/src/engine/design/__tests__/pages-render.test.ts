import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  primeDesignDirectoryName,
  forgetDesignDirectoryName,
} from "../directory-registry";
import { readDesignFrame, readDesignWorkspaceSnapshot } from "../document";
import { readDesignProtocolResource } from "../protocol-resource";
import { expandDesignComponents } from "../components";
import { readDesignWebDocumentState } from "../document-transactions";
import { prepareDesignHeadlessHtml } from "@zeros/design-web/playwright";
import { runGit } from "../../git/git-exec";
import { runDesignVerificationCli } from "../verification-cli";
import { startDesignVerificationService } from "../verification-service";
import * as verification from "../verification-service";
import { createDesignContextReference } from "../context";
import {
  handleDesignWorkspaceRoute,
  type DesignWorkspaceRouteHost,
} from "../routes";
import { pagesCanvas, pagesDirectory, pagesManifest } from "./pages-fixtures";

describe("page frame rendering", () => {
  let root: string;
  const write = async (file: string, source: string | Buffer) => {
    await mkdir(path.dirname(path.join(root, pagesDirectory, file)), {
      recursive: true,
    });
    await writeFile(path.join(root, pagesDirectory, file), source);
  };
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-pages-render-"));
    await write("meta/design.toml", pagesManifest);
    await write("meta/canvas.json", JSON.stringify(pagesCanvas));
    await write(
      "tokens.css",
      '.shared { color: red; background-image: url("./assets/root.png"); }',
    );
    await write(
      "page-1/styles.css",
      '.local { color: blue; background-image: url("./local.png"); }',
    );
    await write("assets/root.png", Buffer.from("root-image"));
    await write("assets/component.png", Buffer.from("component-image"));
    await write("page-1/local.png", Buffer.from("local-image"));
    await write(
      "components/card.html",
      '<!doctype html><html><head><style>.card { background-image: url("./assets/component.png"); }</style></head><body><div class="card"><img src="./assets/component.png"><slot></slot></div></body></html>',
    );
    await write(
      "page-1/home.html",
      '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"><link rel="stylesheet" href="./styles.css"><style>.inline { background-image: url("../assets/root.png"); }</style></head><body><main data-oid="home" class="shared local"><img data-oid="local" src="./local.png"><img data-oid="set" srcset="./local.png 1x, ../assets/root.png 2x"><zd-card data-oid="card"><img data-oid="slot" src="./local.png"></zd-card></main></body></html>',
    );
    await write(
      "checkout/home.html",
      '<!doctype html><html><head><link rel="stylesheet" href="../tokens.css"></head><body><main data-oid="checkout">Checkout</main></body></html>',
    );
    primeDesignDirectoryName(root, pagesDirectory);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    forgetDesignDirectoryName(root);
    await rm(root, { recursive: true, force: true });
  });

  it("resolves frame and stylesheet assets at their own source origins", async () => {
    const sourceBefore = await readFile(
      path.join(root, pagesDirectory, "page-1/home.html"),
      "utf8",
    );
    const frame = await readDesignFrame(root, "page-1/home.html");
    const html = frame.srcDoc;
    expect(html).toContain("color: red");
    expect(html).toContain("color: blue");
    for (const payload of ["root-image", "local-image", "component-image"])
      expect(html).toContain(
        `data:image/png;base64,${Buffer.from(payload).toString("base64")}`,
      );
    expect(html).not.toMatch(/(?:src|srcset)="\.\.?\//);
    expect(html).toContain(
      `srcset="data:image/png;base64,${Buffer.from("local-image").toString("base64")} 1x, data:image/png;base64,${Buffer.from("root-image").toString("base64")} 2x"`,
    );
    expect(
      await readFile(
        path.join(root, pagesDirectory, "page-1/home.html"),
        "utf8",
      ),
    ).toBe(sourceBefore);
    const snapshot = await readDesignWorkspaceSnapshot(root);
    expect(
      snapshot.lint.violations.filter(
        (row) => row.ruleId === "local-refs-only",
      ),
    ).toEqual([]);
  });

  it("rebases component definition URLs before mixing frame-authored slot content", async () => {
    const source = await readFile(
      path.join(root, pagesDirectory, "page-1/home.html"),
      "utf8",
    );
    const expanded = await expandDesignComponents(
      root,
      source,
      undefined,
      "page-1/home.html",
    );
    expect(expanded.html).toContain('src="../assets/component.png"');
    expect(expanded.html).toContain('url("../assets/component.png")');
    expect(expanded.html).toContain('data-oid="slot" src="./local.png"');
  });

  it("loads page-local styles into immutable headless source bundles", async () => {
    const state = await readDesignWebDocumentState(root, "page-1/home.html");
    expect(state.files["page-1/styles.css"]).toContain("color: blue");
    // Binary assets and component expansion use the filesystem composer; this
    // textual composer still resolves both shared and page-local stylesheets.
    expect(prepareDesignHeadlessHtml(state)).toContain("color: blue");
  });

  it("renders CSS image URLs with parentheses while preserving literal URL-like text", async () => {
    await write("assets/image(test).png", Buffer.from("parenthesized-image"));
    await write(
      "tokens.css",
      '.image { background: url("./assets/image(test).png"); } .literal::before { content: "url(./assets/root.png)"; }',
    );
    const frame = await readDesignFrame(root, "page-1/home.html");
    expect(frame.srcDoc).toContain(
      `data:image/png;base64,${Buffer.from("parenthesized-image").toString("base64")}`,
    );
    expect(frame.srcDoc).toContain('content: "url(./assets/root.png)"');
  });

  it("serves registered nested HTML with the same generation and CSP as srcDoc", async () => {
    const frame = await readDesignFrame(root, "page-1/home.html");
    const response = await readDesignProtocolResource(root, {
      path: frame.file,
      sourceVersion: frame.sourceVersion,
    });
    expect(response.status).toBe(200);
    expect(response.body.toString("utf8")).toContain(frame.sourceVersion);
    expect(response.headers["Content-Security-Policy"]).toContain(
      "connect-src 'none'",
    );
    expect(
      (
        await readDesignProtocolResource(root, {
          path: frame.file,
          sourceVersion: "a".repeat(24),
        })
      ).status,
    ).toBe(409);
    await write(
      "page-1/unregistered.html",
      "<!doctype html><html><body>Unregistered</body></html>",
    );
    expect(
      (
        await readDesignProtocolResource(root, {
          path: "page-1/unregistered.html",
          sourceVersion: null,
        })
      ).status,
    ).toBe(404);
  });

  it("addresses page frame captures through separate URL segments", async () => {
    await runGit(root, ["init", "-b", "main"]);
    const reference = await createDesignContextReference(
      root,
      "workspace_pages",
      "page-1/home.html",
    );
    const access = {
      url: "http://127.0.0.1:1234/fixture",
      command: "fixture",
      expiresAt: Date.now(),
      captureAvailable: true,
    };
    vi.spyOn(verification, "openDesignVerification").mockResolvedValue(access);
    const capture = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("png", { status: 200 }));
    const host = {
      withDesignReadWorkspace: async (_workspaceId, _remote, read) =>
        read({
          root,
          designDirectory: pagesDirectory,
          writeBack: false,
          workspace: { id: "workspace_pages", path: root },
        } as Parameters<typeof read>[0]),
    } satisfies Pick<DesignWorkspaceRouteHost, "withDesignReadWorkspace">;
    const result = await handleDesignWorkspaceRoute(
      host as DesignWorkspaceRouteHost,
      "design.context.capture",
      {
        workspaceId: "workspace_pages",
        reference,
      },
      { remote: false, hostLocalResources: true },
    );
    expect(capture.mock.calls[0]?.[0]).toBe(
      `${access.url}/page-1/home.html/capture?revision=${reference.revision}&frameId=${reference.frameId}`,
    );
    expect(result).toMatchObject({
      reference,
      mimeType: "image/png",
      data: Buffer.from("png").toString("base64"),
    });
  });

  it("validates and previews nested frames through the ordinary verification URL", async () => {
    await runGit(root, ["init", "-b", "main"]);
    const service = await startDesignVerificationService({
      renderer: () => undefined,
    });
    const access = service.register({
      workspaceId: "workspace_pages",
      workspacePath: root,
      directory: pagesDirectory,
      directoryId: "design_pages",
    });
    try {
      const response = await fetch(`${access.url}/page-1/home.html/state`);
      expect(response.status).toBe(200);
      const state = await response.json();
      expect(state.reference.frame).toBe("page-1/home.html");
      const document = await fetch(
        `${access.url}/page-1/home.html/document?revision=${state.reference.revision}`,
      );
      expect(document.status).toBe(200);
      expect(document.headers.get("content-security-policy")).toContain(
        "script-src 'none'",
      );
      const lines: string[] = [];
      expect(
        await runDesignVerificationCli(
          ["preview", "--url", access.url, "--frame", "page-1/home.html"],
          (line) => lines.push(line),
        ),
      ).toBe(0);
      expect(JSON.parse(lines[0]).url).toContain("/page-1/home.html/");
    } finally {
      await service.stop();
    }
  });
});
