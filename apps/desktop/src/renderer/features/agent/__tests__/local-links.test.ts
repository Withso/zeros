import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { LocalLinkSnapshot } from "../../../platform/local-link-snapshot";
import type { Workspace } from "../../../platform/git";
import type { ChatRowWire } from "../agent-history-client";
import {
  localLinkIndex,
  localLinkSourceEnabled,
  localLinkSpans,
} from "../local-links/model";
import {
  LocalLinksContext,
  type LocalLinksContextValue,
} from "../local-links/context";
import { LocalLinkPill } from "../local-links/pill";
import { LocalLinkHtml, LocalLinkText } from "../local-links/text";
import { TextMessage } from "../renderers/text-message";
import { TurnPromptHeader } from "../turn-container";
import type { RendererContext } from "../renderers/types";
import { TooltipProvider } from "../../../shared/ui/primitives/tooltip";
import type { ChatThread } from "../../../state/store";

vi.mock("../markdown", () => ({
  renderMarkdownSegments: (text: string) => [{ type: "html", html: text }],
  fileRefPath: () => null,
}));

const workspace = (
  id = "ws_child",
  extra: Partial<Workspace> = {},
): Workspace =>
  ({
    id,
    repoRoot: "/repo",
    path: "/worktrees/child",
    repoSlug: "repo",
    branch: "child",
    organizationId: null,
    placement: "local",
    archivedAt: null,
    ...extra,
  }) as Workspace;
const chat = (
  id: string,
  agentId = "codex",
  extra: Partial<ChatRowWire> = {},
): ChatRowWire =>
  ({
    id,
    agentId,
    title: `${agentId} review`,
    folder: "/repo",
    archived: false,
    kind: "chat",
    ...extra,
  }) as ChatRowWire;
const snapshot: LocalLinkSnapshot = {
  projects: [
    {
      id: "canonical",
      name: "Project",
      repoRoot: "/repo",
      repoSlug: "repo",
      originUrl: null,
      addedAt: 1,
    },
  ],
  workspaces: [
    workspace(),
    workspace("ws_org", { path: "/repo/org", organizationId: "organization" }),
    workspace("ws_archived", { path: "/repo/archived", archivedAt: 1 }),
    workspace("ws_cloud", { path: "/repo/cloud-placed", placement: "cloud" }),
  ],
  chats: [
    chat("codex"),
    chat("claude", "claude"),
    chat("cursor", "cursor"),
    chat("org", "claude", { folder: "/repo/org" }),
    chat("cloud", "claude", { folder: "cloud://org/foreign" }),
    chat("archived", "codex", { archived: true }),
  ],
};
const index = localLinkIndex(snapshot, []);
const context: LocalLinksContextValue = {
  enabled: true,
  scheme: "zeros-dev",
  index,
  navigate: vi.fn(),
};
const render = (element: ReturnType<typeof h>, value = context) =>
  renderToStaticMarkup(
    h(TooltipProvider, null, h(LocalLinksContext.Provider, { value }, element)),
  );

