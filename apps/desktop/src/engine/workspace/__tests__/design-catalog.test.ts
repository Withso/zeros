import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceService } from "../service";
import { closeState, setStateRootForTesting } from "../../git";
import { insertWorkspace, updateWorkspace } from "../../git/state";
import {
  primeDesignDirectoryName,
  forgetDesignDirectoryName,
} from "../../design/directory-registry";
import * as metadata from "../../design/catalog-storage";
import {
  designCatalogReplySchema,
  designFramesPrepareReplySchema,
  designPageScopedCatalogSchema,
  DESIGN_CATALOG_BATCH_ENTRIES,
  DESIGN_CATALOG_READ_OPERATION,
  DESIGN_CATALOG_WIDE_BATCH_ENTRIES,
  DESIGN_OPTIONS_SHOW_NOTHING_PARAM,
  designFramesLintReplySchema,
  parseDesignFramesPrepareReply,
} from "@zeros/protocol/design-catalog";
import { withDesignDocumentWrite } from "../../design/document-write-lock";

const directory = "Product - Design";
const admission = {
  connectionId: "local-connection",
  authority: "local-user",
  authorized: () => true,
};
const params = {
  version: 1,
  workspaceId: "catalog-workspace",
  directoryId: "design_test",
  intent: 1,
  limit: 1,
};
describe("Design catalog service authority", () => {
  let root: string;
  let service: WorkspaceService;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-catalog-service-"));
    process.env.ZEROS_DATA_DIR = path.join(root, "private");
    setStateRootForTesting(path.join(root, "state"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    await mkdir(path.join(root, directory, "meta"), { recursive: true });
    await mkdir(path.join(root, directory, "page-1"));
    await writeFile(
      path.join(root, directory, "meta/design.toml"),
      'format = "zeros-design"\nversion = 3\nid = "design_test"\ncanvas = "canvas.json"\n',
    );
    await writeFile(
      path.join(root, directory, "meta/canvas.json"),
      JSON.stringify({
        version: 2,
        pages: [
          { id: "p", title: "Page", folder: "page-1", frames: ["a", "b"] },
        ],
        frames: Object.fromEntries(
          ["a", "b"].map((id) => [
            id,
            {
              kind: "html",
              source: `page-1/${id}.html`,
              title: id,
              x: 0,
              y: 0,
              width: 100,
              height: 100,
            },
          ]),
        ),
      }),
    );
    for (const id of ["a", "b"])
      await writeFile(
        path.join(root, directory, `page-1/${id}.html`),
        `<html><body data-oid="${id}">Synthetic</body></html>`,
      );
    primeDesignDirectoryName(root, directory);
    service = new WorkspaceService(root);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    forgetDesignDirectoryName(root);
    closeState();
    delete process.env.ZEROS_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  });
  const insert = (root: string, organizationId: string | null = null) =>
    insertWorkspace({
      id: params.workspaceId,
      organizationId,
      placement: "local",
      repoRoot: root,
      repoSlug: "catalog",
      path: root,
      branch: "main",
      baseBranch: "main",
      status: "in-progress",
      createdAt: 1,
      archivedAt: null,
      stashRef: null,
      prNumber: null,
      prState: null,
      prUrl: null,
      agentId: null,
      lastActiveAt: null,
    });
  it.each([null, "organization-local"])("negotiates passive surface metadata without changing legacy Local replies for %s", async organizationId => {
    insert(root, organizationId);
    const navigation = await service.handle("design.navigation.read", { workspaceId: params.workspaceId }) as { catalogRevision: string };
    const input = { workspaceId: params.workspaceId, directoryId: params.directoryId,
      catalogRevision: navigation.catalogRevision, files: ["page-1/a.html"] };
    const legacy = designFramesPrepareReplySchema.parse(await service.handle("design.frames.prepare", input));
    expect(legacy.frames[0]).not.toHaveProperty("surfaceCost");
    const capable = designFramesPrepareReplySchema.parse(await service.handle("design.frames.prepare", { ...input, surfaceCosts: true }));
    expect(capable.frames[0]).toHaveProperty("surfaceCost", { sourceBytes: expect.any(Number), nodes: 3, imageBytes: 0 });
  });
  it.each([null, "organization-local"])("reports a component frame's options only to a renderer that asks, for %s", async organizationId => {
    insert(root, organizationId);
    await writeFile(path.join(root, directory, "page-1/a.html"),
      '<html><head><template data-zd-options>\n<zd-option name="width" type="number" default="1" unit="px"></zd-option>\n</template></head><body data-oid="a">Synthetic</body></html>');
    const navigation = await service.handle("design.navigation.read", { workspaceId: params.workspaceId }) as { catalogRevision: string };
    const input = { workspaceId: params.workspaceId, directoryId: params.directoryId,
      catalogRevision: navigation.catalogRevision, files: ["page-1/a.html"] };
    const legacy = designFramesPrepareReplySchema.parse(await service.handle("design.frames.prepare", input));
    expect(legacy.frames[0]).not.toHaveProperty("component");
    const capable = designFramesPrepareReplySchema.parse(await service.handle("design.frames.prepare", { ...input, componentOptions: true }));
    expect(capable.frames[0]?.component).toEqual({
      elements: [{ tag: "zd-option", attributes: [{ name: "name", value: "width" }, { name: "type", value: "number" }, { name: "default", value: "1" }, { name: "unit", value: "px" }] }],
      reach: { width: "css" },
    });
    expect(capable.frames[0]).not.toHaveProperty("surfaceCost");
  });
  it.each([null, "organization-local"])("a main whose own template fails shows nothing and says so, to a renderer that asks, for %s", async organizationId => {
    insert(root, organizationId);
    const canvasFile = path.join(root, directory, "meta/canvas.json");
    const canvas = JSON.parse(await readFile(canvasFile, "utf8"));
    canvas.frames.a.component = "chip";
    await writeFile(canvasFile, JSON.stringify(canvas));
    await writeFile(path.join(root, directory, "page-1/a.html"),
      '<html><head><template data-zd-options>\n<zd-option name="label" type="text" default="Chip"></zd-option>\n</template></head><body data-oid="a"><b data-oid="r">{{ label + }}</b></body></html>');
    await writeFile(path.join(root, directory, "page-1/b.html"), '<html><body data-oid="b"><zd-chip data-oid="ws"></zd-chip></body></html>');
    const workspaceId = params.workspaceId;
    const navigation = await service.handle("design.navigation.read", { workspaceId }) as { catalogRevision: string };
    const input = { workspaceId, directoryId: params.directoryId, catalogRevision: navigation.catalogRevision,
      files: ["page-1/a.html", "page-1/b.html"], componentOptions: true };
    const shownReply = await service.handle("design.frame", { workspaceId, frame: "page-1/a.html" });
    // Every reply below made without negotiating carries no "nothing", whatever key holds the record.
    expect(JSON.stringify(shownReply)).not.toContain('"nothing"');
    const shown = (shownReply as { frame: { srcDoc: string } }).frame.srcDoc;
    expect(shown).not.toContain("{{");
    expect(shown).not.toContain("label +");
    const capable = parseDesignFramesPrepareReply(await service.handle("design.frames.prepare", { ...input, [DESIGN_OPTIONS_SHOW_NOTHING_PARAM]: true }),
      { optionsShowNothing: true });
    const byFile = new Map(capable.frames.map((frame) => [frame.file, frame]));
    expect(byFile.get("page-1/a.html")?.component?.notApplied).toBe("nothing");
    expect(byFile.get("page-1/b.html")?.instances?.hosts.ws?.failed).toBe(true);
    expect(byFile.get("page-1/b.html")?.instances?.notApplied).toBe("nothing");
    const snapshot = await service.handle("design.snapshot", { workspaceId, [DESIGN_OPTIONS_SHOW_NOTHING_PARAM]: true }) as {
      snapshot: { frames: Array<{ file: string; component?: { notApplied?: string }; instances?: { notApplied?: string } }> } };
    expect(snapshot.snapshot.frames.find((frame) => frame.file === "page-1/a.html")?.component?.notApplied).toBe("nothing");
    // An older renderer reads records strictly and knows only these two values:
    // it is told "defaults" and still receives no raw template source.
    const legacyRaw = await service.handle("design.frames.prepare", input);
    expect(JSON.stringify(legacyRaw)).not.toContain('"nothing"');
    const legacy = parseDesignFramesPrepareReply(legacyRaw);
    expect(legacy.errors).toEqual([]);
    expect(legacy.frames.map((frame) => frame.component?.notApplied ?? frame.instances?.notApplied)).toEqual(["defaults", "defaults"]);
    const legacySnapshot = await service.handle("design.snapshot", { workspaceId });
    expect(JSON.stringify(legacySnapshot)).not.toContain('"nothing"');
    const legacyShownReply = await service.handle("design.frame", { workspaceId, frame: "page-1/a.html" });
    expect(JSON.stringify(legacyShownReply)).not.toContain('"nothing"');
    const legacyShown = (legacyShownReply as { frame: { srcDoc: string } }).frame.srcDoc;
    expect(legacyShown).not.toContain("{{");
  });
  it.each([null, "organization-local"])("lints on preparation only the frames a renderer names, for %s", async organizationId => {
    insert(root, organizationId);
    await writeFile(path.join(root, directory, "page-1/a.html"), '<html><body data-oid="a"><p data-oid="p" class="no-such-class">Synthetic</p></body></html>');
    const navigation = await service.handle("design.navigation.read", { workspaceId: params.workspaceId }) as { catalogRevision: string };
    const input = { workspaceId: params.workspaceId, directoryId: params.directoryId,
      catalogRevision: navigation.catalogRevision, files: ["page-1/a.html", "page-1/b.html"] };
    const legacy = await service.handle("design.frames.prepare", input);
    expect(legacy).not.toHaveProperty("lint");
    const linted = designFramesPrepareReplySchema.parse(await service.handle("design.frames.prepare", { ...input, lintFiles: ["page-1/a.html"] }));
    expect(linted.frames.map((frame) => frame.file).sort()).toEqual(["page-1/a.html", "page-1/b.html"]);
    expect(linted.lint?.checkedFiles).toEqual(["page-1/a.html"]);
    expect(linted.lint?.violations).toContainEqual(expect.objectContaining({ file: "page-1/a.html", ruleId: "unknown-class", oid: "p" }));
    expect(linted.lint?.violations.every((violation) => violation.file === "page-1/a.html")).toBe(true);
    // Linting on preparation reads the source; it never writes it.
    expect(await readFile(path.join(root, directory, "page-1/a.html"), "utf8")).toContain('class="no-such-class"');
  });
  it.each([null, "organization-local"])("lints the frames that prepared when another named frame's file is gone, for %s", async organizationId => {
    insert(root, organizationId);
    await writeFile(path.join(root, directory, "page-1/a.html"), '<html><body data-oid="a"><p data-oid="p" class="no-such-class">Synthetic</p></body></html>');
    const navigation = await service.handle("design.navigation.read", { workspaceId: params.workspaceId }) as { catalogRevision: string };
    // Changed outside Zeros while both were prepared: one edited, one deleted.
    await rm(path.join(root, directory, "page-1/b.html"));
    const files = ["page-1/a.html", "page-1/b.html"];
    const reply = designFramesPrepareReplySchema.parse(await service.handle("design.frames.prepare", { workspaceId: params.workspaceId,
      directoryId: params.directoryId, catalogRevision: navigation.catalogRevision, files, lintFiles: files }));
    expect(reply.frames.map((frame) => frame.file)).toEqual(["page-1/a.html"]);
    expect(reply.errors.map((error) => error.file)).toEqual(["page-1/b.html"]);
    expect(reply.lint?.checkedFiles).toEqual(["page-1/a.html"]);
    expect(reply.lint?.violations).toContainEqual(expect.objectContaining({ file: "page-1/a.html", ruleId: "unknown-class", oid: "p" }));
  });
  it.each([null, "organization-local"])("keeps lint off a scoped write acknowledgement and lints the written frame on request without the write lock, for %s", async organizationId => {
    insert(root, organizationId);
    const source = '<html><body data-oid="a"><p data-oid="p" class="no-such-class">Synthetic</p></body></html>';
    await writeFile(path.join(root, directory, "page-1/a.html"), source);
    const workspaceId = params.workspaceId;
    const geometry = { x: 0, y: 0, w: 100, h: 100, z: 0 };
    const moved = await service.handle("design.frames.move", { workspaceId, snapshotMode: "scoped",
      moves: [{ frame: "page-1/a.html", from: geometry, to: { ...geometry, x: 40 } }] }) as {
      snapshot: { frames: Array<{ file: string; sourceVersion: string }>; lint: { checkedFiles: string[]; violations: unknown[] } } };
    expect(moved.snapshot.lint).toMatchObject({ checkedFiles: [], violations: [] });
    const sourceVersion = moved.snapshot.frames.find((frame) => frame.file === "page-1/a.html")!.sourceVersion;
    // A write holding the document lock does not keep this read waiting.
    let release!: () => void;
    const held = withDesignDocumentWrite(root, () => new Promise<void>((done) => { release = done; }));
    try {
      const linted = designFramesLintReplySchema.parse(await service.handle("design.frames.lint", { workspaceId, directoryId: params.directoryId,
        frames: [{ file: "page-1/a.html", sourceVersion }, { file: "page-1/b.html", sourceVersion: "0".repeat(24) }] }));
      // b.html has another source than the one named: no rows for it.
      expect(linted.frames).toEqual([{ file: "page-1/a.html", sourceVersion }]);
      expect(linted.checkedFiles).toEqual(["page-1/a.html"]);
      expect(linted.violations).toContainEqual(expect.objectContaining({ file: "page-1/a.html", ruleId: "unknown-class", oid: "p" }));
      expect(linted.violations.every((violation) => violation.file === "page-1/a.html")).toBe(true);
    } finally { release(); await held; }
    expect(await readFile(path.join(root, directory, "page-1/a.html"), "utf8")).toBe(source);
    await expect(service.handle("design.frames.lint", { workspaceId, directoryId: "design_other", frames: [{ file: "page-1/a.html", sourceVersion }] }))
      .rejects.toThrow();
  });
  it.each([null, "organization-local"])("negotiates page hashes and page-scoped write acknowledgements for %s", async organizationId => {
    insert(root, organizationId);
    const workspaceId = params.workspaceId;
    expect(await service.handle("design.navigation.read", { workspaceId })).not.toHaveProperty("pageHashes");
    const navigation = await service.handle("design.navigation.read", { workspaceId, pageHashes: true }) as { pageHashes: Record<string, string> };
    expect(Object.keys(navigation.pageHashes)).toEqual(["p"]);
    const scoped = await service.handle("design.frame.create", { workspaceId, pageId: "p", title: "Scoped",
      snapshotMode: "scoped", knownPages: navigation.pageHashes }) as { frame: { file: string }; snapshot: Record<string, unknown> };
    expect(scoped.snapshot).not.toHaveProperty("mutationCatalog");
    expect(scoped.snapshot).not.toHaveProperty("pages");
    expect(designPageScopedCatalogSchema.parse(scoped.snapshot.pageCatalog).frames.map((frame) => frame.source)).toContain(scoped.frame.file);
    for (const extra of [{}, { knownPages: { p: "not-a-hash" } }]) {
      const complete = await service.handle("design.frame.create", { workspaceId, pageId: "p", title: "Complete",
        snapshotMode: "scoped", ...extra }) as { snapshot: Record<string, unknown> };
      expect(complete.snapshot).toHaveProperty("mutationCatalog");
      expect(complete.snapshot).not.toHaveProperty("pageCatalog");
    }
  });
  it.each([null, "organization-local"])(
    "preserves exact Local ownership %s and never returns a full-snapshot envelope",
    async (organizationId) => {
      insert(root, organizationId);
      const before = await readFile(
        path.join(root, directory, "meta/canvas.json"),
        "utf8",
      );
      const first = designCatalogReplySchema.parse(
        await service.handle(DESIGN_CATALOG_READ_OPERATION, params, {
          catalogAdmission: admission,
        }),
      );
      expect(first).toMatchObject({
        status: "ready",
        coverage: "partial",
        owner: {
          workspaceId: params.workspaceId,
          directoryId: "design_test",
          organizationId,
          placement: "local",
        },
      });
      expect(first).not.toHaveProperty("snapshot");
      expect(first).not.toHaveProperty("protocolCapability");
      expect(first).not.toHaveProperty("lint");
      if (first.status !== "ready" || !first.nextCursor)
        throw new Error("missing cursor");
      expect(
        await service.handle(
          DESIGN_CATALOG_READ_OPERATION,
          { ...params, cursor: first.nextCursor },
          { catalogAdmission: admission },
        ),
      ).toMatchObject({
        status: "ready",
        offset: 1,
        coverage: "partial",
        nextCursor: null,
      });
      expect(
        await readFile(path.join(root, directory, "meta/canvas.json"), "utf8"),
      ).toBe(before);
    },
  );
  it("requires server connection authority and rejects an unqualified remote read", async () => {
    insert(root);
    await expect(
      service.handle(DESIGN_CATALOG_READ_OPERATION, params),
    ).rejects.toThrow(/connection/);
    expect(
      await service.handle(DESIGN_CATALOG_READ_OPERATION, params, {
        catalogAdmission: { ...admission, authorized: () => false },
      }),
    ).toMatchObject({ reason: "authority-lost" });
    await expect(
      service.handle(DESIGN_CATALOG_READ_OPERATION, params, {
        remote: true,
        catalogAdmission: admission,
      }),
    ).rejects.toThrow();
  });
  it("answers wide batches to a Local connection only", async () => {
    const ids = Array.from({ length: 600 }, (_, index) => `f${index}`);
    await writeFile(path.join(root, directory, "meta/canvas.json"), JSON.stringify({
      version: 2,
      pages: [{ id: "p", title: "Page", folder: "page-1", frames: ids }],
      frames: Object.fromEntries(ids.map((id, index) => [id, { kind: "html", source: `page-1/${id}.html`, title: id,
        x: index * 120, y: 0, width: 100, height: 100 }])),
    }));
    insert(root);
    const wide = { ...params, limit: DESIGN_CATALOG_WIDE_BATCH_ENTRIES };
    const local = designCatalogReplySchema.parse(await service.handle(DESIGN_CATALOG_READ_OPERATION, wide, {
      hostLocalResources: true, catalogAdmission: admission }));
    // A cloud connection: the engine passes hostLocalResources for Local ones only.
    const other = designCatalogReplySchema.parse(await service.handle(DESIGN_CATALOG_READ_OPERATION, { ...wide, intent: 2 }, {
      hostLocalResources: false, catalogAdmission: admission }));
    if (local.status !== "ready" || other.status !== "ready") throw new Error("expected batches");
    expect(local.frames.length).toBeGreaterThan(DESIGN_CATALOG_BATCH_ENTRIES);
    expect(other.frames).toHaveLength(DESIGN_CATALOG_BATCH_ENTRIES);
  });

  it("revalidates root replacement and catalog revision on continuation", async () => {
    insert(root);
    const first = designCatalogReplySchema.parse(
      await service.handle(DESIGN_CATALOG_READ_OPERATION, params, {
        catalogAdmission: admission,
      }),
    );
    if (first.status !== "ready" || !first.nextCursor)
      throw new Error("missing cursor");
    const restored = path.join(root, "restored");
    await mkdir(restored);
    execFileSync("git", ["init", "-q"], { cwd: restored });
    await cp(path.join(root, directory), path.join(restored, directory), {
      recursive: true,
    });
    primeDesignDirectoryName(restored, directory);
    updateWorkspace(params.workspaceId, { path: restored });
    try {
      expect(
        await service.handle(
          DESIGN_CATALOG_READ_OPERATION,
          { ...params, cursor: first.nextCursor },
          { catalogAdmission: admission },
        ),
      ).toMatchObject({ reason: "stale" });
    } finally {
      forgetDesignDirectoryName(restored);
    }
  });
  it("does not publish a held read after its transport authority retires", async () => {
    insert(root);
    const original = metadata.readDesignCatalogMetadata;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(metadata, "readDesignCatalogMetadata").mockImplementation(
      async (root, directory) => {
        const value = await original(root, directory);
        entered();
        await pending;
        return value;
      },
    );
    let authorized = true;
    const reading = service.handle(DESIGN_CATALOG_READ_OPERATION, params, {
      catalogAdmission: { ...admission, authorized: () => authorized },
    });
    await inside;
    authorized = false;
    release();
    expect(await reading).toMatchObject({ reason: "authority-lost" });
  });
  it("classifies catalog reads as non-authoring and not generically remote", () => {
    expect(service.isWriteOp(DESIGN_CATALOG_READ_OPERATION)).toBe(false);
    expect(service.isRemoteAllowed(DESIGN_CATALOG_READ_OPERATION)).toBe(false);
  });
});
