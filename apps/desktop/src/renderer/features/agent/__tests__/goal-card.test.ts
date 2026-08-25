import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AgentGoal } from "@zeros/protocol/agent-events";
import { GoalCard } from "../goal-card";

const goal = (status: AgentGoal["status"]): AgentGoal => ({
  objective: "Finish Phase 3",
  status,
  tokenBudget: 10_000,
  tokensUsed: 2_500,
  timeUsedSeconds: 60,
  createdAt: 1,
  updatedAt: 2,
});

const renderGoal = (status: AgentGoal["status"], editing = false) =>
  renderToStaticMarkup(
    createElement(GoalCard, {
      goal: goal(status),
      editing,
      onEditingChange: vi.fn(),
      onSave: vi.fn(async () => undefined),
      onStatus: vi.fn(async () => undefined),
      onDelete: vi.fn(async () => undefined),
    }),
  );

describe("GoalCard", () => {
  it("shows the compact active-goal row with pause and budget progress", () => {
    const html = renderGoal("active");
    expect(html).toContain("Pursuing goal");
    expect(html).toContain("Finish Phase 3");
    expect(html).toContain("2,500 / 10,000 tokens");
    expect(html).toContain('aria-label="Pause goal"');
  });

  it("offers resume for every non-active native status", () => {
    for (const status of [
      "paused",
      "blocked",
      "usageLimited",
      "budgetLimited",
      "complete",
    ] as const) {
      expect(renderGoal(status)).toContain('aria-label="Resume goal"');
    }
  });

  it("uses the bounded multiline editor only when explicitly opened", () => {
    const html = renderGoal("active", true);
    expect(html).toContain("textarea");
    expect(html).toContain('maxLength="4000"');
    expect(html).toContain('aria-label="Save goal"');
  });
});
