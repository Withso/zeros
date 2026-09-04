import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs has no type declarations; it exports a plain function.
import {
  exportedIntegerConstant,
  protocolSourceSignature,
} from "../protocol-source-signature.mjs";

describe("protocolSourceSignature", () => {
  it("ignores comment-only edits after template literals", () => {
    const before = [
      "export interface WireMessage { id: string }",
      "export function message(at: number): WireMessage {",
      "  return { id: `mode-${at}` };",
      "}",
      "// Previous note — persist the `at` value.",
    ].join("\n");
    const after = [
      "export interface WireMessage { id: string }",
      "export function message(at: number): WireMessage {",
      "  return { id: `mode-${at}` };",
      "}",
      "// Persist the event timestamp.",
    ].join("\n");

    expect(protocolSourceSignature(after)).toBe(
      protocolSourceSignature(before),
    );
  });

  it("normalizes the one-time public package rename", () => {
    expect(
      protocolSourceSignature(
        'import type { WireMessage } from "@zeros/core";',
      ),
    ).toBe(
      protocolSourceSignature(
        'import type { WireMessage } from "@zeros/protocol";',
      ),
    );
  });

  it("still detects a wire-shape change", () => {
    expect(
      protocolSourceSignature("export interface WireMessage { id?: string }"),
    ).not.toBe(
      protocolSourceSignature("export interface WireMessage { id: string }"),
    );
  });

  it.each([
    "CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION",
    "MIN_CLOUD_WORKSPACE_ENGINE_PROTOCOL_VERSION",
  ])("reads %s from its export instead of a preceding comment", (name) => {
    expect(
      exportedIntegerConstant(
        `// export const ${name} = 1\nexport const ${name} = 14 as const;`,
        name,
      ),
    ).toBe("14");
  });
});
