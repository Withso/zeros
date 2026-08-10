import {
  applyDesignTransaction,
  DesignTransactionConflictError,
  type DesignOperation,
} from "@zeros/design-core";
import { describe, expect, it } from "vitest";

import { designWebTransactionAdapter } from "../adapter";
import { DesignApi, InMemoryDesignDocumentRepository } from "../api";
import { createDesignWebDocumentState } from "../revision";

const HTML = `<!doctype html>
<html>
  <head><link rel="stylesheet" href="./styles.css"></head>
  <body>
    <main data-oid="root">
      <article data-oid="card" class="card"><span data-oid="label">Before</span></article>
    </main>
  </body>
</html>
`;

const CSS = `:root { --accent: #7c3aed; }
[data-oid="root"] { display: grid; grid-template-columns: 1fr; }
[data-oid="card"] {
  display: flex;
  padding: 8px;
  gap: 4px;
  color: red;
}
@keyframes card-enter {
  0% { opacity: 0; }
  100% { opacity: 1; }
}
`;

describe("Design Foundation 1.0 acceptance", () => {
  it("executes one identical semantic workflow through the pure kernel and headless API", async () => {
    const initial = createDesignWebDocumentState({
      documentId: "foundation-acceptance",
      entryFile: "index.html",
      files: { "index.html": HTML, "styles.css": CSS },
      frames: {
        "index.html": { x: 20, y: 30, width: 1_280, height: 720, z: 0 },
      },
    });
    const operations: DesignOperation[] = [
      {
        operationId: "style-card",
        type: "node.set-styles",
        nodeId: "card",
        styles: { padding: "24px", gap: "12px", color: "#2563eb" },
        scope: "auto",
        responsiveContext: "base",
        stateContext: "default",
      },
      {
        operationId: "set-copy",
        type: "node.set-text",
        nodeId: "label",
        text: "After",
      },
      {
        operationId: "create-component",
        type: "component.create",
        component: {
          id: "status-badge",
          name: "Status badge",
          file: "components/status-badge.html",
          props: [{ name: "label", type: "string", defaultValue: "Ready" }],
          slots: [],
        },
        html: '<!doctype html><html><head><style>zd-status-badge{display:inline-flex}</style></head><body><span data-zid="label"><slot data-zd-attr="label">Ready</slot></span></body></html>',
      },
      {
        operationId: "create-instance",
        type: "instance.create",
        componentId: "status-badge",
        parentNodeId: "card",
        instanceNodeId: "status-instance",
        props: { label: "Shipped" },
        slotHtml: "",
      },
      {
        operationId: "create-accent-parameter",
        type: "parameter.create",
        parameter: {
          id: "accent",
          name: "Accent",
          type: "color",
          defaultValue: "#2563eb",
          value: "#2563eb",
          bindings: [
            {
              kind: "css-custom-property",
              documentId: "foundation-acceptance",
              name: "--accent",
              selector: ":root",
              file: "styles.css",
            },
          ],
        },
      },
      {
        operationId: "create-contrast-variant",
        type: "variant.create",
        variant: {
          id: "high-contrast",
          name: "High contrast",
          axis: "contrast",
          parameterValues: { accent: "#000000" },
        },
      },
      {
        operationId: "set-contrast-accent",
        type: "variant.set-parameter",
        variantId: "high-contrast",
        parameterId: "accent",
        value: "#ffffff",
      },
    ];
    const transaction = {
      schemaVersion: 1 as const,
      transactionId: "foundation-acceptance-transaction",
      documentId: initial.documentId,
      baseRevision: initial.revision,
      actor: { kind: "agent" as const, id: "acceptance-agent" },
      intent: "Exercise the Foundation vertical slices",
      createdAt: 1,
      operations,
    };
    const direct = applyDesignTransaction(
      initial,
      transaction,
      designWebTransactionAdapter,
    );
    const repository = new InMemoryDesignDocumentRepository([
      {
        documentId: initial.documentId,
        entryFile: initial.entryFile,
        files: initial.files,
        manifest: initial.manifest,
        frames: initial.frames,
      },
    ]);
    const api = new DesignApi(repository);

    const applied = await api.apply(transaction);
    expect(applied.revision).toBe(direct.state.revision);
    expect((await repository.read(initial.documentId)).files).toEqual(
      direct.state.files,
    );
    expect(
      await api.readProvenance({
        documentId: initial.documentId,
        expectedRevision: applied.revision,
        nodeId: "card",
        property: "padding",
        computedValue: "24px",
        matched: [
          {
            property: "padding",
            value: "24px",
            selector: '[data-oid="card"]',
            sourceFile: "styles.css",
            inherited: false,
            active: true,
          },
        ],
      }),
    ).toMatchObject({
      origin: "stylesheet",
      confidence: "correlated",
      winner: { file: "styles.css", value: "24px" },
    });
    const foundation = await api.readFoundation({
      documentId: initial.documentId,
    });
    expect(foundation.manifest).toMatchObject({
      components: [{ id: "status-badge" }],
      parameters: [{ id: "accent", value: "#2563eb" }],
      variants: [
        {
          id: "high-contrast",
          parameterValues: { accent: "#ffffff" },
        },
      ],
    });
    expect(foundation.keyframes).toEqual([
      {
        file: "styles.css",
        name: "card-enter",
        keyframes: [
          { offset: 0, styles: { opacity: "0" } },
          { offset: 100, styles: { opacity: "1" } },
        ],
      },
    ]);

    await expect(
      api.apply({
        ...transaction,
        transactionId: "stale-foundation-transaction",
      }),
    ).rejects.toBeInstanceOf(DesignTransactionConflictError);
    await api.undo(initial.documentId);
    expect((await repository.read(initial.documentId)).files).toEqual(
      initial.files,
    );
    expect(
      (await api.readFoundation({ documentId: initial.documentId })).manifest,
    ).toEqual(initial.manifest);
    await api.redo(initial.documentId);
    expect((await repository.read(initial.documentId)).files).toEqual(
      direct.state.files,
    );
  });
});
