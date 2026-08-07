import {
  applyDesignTransaction,
  type DesignOperation,
} from "@zeros/design-core";
import { designWebTransactionAdapter } from "@zeros/design-web";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  commitDesignWebDocumentState,
  createDesignFrame,
  DESIGN_DIRECTORY_NAME,
  DESIGN_TRANSACTION_JOURNAL_FILE,
  designWebDocumentId,
  initializeDesignDocument,
  readDesignFrame,
  readDesignWebDocumentState,
  readDesignWorkspaceSnapshot,
} from "../document";

describe("filesystem Design API repository", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-design-api-repository-"));
    await initializeDesignDocument(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("compare-and-swaps the same pure transaction result into authored source", async () => {
    const frame = await createDesignFrame(root, { title: "Repository" });
    const current = await readDesignWebDocumentState(root, frame.file);
    expect(current.documentId).toBe(designWebDocumentId(frame.file));
    expect(current.files).toHaveProperty("tokens.css");
    expect(current.frames[frame.file]).toMatchObject({
      width: 1_440,
      height: 900,
    });
    const nodeId = /<main data-oid="([^"]+)"/.exec(
      current.files[frame.file]!,
    )?.[1];
    expect(nodeId).toBeTruthy();
    const transaction = {
      schemaVersion: 1 as const,
      transactionId: "repository-style",
      documentId: current.documentId,
      baseRevision: current.revision,
      actor: { kind: "human" as const, id: "tester" },
      intent: "Change padding",
      createdAt: 1,
      operations: [
        {
          operationId: "padding",
          type: "node.set-styles" as const,
          nodeId: nodeId!,
          styles: { padding: "48px" },
          scope: "auto" as const,
          responsiveContext: "base",
          stateContext: "default",
        },
      ],
    };
    const outcome = applyDesignTransaction(
      current,
      transaction,
      designWebTransactionAdapter,
    );

    await commitDesignWebDocumentState(
      root,
      frame.file,
      current.revision,
      outcome.state,
    );
    const committed = await readDesignWebDocumentState(root, frame.file);
    expect(committed.revision).toBe(outcome.state.revision);
    expect(committed.files[frame.file]).toContain("padding:48px");
    await expect(
      commitDesignWebDocumentState(
        root,
        frame.file,
        current.revision,
        outcome.state,
      ),
    ).rejects.toThrow("Design document changed");
  });

  it("finishes a validated write-ahead journal before exposing a document", async () => {
    const frame = await createDesignFrame(root, { title: "Recovery" });
    const current = await readDesignWebDocumentState(root, frame.file);
    const source = current.files[frame.file]!;
    const nextSource = source.replace(
      "Shape this frame with the canvas and inspector.",
      "Recovered transaction",
    );
    const next = {
      ...current,
      files: { ...current.files, [frame.file]: nextSource },
    };
    const { createDesignWebDocumentState } = await import("@zeros/design-web");
    const normalized = createDesignWebDocumentState(next);
    const geometry = normalized.frames[frame.file]!;
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, DESIGN_TRANSACTION_JOURNAL_FILE),
      `${JSON.stringify({
        version: 1,
        documentId: normalized.documentId,
        entryFile: frame.file,
        nextRevision: normalized.revision,
        files: [{ file: frame.file, content: nextSource }],
        foundation: normalized.manifest,
        geometry: {
          x: geometry.x,
          y: geometry.y,
          w: geometry.width,
          h: geometry.height,
          z: geometry.z,
        },
      })}\n`,
      "utf8",
    );

    const snapshot = await readDesignWorkspaceSnapshot(root);
    expect(
      (await readDesignFrame(root, snapshot.frames[0]!.file)).source,
    ).toContain("Recovered transaction");
    const recovered = await readDesignWebDocumentState(root, frame.file);
    expect(recovered.revision).toBe(normalized.revision);
    expect(recovered.files[frame.file]).toContain("Recovered transaction");
    await expect(
      readFile(
        path.join(root, DESIGN_DIRECTORY_NAME, DESIGN_TRANSACTION_JOURNAL_FILE),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("commits a transaction that changes more than 128 bounded source files", async () => {
    const frame = await createDesignFrame(root, { title: "Large journal" });
    const current = await readDesignWebDocumentState(root, frame.file);
    const operations: DesignOperation[] = Array.from(
      { length: 129 },
      (_, index) => ({
        operationId: `create-bulk-${index}`,
        type: "component.create" as const,
        component: {
          id: `bulk-card-${index}`,
          name: `Bulk card ${index}`,
          file: `components/bulk-card-${index}.html`,
          props: [],
          slots: [],
        },
        html: `<!doctype html><html><body><article data-zid="root-${index}">Card</article></body></html>`,
      }),
    );
    const outcome = applyDesignTransaction(
      current,
      {
        schemaVersion: 1,
        transactionId: "create-bounded-component-batch",
        documentId: current.documentId,
        baseRevision: current.revision,
        actor: { kind: "agent", id: "test-agent" },
        intent: "Create a bounded component batch",
        createdAt: 1,
        operations,
      },
      designWebTransactionAdapter,
    );

    await commitDesignWebDocumentState(
      root,
      frame.file,
      current.revision,
      outcome.state,
    );
    const committed = await readDesignWebDocumentState(root, frame.file);
    expect(committed.revision).toBe(outcome.state.revision);
    expect(committed.manifest.components).toHaveLength(129);
  });

  it("refuses to write a component through a directory symlink", async () => {
    const frame = await createDesignFrame(root, { title: "Safe component" });
    const componentDirectory = path.join(
      root,
      DESIGN_DIRECTORY_NAME,
      "components",
    );
    const outside = path.join(root, "outside-components");
    await rm(componentDirectory, { recursive: true, force: true });
    await mkdir(outside);
    await symlink(outside, componentDirectory, "dir");
    const current = await readDesignWebDocumentState(root, frame.file);
    const outcome = applyDesignTransaction(
      current,
      {
        schemaVersion: 1,
        transactionId: "unsafe-component-directory",
        documentId: current.documentId,
        baseRevision: current.revision,
        actor: { kind: "agent", id: "test-agent" },
        intent: "Attempt a component write through a symlink",
        createdAt: 1,
        operations: [
          {
            operationId: "create-unsafe-component",
            type: "component.create",
            component: {
              id: "unsafe-card",
              name: "Unsafe card",
              file: "components/unsafe-card.html",
              props: [],
              slots: [],
            },
            html: '<!doctype html><html><body><article data-zid="root">Unsafe</article></body></html>',
          },
        ],
      },
      designWebTransactionAdapter,
    );

    await expect(
      commitDesignWebDocumentState(
        root,
        frame.file,
        current.revision,
        outcome.state,
      ),
    ).rejects.toThrow("unsafe design write directory");
    await expect(
      readFile(path.join(outside, "unsafe-card.html"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adopts legacy component files into the manifest on the next transaction", async () => {
    const frame = await createDesignFrame(root, { title: "Legacy component" });
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, "components", "legacy-card.html"),
      '<!doctype html><html><head></head><body><article data-zid="root">Legacy</article></body></html>',
      "utf8",
    );
    const current = await readDesignWebDocumentState(root, frame.file);
    expect(current.manifest.components).toEqual([
      {
        id: "legacy-card",
        name: "Legacy card",
        file: "components/legacy-card.html",
        props: [],
        slots: [],
      },
    ]);
    const nodeId = /<main data-oid="([^"]+)"/.exec(
      current.files[frame.file]!,
    )?.[1];
    const outcome = applyDesignTransaction(
      current,
      {
        schemaVersion: 1,
        transactionId: "adopt-legacy-component",
        documentId: current.documentId,
        baseRevision: current.revision,
        actor: { kind: "human", id: "tester" },
        intent: "Persist migrated component metadata",
        createdAt: 1,
        operations: [
          {
            operationId: "set-color",
            type: "node.set-styles",
            nodeId: nodeId!,
            styles: { color: "red" },
            scope: "inline",
            responsiveContext: "base",
            stateContext: "default",
          },
        ],
      },
      designWebTransactionAdapter,
    );
    await commitDesignWebDocumentState(
      root,
      frame.file,
      current.revision,
      outcome.state,
    );
    const canvas = JSON.parse(
      await readFile(
        path.join(root, DESIGN_DIRECTORY_NAME, ".zeros-canvas.json"),
        "utf8",
      ),
    ) as { foundation?: { components?: Array<{ id?: string }> } };
    expect(canvas.foundation?.components?.[0]?.id).toBe("legacy-card");
  });

  it("does not delete a shared component still instantiated by another frame", async () => {
    const first = await createDesignFrame(root, { title: "First" });
    const second = await createDesignFrame(root, { title: "Second" });
    const initial = await readDesignWebDocumentState(root, first.file);
    const created = applyDesignTransaction(
      initial,
      {
        schemaVersion: 1,
        transactionId: "create-shared-component",
        documentId: initial.documentId,
        baseRevision: initial.revision,
        actor: { kind: "human", id: "tester" },
        intent: "Create a shared component",
        createdAt: 1,
        operations: [
          {
            operationId: "create-shared",
            type: "component.create",
            component: {
              id: "shared-card",
              name: "Shared card",
              file: "components/shared-card.html",
              props: [],
              slots: [],
            },
            html: '<!doctype html><html><body><article data-zid="root">Shared</article></body></html>',
          },
        ],
      },
      designWebTransactionAdapter,
    );
    await commitDesignWebDocumentState(
      root,
      first.file,
      initial.revision,
      created.state,
    );
    const secondTarget = path.join(root, DESIGN_DIRECTORY_NAME, second.file);
    await writeFile(
      secondTarget,
      (await readFile(secondTarget, "utf8")).replace(
        "</main>",
        '<zd-shared-card data-oid="shared-instance"></zd-shared-card></main>',
      ),
    );

    const current = await readDesignWebDocumentState(root, first.file);
    const removed = applyDesignTransaction(
      current,
      {
        schemaVersion: 1,
        transactionId: "delete-shared-component",
        documentId: current.documentId,
        baseRevision: current.revision,
        actor: { kind: "human", id: "tester" },
        intent: "Delete a shared component",
        createdAt: 2,
        operations: [
          {
            operationId: "delete-shared",
            type: "component.delete",
            componentId: "shared-card",
          },
        ],
      },
      designWebTransactionAdapter,
    );

    await expect(
      commitDesignWebDocumentState(
        root,
        first.file,
        current.revision,
        removed.state,
      ),
    ).rejects.toThrow(`still has instances in ${second.file}`);
    expect(
      await readFile(
        path.join(
          root,
          DESIGN_DIRECTORY_NAME,
          "components",
          "shared-card.html",
        ),
        "utf8",
      ),
    ).toContain("Shared");
  });

  it("fails closed without applying a journal whose target revision is forged", async () => {
    const frame = await createDesignFrame(root, { title: "Forged journal" });
    const current = await readDesignWebDocumentState(root, frame.file);
    const forged = current.files[frame.file]!.replace(
      "Shape this frame with the canvas and inspector.",
      "This must not be written",
    );
    await writeFile(
      path.join(root, DESIGN_DIRECTORY_NAME, DESIGN_TRANSACTION_JOURNAL_FILE),
      `${JSON.stringify({
        version: 1,
        documentId: current.documentId,
        entryFile: frame.file,
        nextRevision: "f".repeat(24),
        files: [{ file: frame.file, content: forged }],
        foundation: current.manifest,
        geometry: {
          x: current.frames[frame.file]!.x,
          y: current.frames[frame.file]!.y,
          w: current.frames[frame.file]!.width,
          h: current.frames[frame.file]!.height,
          z: current.frames[frame.file]!.z,
        },
      })}\n`,
      "utf8",
    );
    await expect(readDesignWebDocumentState(root, frame.file)).rejects.toThrow(
      "target revision",
    );
    expect(
      await readFile(
        path.join(root, DESIGN_DIRECTORY_NAME, frame.file),
        "utf8",
      ),
    ).not.toContain("This must not be written");
  });
});
