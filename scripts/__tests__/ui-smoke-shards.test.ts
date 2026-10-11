import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  scenarioRegistry,
  selectScenarioSteps,
  selectScenarios,
  smokeShards,
  validateSmokePartition,
} from "../ui-smoke/scenarios.mjs";
import { checkPageErrors, runSmokeScenarios } from "../ui-smoke/runner.mjs";
import { cloudComputerV2ReviewRegressions } from "../ui-smoke-cloud-computer-v2.mjs";

// Frozen from the serial runner, including the design-workspace dispatcher's
// children. Core's later phases stay after file-prefetch in the execution plan.
const originalOrder = [
  "git-review-actions",
  "code-review",
  "code-review-retention",
  "create-composer",
  "create-source-immediate-escape",
  "create-source-tooltip-escape",
  "cloud-workspace",
  "workbench-status",
  "cloud-replica",
  "cloud-preview",
  "cloud-design-assets",
  "cloud-terminal",
  "cloud-settings",
  "cloud-design-directories",
  "cloud-computer-v2",
  "context-gauge",
  "claude-runtime-ui",
  "codex-runtime-ui",
  "shared-default-model",
  "composer-send-failures",
  "permission-hints",
  "conversation-summary",
  "overlay-positioning",
  "draft-indicators",
  "app-sidebar",
  "chat-titles",
  "composer-editor",
  "design-mode",
  "attachment-persistence",
  "attachment-layout",
  "core-inline",
  "design-floating-chrome",
  "design-floating-chrome-edges",
  "design-workbench",
  "design-selection",
  "design-auto-layout",
  "design-spacing",
  "design-layout-gestures",
  "design-inspector-races",
  "design-inspector-edits",
  "design-layout",
  "design-layout-children",
  "design-frame-children",
  "design-authored-frame",
  "design-loading-edits",
  "design-frame-recovery",
  "design-inline-tools",
  "design-camera",
  "design-preview",
  "design-interaction-integrity",
  "design-panel-integrity",
  "design-canvas-refinements",
  "design-motion-refinements",
  "design-style-refinements",
  "design-pages",
  "design-workspace-canvas",
  "file-prefetch",
  "personal-organization",
  "mentions",
  "composer-attachments",
  "customize",
  "tools",
  "native-tools",
  "codex-transcript",
  "repo-settings",
  "folder-workspace",
  "workspace-recovery-navigation",
  "folder-review",
  "folder-files",
  "start-from-scratch",
  "folder-auto-setup",
  "create-project-selection",
  "folder-create",
  "folder-design-setup",
  "dialog-chrome",
  "terminal-workbench",
  "workspace-archives",
  "pr-actions",
  "activity-disclosure",
  "sticky-bottom",
  "subscription",
];

const runner = fileURLToPath(
  new URL("../ui-smoke-composer.mjs", import.meta.url),
);
function cli(args: string[]) {
  return spawnSync(process.execPath, [runner, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    // A list/argument-validation command must work without pnpm or a browser.
    env: {
      ...process.env,
      PATH: "/nonexistent-ui-smoke-list-bin",
      PLAYWRIGHT_BROWSERS_PATH: "/nonexistent-ui-smoke-list-browsers",
    },
  });
}

describe("UI smoke shard registry", () => {
  it("uses unique stable kebab-case IDs with explicit page fixtures", () => {
    const ids = scenarioRegistry.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of scenarioRegistry) {
      expect(scenario.id).toMatch(/^[a-z]+(?:-[a-z0-9]+)*$/);
      expect(scenario.fixture.page).toBeTruthy();
      expect(scenario.fixture.viewport.width).toBeGreaterThan(0);
      expect(scenario.fixture.viewport.height).toBeGreaterThan(0);
      expect(["self", "origin"]).toContain(scenario.fixture.navigation);
    }
  });

  it("partitions every scenario exactly once across three shards", () => {
    expect(smokeShards).toHaveLength(3);
    expect(smokeShards.flat().sort()).toEqual([...originalOrder].sort());
    expect(() => validateSmokePartition()).not.toThrow();
  });

  it("rejects stale partitions instead of silently dropping or repeating work", () => {
    const duplicated = smokeShards.map((shard) => [...shard]);
    duplicated[0].push(duplicated[1][0]);
    expect(() => validateSmokePartition(duplicated)).toThrow(/more than once/);
    const missing = smokeShards.map((shard) => [...shard]);
    missing[0].pop();
    expect(() => validateSmokePartition(missing)).toThrow(/missing/);
    const unknown = smokeShards.map((shard) => [...shard]);
    unknown[0].push("unknown-scenario");
    expect(() => validateSmokePartition(unknown)).toThrow(/unknown/);
    expect(() => validateSmokePartition(smokeShards.slice(1))).toThrow(/three/);
  });

  it("keeps the original default order, including the interleaved core phases", () => {
    expect(selectScenarios().map((scenario) => scenario.id)).toEqual(
      originalOrder,
    );
    const expectedSteps = originalOrder.flatMap((id) => {
      if (id === "core-inline") return [{ id, phase: "model-menu" }];
      if (id === "file-prefetch") {
        return [
          { id },
          { id: "core-inline", phase: "diff-files" },
          { id: "core-inline", phase: "github-settings" },
          { id: "core-inline", phase: "browser-retention" },
        ];
      }
      return [{ id }];
    });
    expect(selectScenarioSteps()).toEqual(expectedSteps);
  });

  it("filters assignments in original order and keeps subscription last", () => {
    for (let index = 1; index <= 3; index += 1) {
      const assigned = smokeShards[index - 1];
      expect(selectScenarios(index).map((scenario) => scenario.id)).toEqual(
        originalOrder.filter((id) => assigned.includes(id)),
      );
      expect(selectScenarioSteps(index)).toEqual(
        selectScenarioSteps().filter((step) => assigned.includes(step.id)),
      );
      if (assigned.includes("subscription")) {
        expect(selectScenarioSteps(index).at(-1)?.id).toBe("subscription");
      }
    }
  });
});

