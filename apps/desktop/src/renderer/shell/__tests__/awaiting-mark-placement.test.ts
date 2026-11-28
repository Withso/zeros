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
  const leading = row.slice(row.indexOf("const leadMark ="), row.indexOf("const parentToggle"));

  it("rests the square while every asking chat waits on the user", () => {
    expect(row).toContain("const activity = useAnyChatWorkingActivity(chatIds);");
    expect(row).not.toContain("useAnyChatAgentActivity(");
  });

  it("keeps the logo and carries the loader or dot in the lead only for a dot lead", () => {
    expect(leading).not.toMatch(/awaiting|ClipboardList|MessageCircleQuestionMark/i);
    expect(leading.match(/<WorkspaceProjectIcon/g)).toHaveLength(1);
    expect(leading).toMatch(/lead === "working" \? <AgentActivityIndicator activity=\{activity\} \/>/);
    expect(leading).toMatch(/lead === "status-dot" \? <span className=\{cn\(STATUS_DOT_BASE_CLS, statusDot\)\}/);
    expect(leading).toMatch(/lead === "idle-dot" \? <span className=\{IDLE_DOT_CLS\}/);
    expect(row).toContain("const dotLead = repositoryLead || (depth > 0 && sameProjectAsParent);");
    expect(ROW).toContain('const IDLE_DOT_CLS = "size-1.5 rounded-full bg-(--sidebar-idle-dot)";');
  });

  it("puts the loader, else the status dot, at the right end of line 1 in every density", () => {
    expect(row).toContain("const statusDot = archiving ? null : sidebarStatusDot(rowStatus);");
    expect(row).toContain("const endMark = sidebarRowEndMark({ archiving, working, dotLead, statusDot: !!statusDot, folder: localFolder, design: designWorkspace });");
    const end = row.slice(row.indexOf('<span className={cn(SIDEBAR_WORKSPACE_TRAILING_CLS, "ml-auto")}>'));
    expect(end).toMatch(/endMark === "loader" \? \([\s\S]*?<AgentActivityIndicator activity=\{activity\} \/>/);
    expect(end).toMatch(/endMark === "dot" \? \([\s\S]*?role="img" aria-label=\{statusDotLabel\}/);
    expect(end).toMatch(/compact && sidebarCompactShowsTime\(\{ working, statusDot: !!statusDot \}\)/);
    expect(row).not.toContain("leadStatusDot");
    expect(ROW).toMatch(/const SIDEBAR_WORKSPACE_GROUPED_INSET_CLS = "pl-8";/);
    expect(ROW).not.toContain("SIDEBAR_WORKSPACE_GUTTER_CLS");
  });

  it("puts the unsent-draft pencil right after the name", () => {
    const name = row.indexOf('<span className="text-fg1 min-w-0 truncate">{label}</span>');
    const pencil = row.indexOf("{showDraft && (");
    expect(pencil).toBeGreaterThan(name);
    expect(pencil).toBeLessThan(row.indexOf("{placementMark && ("));
    expect(row).not.toContain("trailingMark");
    expect(row).not.toContain("trailingAgentState");
  });
});

describe("unread dot", () => {
  const DECK = source("apps/desktop/src/renderer/shell/conversation/chat-deck.tsx");
  const SHELL = source("apps/desktop/src/renderer/app-shell.tsx");

  it("is a small violet dot, decorative because its surface names the state", () => {
    const dot = renderToStaticMarkup(createElement(ChatUnreadDot));
    expect(dot).toMatch(/<span class="[^"]*\bbg-violet-text\b[^"]*\brounded-full\b/);
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

  it("drives a workspace row's Done word and dot, which go once the chat is read", () => {
    expect(row).toContain("const unread = useAnyChatUnread(chatIds);");
    expect(row).not.toContain("<ChatUnreadDot");
    expect(row).toMatch(/unread,\s*\}\)\}/);
  });

  it("reads the chats the deck puts on screen, and tracks finishes app-wide", () => {
    expect(DECK).toMatch(/const chatsInView = activePage === "workspace" \? displayedChatIds : NO_CHATS;/);
    expect(DECK).toMatch(/setChatsInView\(chatsInView\)/);
    expect(SHELL).toMatch(/useEffect\(\(\) => startChatUnreadTracking\(\), \[\]\)/);
    expect(SHELL).toMatch(/<ChatUnreadTracking \/>/);
  });
});
