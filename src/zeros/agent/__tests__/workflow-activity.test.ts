// Workflow activity row + hover panel.
//
// These assert RENDERED markup (like permission-card.test.ts) rather than the
// component's source text: the settled design is "does the user see 32 fixed
// cells on a --bg1 surface, with honest status copy", and a Prettier/Tailwind
// class reorder must not fail the suite for a UI that never changed.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "../../ui/primitives/tooltip";
import {
  WORKFLOW_SEGMENT_COUNT,
  WorkflowProgressPanel,
  filledWorkflowSegments,
  pickActiveWorkflow,
  workflowIsStoppable,
  workflowPhaseCountLabel,
  workflowStatusLabel,
} from "../workflow-activity";
import type { WorkflowProgress } from "../../bridge/agent-events";

const workflow = (
  overrides: Partial<WorkflowProgress> = {},
): WorkflowProgress => ({
  taskId: "wf-1",
  name: "dependency-audit",
  status: "running",
  startedAt: 1,
  updatedAt: 2,
  phases: [
    { index: 0, title: "Find", completed: 3, total: 4, status: "running" },
    { index: 1, title: "Verify", completed: 0, total: 0, status: "queued" },
  ],
  ...overrides,
});

const renderPanel = (value: WorkflowProgress) =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(WorkflowProgressPanel, {
        workflow: value,
        onStop: vi.fn(),
      }),
    ),
  );

describe("workflow activity progress", () => {
  it("always renders the settled fixed horizontal segment count", () => {
    expect(WORKFLOW_SEGMENT_COUNT).toBe(32);
    expect(filledWorkflowSegments(3, 4)).toBe(24);
    expect(filledWorkflowSegments(8, 8)).toBe(32);
    expect(filledWorkflowSegments(0, 0)).toBe(0);
  });

  it("shows only exact counts or Queued", () => {
    expect(workflowPhaseCountLabel({ completed: 3, total: 4 })).toBe("3/4");
    expect(workflowPhaseCountLabel({ completed: 0, total: 0 })).toBe("Queued");
  });
});

describe("workflow status copy", () => {
  it("names what the run is actually doing", () => {
    expect(workflowStatusLabel("running")).toBe("Workflow running");
    expect(workflowStatusLabel("paused")).toBe("Workflow paused");
    expect(workflowStatusLabel("completed")).toBe("Workflow complete");
    expect(workflowStatusLabel("failed")).toBe("Workflow failed");
    expect(workflowStatusLabel("killed")).toBe("Workflow stopped");
  });

  it("offers Stop only while the run can still be stopped", () => {
    expect(workflowIsStoppable("running")).toBe(true);
    expect(workflowIsStoppable("paused")).toBe(true);
    expect(workflowIsStoppable("completed")).toBe(false);
    expect(workflowIsStoppable("failed")).toBe(false);
    expect(workflowIsStoppable("killed")).toBe(false);
  });
});

describe("active workflow selection", () => {
  it("picks the newest live run", () => {
    expect(
      pickActiveWorkflow([
        workflow({ taskId: "old", updatedAt: 5 }),
        workflow({ taskId: "new", updatedAt: 9 }),
      ])?.taskId,
    ).toBe("new");
  });

  it("breaks an updatedAt tie on the newer start", () => {
    expect(
      pickActiveWorkflow([
        workflow({ taskId: "first", updatedAt: 7, startedAt: 1 }),
        workflow({ taskId: "second", updatedAt: 7, startedAt: 4 }),
      ])?.taskId,
    ).toBe("second");
  });

  it("ignores a run that settled mid-turn, even when it is the newest", () => {
    expect(
      pickActiveWorkflow([
        workflow({ taskId: "live", updatedAt: 5 }),
        workflow({ taskId: "done", updatedAt: 9, status: "completed" }),
      ])?.taskId,
    ).toBe("live");
    expect(
      pickActiveWorkflow([
        workflow({ taskId: "done", updatedAt: 9, status: "completed" }),
        workflow({ taskId: "failed", updatedAt: 10, status: "failed" }),
        workflow({ taskId: "killed", updatedAt: 11, status: "killed" }),
      ]),
    ).toBeNull();
  });

  it("keeps a paused run on screen so it can still be stopped", () => {
    expect(
      pickActiveWorkflow([workflow({ status: "paused" })])?.taskId,
    ).toBe("wf-1");
  });
});

describe("workflow hover panel", () => {
  it("renders the workflow name, phase titles and counts only", () => {
    const html = renderPanel(workflow());
    expect(html).toContain("dependency-audit");
    expect(html).toContain("Find");
    expect(html).toContain("3/4");
    expect(html).toContain("Queued");
    // Counts only — never token/cost telemetry (settled design decision).
    expect(html).not.toMatch(/tokens|\$\d/);
  });

  it("draws one fixed-density track per phase at 8px with progressed cells", () => {
    const html = renderPanel(workflow());
    const tracks = html.match(/role="progressbar"/g) ?? [];
    expect(tracks).toHaveLength(2);
    const cells = html.match(/rounded-\[2px\]/g) ?? [];
    expect(cells).toHaveLength(2 * WORKFLOW_SEGMENT_COUNT);
    expect(html).toContain('aria-valuenow="3"');
    expect(html).toContain('aria-valuemax="4"');
    // 24 progressed --fg2 cells, the rest at the dimmer unprogressed token.
    expect((html.match(/bg-fg2/g) ?? []).length).toBe(24);
    expect((html.match(/bg-bg4/g) ?? []).length).toBe(
      2 * WORKFLOW_SEGMENT_COUNT - 24,
    );
    expect(html).not.toContain("h-[3px]");
  });

  it("turns every cell green once the workflow completes", () => {
    const html = renderPanel(workflow({ status: "completed" }));
    expect((html.match(/bg-green-primary/g) ?? []).length).toBe(
      2 * WORKFLOW_SEGMENT_COUNT,
    );
    expect(html).not.toContain("bg-fg2");
  });

  it("keeps Pause disabled and disables Stop for a settled run", () => {
    const live = renderPanel(workflow());
    // Exactly one disabled control while running: the unsupported Pause.
    expect((live.match(/disabled=""/g) ?? []).length).toBe(1);

    const done = renderPanel(workflow({ status: "completed" }));
    expect((done.match(/disabled=""/g) ?? []).length).toBe(2);
  });
});