describe("UI smoke CLI without Vite or Chromium", () => {
  it("lists the complete registry as JSON", () => {
    const result = cli(["--list", "--format=json"]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(originalOrder);
  });

  it.each([1, 2, 3])(
    "lists only shard %i in default relative order",
    (index) => {
      const result = cli([`--shard=${index}/3`, "--format=json", "--list"]);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual(
        originalOrder.filter((id) => smokeShards[index - 1].includes(id)),
      );
    },
  );

  it("lists plain IDs when no format is requested", () => {
    const result = cli(["--list"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(originalOrder);
  });

  it.each([
    { args: ["--unknown"], message: /unknown argument/ },
    { args: ["extra"], message: /unknown argument/ },
    { args: ["--shard"], message: /--shard=k\/n/ },
    { args: ["--shard=garbage"], message: /--shard=k\/n/ },
    { args: ["--shard=1/2"], message: /must be 3/ },
    { args: ["--shard=0/3"], message: /between 1 and 3/ },
    { args: ["--shard=4/3"], message: /between 1 and 3/ },
    { args: ["--shard=-1/3"], message: /--shard=k\/n/ },
    { args: ["--shard=1.5/3"], message: /--shard=k\/n/ },
    { args: ["--shard=1/3/3"], message: /--shard=k\/n/ },
    { args: ["--shard=1/3", "--shard=2/3"], message: /duplicate/ },
    { args: ["--list", "--list"], message: /duplicate/ },
    { args: ["--format=json"], message: /requires --list/ },
    { args: ["--list", "--format=yaml"], message: /--format=json/ },
    {
      args: ["--list", "--format=json", "--format=json"],
      message: /duplicate/,
    },
  ])("rejects $args before starting a server", ({ args, message }) => {
    const result = cli(args);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain("ui-smoke-composer:");
    expect(result.stderr).not.toContain("[vite]");
  });
});

function fakeRun(shard?: number, crashId?: string) {
  const pages: (EventEmitter & {
    viewport: { width: number; height: number };
    goto: ReturnType<typeof vi.fn>;
    route: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    setViewportSize: ReturnType<typeof vi.fn>;
  })[] = [];
  const calls: {
    id: string;
    phase?: string;
    page: (typeof pages)[number];
    regression?: string;
  }[] = [];
  const pageErrors: string[] = [];
  const check = vi.fn();
  const run = () =>
    runSmokeScenarios({
      shard,
      harnessBase: "http://127.0.0.1:4100/apps/desktop/src/renderer/harnesses",
      pageUrl:
        "http://127.0.0.1:4100/apps/desktop/src/renderer/harnesses/harness-model-menu.html",
      check,
      pageErrors,
      newPage: async ({ viewport }) => {
        const page = Object.assign(new EventEmitter(), {
          viewport,
          goto: vi.fn(async () => {}),
          route: vi.fn(async () => {}),
          close: vi.fn(async () => {}),
          setViewportSize: vi.fn(async () => {}),
        });
        pages.push(page);
        return page;
      },
      loadModule: async (specifier) => {
        const exports: Record<string, unknown> = {
          cloudComputerV2ReviewRegressions,
        };
        for (const scenario of scenarioRegistry.filter(
          (entry) => entry.module === specifier,
        )) {
          const handlers = scenario.phases
            ? Object.entries(scenario.phases).map(([phase, config]) => [
                phase,
                config.run,
              ])
            : [[undefined, scenario.run]];
          for (const [phase, name] of handlers) {
            exports[name!] = async ({ page, regression }) => {
              calls.push({ id: scenario.id, phase, page, regression });
              if (scenario.id === crashId) throw new Error("scenario crashed");
            };
          }
        }
        return exports;
      },
    });
  return { run, pages, calls, pageErrors, check };
}

describe("UI smoke independent execution", () => {
  it("resolves every registered handler, including all four core phases", async () => {
    for (const scenario of scenarioRegistry) {
      const module = await import(
        new URL(
          scenario.module,
          new URL("../ui-smoke/runner.mjs", import.meta.url),
        ).href
      );
      const names = scenario.phases
        ? Object.values(scenario.phases).map((phase) => phase.run)
        : [scenario.run];
      for (const name of names)
        expect(typeof module[name], scenario.id).toBe("function");
    }
  });

  it("preserves full-run page sharing and every Cloud Computer regression profile", async () => {
    const fixture = fakeRun();
    fixture.check.mockImplementation((name) => {
      if (name === "no uncaught page errors") {
        const mainPage = fixture.calls.find(
          (call) => call.id === "composer-editor",
        )!.page;
        expect(mainPage.close).not.toHaveBeenCalled();
      }
    });
    await fixture.run();
    expect(fixture.check).toHaveBeenCalledWith(
      "no uncaught page errors",
      true,
      "",
    );
    const pageFor = (id: string) =>
      fixture.calls.find((call) => call.id === id)!.page;
    expect(pageFor("code-review")).toBe(pageFor("code-review-retention"));
    expect(pageFor("composer-editor")).toBe(pageFor("design-inline-tools"));
    expect(pageFor("composer-editor")).toBe(pageFor("subscription"));
    expect(pageFor("composer-editor").viewport).toEqual({
      width: 900,
      height: 700,
    });
    expect(pageFor("composer-editor").route).not.toHaveBeenCalled();
    const computer = fixture.calls.filter(
      (call) => call.id === "cloud-computer-v2",
    );
    expect(computer.map((call) => call.regression)).toEqual([
      undefined,
      ...cloudComputerV2ReviewRegressions,
    ]);
    expect(new Set(computer.map((call) => call.page)).size).toBe(
      computer.length,
    );
    for (const page of fixture.pages) expect(page.close).toHaveBeenCalledOnce();
  });

  it.each([1, 2, 3])(
    "isolates shard %i units while preserving core's phase context and fixtures",
    async (shard) => {
      const fixture = fakeRun(shard);
      await fixture.run();
      const steps = fixture.calls.map(({ id, phase }) =>
        phase ? { id, phase } : { id },
      );
      const expectedSteps = selectScenarioSteps(shard).flatMap((step) =>
        step.id === "cloud-computer-v2"
          ? Array(1 + cloudComputerV2ReviewRegressions.length).fill(step)
          : [step],
      );
      expect(steps).toEqual(expectedSteps);
      const owners = new Map<(typeof fixture.pages)[number], string>();
      for (const call of fixture.calls) {
        expect(owners.get(call.page) ?? call.id).toBe(call.id);
        owners.set(call.page, call.id);
        const scenario = scenarioRegistry.find(({ id }) => id === call.id)!;
        expect(call.page.viewport).toEqual(scenario.fixture.viewport);
        if (scenario.fixture.navigation === "origin") {
          expect(call.page.route).toHaveBeenCalledOnce();
          expect(call.page.goto).toHaveBeenCalledWith(
            expect.stringContaining("/ui-smoke-origin.html"),
          );
        }
      }
      const core = fixture.calls.filter((call) => call.id === "core-inline");
      if (core.length) {
        expect(core).toHaveLength(4);
        expect(new Set(core.map((call) => call.page)).size).toBe(1);
        expect(core[0].page.setViewportSize).toHaveBeenCalledWith({
          width: 1440,
          height: 900,
        });
        core[0].page.emit("pageerror", new Error("late page error"));
        expect(fixture.pageErrors).toEqual(["late page error"]);
      }
      for (const page of fixture.pages)
        expect(page.close).toHaveBeenCalledOnce();
    },
  );

  it("closes every retained page when an interleaved design scenario crashes", async () => {
    const fixture = fakeRun(3, "design-inspector-races");
    await expect(fixture.run()).rejects.toThrow("scenario crashed");
    expect(fixture.calls.some((call) => call.id === "core-inline")).toBe(true);
    expect(fixture.calls.some((call) => call.id === "subscription")).toBe(
      false,
    );
    for (const page of fixture.pages) expect(page.close).toHaveBeenCalledOnce();
  });

  it("checks page errors in every shard without duplicating the full-run checkpoint", () => {
    const full = vi.fn();
    const sharded = vi.fn();
    checkPageErrors({ pageErrors: [], check: full });
    for (const shard of [1, 2, 3])
      checkPageErrors({ pageErrors: [], check: sharded, shard });
    expect(sharded.mock.calls).toEqual(full.mock.calls);
    for (const shard of [1, 2, 3]) {
      const failed = vi.fn();
      checkPageErrors({ pageErrors: ["uncaught error"], check: failed, shard });
      expect(failed).toHaveBeenCalledWith(
        "no uncaught page errors",
        false,
        "uncaught error",
      );
    }
  });
});
