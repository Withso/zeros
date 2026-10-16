import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRepoTaskBoundaryFactory } from "../../agents/containment/repo-task-boundary";
import { testExecutionBoundary } from "../../agents/__tests__/helpers/test-execution-boundary";
import type { CanvasDocument } from "../document-model";
import {
  configureDesignStyleBuilds,
  designStyleBuildSetting,
  designStyleInputChanged,
  refreshDesignStyleBuilds,
  hasRunningDesignStyleBuilds,
  resetDesignStyleBuildsForTests,
  setDesignStyleBuildPresence,
  settleDesignStyleBuildRunsForTests,
  stopDesignStyleBuilds,
  type DesignStyleBuildHost,
} from "../style-builds";
import {
  designStyleBuildSettings,
  frameStyleSources,
  resolveDesignStyleSource,
  type DesignStyleSourceDeclaration,
} from "../style-sources";

// A one-shot build: counts its runs and writes the output.
const ONE_SHOT = `const fs = require("node:fs");
fs.appendFileSync("runs.log", "run\\n");
fs.mkdirSync(require("node:path").dirname(process.env.ZEROS_DESIGN_STYLE_OUTPUT), { recursive: true });
fs.writeFileSync(process.env.ZEROS_DESIGN_STYLE_OUTPUT, ":root { --runs: " + fs.readFileSync("runs.log", "utf8").trim().split("\\n").length + "; }");
`;
// A watch build: counts its starts, then rewrites the output from src/app.css.
const WATCH = `const fs = require("node:fs");
fs.appendFileSync("starts.log", "start\\n");
const write = () => fs.writeFileSync(process.env.ZEROS_DESIGN_STYLE_OUTPUT, fs.readFileSync("src/app.css", "utf8"));
write();
fs.watch("src", () => { try { write(); } catch {} });
setInterval(() => {}, 1 << 30);
`;

