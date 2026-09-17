import { describe, expect, it } from "vitest";
import {
  canonicalToolContent,
  canonicalResourceLinks,
  boundedStructuredOutput,
} from "../tool-content";

describe("bounded tool artifacts", () => {
  it("keeps ordinary structured data fields while omitting encoded media", () => {
    expect(
      boundedStructuredOutput({
        structuredContent: { data: "Permission denied" },
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      }),
    ).toEqual({
      structuredContent: { data: "Permission denied" },
      content: [{ type: "image", mimeType: "image/png" }],
    });
  });
  it("preserves supported metadata and drops arbitrary server metadata", () => {
    const content = canonicalResourceLinks([
      {
        uri: "file:///ws/report.pdf",
        name: "Report",
        annotations: {
          audience: ["user"],
          priority: 0.5,
          lastModified: "2026-09-16",
          unsafe: "omit",
        },
        _meta: { secret: "omit" },
      },
    ]);
    expect(content[0].content).toMatchObject({
      type: "resource_link",
      annotations: {
        audience: ["user"],
        priority: 0.5,
        lastModified: "2026-09-16",
      },
    });
    expect(JSON.stringify(content)).not.toContain("omit");
  });
  it("bounds large and malformed payloads before persistence", () => {
    expect(
      canonicalToolContent([
        { type: "image", data: "not base64!", mimeType: "image/png" },
      ]),
    ).toEqual([]);
    const links = canonicalResourceLinks(
      Array.from({ length: 100 }, (_, i) => ({
        uri: `file:///report-${i}.html`,
        name: "Report",
        description: "x".repeat(16_000),
      })),
    );
    expect(JSON.stringify(links).length).toBeLessThan(66_000);
    const cycle: Record<string, unknown> = {
      text: "x".repeat(1_000_000),
      data: "bytes",
    };
    cycle.self = cycle;
    const bounded = JSON.stringify(boundedStructuredOutput(cycle));
    expect(bounded.length).toBeLessThan(257_000);
    expect(bounded).not.toContain("bytes");
    expect(bounded).toContain("truncated");
  });
  it("retains embedded text and a link for binary resources", () => {
    expect(
      canonicalToolContent([
        {
          type: "resource",
          resource: { uri: "report://one", text: "Report body" },
        },
        {
          type: "resource",
          resource: { uri: "report://two", blob: "aGVsbG8=" },
        },
      ]),
    ).toEqual([
      {
        type: "content",
        content: {
          type: "resource",
          resource: { uri: "report://one", text: "Report body" },
        },
      },
      {
        type: "content",
        content: {
          type: "resource_link",
          uri: "report://two",
          name: "report://two",
        },
      },
    ]);
  });
});
