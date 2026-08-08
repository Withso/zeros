import { DesignTransactionSession } from "@zeros/design-core";
import { describe, expect, it, vi } from "vitest";

import { designWebTransactionAdapter } from "../adapter";
import { createDesignWebDocumentState } from "../revision";
import { FRAME_CSS, FRAME_HTML, webState, webTransaction } from "./fixtures";

describe("web transaction adapter", () => {
  it("round-trips an authored CSS edit through exact source inverses", () => {
    const initial = webState();
    const session = new DesignTransactionSession(
      initial,
      designWebTransactionAdapter,
    );
    session.apply(
      webTransaction(initial, "style-edit", [
        {
          operationId: "set-color",
          type: "node.set-styles",
          nodeId: "card",
          styles: { color: "rebeccapurple" },
          scope: "auto",
          responsiveContext: "base",
          stateContext: "default",
        },
      ]),
    );
    expect(session.currentState().files["styles.css"]).toContain(
      "color: rebeccapurple",
    );
    expect(session.undo()?.state.files).toEqual(initial.files);
    expect(session.redo()?.state.files["styles.css"]).toContain(
      "color: rebeccapurple",
    );
  });

  it("executes a CSS-variable Parameter/Tweaks slice and restores it", () => {
    const initial = webState();
    const exact = createDesignWebDocumentState({
      documentId: initial.documentId,
      entryFile: initial.entryFile,
      files: initial.files,
      frames: initial.frames,
      manifest: {
        ...initial.manifest,
        parameters: [
          {
            id: "accent",
            name: "Accent",
            type: "color" as const,
            defaultValue: "#7c3aed",
            value: "#7c3aed",
            bindings: [
              {
                kind: "css-custom-property" as const,
                documentId: initial.documentId,
                name: "--accent",
                selector: ":root",
                file: "styles.css",
              },
            ],
          },
        ],
      },
    });
    const session = new DesignTransactionSession(
      exact,
      designWebTransactionAdapter,
    );
    session.apply(
      webTransaction(exact, "set-accent", [
        {
          operationId: "parameter-value",
          type: "parameter.set",
          parameterId: "accent",
          value: "#ff006e",
        },
      ]),
    );
    expect(session.currentState().manifest.parameters[0]?.value).toBe(
      "#ff006e",
    );
    expect(session.currentState().files["styles.css"]).toBe(
      FRAME_CSS.replace("--accent: #7c3aed", "--accent: #ff006e"),
    );
    expect(session.undo()?.state.files["styles.css"]).toBe(FRAME_CSS);
  });

  it("synchronizes parameter bindings when they are created or attached", () => {
    const initial = webState();
    const session = new DesignTransactionSession(
      initial,
      designWebTransactionAdapter,
    );
    const created = session.apply(
      webTransaction(initial, "create-bound-parameter", [
        {
          operationId: "create-accent",
          type: "parameter.create",
          parameter: {
            id: "accent",
            name: "Accent",
            type: "color",
            defaultValue: "#ff006e",
            value: "#ff006e",
            bindings: [
              {
                kind: "css-custom-property",
                documentId: initial.documentId,
                name: "--accent",
                selector: ":root",
                file: "styles.css",
              },
            ],
          },
        },
      ]),
    ).state;
    expect(created.files["styles.css"]).toContain("--accent: #ff006e");
    expect(session.undo()?.state.files).toEqual(initial.files);

    const unbound = session.apply(
      webTransaction(session.currentState(), "create-unbound-parameter", [
        {
          operationId: "create-spacing",
          type: "parameter.create",
          parameter: {
            id: "spacing",
            name: "Spacing",
            type: "length",
            defaultValue: "24px",
            value: "24px",
            bindings: [],
          },
        },
      ]),
    ).state;
    const bound = session.apply(
      webTransaction(unbound, "bind-spacing", [
        {
          operationId: "bind-spacing-property",
          type: "parameter.bind",
          parameterId: "spacing",
          binding: {
            kind: "css-custom-property",
            documentId: initial.documentId,
            name: "--spacing",
            selector: ":root",
            file: "styles.css",
          },
        },
      ]),
    ).state;
    expect(bound.files["styles.css"]).toContain("--spacing: 24px");
    const undoneBinding = session.undo()?.state;
    expect(undoneBinding?.files["styles.css"]).toBe(FRAME_CSS);
    expect(undoneBinding?.manifest.parameters[0]?.bindings).toEqual([]);
  });

  it("rejects a parameter owned by another document instead of partially applying it", () => {
    const initial = webState();
    const exact = createDesignWebDocumentState({
      documentId: initial.documentId,
      entryFile: initial.entryFile,
      files: initial.files,
      frames: initial.frames,
      manifest: {
        ...initial.manifest,
        parameters: [
          {
            id: "foreign-accent",
            name: "Foreign accent",
            type: "color" as const,
            defaultValue: "#7c3aed",
            value: "#7c3aed",
            bindings: [
              {
                kind: "css-custom-property" as const,
                documentId: "document-2",
                name: "--accent",
                selector: ":root",
                file: "styles.css",
              },
            ],
          },
        ],
      },
    });
    const session = new DesignTransactionSession(
      exact,
      designWebTransactionAdapter,
    );

    expect(() =>
      session.apply(
        webTransaction(exact, "foreign-parameter", [
          {
            operationId: "set-foreign",
            type: "parameter.set",
            parameterId: "foreign-accent",
            value: "#ff006e",
          },
        ]),
      ),
    ).toThrow("belongs to another document");
    expect(session.currentState()).toBe(exact);
  });

  it("round-trips a semantic token edit and a newly-authored theme", () => {
    const initial = webState();
    const session = new DesignTransactionSession(
      initial,
      designWebTransactionAdapter,
    );
    const base = session.apply(
      webTransaction(initial, "set-token", [
        {
          operationId: "set-accent",
          type: "token.set",
          file: "styles.css",
          name: "--accent",
          theme: null,
          value: "#ff006e",
        },
      ]),
    ).state;
    expect(base.files["styles.css"]).toContain("--accent: #ff006e");
    const themed = session.apply(
      webTransaction(base, "set-dark-token", [
        {
          operationId: "set-dark-accent",
          type: "token.set",
          file: "styles.css",
          name: "--accent",
          theme: "dark",
          value: "#ffffff",
        },
      ]),
    ).state;
    expect(themed.files["styles.css"]).toContain('[data-zd-theme="dark"]');
    expect(session.undo()?.state.files["styles.css"]).toBe(
      base.files["styles.css"],
    );
    expect(session.undo()?.state.files).toEqual(initial.files);
    expect(session.redo()?.state.files["styles.css"]).toContain(
      "--accent: #ff006e",
    );
  });

  it("round-trips duplicate, delete, and keyframe canvas operations", () => {
    const initial = webState();
    const session = new DesignTransactionSession(
      initial,
      designWebTransactionAdapter,
    );
    const changed = session.apply(
      webTransaction(initial, "direct-manipulation", [
        {
          operationId: "duplicate-card",
          type: "node.duplicate",
          nodeId: "card",
          duplicateNodeId: "card-copy",
        },
        {
          operationId: "delete-label",
          type: "node.delete",
          nodeId: "label",
        },
        {
          operationId: "card-motion",
          type: "keyframes.set",
          file: "styles.css",
          name: "card-enter",
          keyframes: [
            { offset: 0, styles: { opacity: "0" } },
            { offset: 100, styles: { opacity: "1" } },
          ],
        },
      ]),
    ).state;

    expect(changed.files["index.html"]).toContain('data-oid="card-copy"');
    expect(changed.files["index.html"]).not.toContain('data-oid="label"');
    expect(changed.files["styles.css"]).toContain("@keyframes card-enter");
    expect(session.undo()?.state.files).toEqual(initial.files);
  });

  it("executes one component definition and instance transaction", () => {
    const initial = webState();
    const session = new DesignTransactionSession(
      initial,
      designWebTransactionAdapter,
    );
    session.apply(
      webTransaction(initial, "component-slice", [
        {
          operationId: "create-card",
          type: "component.create",
          component: {
            id: "promo-card",
            name: "Promo card",
            file: "components/promo-card.html",
            props: [{ name: "label", type: "string", defaultValue: "Promo" }],
            slots: ["content"],
          },
          html: '<!doctype html><html><head><style>zd-promo-card{display:block}</style></head><body><article data-zid="surface"><slot data-zd-attr="label">Promo</slot><slot></slot></article></body></html>',
        },
        {
          operationId: "create-instance",
          type: "instance.create",
          componentId: "promo-card",
          parentNodeId: "root",
          instanceNodeId: "promo-instance",
          props: { label: "Launch" },
          slotHtml: '<strong data-oid="promo-copy">Today</strong>',
        },
      ]),
    );
    expect(session.currentState().manifest.components[0]?.id).toBe(
      "promo-card",
    );
    expect(
      session.currentState().files["components/promo-card.html"],
    ).toContain('data-zid="surface"');
    expect(session.currentState().files["index.html"]).toContain(
      '<zd-promo-card data-oid="promo-instance" label="Launch">',
    );
    expect(session.undo()?.state.files).toEqual(initial.files);
    expect(session.currentState().manifest.components).toEqual([]);
    expect(session.redo()?.state.files["index.html"]).toContain(
      "promo-instance",
    );
  });

  it("reports a deleted component source as an affected file", () => {
    const initial = webState();
    const session = new DesignTransactionSession(
      initial,
      designWebTransactionAdapter,
    );
    const created = session.apply(
      webTransaction(initial, "create-removable-component", [
        {
          operationId: "create-removable",
          type: "component.create",
          component: {
            id: "removable-card",
            name: "Removable card",
            file: "components/removable-card.html",
            props: [],
            slots: [],
          },
          html: '<!doctype html><html><body><article data-zid="root">Card</article></body></html>',
        },
      ]),
    ).state;
    const removed = session.apply(
      webTransaction(created, "delete-removable-component", [
        {
          operationId: "delete-removable",
          type: "component.delete",
          componentId: "removable-card",
        },
      ]),
    );

    expect(removed.receipt.affectedFiles).toContain(
      "components/removable-card.html",
    );
  });

  it("enforces existing frame geometry and declared component prop contracts", () => {
    const initial = webState();
    const session = new DesignTransactionSession(
      initial,
      designWebTransactionAdapter,
    );
    expect(() =>
      session.apply(
        webTransaction(initial, "missing-frame", [
          {
            operationId: "geometry",
            type: "frame.set-geometry",
            frame: "missing.html",
            geometry: { x: 0, y: 0, width: 100, height: 100, z: 0 },
          },
        ]),
      ),
    ).toThrow("Frame geometry not found");
    expect(() =>
      session.apply(
        webTransaction(initial, "unidentified-component", [
          {
            operationId: "unidentified-component",
            type: "component.create",
            component: {
              id: "plain-card",
              name: "Plain card",
              file: "components/plain-card.html",
              props: [],
              slots: [],
            },
            html: "<!doctype html><html><body><article>Card</article></body></html>",
          },
        ]),
      ),
    ).toThrow("missing definition-local data-zid");
    expect(() =>
      session.apply(
        webTransaction(initial, "mismatched-component-file", [
          {
            operationId: "mismatched-component",
            type: "component.create",
            component: {
              id: "named-card",
              name: "Named card",
              file: "components/other-card.html",
              props: [],
              slots: [],
            },
            html: "<!doctype html><html><body><article>Card</article></body></html>",
          },
        ]),
      ),
    ).toThrow("file must match its id");

    const withComponent = new DesignTransactionSession(
      initial,
      designWebTransactionAdapter,
    );
    const created = withComponent.apply(
      webTransaction(initial, "create-typed-component", [
        {
          operationId: "create",
          type: "component.create",
          component: {
            id: "typed-card",
            name: "Typed card",
            file: "components/typed-card.html",
            props: [{ name: "enabled", type: "boolean", defaultValue: true }],
            slots: [],
          },
          html: '<!doctype html><html><head></head><body><article data-zid="root">Card</article></body></html>',
        },
      ]),
    ).state;
    expect(() =>
      withComponent.apply(
        webTransaction(created, "bad-props", [
          {
            operationId: "instance",
            type: "instance.create",
            componentId: "typed-card",
            parentNodeId: "root",
            instanceNodeId: "typed-instance",
            props: { enabled: "yes", unknown: true },
            slotHtml: "",
          },
        ]),
      ),
    ).toThrow("component prop");
  });

  it("requires unique definition-local identities in new components", () => {
    const initial = webState();
    const session = new DesignTransactionSession(
      initial,
      designWebTransactionAdapter,
    );
    expect(() =>
      session.apply(
        webTransaction(initial, "invalid-component-identities", [
          {
            operationId: "create",
            type: "component.create",
            component: {
              id: "identity-card",
              name: "Identity card",
              file: "components/identity-card.html",
              props: [],
              slots: [],
            },
            html: '<!doctype html><html><body><article data-zid="surface"><span data-zid="surface">Duplicate</span></article></body></html>',
          },
        ]),
      ),
    ).toThrow("data-zid is duplicated");
  });

  it("keeps authored and renderer revisions as separate deterministic concepts", () => {
    const first = webState();
    const second = webState();
    expect(first.revision).toBe(second.revision);
    expect(first.revision).toMatch(/^[a-f0-9]{24}$/);
    expect(first.files["index.html"]).toBe(FRAME_HTML);
  });

  it("derives one revision regardless of source-record insertion order", () => {
    const first = webState();
    const second = createDesignWebDocumentState({
      documentId: first.documentId,
      entryFile: first.entryFile,
      files: {
        "styles.css": first.files["styles.css"]!,
        "index.html": first.files["index.html"]!,
      },
      frames: {
        "other.html": { x: 1, y: 2, width: 100, height: 100, z: 1 },
        "index.html": first.frames["index.html"]!,
      },
    });
    const third = createDesignWebDocumentState({
      documentId: first.documentId,
      entryFile: first.entryFile,
      files: first.files,
      frames: {
        "index.html": first.frames["index.html"]!,
        "other.html": { x: 1, y: 2, width: 100, height: 100, z: 1 },
      },
    });
    expect(second.revision).toBe(third.revision);
  });

  it("derives revisions independently of the host locale collation", () => {
    const input = {
      documentId: "locale-independent-document",
      entryFile: "index.html",
      files: {
        "index.html": FRAME_HTML,
        "A.css": ":root { --a: 1; }",
        "b.css": ":root { --b: 2; }",
      },
      frames: {
        "index.html": { x: 0, y: 0, width: 800, height: 600, z: 0 },
        "A.html": { x: 1, y: 1, width: 800, height: 600, z: 1 },
      },
    };
    const baseline = createDesignWebDocumentState(input).revision;
    const localeCompare = vi
      .spyOn(String.prototype, "localeCompare")
      .mockImplementation(function (this: string, other: string) {
        return this < other ? 1 : this > other ? -1 : 0;
      });
    try {
      expect(createDesignWebDocumentState(input).revision).toBe(baseline);
    } finally {
      localeCompare.mockRestore();
    }
  });
});
