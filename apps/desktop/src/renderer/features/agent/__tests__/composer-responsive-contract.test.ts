import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveComposerPlaceholder } from "../composer-placeholder";
import { chatTranscriptSummariesKey } from "../use-chat-transcript-summaries";
import { resolvePermissionFeedbackPlacement } from "../permission-feedback-placement";

function read(relativePath: string): string {
  try {
    return readFileSync(
      fileURLToPath(new URL(relativePath, import.meta.url)),
      "utf8",
    );
  } catch {
    return "";
  }
}

describe("chat composer responsive contract", () => {
  const agentChat = read("../agent-chat.tsx");
  const pills = read("../composer-pills.tsx");
  const pillStyles = read("../composer-pills.css");
  const promptInput = read(
    "../../../shared/ui/primitives/elements/prompt-input.tsx",
  );

  it("uses the chat pane as the named inline-size query container", () => {
    expect(agentChat).toContain("[container-name:agent-chat]");
    expect(agentChat).toContain("[container-type:inline-size]");
  });

  it("keeps the composer toolbar on one line", () => {
    expect(agentChat).toMatch(
      /<PromptInputTools className="[^"]*flex-nowrap[^"]*"/,
    );
    expect(agentChat).toMatch(
      /<PromptInputToolbar[^>]*className="[^"]*flex-nowrap[^"]*"/,
    );
  });

  it("does not expose ZSR or sandbox diagnostics in the composer", () => {
    expect(agentChat).not.toContain("BoundaryStatusPill");
    expect(agentChat).not.toContain('from "./boundary-status"');
  });

  it("keeps Stop wired to the first turn while admission is pending", () => {
    expect(agentChat).toContain(
      "hasPendingLocalTurn: pendingLocalTurnId !== null",
    );
    expect(agentChat).toMatch(
      /if \(composerStreaming\) \{\s*void session\.cancel\(\);\s*return;/,
    );
    expect(agentChat).toContain("{composerStreaming ? (");
    expect(agentChat).toContain('<Square className="size-3" />');
  });

  it("does not revalidate every provider after a non-auth execution failure", () => {
    expect(agentChat).toMatch(
      /if \(isAuth\) \{\s*invalidateAgentsCache\(\);\s*void refreshAgents/,
    );
  });

  it("shows metadata without the model name below 450px and only the logo below 400px", () => {
    expect(pills).toContain("data-model-pill-name");
    expect(pills).toContain("data-model-pill-metadata");
    expect(pillStyles).toContain("@container agent-chat (max-width: 449.98px)");
    expect(pillStyles).toContain("@container agent-chat (max-width: 399.98px)");
    expect(pillStyles).toMatch(
      /max-width: 449\.98px[\s\S]*\[data-model-pill-name\][\s\S]*display:\s*none/,
    );
    expect(pillStyles).toMatch(
      /max-width: 399\.98px[\s\S]*\[data-model-pill-label\][\s\S]*display:\s*none/,
    );
  });

  it("shows permission feedback to the right with a responsive top fallback", () => {
    const editComposer = read("../turn-container.tsx");
    expect(pills).toContain("data-permission-mode-feedback");
    expect(pills).toContain('feedbackPlacement === "right"');
    expect(pills).toContain("left-full");
    expect(pills).toContain("bottom-full");
    expect(pills).toContain("delayDuration={0}");
    expect(pills).toContain("open={labelVisible ? false : tooltipOpen}");
    expect(agentChat).toContain("data-permission-feedback-boundary");
    expect(agentChat).toContain("data-composer-toolbar-actions");
    expect(editComposer).toContain("data-permission-feedback-boundary");
    expect(editComposer).toContain("data-composer-toolbar-actions");
  });

  it("renders the send action as a borderless primary circle", () => {
    expect(promptInput).toContain('variant="default"');
    expect(promptInput).toMatch(/size-7 rounded-full border-0/);
  });
});

describe("permission feedback placement", () => {
  it("uses the right side whenever the label fits, including the exact edge", () => {
    expect(
      resolvePermissionFeedbackPlacement({
        triggerRight: 100,
        feedbackWidth: 80,
        boundaryRight: 184,
      }),
    ).toBe("right");
  });

  it("moves above only when the right side cannot fit", () => {
    expect(
      resolvePermissionFeedbackPlacement({
        triggerRight: 100,
        feedbackWidth: 80,
        boundaryRight: 183.99,
      }),
    ).toBe("top");
  });

  it("fails open to the requested right-side default when geometry is unavailable", () => {
    expect(
      resolvePermissionFeedbackPlacement({
        triggerRight: Number.NaN,
        feedbackWidth: 80,
        boundaryRight: 184,
      }),
    ).toBe("right");
  });
});

describe("chat composer first-turn placeholder", () => {
  const placeholder = read("../composer-placeholder.ts");
  const agentChat = read("../agent-chat.tsx");
  const editor = read("../composer-editor/use-composer-editor.tsx");

  it("uses the requested first-turn and follow-up copy", () => {
    expect(resolveComposerPlaceholder(false)).toBe(
      "Build, Design, / for commands, @ for context",
    );
    expect(resolveComposerPlaceholder(true)).toBe("Send follow up");
    expect(placeholder).toContain(
      '"Build, Design, / for commands, @ for context"',
    );
    expect(placeholder).toContain('"Send follow up"');
    expect(agentChat).toContain(
      "resolveComposerPlaceholder(conversationStarted)",
    );
  });

  it("refreshes the live TipTap decoration when placeholder state changes", () => {
    expect(editor).toContain("optsRef.current.placeholder");
    expect(editor).toContain("refreshPlaceholderDecoration");
  });
});

describe("composer attachment menu interaction path", () => {
  const agentChat = read("../agent-chat.tsx");
  const attachmentMenu = read("../composer-attachment-menu.tsx");
  const summaries = read("../use-chat-transcript-summaries.ts");

  it("owns open state in the small menu subtree instead of AgentChat", () => {
    expect(agentChat).not.toContain("const [plusMenuOpen, setPlusMenuOpen]");
    expect(agentChat).toContain("<ComposerAttachmentMenu");
    expect(attachmentMenu).toContain("const [open, setOpen] = useState(false)");
  });

  it("warms the exact transcript-summary key before click without a parent state update", () => {
    expect(attachmentMenu).toContain("onPointerEnter={onIntent}");
    expect(attachmentMenu).toContain("onFocus={onIntent}");
    expect(agentChat).toContain("warmChatTranscriptSummaries");
    expect(summaries).toContain("KeyedAsyncCache");
  });

  it("keeps folder and excluded-chat boundaries collision-free", () => {
    expect(chatTranscriptSummariesKey("/repo/a", "chat/b")).not.toBe(
      chatTranscriptSummariesKey("/repo/a/chat", "b"),
    );
    expect(chatTranscriptSummariesKey("/repo\u0000a", "chat")).not.toBe(
      chatTranscriptSummariesKey("/repo", "a\u0000chat"),
    );
    expect(JSON.parse(chatTranscriptSummariesKey("/repo", null))).toEqual([
      "/repo",
      null,
    ]);
  });
});
