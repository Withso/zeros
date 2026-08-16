import { applyDesignTransaction } from "@zeros/design-core";
import { describe, expect, it, vi } from "vitest";

import {
  DesignApi,
  DesignApiAuthorizationError,
  DesignApiRepositoryConflictError,
  InMemoryDesignDocumentRepository,
  type DesignApiOptions,
  type DesignDocumentRepository,
  type DesignHeadlessRenderer,
} from "../api";
import { designWebTransactionAdapter } from "../adapter";
import { FRAME_CSS, FRAME_HTML, webState, webTransaction } from "./fixtures";

function repository() {
  const state = webState();
  return new InMemoryDesignDocumentRepository([
    {
      documentId: state.documentId,
      entryFile: state.entryFile,
      files: state.files,
      manifest: state.manifest,
      frames: state.frames,
    },
  ]);
}

function trustedApi(
  storage: DesignDocumentRepository,
  options: Omit<DesignApiOptions, "authorization"> = {},
): DesignApi {
  return new DesignApi(storage, {
    ...options,
    authorization: { kind: "trusted-in-process" },
  });
}

function styleTransaction() {
  const state = webState();
  return webTransaction(state, "api-style-edit", [
    {
      operationId: "set-color",
      type: "node.set-styles",
      nodeId: "card",
      styles: { color: "rebeccapurple" },
      scope: "auto",
      responsiveContext: "base",
      stateContext: "default",
    },
  ]);
}