describe("Local link identity and presentation", () => {
  it("indexes canonical folder ids, live titles and exact folder ownership once", () => {
    const live = [chat("codex", "codex", { title: "Renamed" }) as ChatThread];
    const first = localLinkIndex(snapshot, live);
    expect(localLinkIndex(snapshot, live)).toBe(first);
    expect(first.chats.get("codex")?.label).toBe("Renamed");
    expect(first.workspaces.get("folder:canonical")).toMatchObject({
      available: true,
      label: "Project",
    });
    expect(first.workspaces.has("local-main")).toBe(false);
    expect(first.allowsFolder("/repo/subdir")).toBe(true);
    expect(first.allowsFolder("/repo/org/nested")).toBe(false);
    expect(first.allowsFolder("/repo/archived")).toBe(false);
    expect(
      localLinkIndex(snapshot, [
        chat("codex", "codex", { folder: "/elsewhere" }) as ChatThread,
      ]).chats.get("codex")?.available,
    ).toBe(false);
  });

  it.each(["/repo", "/repo/subdir", "/worktrees/child"])(
    "resolves a pristine live chat in %s before the engine saves it",
    (folder) => {
      const live = [
        chat("pristine", "cursor", { title: "Untitled", folder }) as ChatThread,
      ];
      const first = localLinkIndex(snapshot, live);
      expect(snapshot.chats.some((row) => row.id === "pristine")).toBe(false);
      expect(localLinkIndex(snapshot, live)).toBe(first);
      expect(first.chats.get("pristine")).toEqual({
        available: true,
        label: "Untitled",
        agentId: "cursor",
      });
      const html = render(h(LocalLinkPill, { href: "zeros-dev://chat/pristine" }), {
        ...context,
        index: first,
      });
      expect(html).toContain('data-local-link-available="true"');
      expect(html).toContain('data-local-link-agent="cursor"');
      expect(html).toContain("Open chat: Untitled");

      // The originator's store updates before persistence or DB_CHANGED.
      const renamed = localLinkIndex(snapshot, [{ ...live[0], title: "Review" }]);
      expect(renamed.chats.get("pristine")?.label).toBe("Review");
      expect(first.chats.get("pristine")?.label).toBe("Untitled");
    },
  );

  it.each([
    { archived: true },
    { kind: "terminal" as const },
    { folder: "/repo/org/nested" },
    { folder: "/repo/archived" },
    { folder: "/repo/cloud-placed" },
    { folder: "cloud://org/foreign" },
    { folder: "/unknown" },
  ])("keeps an ineligible live-only chat muted: %j", (overrides) => {
    const live = [chat("pristine", "cursor", overrides) as ChatThread];
    const current = localLinkIndex(snapshot, live);
    const html = render(h(LocalLinkPill, { href: "zeros-dev://chat/pristine" }), {
      ...context,
      index: current,
    });
    expect(html).toContain('data-local-link-available="false"');
    expect(html).not.toContain('data-local-link-agent="cursor"');
    expect(html).toContain("Open chat: Chat");
  });

  it.each([
    { workspaces: [] },
    { workspaces: [workspace("local-main", { path: "/repo" })] },
  ])(
    "resolves live tabs in plain folders and the synthetic main checkout",
    ({ workspaces }) => {
      const current = localLinkIndex({ ...snapshot, workspaces, chats: [] }, [
        chat("pristine", "cursor", { title: "Untitled" }) as ChatThread,
      ]);
      expect(current.chats.get("pristine")).toMatchObject({
        available: true,
        label: "Untitled",
        agentId: "cursor",
      });
      expect(current.workspaces.get("folder:canonical")?.available).toBe(true);
    },
  );

  it.each([
    { folder: "/repo/subdir" },
    { folder: "/repo/org" },
    { archived: true },
    { kind: "terminal" as const },
  ])("does not let a saved row bypass its live ownership guard: %j", (overrides) => {
    const current = localLinkIndex(snapshot, [
      chat("cursor", "cursor", overrides) as ChatThread,
    ]);
    expect(current.chats.get("cursor")).toEqual({
      available: false,
      label: "Chat",
      agentId: null,
    });
  });

  it.each(["claude", "codex", "cursor"])(
    "uses %s's real logo on the attachment shell with unchanged metrics",
    (agent) => {
      const html = render(
        h(LocalLinkPill, { href: `zeros-dev://chat/${agent}` }),
      );
      expect(html).toContain(`${agent} review`);
      expect(html).toContain(`data-local-link-agent="${agent}"`);
      expect(html).toContain("<svg");
      expect(html).toContain("bg-bg1");
      expect(html).toContain("border-border3");
      expect(html).toContain("text-fg1");
      expect(html).toContain("hover:bg-bg1-hover");
      expect(html).not.toContain("bg-agent-");
      expect(html).not.toContain("border-0");
      expect(html).toContain("h-5");
      expect(html).toContain("gap-2");
      expect(html).toContain("px-1.5");
      expect(html).not.toContain("hover:border-");
    },
  );

  it("renders workspace labels and the existing workspace glyph", () => {
    expect(
      render(h(LocalLinkPill, { href: "zeros-dev://workspace/ws_child" })),
    ).toContain("child");
    const folder = render(
      h(LocalLinkPill, { href: "zeros-dev://workspace/folder%3Acanonical" }),
    );
    expect(folder).toContain("Project");
    expect(folder).toContain("lucide-folder");
    expect(folder).toContain("bg-blue-pill-bg");
    expect(folder).toContain("border-0");
    // A tighter icon-to-name gap than the attachment-shaped chat pill.
    for (const html of [folder, render(h(LocalLinkPill, { href: "zeros-dev://workspace/ws_child" }))]) {
      expect(html).toMatch(/\bgap-1\b/);
      expect(html).not.toMatch(/\bgap-2\b/);
      expect(html).toContain("px-1.5");
    }
  });

  it.each(["missing", "org", "cloud", "archived"])(
    "keeps a refused %s target as a muted passive pill",
    (id) => {
      const html = render(h(LocalLinkPill, { href: `zeros-dev://chat/${id}` }));
      expect(html).toContain('data-local-link-available="false"');
      expect(html).toContain("bg-bg2-hover");
      expect(html).toContain("Open chat: Chat");
      expect(html).not.toContain("disabled=");
    },
  );

  it("uses engine provenance only as the missing-target fallback", () => {
    expect(
      render(
        h(LocalLinkPill, {
          href: "zeros-dev://chat/missing",
          fallback: { title: "Saved title", agentId: "claude" },
        }),
      ),
    ).toContain("Saved title");
    expect(
      render(
        h(LocalLinkPill, {
          href: "zeros-dev://chat/codex",
          fallback: { title: "Old title", agentId: "claude" },
        }),
      ),
    ).not.toContain("Old title");
  });

  it.each([
    { rollout: false },
    { organizationId: "organization" },
    { runtimeKind: "cloud" },
    { cwd: "cloud://org/workspace" },
    { cwd: "/repo/org" },
    { cwd: "/unknown" },
  ])("keeps raw text when source admission fails: %j", (override) => {
    const enabled = localLinkSourceEnabled({
      rollout: true,
      organizationId: null,
      runtimeKind: "local",
      cwd: "/repo",
      index,
      ...override,
    });
    expect(enabled).toBe(false);
    expect(
      render(h(LocalLinkText, { text: "See zeros-dev://chat/codex" }), {
        ...context,
        enabled,
      }),
    ).toBe("See zeros-dev://chat/codex");
  });

  it("keeps all occurrences, punctuation and foreign/malformed URLs intact", () => {
    const text =
      "See (zeros-dev://chat/codex), zeros-dev://chat/codex. zeros-beta://chat/other zeros-dev://chat/codex?run=true zeros-dev://chat/codex/path";
    const spans = localLinkSpans(text, "zeros-dev");
    expect(spans.map((span) => text.slice(span.start, span.end))).toEqual([
      "zeros-dev://chat/codex",
      "zeros-dev://chat/codex",
    ]);
    const html = render(h(LocalLinkText, { text }));
    expect(html.match(/data-local-link-pill=/g)).toHaveLength(2);
    expect(html).toContain("zeros-beta://chat/other");
    expect(html).toContain("zeros-dev://chat/codex?run=true");
    expect(render(h(LocalLinkText, { text: "No links here" }))).toBe(
      "No links here",
    );
  });

  it("linkifies sanitized markdown text/anchors while keeping pre and foreign anchors verbatim", () => {
    const html = render(
      h(LocalLinkHtml, {
        html: '<p>zeros-dev://chat/codex <a data-local-link="zeros-dev://chat/claude">reference</a></p><pre><code>zeros-dev://chat/codex</code></pre><a href="https://example.com">zeros-dev://chat/codex</a>',
      }),
    );
    expect(html.match(/data-local-link-pill=/g)).toHaveLength(2);
    expect(html).toContain("<pre><code>zeros-dev://chat/codex</code></pre>");
    expect(html).toContain(
      '<a href="https://example.com">zeros-dev://chat/codex</a>',
    );
  });

  it("does not insert an interactive pill inside sanitized HTML controls", () => {
    const html = render(
      h(LocalLinkHtml, {
        html: "<button>zeros-dev://chat/codex</button><details><summary>zeros-dev://chat/codex</summary><p>zeros-dev://chat/codex</p></details>",
      }),
    );
    expect(html.match(/data-local-link-pill=/g)).toHaveLength(1);
    expect(html).toContain("<button>zeros-dev://chat/codex</button>");
    expect(html).toContain("<summary>zeros-dev://chat/codex</summary>");
  });

  it("renders provenance above a label-free body and notes only as activity", () => {
    const ref = {
      chatId: "codex",
      title: "Saved",
      agentId: "codex",
      link: "zeros-dev://chat/codex",
    };
    const message = {
      id: "message",
      kind: "text" as const,
      role: "user" as const,
      createdAt: 1,
      text: "The actual body",
    };
    const ctx = {
      isStreaming: false,
      attachmentImagesActive: false,
    } as RendererContext;
    const body = h(TextMessage, { message: { ...message, localFrom: ref }, ctx });
    const from = render(h(TurnPromptHeader, { originalText: message.text, localFrom: ref, children: body }));
    expect(from).toContain("Sent from");
    expect(from).toContain("The actual body");
    expect(from).not.toContain("[Zeros]");
    expect(render(body)).not.toContain("Sent from");
    // The bubble fits its message and stays flush right; the header keeps
    // its own width, starting at the group's left edge, 8px above.
    expect(from).toMatch(/data-local-from=""[^>]*class="[^"]*\bself-start\b/);
    expect(from).toMatch(/data-local-from=""[^>]*class="[^"]*\bmb-2\b/);
    expect(from).toMatch(/data-local-from-group=""[^>]*class="[^"]*\bitems-end\b/);
    expect(from).toMatch(/data-user-bubble=""[^>]*class="[^"]*\bw-fit\b/);
    expect(from).not.toMatch(/data-user-bubble=""[^>]*class="[^"]*\bw-full\b/);
    expect(from.indexOf("Sent from")).toBeLessThan(from.indexOf('data-user-bubble=""'));
    expect(from).not.toContain('aria-label="Edit message"');
    const note = render(
      h(TextMessage, {
        message: {
          ...message,
          localNote: { ...ref, event: "permission", cardTitle: "Run: tests" },
        },
        ctx,
      }),
    );
    expect(note).toContain("Permission requested");
    expect(note).toContain("lucide-terminal");
    expect(note).toContain("Run: tests");
    expect(note).not.toContain("The actual body");
    expect(note).not.toContain("data-role=");
    const linkedNote = render(h(TextMessage, {
      message: { ...message, localNote: { ...ref, event: "permission", cardTitle: "Run: zeros local chat status zeros-dev://chat/claude" } }, ctx,
    }));
    expect(linkedNote.match(/data-local-link-pill=/g)).toHaveLength(2);
    expect(linkedNote.slice(linkedNote.indexOf(">Run:"))).not.toContain("data-local-link-pill");
    expect(linkedNote).toContain("Run: zeros local chat status zeros-dev://chat/claude</span>");
  });
});
