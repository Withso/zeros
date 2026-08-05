// EditCard row state for failed edits.
//
// The bug: EditCard passed `defaultOpen={tool.status === "failed"}` into
// EventRow, whose useState seeds from it at MOUNT. A fast-failing Edit
// (Claude rejects a stale old_string in milliseconds, so the tool_call and
// its failed result land in the same React commit) therefore mounted its row
// pre-expanded mid-stream — while a slow failure (status flips after mount)
// never expanded, and every remount (summary-chip re-expand, chat reopen)
// re-opened rows the user had collapsed. These tests pin the fix: a failed
// edit renders collapsed like every other failed tool, and its misleading
// green/red ± badge (applied-change vocabulary) is suppressed.
//
// renderToStaticMarkup keeps the row collapsed, so the detail subtree —
// EditDiff → <PatchDiff> (shadow DOM) — is never invoked; no mocks needed.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EditCard } from "../renderers/tool-edit";
import { EventRow } from "../renderers/event-row";
import type { RendererContext } from "../renderers/types";
import type { AgentToolMessage } from "../use-agent-session";

const ctx = { editBaselines: new Map() } as unknown as RendererContext;

const editTool = (over: Partial<AgentToolMessage>): AgentToolMessage =>
  ({
    id: "tool-e1",
    kind: "tool",
    toolCallId: "e1",
    title: "Edit",
    toolKind: "edit",
    status: "completed",
    rawInput: {
      file_path: "/src/a.ts",
      old_string: "old line",
      new_string: "new line 1\nnew line 2",
    },
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as AgentToolMessage;

const render = (message: AgentToolMessage): string =>
  renderToStaticMarkup(createElement(EditCard as never, { message, ctx }));

describe("EditCard — failed edits stay collapsed", () => {
  const failed = editTool({
    status: "failed",
    content: [
      {
        type: "content",
        content: { type: "text", text: "String to replace not found in file." },
      },
    ] as never,
  });

  it("mounts collapsed even when the row's first render already sees 'failed'", () => {
    const html = render(failed);
    expect(html).toContain('aria-expanded="false"');
    // Collapsed = no detail body: neither the error text nor the attempted diff.
    expect(html).not.toContain("String to replace not found");
  });

  it("suppresses the applied-change ± badge on the failed row", () => {
    // The same edit succeeds → +2 −1 shows; failed → no green/red counts.
    expect(render(editTool({}))).toContain("text-green-primary");
    expect(render(failed)).not.toContain("text-green-primary");
  });

  it("keeps a successful edit collapsed by default too (row parity)", () => {
    expect(render(editTool({}))).toContain('aria-expanded="false"');
  });

  it("makes a successful Edit row the trigger for a diff hover preview", () => {
    expect(render(editTool({}))).toContain('data-slot="hover-card-trigger"');
  });

  it("makes a successful whole-file Write row a diff hover trigger too", () => {
    expect(
      render(
        editTool({
          title: "Write",
          rawInput: { file_path: "/src/new.ts", content: "one\ntwo\n" },
        }),
      ),
    ).toContain('data-slot="hover-card-trigger"');
  });

  it("does not preview a failed edit as though its attempted diff landed", () => {
    expect(render(failed)).not.toContain('data-slot="hover-card-trigger"');
  });

  it("does not create a hover surface for a no-op Edit", () => {
    expect(
      render(
        editTool({
          rawInput: {
            file_path: "/src/a.ts",
            old_string: "unchanged",
            new_string: "unchanged",
          },
        }),
      ),
    ).not.toContain('data-slot="hover-card-trigger"');
  });

  it("does not add a hover preview to Read rows", () => {
    const read = editTool({
      title: "Read",
      toolKind: "read",
      rawInput: { file_path: "/src/a.ts" },
    });
    const html = renderToStaticMarkup(
      createElement(EventRow, {
        message: read,
        ctx,
        detail: createElement("pre", null, "file body"),
      }),
    );
    expect(html).not.toContain('data-slot="hover-card-trigger"');
  });
});
