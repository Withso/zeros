import { describe, expect, it } from "vitest";
import {
  assertDesignTransactionInputSize,
  designComponentNodeAddressSchema,
  designFoundationManifestSchema,
  designTransactionSchema,
  migrateDesignFoundationManifest,
} from "../schema";

describe("Design Foundation schemas", () => {
  it("fills bounded manifest defaults and migrates the pre-version shape", () => {
    expect(migrateDesignFoundationManifest(undefined)).toEqual({
      schemaVersion: 1,
      parameters: [],
      variants: [],
      components: [],
    });
    expect(migrateDesignFoundationManifest({ parameters: [] })).toEqual({
      schemaVersion: 1,
      parameters: [],
      variants: [],
      components: [],
    });
  });

  it("fails closed for a future schema version", () => {
    expect(() => migrateDesignFoundationManifest({ schemaVersion: 2 })).toThrow(
      "Unsupported Design Foundation schema version",
    );
  });

  it("rejects duplicate stable identities", () => {
    const result = designFoundationManifestSchema.safeParse({
      schemaVersion: 1,
      parameters: [
        {
          id: "spacing",
          name: "Spacing",
          type: "length",
          defaultValue: "8px",
          value: "8px",
        },
        {
          id: "spacing",
          name: "Spacing copy",
          type: "length",
          defaultValue: "12px",
          value: "12px",
        },
      ],
      variants: [],
      components: [],
    });
    expect(result.success).toBe(false);
  });

  it("models nested component internals with an instance-rooted path", () => {
    expect(
      designComponentNodeAddressSchema.parse({
        rootInstanceId: "hero-instance",
        definitionPath: [
          { componentId: "hero", definitionNodeId: "surface" },
          { componentId: "badge", definitionNodeId: "label" },
        ],
      }),
    ).toMatchObject({
      rootInstanceId: "hero-instance",
      definitionPath: [{ componentId: "hero" }, { componentId: "badge" }],
    });
  });

  it("models a parameter binding and variant without embedding UI state", () => {
    const manifest = designFoundationManifestSchema.parse({
      schemaVersion: 1,
      parameters: [
        {
          id: "accent",
          name: "Accent",
          type: "color",
          defaultValue: "#7c3aed",
          value: "#7c3aed",
          bindings: [
            {
              kind: "css-custom-property",
              documentId: "document-1",
              name: "--accent",
              selector: ":root",
              file: "styles.css",
            },
          ],
        },
      ],
      variants: [
        {
          id: "high-contrast",
          name: "High contrast",
          axis: "contrast",
          parameterValues: { accent: "#000000" },
        },
      ],
      components: [],
    });
    expect(manifest.parameters[0]?.bindings[0]?.kind).toBe(
      "css-custom-property",
    );
    expect(manifest.variants[0]?.parameterValues.accent).toBe("#000000");
  });

  it("keeps one parameter atomic by rejecting cross-document bindings", () => {
    const result = designFoundationManifestSchema.safeParse({
      schemaVersion: 1,
      parameters: [
        {
          id: "spacing",
          name: "Spacing",
          type: "length",
          defaultValue: "8px",
          value: "8px",
          bindings: [
            {
              kind: "css-custom-property",
              documentId: "document-a",
              name: "--spacing",
              file: "styles.css",
            },
            {
              kind: "css-custom-property",
              documentId: "document-b",
              name: "--spacing",
              file: "styles.css",
            },
          ],
        },
      ],
      variants: [],
      components: [],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("only one document")]),
    );
  });

  it("rejects dangling tweak references, variant cycles, and duplicate component files", () => {
    const result = designFoundationManifestSchema.safeParse({
      schemaVersion: 1,
      parameters: [
        {
          id: "enabled",
          name: "Enabled",
          type: "boolean",
          defaultValue: false,
          value: "not-a-boolean",
          visibleWhen: { parameterId: "missing", equals: true },
        },
      ],
      variants: [
        {
          id: "a",
          name: "A",
          axis: "mode",
          baseId: "b",
          parameterValues: { missing: true },
        },
        {
          id: "b",
          name: "B",
          axis: "mode",
          baseId: "a",
          parameterValues: {},
        },
      ],
      components: [
        {
          id: "card-a",
          name: "Card A",
          file: "components/card.html",
        },
        {
          id: "card-b",
          name: "Card B",
          file: "components/card.html",
        },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("boolean value"),
        expect.stringContaining("unknown parameter"),
        expect.stringContaining("cycle"),
        expect.stringContaining("Duplicate component file"),
      ]),
    );
  });

  it("rejects indirect parameter visibility cycles", () => {
    const result = designFoundationManifestSchema.safeParse({
      schemaVersion: 1,
      parameters: [
        {
          id: "first",
          name: "First",
          type: "boolean",
          defaultValue: true,
          value: true,
          visibleWhen: { parameterId: "second", equals: true },
        },
        {
          id: "second",
          name: "Second",
          type: "boolean",
          defaultValue: true,
          value: true,
          visibleWhen: { parameterId: "first", equals: true },
        },
      ],
      variants: [],
      components: [],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([expect.stringContaining("visibility cycle")]),
    );
  });

  it("requires enum values and component defaults to satisfy their declared types", () => {
    const result = designFoundationManifestSchema.safeParse({
      schemaVersion: 1,
      parameters: [
        {
          id: "density",
          name: "Density",
          type: "enum",
          defaultValue: "comfortable",
          value: "unknown",
          options: [{ label: "Compact", value: "compact" }],
        },
      ],
      variants: [],
      components: [
        {
          id: "card",
          name: "Card",
          file: "components/card.html",
          props: [{ name: "enabled", type: "boolean", defaultValue: "yes" }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("enforces numeric defaults and variant values against parameter constraints", () => {
    const result = designFoundationManifestSchema.safeParse({
      schemaVersion: 1,
      parameters: [
        {
          id: "scale",
          name: "Scale",
          type: "number",
          defaultValue: 4,
          value: 12,
          min: 8,
          max: 24,
        },
        {
          id: "density",
          name: "Density",
          type: "enum",
          defaultValue: "comfortable",
          value: "comfortable",
          options: [
            { label: "Comfortable", value: "comfortable" },
            { label: "Compact", value: "compact" },
          ],
        },
      ],
      variants: [
        {
          id: "invalid-density",
          name: "Invalid density",
          axis: "density",
          parameterValues: { density: "unknown" },
        },
      ],
      components: [],
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("defaultValue is below min"),
        expect.stringContaining("violates its parameter contract"),
      ]),
    );
  });

  it("rejects duplicate operation ids inside one atomic transaction", () => {
    const result = designTransactionSchema.safeParse({
      schemaVersion: 1,
      transactionId: "transaction-1",
      documentId: "document-1",
      baseRevision: "revision-0",
      actor: { kind: "human", id: "tester" },
      intent: "Duplicate operation test",
      createdAt: 0,
      operations: [
        {
          operationId: "same",
          type: "node.set-text",
          nodeId: "first",
          text: "a",
        },
        {
          operationId: "same",
          type: "node.set-text",
          nodeId: "second",
          text: "b",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an aggregate transaction envelope before adapter execution", () => {
    const oversized = {
      schemaVersion: 1,
      transactionId: "oversized",
      documentId: "document-1",
      baseRevision: "revision-0",
      actor: { kind: "agent", id: "tester" },
      intent: "Oversized batch",
      createdAt: 0,
      operations: Array.from({ length: 9 }, (_, index) => ({
        operationId: `replace-${index}`,
        type: "node.set-html",
        nodeId: "root",
        html: "x".repeat(500_000),
        mode: "replace-inner",
      })),
    };

    expect(() => assertDesignTransactionInputSize(oversized)).toThrow(
      "4 MiB input limit",
    );
  });

  it("accepts a bounded semantic token edit without exposing source splices", () => {
    const result = designTransactionSchema.parse({
      schemaVersion: 1,
      transactionId: "transaction-token",
      documentId: "document-1",
      baseRevision: "revision-0",
      actor: { kind: "agent", id: "design-agent" },
      intent: "Change the accent token",
      createdAt: 0,
      operations: [
        {
          operationId: "set-token",
          type: "token.set",
          file: "tokens.css",
          name: "--accent",
          theme: null,
          value: "#2563eb",
        },
      ],
    });
    expect(result.operations[0]).toMatchObject({
      type: "token.set",
      file: "tokens.css",
      name: "--accent",
    });
  });
});
