import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDesignPage,
  deleteDesignPage,
  initializeDesignDocument,
  readDesignWebDocumentState,
} from "../document";
import {
  nativeDesignContext,
  designPromptContext,
} from "../conversation-tools";
import { DesignCodeTools, type DesignCodeToolTarget } from "../code-tools";
import { withDesignDirectoryNameLease } from "../directory-registry";
import { createDesignDirectoryPages, designDirectoryEntry } from "../metadata";
import { selectDesignPageHint } from "../page-selection";
import { DesignPageTargetError } from "../pages";
import { resetWorkspaceDesignApisForTests } from "../design-api";
import { serializeDesignRegistration } from "../manifest";

describe("page context and agent frame targeting", () => {
  let root: string;
  let target: DesignCodeToolTarget;
  let tools: DesignCodeTools;
  const directory = "Product - Design";
  const run = <T>(action: () => Promise<T>) =>
    withDesignDirectoryNameLease(root, directory, action);
  const canvasSource = () =>
    readFileSync(path.join(root, directory, "meta/canvas.json"), "utf8");
  const initialPage = () => {
    const { id, title, folder } = JSON.parse(canvasSource()).pages[0] as {
      id: string;
      title: string;
      folder: string;
    };
    return { id, title, folder };
  };
  async function call(name: string, args: unknown = {}) {
    const result = await tools.callTool(
      name,
      args,
      new AbortController().signal,
    );
    const first = result.content[0];
    if (first?.type !== "text") throw new Error("Missing tool result");
    return JSON.parse(first.text);
  }
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-page-context-"));
    await run(() => initializeDesignDocument(root));
    target = {
      workspaceId: "workspace",
      workspacePath: root,
      directory,
      directoryId: designDirectoryEntry(root, directory)!.id,
      actorId: "conversation",
      assertCurrent: () => {},
    };
    tools = new DesignCodeTools(target, { requireDesignMode: false });
  });
  afterEach(async () => {
    tools.dispose();
    resetWorkspaceDesignApisForTests();
    await rm(root, { recursive: true, force: true });
  });

  it("names the sole page in native and API prompt context and exposes the catalog in capabilities", async () => {
    const before = canvasSource();
    for (const method of ["native", "api"] as const) {
      const context = await designPromptContext(
        async () => target,
        "code",
        () => {},
        method,
      );
      expect(context).toContain("Page 1");
      expect(context).toContain("page-1/");
      expect(context).toContain(initialPage().id);
      if (method === "native") {
        expect(context).toContain("--output '<png-output-path>'");
        expect(context).not.toContain(".context/");
      }
    }
    expect(await call("design_capabilities")).toMatchObject({
      pages: [{ ...initialPage(), frameFiles: [] }],
      activePageId: initialPage().id,
    });
    expect(canvasSource()).toBe(before);
  });

  it.each(["invalid canvas", "competing manifests"])(
    "reports %s without losing capabilities or prompt context",
    async (failure) => {
      if (failure === "invalid canvas") {
        writeFileSync(
          path.join(root, directory, "meta/canvas.json"),
          "<<<<<<< unresolved canvas",
        );
      } else {
        writeFileSync(
          path.join(root, directory, "design.toml"),
          serializeDesignRegistration(target.directoryId),
        );
      }
      const capabilities = await call("design_capabilities");
      expect(capabilities).toMatchObject({
        version: 1,
        directoryId: target.directoryId,
        composerMode: { mode: "code", revision: 0 },
        pages: null,
        activePageId: null,
        pagesError: expect.stringMatching(/canvas|competing|conflict|JSON/i),
      });
      expect(capabilities.tools).toContain("design_document_open");
      for (const mode of ["code", "design"] as const) {
        for (const method of ["native", "api"] as const) {
          const context = await designPromptContext(
            async () => target,
            mode,
            () => {},
            method,
          );
          expect(context).toMatch(
            /pages? (?:catalog )?(?:is |are )?unavailable/i,
          );
          expect(context).toMatch(/canvas|competing|conflict|JSON/i);
        }
      }
    },
  );

  it("honors only a current hint belonging to this workspace and active directory", async () => {
    const checkout = await run(() =>
      createDesignPage(root, { title: "Checkout" }),
    );
    selectDesignPageHint(target.workspaceId, root, {
      directoryId: target.directoryId,
      pageId: checkout.id,
    });
    const context = await nativeDesignContext(target, "code");
    expect(context).toContain('The user is viewing page "Checkout"');
    expect(context).toContain("checkout/");
    expect(context).toContain(
      "add new frames there unless the user says otherwise",
    );
    expect(context).toContain(initialPage().id);
    expect(context).toContain(checkout.id);
    expect(await call("design_capabilities")).toMatchObject({
      activePageId: checkout.id,
      pages: [{ id: initialPage().id }, { id: checkout.id }],
    });
    selectDesignPageHint(target.workspaceId, root, {
      directoryId: target.directoryId,
      pageId: "stale_page",
    });
    const fallback = await nativeDesignContext(target, "code");
    expect(fallback).toContain("default to the first page");
    expect(await call("design_capabilities")).toMatchObject({
      activePageId: initialPage().id,
    });
    await run(() => deleteDesignPage(root, checkout.id, []));
    selectDesignPageHint(target.workspaceId, root, {
      directoryId: target.directoryId,
      pageId: checkout.id,
    });
    expect(await call("design_capabilities")).toMatchObject({
      activePageId: initialPage().id,
    });
    expect(existsSync(path.join(root, directory, checkout.folder))).toBe(false);
  });

  it("ignores a hint for a separately registered directory or workspace", async () => {
    const otherDirectory = "Other Design";
    await mkdir(path.join(root, otherDirectory));
    createDesignDirectoryPages(root, otherDirectory, {
      frames: {},
      frame_info: {},
    });
    const otherId = designDirectoryEntry(root, otherDirectory)!.id;
    selectDesignPageHint(target.workspaceId, root, {
      directoryId: otherId,
      pageId: "another",
    });
    expect(await call("design_capabilities")).toMatchObject({
      activePageId: initialPage().id,
    });
    selectDesignPageHint("other-workspace", root, {
      directoryId: target.directoryId,
      pageId: "another",
    });
    expect(await nativeDesignContext(target, "code")).toContain('"Page 1"');
  });

  it("requires explicit API page targets in a multi-page directory even with an active hint", async () => {
    const checkout = await run(() =>
      createDesignPage(root, { title: "Checkout" }),
    );
    selectDesignPageHint(target.workspaceId, root, {
      directoryId: target.directoryId,
      pageId: checkout.id,
    });
    const capabilities = await call("design_capabilities");
    expect(
      capabilities.tools.some((name: string) =>
        name.startsWith("design_page_"),
      ),
    ).toBe(false);
    const input = { title: "Home", createdAt: capabilities.serverTime };
    await expect(
      call("design_frame_create", { ...input, requestId: "ambiguous" }),
    ).rejects.toThrow(/pageId required/i);
    await expect(
      call("design_frame_create", {
        ...input,
        requestId: "invalid-page",
        pageId: 123,
      }),
    ).rejects.toThrow();
    const created = await call("design_frame_create", {
      ...input,
      requestId: "checkout-home",
      pageId: checkout.id,
    });
    expect(created).toMatchObject({
      file: "checkout/home.html",
      pageId: checkout.id,
    });
    expect(
      await call("design_frame_create", {
        ...input,
        requestId: "checkout-home",
        pageId: checkout.id,
      }),
    ).toEqual(created);
    const state = await run(() =>
      readDesignWebDocumentState(root, created.file),
    );
    const duplicate = {
      documentId: `frame:${created.file}`,
      expectedRevision: state.revision,
      createdAt: capabilities.serverTime,
    };
    await expect(
      call("design_frame_duplicate", {
        ...duplicate,
        requestId: "ambiguous-duplicate",
      }),
    ).rejects.toThrow(/pageId required/i);
    const copied = await call("design_frame_duplicate", {
      ...duplicate,
      requestId: "copy-to-first",
      pageId: initialPage().id,
    });
    expect(copied).toMatchObject({
      file: "page-1/home-copy.html",
      pageId: initialPage().id,
    });
    const canvas = JSON.parse(canvasSource());
    expect(
      canvas.pages.map((page: { frames: string[] }) => page.frames.length),
    ).toEqual([1, 1]);
  });

  it("retains the optional single-page API target for existing callers", async () => {
    const frame = await call("design_frame_create", {
      requestId: "single-page",
      title: "Home",
      createdAt: Date.now(),
    });
    expect(frame).toMatchObject({
      file: "page-1/home.html",
      pageId: initialPage().id,
    });
    const state = await run(() => readDesignWebDocumentState(root, frame.file));
    expect(
      await call("design_frame_duplicate", {
        requestId: "single-duplicate",
        documentId: `frame:${frame.file}`,
        expectedRevision: state.revision,
        createdAt: Date.now(),
      }),
    ).toMatchObject({ pageId: initialPage().id });
  });

  it.each(["code", "design"] as const)(
    "preserves explicit target errors in %s prompt preparation",
    async (mode) => {
      const error = new DesignPageTargetError(
        "The explicit Design page was removed. Refresh its target.",
      );
      await expect(
        designPromptContext(
          async () => {
            throw error;
          },
          mode,
          () => {},
        ),
      ).rejects.toBe(error);
      await expect(
        designPromptContext(
          async () => ({
            ...target,
            assertCurrent: () => {
              throw error;
            },
          }),
          mode,
          () => {},
        ),
      ).rejects.toBe(error);
    },
  );

  it("propagates a resolved owner's revocation instead of an inspection notice", async () => {
    const error = new Error(
      "Design directory selection changed; reopen the session.",
    );
    await expect(
      designPromptContext(
        async () => ({
          ...target,
          assertCurrent: () => {
            throw error;
          },
        }),
        "code",
        () => {},
      ),
    ).rejects.toBe(error);
  });

  it("still permits native source conflict repair when observational inspection is unavailable", async () => {
    const context = await designPromptContext(
      async () => {
        throw new Error("Conflicted canvas JSON");
      },
      "design",
      () => {},
    );
    expect(context).toContain("inspect and repair");
  });
});
