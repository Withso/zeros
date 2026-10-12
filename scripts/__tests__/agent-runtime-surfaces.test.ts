import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  compareSurfaces,
  declarationArchive,
  declarationSurface,
  normalizeSchema,
  reviewChanges,
  schemaSurface,
} from "../agent-runtime/surfaces.mjs";

function archive(name: string, content: string, type = "0") {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write(
    Buffer.byteLength(content).toString(8).padStart(11, "0") + "\0",
    124,
  );
  header.write(type, 156);
  const compressed = gzipSync(
    Buffer.concat([
      header,
      Buffer.from(content),
      Buffer.alloc((512 - (Buffer.byteLength(content) % 512)) % 512),
      Buffer.alloc(1024),
    ]),
  );
  return {
    compressed,
    integrity: `sha512-${createHash("sha512").update(compressed).digest("base64")}`,
  };
}

describe("semantic runtime review", () => {
  it("catches an existing nested field change without relying on a new event name", () => {
    const manifest = { types: "sdk.d.ts" };
    const before = declarationSurface(
      {
        "sdk.d.ts": "export interface Options { tool: { approved: boolean } }",
      },
      manifest,
    );
    const after = declarationSurface(
      {
        "sdk.d.ts":
          "export interface Options { tool: { approved?: boolean | null } }",
      },
      manifest,
    );
    expect(compareSurfaces("claude", before, after)).toMatchObject([
      { kind: "changed", subject: "sdk.d.ts:Options" },
    ]);
  });
  it("ignores comments and formatting but preserves literal types", () => {
    const manifest = { types: "sdk.d.ts" };
    const a = declarationSurface(
      { "sdk.d.ts": 'export type Mode = "a b";' },
      manifest,
    );
    const b = declarationSurface(
      { "sdk.d.ts": '/** Changed prose */\nexport type Mode="a b";' },
      manifest,
    );
    const c = declarationSurface(
      { "sdk.d.ts": 'export type Mode = "a  b";' },
      manifest,
    );
    expect(compareSurfaces("cursor", a, b)).toHaveLength(0);
    expect(compareSurfaces("cursor", a, c)).toHaveLength(1);
  });
  it("catches required/optional, enum and default changes in Codex schemas", () => {
    const before = {
      definitions: {
        Option: {
          type: "object",
          required: ["mode"],
          properties: { mode: { enum: ["read", "write"], default: "read" } },
        },
      },
    };
    const after = structuredClone(before);
    after.definitions.Option.required = [];
    expect(
      compareSurfaces(
        "codex",
        schemaSurface({ "v2.json": JSON.stringify(before) }),
        schemaSurface({ "v2.json": JSON.stringify(after) }),
      ),
    ).toHaveLength(1);
    expect(normalizeSchema({ description: "old", enum: ["b", "a"] })).toEqual(
      normalizeSchema({ description: "new", enum: ["a", "b"] }),
    );
  });
  it("does not invent a human disposition for a new surface", () => {
    const changes = compareSurfaces("codex", { RPC: "old" }, { RPC: "new" });
    expect(
      reviewChanges(changes, { schema: 1, decisions: [] })[0].disposition,
    ).toBeNull();
    const decision = {
      provider: "codex",
      fingerprint: changes[0].fingerprint,
      disposition: "implemented",
      rationale: "The adapter handles the new payload.",
      evidence: ["scripts/__tests__/fixture.test.ts"],
    };
    expect(
      reviewChanges(changes, { schema: 1, decisions: [decision] })[0]
        .disposition,
    ).toBe("implemented");
    expect(() =>
      reviewChanges(changes, {
        schema: 1,
        decisions: [{ ...decision, rationale: "" }],
      }),
    ).toThrow();
  });
  it("detects changes to the actual Codex Model.description wire field", () => {
    const before = JSON.parse(
      readFileSync(
        new URL(
          "../../apps/desktop/src/engine/agents/adapters/codex/generated/codex_app_server_protocol.v2.schemas.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const after = structuredClone(before);
    expect(before.definitions.Model.properties.description.type).toBe("string");
    after.definitions.Model.properties.description.type = "integer";
    expect(
      compareSurfaces(
        "codex",
        schemaSurface({ "v2.json": JSON.stringify(before) }),
        schemaSurface({ "v2.json": JSON.stringify(after) }),
      ),
    ).toMatchObject([{ kind: "changed", subject: "v2.json:Model" }]);
  });
  it("strips schema annotations without stripping names or literal data", () => {
    const names = ["description", "title", "$comment", "examples"];
    for (const map of [
      "properties",
      "patternProperties",
      "definitions",
      "$defs",
      "dependentSchemas",
      "dependencies",
    ]) {
      const schema = {
        [map]: Object.fromEntries(
          names.map((key) => [key, { type: "string", description: "prose" }]),
        ),
      };
      expect(normalizeSchema(schema)).toEqual({
        [map]: Object.fromEntries(
          names.map((key) => [key, { type: "string" }]),
        ),
      });
    }
    const literal = {
      description: "wire data",
      title: "title",
      examples: [{ $comment: "data" }],
      required: ["b", "a"],
    };
    expect(
      normalizeSchema({ default: literal, const: literal, enum: [literal] }),
    ).toEqual({
      default: literal,
      const: literal,
      enum: [literal],
    });
    for (const key of [
      "items",
      "additionalProperties",
      "not",
      "if",
      "then",
      "else",
      "contains",
    ])
      expect(
        normalizeSchema({
          [key]: {
            description: "prose",
            properties: { title: { type: "string", title: "prose" } },
          },
        }),
      ).toEqual({
        [key]: { properties: { title: { type: "string" } } },
      });
    expect(
      normalizeSchema({ allOf: [{ title: "prose", type: "string" }] }),
    ).toEqual({ allOf: [{ type: "string" }] });
    const changed = { ...literal, description: "changed wire data" };
    expect(
      compareSurfaces(
        "codex",
        { Model: normalizeSchema({ const: literal }) },
        { Model: normalizeSchema({ const: changed }) },
      ),
    ).toHaveLength(1);
  });
  it("fails on parser drift instead of producing a successful empty diff", () => {
    expect(() =>
      declarationSurface(
        { "sdk.d.ts": "export interface Broken {" },
        { types: "sdk.d.ts" },
      ),
    ).toThrow();
    expect(() => schemaSurface({ "v2.json": "{}" })).toThrow();
  });
  it("verifies integrity and rejects traversal and links without extracting files", () => {
    const good = archive("package/package.json", '{"name":"fixture"}');
    expect(
      declarationArchive(good.compressed, good.integrity)["package.json"],
    ).toContain("fixture");
    expect(() =>
      declarationArchive(
        good.compressed,
        `sha512-${Buffer.alloc(64).toString("base64")}`,
      ),
    ).toThrow("integrity");
    for (const entry of [
      archive("package/../../escape", "bad"),
      archive("package/link", "", "2"),
    ])
      expect(() =>
        declarationArchive(entry.compressed, entry.integrity),
      ).toThrow();
  });
});
