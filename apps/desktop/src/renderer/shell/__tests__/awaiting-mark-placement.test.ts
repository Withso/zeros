import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AGENT_AWAITING_LABEL,
  AgentAwaitingIcon,
  AgentAwaitingIndicator,
} from "../../features/agent/agent-awaiting-indicator";
import { ChatUnreadDot } from "../../features/agent/chat-unread-dot";
import { TooltipProvider } from "../../shared/ui/primitives/tooltip";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const TABS = source("apps/desktop/src/renderer/shell/conversation/chat-tabs.tsx");
const ROW = source("apps/desktop/src/renderer/shell/sidebar-workspace-row.tsx");

/** TabRow's body, from its declaration to the next top-level one. */
const tabRow = TABS.slice(TABS.indexOf("function TabRow("), TABS.indexOf("\n}\n", TABS.indexOf("function TabRow(")));
/** SidebarWorkspaceRow's body. */
const row = ROW.slice(ROW.indexOf("export function SidebarWorkspaceRow("), ROW.indexOf("/** Placeholder row"));

describe("awaiting mark", () => {
  it("labels a plan review and a pending question or permission", () => {
    const inTooltips = (kind: "plan" | "input") =>
      renderToStaticMarkup(
        createElement(TooltipProvider, null, createElement(AgentAwaitingIndicator, { kind })),
      );
    const plan = inTooltips("plan");
    expect(plan).toContain('role="img"');
    expect(plan).toContain(`aria-label="${AGENT_AWAITING_LABEL.plan}"`);
    expect(plan).toContain('data-agent-awaiting="plan"');
    const input = inTooltips("input");
    expect(input).toContain(`aria-label="${AGENT_AWAITING_LABEL.input}"`);
    expect(input).toContain('data-agent-awaiting="input"');
    // Sized like the draft pencil whose slot it takes.
    expect(input).toMatch(/<span class="[^"]*\bsize-3\b/);
  });

  it("draws a bare, decorative icon for rows that label themselves", () => {
    const icon = renderToStaticMarkup(createElement(AgentAwaitingIcon, { kind: "input", className: "size-3.5" }));
    expect(icon).toContain('aria-hidden="true"');
    expect(icon).not.toContain("role=");
  });
});