describe("headless Design API", () => {
  it("fails closed for mutations when a caller does not declare its authority", async () => {
    const storage = repository();
    const api = new DesignApi(storage);

    await expect(api.open("document-1")).rejects.toBeInstanceOf(
      DesignApiAuthorizationError,
    );
    await expect(api.apply(styleTransaction())).rejects.toBeInstanceOf(
      DesignApiAuthorizationError,
    );
    expect((await storage.read("document-1")).files["styles.css"]).toBe(
      FRAME_CSS,
    );
  });

  it("paginates projections and applies the same adapter operation as a direct caller", async () => {
    const storage = repository();
    const api = trustedApi(storage);
    const opened = await api.open("document-1");
    const firstPage = await api.readProjection({
      documentId: "document-1",
      expectedRevision: opened.revision,
      limit: 2,
    });
    expect(firstPage.nodes.map((node) => node.id)).toEqual(["root", "card"]);
    expect(firstPage.nextCursor).toBe("2");
    const secondPage = await api.readProjection({
      documentId: "document-1",
      expectedRevision: opened.revision,
      cursor: firstPage.nextCursor!,
      limit: 2,
    });
    expect(secondPage.nodes.map((node) => node.id)).toEqual(["label"]);

    const transaction = styleTransaction();
    const direct = applyDesignTransaction(
      webState(),
      transaction,
      designWebTransactionAdapter,
    );
    const applied = await api.apply(transaction);
    const source = await api.readSource({
      documentId: "document-1",
      file: "styles.css",
      expectedRevision: applied.revision,
    });
    expect(source.source).toBe(direct.state.files["styles.css"]);
    expect(applied.receipt.status).toBe("applied");
  });

  it("validates untrusted read inputs and bounds runtime provenance evidence", async () => {
    const api = trustedApi(repository());
    await expect(api.open("../outside")).rejects.toThrow("ID must be portable");
    await expect(
      api.readSource({ documentId: "document-1", file: "toString" }),
    ).rejects.toThrow("source file is missing");
    await expect(
      api.readProvenance({
        documentId: "document-1",
        nodeId: "card",
        property: "color",
        matched: Array.from({ length: 257 }, () => ({
          property: "color",
          value: "red",
          active: true,
        })),
      }),
    ).rejects.toThrow("matched declarations");
  });

  it("dry-runs without writing and supports API undo and redo", async () => {
    const storage = repository();
    const api = trustedApi(storage);
    const transaction = styleTransaction();
    const dryRun = await api.apply(transaction, { dryRun: true });
    expect(dryRun.dryRun).toBe(true);
    expect((await storage.read("document-1")).files["styles.css"]).toBe(
      FRAME_CSS,
    );

    const applied = await api.apply(transaction);
    expect(applied.dryRun).toBe(false);
    expect((await api.undo("document-1"))?.revision).not.toBe(applied.revision);
    expect((await storage.read("document-1")).files["styles.css"]).toBe(
      FRAME_CSS,
    );
    await api.redo("document-1");
    expect((await storage.read("document-1")).files["styles.css"]).toContain(
      "rebeccapurple",
    );
  });

  it("retains a no-op receipt without performing a durable commit", async () => {
    class CountingRepository extends InMemoryDesignDocumentRepository {
      commits = 0;

      override async commit(
        input: Parameters<InMemoryDesignDocumentRepository["commit"]>[0],
      ) {
        this.commits += 1;
        return super.commit(input);
      }
    }
    const initial = webState();
    const storage = new CountingRepository([
      {
        documentId: initial.documentId,
        entryFile: initial.entryFile,
        files: initial.files,
        manifest: initial.manifest,
        frames: initial.frames,
      },
    ]);
    const api = trustedApi(storage);
    const result = await api.apply(
      webTransaction(initial, "no-op-style", [
        {
          operationId: "keep-color",
          type: "node.set-styles",
          nodeId: "card",
          styles: { color: "red" },
          scope: "auto",
          responsiveContext: "base",
          stateContext: "default",
        },
      ]),
    );

    expect(result.receipt.status).toBe("noop");
    expect(storage.commits).toBe(0);
  });

  it("applies source budgets identically during dry-run and durable execution", async () => {
    const padding = "x".repeat(1_800_000);
    const html = FRAME_HTML.replace("<head>", `<head><!--${padding}-->`);
    const storage = new InMemoryDesignDocumentRepository([
      {
        documentId: "bounded-document",
        entryFile: "index.html",
        files: { "index.html": html, "styles.css": FRAME_CSS },
        frames: {
          "index.html": { x: 0, y: 0, width: 800, height: 600, z: 0 },
        },
      },
    ]);
    const api = trustedApi(storage);
    const opened = await api.open("bounded-document");
    const transaction = {
      schemaVersion: 1 as const,
      transactionId: "oversized-source-result",
      documentId: "bounded-document",
      baseRevision: opened.revision,
      actor: { kind: "agent" as const, id: "test-agent" },
      intent: "Attempt an oversized append",
      createdAt: 1,
      operations: [
        {
          operationId: "append",
          type: "node.set-html" as const,
          nodeId: "root",
          html: `<span data-oid="large-child">${"y".repeat(350_000)}</span>`,
          mode: "append" as const,
        },
      ],
    };

    await expect(api.apply(transaction, { dryRun: true })).rejects.toThrow(
      "per-file limit",
    );
    await expect(api.apply(transaction)).rejects.toThrow("per-file limit");
    expect((await storage.read("bounded-document")).files["index.html"]).toBe(
      html,
    );
  });

  it("denies unauthorized and internal source operations", async () => {
    const state = webState();
    class CountingReadRepository extends InMemoryDesignDocumentRepository {
      reads = 0;

      override async read(documentId: string) {
        this.reads += 1;
        return super.read(documentId);
      }
    }
    const deniedStorage = new CountingReadRepository([
      {
        documentId: state.documentId,
        entryFile: state.entryFile,
        files: state.files,
        manifest: state.manifest,
        frames: state.frames,
      },
    ]);
    const denied = new DesignApi(deniedStorage, {
      authorization: {
        kind: "authorize",
        actor: { kind: "agent", id: "denied-agent" },
        authorize: () => false,
      },
    });
    await expect(denied.apply(styleTransaction())).rejects.toBeInstanceOf(
      DesignApiAuthorizationError,
    );
    expect(deniedStorage.reads).toBe(0);

    const api = trustedApi(repository());
    await expect(
      api.apply(
        webTransaction(state, "internal-splice", [
          {
            operationId: "splice",
            type: "source.splice",
            file: "index.html",
            start: 0,
            deleteText: "",
            insertText: "bad",
          },
        ]),
      ),
    ).rejects.toBeInstanceOf(DesignApiAuthorizationError);
  });

  it("binds an authorized API to one actor and rejects actor self-escalation", async () => {
    const storage = repository();
    const seen: Array<{ actor: string; operations: string[] }> = [];
    const api = new DesignApi(storage, {
      authorization: {
        kind: "authorize",
        actor: { kind: "agent", id: "design-child" },
        authorize: ({ actor, operationTypes }) => {
          seen.push({ actor: `${actor.kind}:${actor.id}`, operations: operationTypes });
          return true;
        },
      },
    });

    await api.open("document-1");
    await expect(api.apply(styleTransaction())).rejects.toBeInstanceOf(
      DesignApiAuthorizationError,
    );
    expect((await storage.read("document-1")).files["styles.css"]).toBe(
      FRAME_CSS,
    );
    expect(seen).toEqual([
      { actor: "agent:design-child", operations: ["document.open"] },
    ]);
  });

  it("clears unsafe history after an external edit and rejects stale callers", async () => {
    const storage = repository();
    const api = trustedApi(storage);
    const applied = await api.apply(styleTransaction());
    storage.replace({
      documentId: "document-1",
      entryFile: "index.html",
      files: {
        "index.html": FRAME_HTML.replace("Hello", "External"),
        "styles.css": FRAME_CSS.replace("red", "blue"),
      },
      frames: webState().frames,
    });
    const reopened = await api.open("document-1");
    expect(reopened.history).toMatchObject({ canUndo: false, canRedo: false });
    await expect(
      api.readProjection({
        documentId: "document-1",
        expectedRevision: applied.revision,
      }),
    ).rejects.toBeInstanceOf(DesignApiRepositoryConflictError);
  });

  it("rolls back session history and idempotency state when a repository commit fails", async () => {
    class FailOnceRepository extends InMemoryDesignDocumentRepository {
      failNext = false;

      override async commit(
        input: Parameters<InMemoryDesignDocumentRepository["commit"]>[0],
      ) {
        if (this.failNext) {
          this.failNext = false;
          throw new Error("simulated durable write failure");
        }
        return super.commit(input);
      }
    }

    const initial = webState();
    const storage = new FailOnceRepository([
      {
        documentId: initial.documentId,
        entryFile: initial.entryFile,
        files: initial.files,
        manifest: initial.manifest,
        frames: initial.frames,
      },
    ]);
    const api = trustedApi(storage);
    await api.apply(styleTransaction());
    const beforeFailure = await api.open("document-1");
    expect(beforeFailure.history.undoDepth).toBe(1);
    const retryable = {
      schemaVersion: 1 as const,
      transactionId: "retry-after-write-failure",
      documentId: "document-1",
      baseRevision: beforeFailure.revision,
      actor: { kind: "human" as const, id: "tester" },
      intent: "Set padding after a transient failure",
      createdAt: 2,
      operations: [
        {
          operationId: "set-padding",
          type: "node.set-styles" as const,
          nodeId: "card",
          styles: { padding: "24px" },
          scope: "auto" as const,
          responsiveContext: "base",
          stateContext: "default",
        },
      ],
    };
    storage.failNext = true;
    await expect(api.apply(retryable)).rejects.toThrow(
      "simulated durable write failure",
    );
    const afterFailure = await api.open("document-1");
    expect(afterFailure.history.undoDepth).toBe(1);
    expect(
      (await api.readSource({ documentId: "document-1", file: "styles.css" }))
        .source,
    ).not.toContain("24px");

    await expect(api.apply(retryable)).resolves.toMatchObject({
      receipt: { status: "applied" },
    });
    expect((await api.open("document-1")).history.undoDepth).toBe(2);
  });

  it("restores the session even when recovery cannot immediately reread storage", async () => {
    class UnavailableAfterFailureRepository extends InMemoryDesignDocumentRepository {
      failCommit = true;
      failRead = false;

      override async commit(
        input: Parameters<InMemoryDesignDocumentRepository["commit"]>[0],
      ) {
        if (this.failCommit) {
          this.failCommit = false;
          this.failRead = true;
          throw new Error("simulated commit failure");
        }
        return super.commit(input);
      }

      override async read(documentId: string) {
        if (this.failRead) {
          this.failRead = false;
          throw new Error("simulated recovery read failure");
        }
        return super.read(documentId);
      }
    }

    const initial = webState();
    const storage = new UnavailableAfterFailureRepository([
      {
        documentId: initial.documentId,
        entryFile: initial.entryFile,
        files: initial.files,
        manifest: initial.manifest,
        frames: initial.frames,
      },
    ]);
    const api = trustedApi(storage);

    await expect(api.apply(styleTransaction())).rejects.toThrow(
      "simulated commit failure",
    );
    expect(await api.open("document-1")).toMatchObject({
      history: { undoDepth: 0, redoDepth: 0 },
    });
    expect(
      (
        await api.readSource({
          documentId: "document-1",
          file: "styles.css",
        })
      ).source,
    ).toBe(FRAME_CSS);
  });

  it("serializes reads behind an in-flight commit without clearing valid history", async () => {
    let announceCommit!: () => void;
    let releaseCommit!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      announceCommit = resolve;
    });
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    class BlockingRepository extends InMemoryDesignDocumentRepository {
      override async commit(
        input: Parameters<InMemoryDesignDocumentRepository["commit"]>[0],
      ) {
        announceCommit();
        await commitRelease;
        return super.commit(input);
      }
    }
    const initial = webState();
    const storage = new BlockingRepository([
      {
        documentId: initial.documentId,
        entryFile: initial.entryFile,
        files: initial.files,
        manifest: initial.manifest,
        frames: initial.frames,
      },
    ]);
    const api = trustedApi(storage);

    const applying = api.apply(styleTransaction());
    await commitStarted;
    let readSettled = false;
    const reading = api.open("document-1").finally(() => {
      readSettled = true;
    });
    await Promise.resolve();
    expect(readSettled).toBe(false);
    releaseCommit();

    const [, opened] = await Promise.all([applying, reading]);
    expect(opened.history).toMatchObject({ canUndo: true, undoDepth: 1 });
    expect(
      (
        await api.readSource({
          documentId: "document-1",
          file: "styles.css",
        })
      ).source,
    ).toContain("rebeccapurple");
  });

  it("evicts inactive sessions by retained bytes, not only document count", async () => {
    const largeCss = `${FRAME_CSS}\n/* ${"x".repeat(1_100_000)} */`;
    const storage = new InMemoryDesignDocumentRepository(
      ["document-1", "document-2"].map((documentId) => ({
        documentId,
        entryFile: "index.html",
        files: { "index.html": FRAME_HTML, "styles.css": largeCss },
        frames: {
          "index.html": { x: 0, y: 0, width: 800, height: 600, z: 0 },
        },
      })),
    );
    const api = trustedApi(storage, {
      maxSessions: 32,
      maxSessionBytes: 4 * 1024 * 1024,
    });
    const first = await api.open("document-1");
    await api.apply({
      ...styleTransaction(),
      baseRevision: first.revision,
    });
    expect((await api.open("document-1")).history.canUndo).toBe(true);

    await api.open("document-2");
    expect((await api.open("document-1")).history).toMatchObject({
      canUndo: false,
      undoDepth: 0,
    });
  });

  it("authorizes history actions and restores the session when denied", async () => {
    const api = new DesignApi(repository(), {
      authorization: {
        kind: "authorize",
        actor: { kind: "human", id: "tester" },
        authorize: ({ operationTypes }) =>
          !operationTypes.some((operation) => operation.startsWith("history.")),
      },
    });
    await api.apply(styleTransaction());

    await expect(api.undo("document-1")).rejects.toBeInstanceOf(
      DesignApiAuthorizationError,
    );
    const opened = await api.open("document-1");
    expect(opened.history).toMatchObject({ canUndo: true, undoDepth: 1 });
    expect(
      (
        await api.readSource({
          documentId: "document-1",
          file: "styles.css",
        })
      ).source,
    ).toContain("rebeccapurple");
  });

  it("validates a mobile render through an injected, cancellable renderer", async () => {
    const render = vi.fn<DesignHeadlessRenderer["render"]>(
      async ({ state, viewport }) => ({
        mimeType: "application/json",
        bytes: new TextEncoder().encode(
          JSON.stringify({ viewport, source: state.files[state.entryFile] }),
        ),
        width: viewport.width,
        height: viewport.height,
        revision: state.revision,
      }),
    );
    const api = trustedApi(repository(), { renderer: { render } });
    const opened = await api.open("document-1");
    const artifact = await api.render({
      documentId: "document-1",
      expectedRevision: opened.revision,
      viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
    });
    expect(artifact).toMatchObject({ width: 390, height: 844 });
    expect(render).toHaveBeenCalledWith(
      expect.objectContaining({
        viewport: expect.objectContaining({
          width: 390,
          height: 844,
          reducedMotion: "reduce",
        }),
      }),
    );

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      api.render({
        documentId: "document-1",
        viewport: { width: 390, height: 844 },
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });

  it("rejects a renderer artifact that is not pinned to the requested viewport", async () => {
    const api = trustedApi(repository(), {
      renderer: {
        render: async ({ state, viewport }) => ({
          mimeType: "image/png",
          bytes: new Uint8Array([137, 80, 78, 71]),
          width: viewport.width + 1,
          height: viewport.height,
          revision: state.revision,
        }),
      },
    });

    await expect(
      api.render({
        documentId: "document-1",
        viewport: { width: 390, height: 844 },
      }),
    ).rejects.toThrow("wrong viewport");
  });

  it("keeps the last valid revision available when external CSS is malformed", async () => {
    const storage = repository();
    const render = vi.fn<DesignHeadlessRenderer["render"]>(
      async ({ state, viewport }) => ({
        mimeType: "text/html",
        bytes: new TextEncoder().encode(state.files[state.entryFile]!),
        width: viewport.width,
        height: viewport.height,
        revision: state.revision,
      }),
    );
    const api = trustedApi(storage, { renderer: { render } });
    const valid = await api.open("document-1");
    storage.replace({
      documentId: "document-1",
      entryFile: "index.html",
      files: { "index.html": FRAME_HTML, "styles.css": ":root {" },
    });
    const invalid = await api.open("document-1");
    expect(invalid.valid).toBe(false);
    expect(invalid.lastValidRevision).toBe(valid.revision);
    await api.render({
      documentId: "document-1",
      expectedRevision: invalid.revision,
      viewport: { width: 390, height: 844 },
    });
    expect(render.mock.calls.at(-1)?.[0].state.revision).toBe(valid.revision);
  });
});
