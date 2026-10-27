import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EventRow } from "../renderers/event-row";
import { metaForEvent } from "../renderers/event-meta";
import { EditCard } from "../renderers/tool-edit";
import type { RendererContext } from "../renderers/types";
import type { AgentToolMessage } from "../use-agent-session";
import { imagePreviewMimeType } from "../image-hover-card";

const ctx = {
  attachmentCwd: "/repo",
  attachmentImagesActive: true,
  editBaselines: new Map(),
} as unknown as RendererContext;

function tool(
  path: string,
  toolKind: "read" | "edit" = "read",
): AgentToolMessage {
  return {
    id: "tool",
    kind: "tool",
    toolCallId: "tool",
    title: toolKind,
    toolKind,
    status: "completed",
    createdAt: 0,
    updatedAt: 0,
    rawInput: { file_path: path, old_string: "before", new_string: "after" },
  } as AgentToolMessage;
}

describe("tool file pill interactions", () => {
  it("names an Edit file without promising a diff destination before Git resolves", () => {
    const html = renderToStaticMarkup(createElement(EditCard, {
      message: tool(".context/task/notes.ts", "edit"), ctx,
    }));
    expect(html).toContain('aria-label="Open notes.ts"');
  });
  it("recognizes image formats without treating code or video as images", () => {
    expect(imagePreviewMimeType("logo.SVG", "text/plain")).toBe(
      "image/svg+xml",
    );
    expect(imagePreviewMimeType("Screenshot", "image/png")).toBe("image/png");
    expect(imagePreviewMimeType("loop.gif", "application/octet-stream")).toBe(
      "image/gif",
    );
    expect(imagePreviewMimeType("still.avif")).toBe("image/avif");
    expect(imagePreviewMimeType("image.png", "video/mp4")).toBeNull();
    expect(imagePreviewMimeType("component.tsx", "text/plain")).toBeNull();
    expect(imagePreviewMimeType("video.webm")).toBeNull();
    expect(imagePreviewMimeType("constructor", "text/plain")).toBeNull();
    expect(imagePreviewMimeType("config.__proto__")).toBeNull();
  });
  it.each(["read", "edit"] as const)(
    "retains the exact %s path behind the basename",
    (kind) => {
      expect(metaForEvent(tool("src/nested/same.ts", kind))).toMatchObject({
        target: "same.ts",
        filePath: "src/nested/same.ts",
      });
    },
  );

  it("makes Read disclosure and file opening sibling controls", () => {
    const html = renderToStaticMarkup(
      createElement(EventRow, {
        message: tool("src/nested/same.ts"),
        ctx,
        detail: createElement("pre", null, "file body"),
      }),
    );
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(
      buttons.filter((button) => button.includes('aria-expanded="false"')),
    ).toHaveLength(1);
    expect(
      buttons.some((button) =>
        button.includes('data-file-path="src/nested/same.ts"'),
      ),
    ).toBe(true);
    expect(html).not.toMatch(
      /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/,
    );
  });

  it("attaches an Edit diff hover only to the file pill", () => {
    const html = renderToStaticMarkup(
      createElement(EditCard, {
        message: tool("src/nested/same.ts", "edit"),
        ctx,
      }),
    );
    const triggers = (html.match(/<button\b[^>]*>/g) ?? []).filter((button) =>
      button.includes('data-slot="hover-card-trigger"'),
    );
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toContain('data-file-path="src/nested/same.ts"');
    expect(triggers[0]).not.toContain("aria-expanded");
  });

  it("gives image Reads a hover preview without previewing video or code", () => {
    for (const [path, preview] of [
      ["art/logo.SVG", true],
      ["art/loop.gif", true],
      ["art/movie.mp4", false],
      ["src/a.ts", false],
    ] as const) {
      const html = renderToStaticMarkup(
        createElement(EventRow, {
          message: tool(path),
          ctx,
          detail: createElement("pre", null, "file body"),
        }),
      );
      expect(html.includes('data-slot="hover-card-trigger"'), path).toBe(
        preview,
      );
    }
  });
});
