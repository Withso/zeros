import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { composerCardDock, composerOwnsFocus } from "../composer-focus";
import { sendPastPermission } from "../session-reload-lifecycle";

const AGENT_CHAT = readFileSync(
  resolve(process.cwd(), "apps/desktop/src/renderer/features/agent/agent-chat.tsx"),
  "utf8",
);

const dock = (overrides: Partial<Parameters<typeof composerCardDock>[0]> = {}) =>
  composerCardDock({
    interactive: true,
    permissionCardActive: false,
    blockingQuestionActive: false,
    ...overrides,
  });

describe("composerCardDock", () => {
  it("keeps the composer on screen under a permission gate or a blocking question", () => {
    // The agent can still be working, and the user can steer it from below.
    expect(dock({ permissionCardActive: true }).concealed).toBe(false);
    expect(dock({ blockingQuestionActive: true }).concealed).toBe(false);
    expect(dock({ permissionCardActive: true, blockingQuestionActive: true }).concealed).toBe(false);
  });

  it("conceals the composer only for a chat that isn't interactive", () => {
    expect(dock({ interactive: false }).concealed).toBe(true);
    expect(dock().concealed).toBe(false);
  });

  it("lets a blocking card hold the keyboard, so its shortcuts keep working", () => {
    expect(dock({ permissionCardActive: true }).cardHoldsKeyboard).toBe(true);
    expect(dock({ blockingQuestionActive: true }).cardHoldsKeyboard).toBe(true);
    // Optional questions and plan review never enter this state.
    expect(dock().cardHoldsKeyboard).toBe(false);
  });
});

describe("composerOwnsFocus with a card above the composer", () => {
  it("stops pulling focus to the composer while a blocking card holds the keyboard", () => {
    const base = { chatId: "a", activeChatId: "a", composerConcealed: false };
    expect(composerOwnsFocus(base)).toBe(true);
    expect(composerOwnsFocus({ ...base, cardHoldsKeyboard: false })).toBe(true);
    expect(composerOwnsFocus({ ...base, cardHoldsKeyboard: true })).toBe(false);
    expect(composerOwnsFocus({ ...base, chatId: null, cardHoldsKeyboard: true })).toBe(false);
  });
});

describe("sendPastPermission", () => {
  it("sends normally when no permission is pending", () => {
    expect(sendPastPermission({ permissionPending: false, planReview: false, status: "streaming" })).toBe("send");
    expect(sendPastPermission({ permissionPending: false, planReview: false, status: "ready" })).toBe("send");
  });

  it("queues a message typed under a hard gate behind the running turn", () => {
    // sendPrompt queues every send while the turn streams; nothing passes
    // the gate until the card is answered.
    expect(sendPastPermission({ permissionPending: true, planReview: false, status: "streaming" })).toBe("send");
  });

  it("holds the draft when a gate has no streaming turn to queue behind", () => {
    for (const status of ["ready", "idle", "reconnecting", "failed"] as const) {
      expect(sendPastPermission({ permissionPending: true, planReview: false, status })).toBe("hold");
    }
  });

  it("turns a follow-up during plan review into a revision", () => {
    expect(sendPastPermission({ permissionPending: true, planReview: true, status: "streaming" })).toBe("revise-plan");
    expect(sendPastPermission({ permissionPending: true, planReview: true, status: "ready" })).toBe("revise-plan");
  });
});

describe("AgentChat wiring", () => {
  it("derives the composer's concealment from the dock, never from a card", () => {
    expect(AGENT_CHAT).toMatch(
      /const \{ concealed: composerConcealed, cardHoldsKeyboard \} = composerCardDock\(\{\s*interactive,\s*permissionCardActive,\s*blockingQuestionActive,\s*\}\);/,
    );
    expect(AGENT_CHAT).not.toMatch(/composerConcealed\s*=\s*!interactive\s*\|\|/);
  });

  it("hands the keyboard to a blocking card in both focus paths", () => {
    const owns = AGENT_CHAT.match(/composerOwnsFocus\(\{[\s\S]*?\}\)/g) ?? [];
    expect(owns).toHaveLength(2);
    for (const call of owns) expect(call).toMatch(/cardHoldsKeyboard/);
  });

  it("lets Send and Enter queue a message while a card is pending", () => {
    const canSend = AGENT_CHAT.slice(AGENT_CHAT.indexOf("const canSend ="), AGENT_CHAT.indexOf("const canSend =") + 200);
    expect(canSend).not.toMatch(/permissionCardActive|blockingQuestionActive/);
    expect(AGENT_CHAT).toMatch(
      /const permissionSend = sendPastPermission\(\{\s*permissionPending: !!session\.pendingPermission,\s*planReview: !!planReview,\s*status: session\.status,\s*\}\);\s*if \(permissionSend === "hold"\) return;\s*if \(permissionSend === "revise-plan"\) denyPlanReview\(\);/,
    );
  });

  it("docks every card above the composer", () => {
    const at = (needle: string) => {
      const index = AGENT_CHAT.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const composer = at("<ComposerConcealedContext.Provider value={composerConcealed}>");
    expect(at("<PermissionCard\n")).toBeLessThan(composer);
    expect(at("<QuestionCard\n")).toBeLessThan(composer);
    expect(at("<PlanReviewCard\n")).toBeLessThan(composer);
  });
});