describe("live build-command style sources", () => {
  let root: string;
  let settings: string;
  let previousSettings: string | undefined;
  const changed = vi.fn();
  const output = ".zeros/design-styles/app.css";
  const declaration: DesignStyleSourceDeclaration = { id: "app", title: "App", kind: "build", path: output, themes: {}, command: "node build.cjs" };
  const canvas = { version: 3, frames: {}, frame_info: {}, styles: [{ ...declaration }] } as unknown as CanvasDocument;
  const lines = (file: string) =>
    existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), "utf8").trim().split("\n").length : 0;
  const setUp = (entry: string) =>
    writeFileSync(path.join(settings, "settings.toml"), `[[design.style_builds]]\noutput = ${JSON.stringify(output)}\n${entry}\n`);
  const open = () => setDesignStyleBuildPresence(root, true, designStyleBuildSettings(root, canvas));
  const leave = () => setDesignStyleBuildPresence(root, false, []);
  const status = () => resolveDesignStyleSource(root, declaration);
  const configure = (overrides: Partial<DesignStyleBuildHost> = {}) =>
    configureDesignStyleBuilds({
      boundaryFactory: createRepoTaskBoundaryFactory({ ...testExecutionBoundary(), backend: "none" }),
      changed,
      idleMs: 200,
      ...overrides,
    });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "zeros-style-build-"));
    settings = mkdtempSync(path.join(tmpdir(), "zeros-style-build-settings-"));
    previousSettings = process.env.ZEROS_USER_SETTINGS_DIR;
    process.env.ZEROS_USER_SETTINGS_DIR = settings;
    writeFileSync(path.join(root, "build.cjs"), ONE_SHOT);
    writeFileSync(path.join(root, "watch.cjs"), WATCH);
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/app.css"), ":root { --gap: 1px; }");
    changed.mockReset();
    configure();
  });
  afterEach(async () => {
    await resetDesignStyleBuildsForTests();
    configureDesignStyleBuilds(null);
    if (previousSettings === undefined) delete process.env.ZEROS_USER_SETTINGS_DIR;
    else process.env.ZEROS_USER_SETTINGS_DIR = previousSettings;
    rmSync(root, { recursive: true, force: true });
    rmSync(settings, { recursive: true, force: true });
  });

  it("never builds from a status read, and says how to set a build up", async () => {
    const bare = { ...declaration, command: undefined };
    const unset = await resolveDesignStyleSource(root, bare);
    expect(unset).toMatchObject({ kind: "build", status: "error", css: null });
    expect(unset.messages[0]!.text).toBe(
      '.zeros/design-styles/app.css does not exist yet. To build it, ask your agent to sync styles, or add the build "command" to this source in meta/canvas.json.',
    );
    expect((await status()).messages[0]).toEqual({ level: "warning", text: "Builds .zeros/design-styles/app.css when you open Design." });
    expect(await frameStyleSources(root, canvas, "page/home.html")).toEqual([]);
    expect(lines("runs.log")).toBe(0);
  });

  it("builds the command the repository declares, with nothing set up on this machine", async () => {
    await open();
    await settleDesignStyleBuildRunsForTests();
    expect(lines("runs.log")).toBe(1);
    expect((await status()).messages[0]!.text).toMatch(/^Built with "node build\.cjs" in \d+\.\d s when Design opened \(from meta\/canvas\.json\)\.$/);
  });

  it("prefers the person's own command, and their opt-out stops only repository builds", async () => {
    writeFileSync(path.join(root, "mine.cjs"), ONE_SHOT.replaceAll("runs.log", "mine.log"));
    setUp('command = "node mine.cjs"');
    await open();
    await settleDesignStyleBuildRunsForTests();
    expect([lines("runs.log"), lines("mine.log")]).toEqual([0, 1]);
    await resetDesignStyleBuildsForTests();
    writeFileSync(path.join(settings, "settings.toml"), "[design]\nrepository_style_builds = false\n");
    rmSync(path.join(root, output));
    await open();
    await settleDesignStyleBuildRunsForTests();
    expect(lines("runs.log")).toBe(0);
    expect((await status()).messages[0]!.text).toMatch(/^\.zeros\/design-styles\/app\.css does not exist yet\. Repository style builds are off in your settings/);
  });

  it("waits for the workspace setup to finish before building", async () => {
    let finish!: () => void;
    const setup = new Promise<void>((resolve) => {
      finish = resolve;
    });
    configure({ whenReady: () => setup });
    await open();
    await vi.waitFor(async () => expect((await status()).messages[0]!.text).toBe("Waiting for the workspace setup to finish before building."));
    expect(lines("runs.log")).toBe(0);
    finish();
    await vi.waitFor(() => expect(lines("runs.log")).toBe(1), { timeout: 5_000 });
  });

  it("runs a one-shot build when Design opens, and again when its inputs change", async () => {
    setUp('command = "node build.cjs"\ninputs = ["src"]');
    await open();
    await settleDesignStyleBuildRunsForTests();
    expect(lines("runs.log")).toBe(1);
    const built = await status();
    expect(built).toMatchObject({ status: "ready", css: expect.stringContaining("--runs: 1") });
    expect(built.messages[0]!.text).toBe('Live: Zeros runs "node build.cjs" when src change, while Design is open (from your settings).');
    await open();
    expect(lines("runs.log")).toBe(1);
    // The engine's worktree watcher reports content changes; the build has no
    // watcher of its own. Its own output and unrelated files never re-run it.
    designStyleInputChanged(root, path.join(root, output));
    designStyleInputChanged(root, path.join(root, "README.md"));
    designStyleInputChanged(path.join(root, "elsewhere"), path.join(root, "src/app.css"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lines("runs.log")).toBe(1);
    writeFileSync(path.join(root, "src/app.css"), ":root { --gap: 2px; }");
    designStyleInputChanged(root, path.join(root, "src/app.css"));
    designStyleInputChanged(root, path.join(root, "src/app.css"));
    await vi.waitFor(() => expect(lines("runs.log")).toBe(2), { timeout: 5_000 });
    await settleDesignStyleBuildRunsForTests();
    expect((await frameStyleSources(root, canvas, "page/home.html"))[0]!.css).toContain("--runs: 2");
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(path.resolve(root)));
  });

  it("runs every one-shot build again when the person presses Update", async () => {
    setUp('command = "node build.cjs"\ninputs = ["src"]');
    await open();
    await settleDesignStyleBuildRunsForTests();
    expect(lines("runs.log")).toBe(1);
    await refreshDesignStyleBuilds(root, designStyleBuildSettings(root, canvas));
    await vi.waitFor(() => expect(lines("runs.log")).toBe(2), { timeout: 5_000 });
    await settleDesignStyleBuildRunsForTests();
    expect((await frameStyleSources(root, canvas, "page/home.html"))[0]!.css).toContain("--runs: 2");
  });

  it("stops re-running on input changes once the idle time after leaving Design passes", async () => {
    // Long enough for a settled input change and a process start.
    configure({ idleMs: 1_500 });
    setUp('command = "node build.cjs"\ninputs = ["src"]');
    await open();
    await settleDesignStyleBuildRunsForTests();
    await leave();
    // Within the idle time a build is still live.
    designStyleInputChanged(root, path.join(root, "src/app.css"));
    await vi.waitFor(() => expect(lines("runs.log")).toBe(2), { timeout: 5_000 });
    await vi.waitFor(async () => expect((await status()).messages[0]!.text).toBe("Paused until you open Design."), { timeout: 5_000 });
    designStyleInputChanged(root, path.join(root, "src/app.css"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(lines("runs.log")).toBe(2);
  });

  it("refreshes the canvas after a one-shot run only when the run changed something", async () => {
    writeFileSync(path.join(root, "same.cjs"), `const fs = require("node:fs");
fs.appendFileSync("runs.log", "run\\n");
const out = process.env.ZEROS_DESIGN_STYLE_OUTPUT;
fs.mkdirSync(require("node:path").dirname(out), { recursive: true });
const css = ":root { --same: 1; }";
if (!fs.existsSync(out) || fs.readFileSync(out, "utf8") !== css) fs.writeFileSync(out, css);
`);
    setUp('command = "node same.cjs"\ninputs = ["src"]');
    await open();
    await settleDesignStyleBuildRunsForTests();
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 150));
    changed.mockReset();
    designStyleInputChanged(root, path.join(root, "src/app.css"));
    await vi.waitFor(() => expect(lines("runs.log")).toBe(2), { timeout: 5_000 });
    await settleDesignStyleBuildRunsForTests();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps a watch build running while Design is open, and stops it after the idle time", async () => {
    setUp('command = "node watch.cjs"\nwatch = true');
    await open();
    await vi.waitFor(
      async () => expect((await status()).messages[0]!.text).toBe('Live: Zeros keeps "node watch.cjs" running while Design is open (from your settings).'),
      { timeout: 5_000 },
    );
    writeFileSync(path.join(root, "src/app.css"), ":root { --gap: 7px; }");
    await vi.waitFor(async () => expect((await status()).css).toContain("--gap: 7px"), { timeout: 5_000 });
    expect(hasRunningDesignStyleBuilds()).toBe(true);
    await leave();
    await vi.waitFor(() => expect(hasRunningDesignStyleBuilds()).toBe(false), { timeout: 5_000 });
    expect((await status()).messages[0]).toEqual({ level: "info", text: "Paused until you open Design." });
    expect(lines("starts.log")).toBe(1);
  });

  it("finds a watch build still running when Design reopens before the idle stop", async () => {
    configure({ idleMs: 60_000 });
    setUp('command = "node watch.cjs"\nwatch = true');
    await open();
    await vi.waitFor(() => expect(lines("starts.log")).toBe(1), { timeout: 5_000 });
    await leave();
    await open();
    await open();
    expect(hasRunningDesignStyleBuilds()).toBe(true);
    expect(lines("starts.log")).toBe(1);
  });

  it("restarts a watch command that exits, then waits for Design to reopen", async () => {
    configure({ restartDelaysMs: [20, 20] });
    writeFileSync(path.join(root, "crash.cjs"), 'require("node:fs").appendFileSync("starts.log", "x\\n"); process.exit(2);');
    setUp('command = "node crash.cjs"\nwatch = true');
    await open();
    await vi.waitFor(() => expect(lines("starts.log")).toBe(3), { timeout: 5_000 });
    await vi.waitFor(
      async () => expect((await status()).messages[0]!.text).toMatch(/^The build failed: repository script exited 2\./),
      { timeout: 5_000 },
    );
    await open();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lines("starts.log")).toBe(3);
    await leave();
    await open();
    await vi.waitFor(() => expect(lines("starts.log")).toBe(6), { timeout: 5_000 });
  });

  it("stops the builds of an archived workspace and spares other owners", async () => {
    configure({ idleMs: 60_000 });
    setUp('command = "node watch.cjs"\nwatch = true');
    await open();
    await vi.waitFor(() => expect(lines("starts.log")).toBe(1), { timeout: 5_000 });
    await stopDesignStyleBuilds((checkout) => checkout !== path.resolve(root));
    expect(hasRunningDesignStyleBuilds()).toBe(true);
    await stopDesignStyleBuilds((checkout) => checkout === path.resolve(root));
    expect(hasRunningDesignStyleBuilds()).toBe(false);
  });

  it("treats a renderer that stops reporting presence as having left", async () => {
    // Let the real process start before shortening the next heartbeat's lease;
    // a 50 ms initial lease can expire during shell startup on a busy runner.
    configure({ idleMs: 20, presenceExpiryMs: 60_000 });
    setUp('command = "node watch.cjs"\nwatch = true');
    await open();
    await vi.waitFor(() => expect(lines("starts.log")).toBe(1), { timeout: 5_000 });
    configure({ idleMs: 20, presenceExpiryMs: 50 });
    await open();
    await vi.waitFor(() => expect(hasRunningDesignStyleBuilds()).toBe(false), { timeout: 5_000 });
  });

  it("keeps the private build folder out of Git", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    setUp('command = "node build.cjs"');
    await open();
    await settleDesignStyleBuildRunsForTests();
    expect(existsSync(path.join(root, output))).toBe(true);
    const untracked = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
    expect(untracked).not.toContain(".zeros/");
    expect(execFileSync("git", ["check-ignore", output], { cwd: root, encoding: "utf8" }).trim()).toBe(output);
  });

  it("reads the setting the agent wrote, including watch and inputs", () => {
    setUp('command = "node build.cjs"\ninputs = ["src", "tokens.json"]');
    expect(designStyleBuildSetting(root, output)).toEqual({
      output,
      command: "node build.cjs",
      timeoutSeconds: 120,
      watch: false,
      inputs: ["src", "tokens.json"],
    });
  });
});
