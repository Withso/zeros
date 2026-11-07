import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), "apps/desktop/src/renderer", path), "utf8");
const agentChat = () => read("features/agent/agent-chat.tsx");

/** The dock column's JSX from its fade up to the composer itself. */
function cardsAboveComposer(src: string): string {
  const start = src.indexOf("data-composer-dock-fade");
  const end = src.indexOf("<ComposerConcealedContext.Provider", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// 2026-11-07 (Zeros Design v401): in an unfocused split pane the composer IS
// its Ask pill. Streaming, and every card docked above the composer, carry on
// unchanged; pressing the pill focuses the pane, which expands it again.
describe("the composer dock in an unfocused split pane", () => {
  it("collapses only an interactive composer, and the card itself becomes the pill", () => {
    const src = agentChat();
    expect(src).toContain("const askCollapsed = interactive && composerCollapsed;");
    expect(src).toContain('data-composer-ask={askCollapsed ? "pill" : "composer"}');
    // After the surface radius, so the pill's corners win.
    expect(src).toMatch(/COMPOSER_SURFACE_RADIUS,\s*composerAskCardClasses\(askCollapsed\),/);
    expect(src).toContain("<ComposerAskPill");
    expect(src).toContain("agent={askAgentName}");
  });

  it("keeps every card above the pill, untouched by the collapse", () => {
    const cards = cardsAboveComposer(agentChat());
    for (const card of ["<EmbeddedTerminalCommand", "<GoalCard", "<QueuedMessagesCard", "<PermissionCard", "<QuestionCard", "<PlanReviewCard"]) {
      expect(cards).toContain(card);
    }
    expect(cards).not.toContain("askCollapsed");
  });

  it("parks the composer's contents, draft and attachments included, out of reach while collapsed", () => {
    const src = agentChat();
    expect(src).toContain("className={composerAskContentClasses(askCollapsed)} {...(askCollapsed ? { inert: \"\" } : {})}>");
    const wrapper = src.indexOf("composerAskContentClasses(askCollapsed)");
    expect(src.indexOf("<PromptInput", wrapper)).toBeGreaterThan(wrapper);
    // Popovers anchored inside close, and the pill draws no mode frame, drop veil or picker.
    expect(src).toContain("<ComposerConcealedContext.Provider value={composerConcealed || askCollapsed}>");
    expect(src).toContain("concealed={composerConcealed || askCollapsed}");
    expect(src).toContain("composerGuarded && !dragActive && !askCollapsed && <PlanModeFrame />");
    expect(src).toContain("composerGuarded && !dragActive && !askCollapsed && \"!border-transparent\"");
    expect(src).toContain("dragActive && !askCollapsed && <ComposerDropVeil />");
    expect(src).toContain("{!askCollapsed && composerSuggestionPopup}");
  });

  it("focuses its pane from the pill, a drop on it, or the keyboard", () => {
    const src = agentChat();
    expect(src).toMatch(/const activateAskPane = useCallback\(\(\) => \{[\s\S]{0,200}dispatch\(\{ type: "SET_ACTIVE_CHAT", id: chatId \}\)/);
    expect(src).toContain("onDrop: (event: React.DragEvent) => { dragHandlers.onDrop(event); activateAskPane(); }");
    expect(src).toMatch(/useComposerAskMorph\(\{[\s\S]{0,400}onPillFocusHandoff: \(\) => composerFocusRef\.current\(\)/);
  });

  it("follows its pane: only a displayed, writable chat in an unfocused split pane collapses", () => {
    const deck = read("shell/conversation/chat-deck.tsx");
    expect(deck).toContain("paneId={paneId}");
    const view = read("shell/conversation/chat-view.tsx");
    expect(view).toContain("const composerCollapsed = usePaneComposerCollapsed(paneId) && surfaceActive && !readOnly;");
    expect(view.match(/composerCollapsed=\{composerCollapsed\}/g)).toHaveLength(2);
  });
});
