import {
  DESIGN_FOUNDATION_SCHEMA_VERSION,
  type DesignOperation,
  type DesignTransaction,
} from "@zeros/design-core";

import { createDesignWebDocumentState } from "../revision";
import type { DesignWebDocumentState } from "../model";

export const FRAME_HTML = `<!doctype html>
<html>
  <head><link rel="stylesheet" href="./styles.css"></head>
  <body>
    <main data-oid="root">
      <article data-oid="card" class="card"><span data-oid="label">Hello</span></article>
    </main>
  </body>
</html>
`;

export const FRAME_CSS = `/* authored */
[data-oid="card"] {
  color: red;
  padding: 8px;
}
:root {
  --accent: #7c3aed;
}
`;

export function webState() {
  return createDesignWebDocumentState({
    documentId: "document-1",
    entryFile: "index.html",
    files: {
      "index.html": FRAME_HTML,
      "styles.css": FRAME_CSS,
    },
    frames: {
      "index.html": { x: 0, y: 0, width: 1280, height: 720, z: 0 },
    },
  });
}

export function webTransaction(
  state: DesignWebDocumentState,
  transactionId: string,
  operations: DesignOperation[],
): DesignTransaction {
  return {
    schemaVersion: DESIGN_FOUNDATION_SCHEMA_VERSION,
    transactionId,
    documentId: state.documentId,
    baseRevision: state.revision,
    actor: { kind: "human", id: "tester" },
    intent: transactionId,
    createdAt: 1,
    operations,
  };
}