describe("chat tab", () => {
  const leading = tabRow.slice(tabRow.indexOf("{isTerminal ? ("), tabRow.indexOf("{renaming ? ("));
  const trailing = tabRow.slice(tabRow.lastIndexOf("{trailingMark ? ("));

  it("rests its loader while the turn waits on the user", () => {
    // parkedOnUser: a blocking question, permission or plan review shows the
    // agent's icon; an ask the agent keeps working beside keeps the loader.
    expect(tabRow).toContain("const activity = useChatWorkingActivity(chat.id);");
    expect(tabRow).not.toContain("useChatAgentActivity(");
  });

  it("keeps the agent's icon or loader leading while it asks", () => {
    expect(leading).not.toMatch(/awaiting|ClipboardList|MessageCircleQuestionMark/i);
    expect(leading).toMatch(/!readOnly && activity \? \(\s*<AgentActivityIndicator/);
  });

  it("puts the plan or question mark at the tab's end, in place of the pencil", () => {
    expect(tabRow).toMatch(/const awaitingMark = readOnly \|\| isTerminal \? null : awaitingKind;/);
    expect(tabRow).toMatch(/const trailingMark = awaitingMark \?\? \(showDraft \? "draft" : null\);/);
    expect(trailing).toMatch(
      /trailingMark === "draft" \? \(\s*<ComposerDraftIndicator \/>\s*\) : \(\s*<AgentAwaitingIndicator kind=\{trailingMark\} \/>\s*\)/,
    );
    // Close covers whichever mark holds the slot, in place.
    expect(tabRow).toMatch(/trailingMark \? TAB_DRAFT_ACTION_OVERLAY_CLS : TAB_HOVER_OVERLAY_CLS/);
  });

  it("names both states when a draft waits under a question", () => {
    expect(tabRow).toMatch(/hasDraft \|\| awaitingMark \|\| unread\s*\? \[/);
    expect(tabRow).toMatch(/awaitingMark && AGENT_AWAITING_LABEL\[awaitingMark\]\.toLowerCase\(\)/);
    expect(tabRow).toMatch(/hasDraft && "unsent draft"/);
    expect(tabRow).toContain("aria-label={tabLabel}");
  });
});

describe("sidebar workspace row", () => {
  const leading = row.slice(row.indexOf("{archiving ? ("), row.indexOf("{/* Only the name truncates"));

  it("rests the square while every asking chat waits on the user", () => {
    expect(row).toContain("const activity = useAnyChatWorkingActivity(chatIds);");
    expect(row).not.toContain("useAnyChatAgentActivity(");
  });

  it("never swaps the square or the loader for the mark", () => {
    expect(leading).not.toMatch(/awaiting|ClipboardList|MessageCircleQuestionMark/i);
    expect(leading.match(/<WorkspaceGlyph/g)).toHaveLength(1);
    expect(leading).toMatch(/working \? \(\s*<AgentActivityIndicator activity=\{activity\} \/>/);
  });

  it("shows a grouped row's mark in the inset gutter, left of the square", () => {
    const gutter = row.indexOf("{grouped && statusMark && (");
    expect(gutter).toBeGreaterThan(-1);
    expect(gutter).toBeLessThan(row.indexOf("{archiving ? ("));
    expect(row.slice(gutter, gutter + 400)).toMatch(
      /<span className=\{SIDEBAR_WORKSPACE_GUTTER_CLS\} aria-hidden="true">[\s\S]*?<AgentAwaitingIcon/,
    );
    expect(ROW).toMatch(/const SIDEBAR_WORKSPACE_GROUPED_INSET_CLS = "pl-6";/);
    expect(ROW).toMatch(/SIDEBAR_WORKSPACE_GUTTER_CLS =\s*"[^"]*\babsolute inset-y-0 left-0\b[^"]*\bw-6\b/);
  });

  it("gives a flat row's mark the pencil's slot, which it outranks", () => {
    expect(row).toMatch(/const statusMark = archiving \? null : \(awaitingKind \?\? /);
    expect(row).toMatch(/const trailingMark = !grouped && statusMark \? statusMark : showDraft \? "draft" : null;/);
    // An Ungrouped row's trailing agent state is the loader alone now.
    expect(row).toMatch(/const trailingAgentState = mixedRepositories && !archiving && working;/);
  });
});

describe("unread dot", () => {
  const DECK = source("apps/desktop/src/renderer/shell/conversation/chat-deck.tsx");
  const SHELL = source("apps/desktop/src/renderer/app-shell.tsx");

  it("is a small brown dot, decorative because its surface names the state", () => {
    const dot = renderToStaticMarkup(createElement(ChatUnreadDot));
    expect(dot).toMatch(/<span class="[^"]*\bbg-brown-fg\b[^"]*\brounded-full\b/);
    expect(dot).toContain('aria-hidden="true"');
    expect(dot).toContain("data-chat-unread");
  });

  it("replaces a chat tab's agent logo, never its working loader", () => {
    const leading = tabRow.slice(tabRow.indexOf("{isTerminal ? ("), tabRow.indexOf("{renaming ? ("));
    expect(tabRow).toMatch(/const unread = useChatUnread\(chat\.id\) && !readOnly && !isTerminal;/);
    expect(leading).toMatch(
      /!readOnly && activity \? \(\s*<AgentActivityIndicator[\s\S]*?\) : unread \? \(\s*<ChatUnreadDot \/>\s*\) : \(\s*<AgentIcon/,
    );
    expect(tabRow).toMatch(/unread && "unread"/);
  });

  it("sits where a workspace row's plan or question mark goes, which outranks it", () => {
    expect(row).toContain("const unread = useAnyChatUnread(chatIds);");
    expect(row).toMatch(/const statusMark = archiving \? null : \(awaitingKind \?\? \(unread \? "unread" : null\)\);/);
    const gutter = row.slice(row.indexOf("{grouped && statusMark && ("), row.indexOf("{archiving ? ("));
    expect(gutter).toMatch(/statusMark === "unread" \? \(\s*<ChatUnreadDot \/>/);
    expect(row).toMatch(/const trailingMark = !grouped && statusMark \? statusMark : showDraft \? "draft" : null;/);
    expect(row).toMatch(/unread,\s*\}\)\}/);
  });

  it("reads the chats the deck puts on screen, and tracks finishes app-wide", () => {
    expect(DECK).toMatch(/const chatsInView = activePage === "workspace" \? displayedChatIds : NO_CHATS;/);
    expect(DECK).toMatch(/setChatsInView\(chatsInView\)/);
    expect(SHELL).toMatch(/useEffect\(\(\) => startChatUnreadTracking\(\), \[\]\)/);
    expect(SHELL).toMatch(/<ChatUnreadTracking \/>/);
  });
});
