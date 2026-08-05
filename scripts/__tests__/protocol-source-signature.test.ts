import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs has no type declarations; it exports a plain function.
import { protocolSourceSignature } from "../protocol-source-signature.mjs";

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
});
