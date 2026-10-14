import { mkdir } from "node:fs/promises";
import path from "node:path";
import { watch as watchPaths, type FSWatcher } from "chokidar";
import type { RepoTaskBoundaryFactory } from "../agents/containment/types";
import { repositoryScriptEnv, runContainedInlineScript } from "../git/setup-hooks";
import { opSettingsResolve } from "../settings/ops";
import { ensureLocalSettingsIgnored } from "../settings/personal-repo";
import { DESIGN_STYLE_BUILD_DIRECTORY } from "./style-source-path";

// Live build-command style sources. A Design source of kind "build" names the
// CSS file a command writes. The repository declares the command; the person's
// own settings can override it or disable repository-declared builds.
//
// Builds are live while a Design tab shows the checkout: a `watch` command
// keeps running and rebuilds by itself; a one-shot command runs when Design
// opens and again when its `inputs` change. Leaving Design starts a 5-minute
// idle timer that stops them; returning before then finds them still running.
// Commands run like setup scripts: in the checkout, inside the repository task
// boundary, with the scrubbed environment.

export const DESIGN_STYLE_BUILD_IDLE_MS = 5 * 60_000;
export const DEFAULT_DESIGN_STYLE_BUILD_TIMEOUT_SECONDS = 120;
/** A renderer that stops reporting presence (closed, crashed) has left. */
const PRESENCE_EXPIRY_MS = 90_000;
const RESTART_DELAYS_MS = [1_000, 5_000, 30_000];
const OUTPUT_SETTLE_MS = 50;
const INPUT_SETTLE_MS = 150;
const MAX_ONE_SHOT_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;
const STDERR_LINES = 6;
const MAX_SESSIONS = 64;

export interface DesignStyleBuildSetting {
  output: string;
  command: string;
  timeoutSeconds: number;
  /** The command keeps running and rebuilds by itself. */
  watch: boolean;
  /** Files or folders whose changes re-run a one-shot command. */
  inputs: string[];
}

export interface DesignStyleBuildHost {
  boundaryFactory: RepoTaskBoundaryFactory;
  /** Views of this checkout should refresh. A build output is usually ignored
   * by Git, so no Git change announces it. */
  changed(workspacePath: string): void;
  /** Throws when this checkout may not start repository code now. */
  assertStartAllowed?(workspacePath: string): void;
  /** Null when the checkout is ready; otherwise settles when its workspace
   * setup (usually the dependency install) finishes. */
  whenReady?(workspacePath: string): Promise<void> | null;
  /** Test overrides for the timers below. */
  idleMs?: number;
  presenceExpiryMs?: number;
  restartDelaysMs?: readonly number[];
}

export type DesignStyleBuildState = "waiting" | "starting" | "building" | "live" | "failed" | "stopped";

/** What the theme editor reports for one build. */
export interface DesignStyleBuildStatus {
  command: string;
  watch: boolean;
  inputs: readonly string[];
  state: DesignStyleBuildState;
  /** The last failure, with the last lines the command wrote to stderr. */
  error: string | null;
  /** Duration of the last one-shot run. */
  durationMs: number | null;
}

interface LiveBuild extends DesignStyleBuildStatus {
  setting: DesignStyleBuildSetting;
  identity: string;
  stderr: string[];
  stop: AbortController | null;
  running: Promise<void> | null;
  stopping: Promise<void> | null;
  /** Retained after failed teardown so a later stop can retry the same proof. */
  proveStopped: (() => Promise<void>) | null;
  /** A one-shot input changed during its run. */
  again: boolean;
  restarts: number;
  /** Set when a stopped command's boundary could not be proven stopped. */
  teardownError?: unknown;
  watchers: FSWatcher[];
  timers: Set<ReturnType<typeof setTimeout>>;
}

interface Session {
  root: string;
  present: boolean;
  builds: Map<string, LiveBuild>;
  idle: ReturnType<typeof setTimeout> | null;
  expiry: ReturnType<typeof setTimeout> | null;
  changed: ReturnType<typeof setTimeout> | null;
}

let host: DesignStyleBuildHost | null = null;
const sessions = new Map<string, Session>();

/** The engine supplies its repository task boundary and change broadcast. */
export function configureDesignStyleBuilds(next: DesignStyleBuildHost | null): void {
  host = next;
}

/** The person's own style build entries and whether repository-declared
 * builds may run, from one settings read. */
export interface DesignStyleBuildPreferences {
  personal: ReadonlyMap<string, DesignStyleBuildSetting>;
  repositoryBuilds: boolean;
}

export function readDesignStyleBuildPreferences(workspacePath: string): DesignStyleBuildPreferences {
  let design: { style_builds?: unknown; repository_style_builds?: unknown } | undefined;
  try {
    design = opSettingsResolve(workspacePath).effective.design as typeof design;
  } catch {
    return { personal: new Map(), repositoryBuilds: true };
  }
  const personal = new Map<string, DesignStyleBuildSetting>();
  for (const build of Array.isArray(design?.style_builds) ? (design.style_builds as Array<Record<string, unknown>>) : []) {
    if (typeof build?.output !== "string" || typeof build.command !== "string" || !build.command.trim()) continue;
    if (personal.has(build.output)) continue;
    personal.set(build.output, {
      output: build.output,
      command: build.command.trim(),
      timeoutSeconds: typeof build.timeout_seconds === "number" ? build.timeout_seconds : DEFAULT_DESIGN_STYLE_BUILD_TIMEOUT_SECONDS,
      watch: build.watch === true,
      inputs: Array.isArray(build.inputs) ? build.inputs.filter((input): input is string => typeof input === "string") : [],
    });
  }
  return { personal, repositoryBuilds: design?.repository_style_builds !== false };
}

/** The build this person set up for `output`, from their own settings. */
export function designStyleBuildSetting(workspacePath: string, output: string): DesignStyleBuildSetting | null {
  return readDesignStyleBuildPreferences(workspacePath).personal.get(output) ?? null;
}

export function designStyleBuildStatus(workspacePath: string, output: string): DesignStyleBuildStatus | undefined {
  const build = sessions.get(path.resolve(workspacePath))?.builds.get(output);
  if (!build) return undefined;
  const { command, watch, inputs, state, error, durationMs } = build;
  return { command, watch, inputs, state, error, durationMs };
}

/** Running commands and unproven teardown both keep repository authority. */
export function hasRunningDesignStyleBuilds(): boolean {
  for (const session of sessions.values()) {
    for (const build of session.builds.values()) {
      if (build.running || build.teardownError !== undefined) return true;
    }
  }
  return false;
}

function later(build: LiveBuild, delayMs: number, run: () => void): void {
  const timer = setTimeout(() => {
    build.timers.delete(timer);
    run();
  }, delayMs);
  timer.unref?.();
  build.timers.add(timer);
}

function announce(session: Session): void {
  // Several outputs and status changes in one burst become one refresh.
  if (session.changed) return;
  session.changed = setTimeout(() => {
    session.changed = null;
    host?.changed(session.root);
  }, OUTPUT_SETTLE_MS);
  session.changed.unref?.();
}

function remember(build: LiveBuild, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    build.stderr.push(trimmed.slice(0, 300));
    if (build.stderr.length > STDERR_LINES) build.stderr.shift();
  }
}

function failureText(build: LiveBuild, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const tail = build.stderr.slice(-3).join(" ");
  return `${message}${tail ? `: ${tail}` : ""}`.slice(0, 600);
}

function isLive(session: Session, build: LiveBuild): boolean {
  return sessions.get(session.root) === session && session.builds.get(build.setting.output) === build;
}

/** Run the build's command once, or until stopped for a watch command. */
async function runCommand(session: Session, build: LiveBuild, signal: AbortSignal): Promise<void> {
  if (!host) throw new Error("This engine cannot run builds.");
  const { root } = session;
  const { setting } = build;
  // A new worktree's setup is usually still installing what the build needs.
  const ready = host.whenReady?.(root);
  if (ready) {
    const state = build.state;
    build.state = "waiting";
    announce(session);
    await ready;
    if (signal.aborted) return;
    build.state = state;
  }
  host.assertStartAllowed?.(root);
  if (setting.output.startsWith(`${DESIGN_STYLE_BUILD_DIRECTORY}/`)) {
    // Keep the private build folder out of Git before anything writes there.
    ensureLocalSettingsIgnored(root, ".zeros/design-styles/");
  }
  await mkdir(path.dirname(path.join(root, ...setting.output.split("/"))), { recursive: true });
  const env = await repositoryScriptEnv({ ZEROS_WORKTREE_PATH: root, ZEROS_DESIGN_STYLE_OUTPUT: setting.output });
  const [shell, flag] = process.platform === "win32" ? ["cmd.exe", "/c"] : ["/bin/sh", "-c"];
  const timeoutMs = setting.watch ? MAX_TIMER_MS : setting.timeoutSeconds * 1000;
  const boundaryFactory = host.boundaryFactory;
  await runContainedInlineScript(
    {
      kind: "design-build",
      command: setting.command,
      workspaceId: "",
      worktreePath: root,
      repoRoot: root,
      baseBranch: "",
      boundaryFactory: async (request) => {
        const boundary = await boundaryFactory(request);
        build.proveStopped = () => boundary.stopAndProve();
        return boundary;
      },
      timeoutMs,
    },
    shell!,
    flag!,
    setting.command,
    env,
    {
      timeoutMs,
      // A watcher logs for as long as it runs; only one-shot output is capped.
      maxOutputBytes: setting.watch ? Number.MAX_SAFE_INTEGER : MAX_ONE_SHOT_OUTPUT_BYTES,
      signal,
      onOutput: (text, stream) => {
        if (stream === "stderr") remember(build, text);
      },
    },
  );
}

function launch(session: Session, build: LiveBuild): void {
  if (build.running || build.stopping || build.teardownError !== undefined || !isLive(session, build)) return;
  const stop = new AbortController();
  const started = performance.now();
  build.stop = stop;
  build.state = build.setting.watch ? "starting" : "building";
  build.stderr = [];
  build.running = runCommand(session, build, stop.signal)
    .then(
      () => {
        if (stop.signal.aborted) return;
        if (build.setting.watch) throw new Error("The watch command exited");
        build.state = "live";
        build.error = null;
      },
      (error: unknown) => {
        if ((error as Error | null)?.name === "RepoTaskContainmentTeardownError") build.teardownError = error;
        if (stop.signal.aborted) return;
        throw error;
      },
    )
    .catch((error: unknown) => {
      build.error = failureText(build, error);
      build.state = "failed";
      // A watcher that exits is restarted while Design is in use; a failed
      // one-shot run waits for its next input change or reopening Design.
      // A failed stop proof must never launch a replacement process.
      const delays = host?.restartDelaysMs ?? RESTART_DELAYS_MS;
      if (build.teardownError === undefined && build.setting.watch && build.restarts < delays.length && isLive(session, build)) {
        later(build, delays[build.restarts++]!, () => launch(session, build));
      }
    })
    .finally(() => {
      build.running = null;
      build.stop = null;
      if (!build.setting.watch) build.durationMs = Math.round(performance.now() - started);
      if (build.teardownError === undefined) {
        build.proveStopped = null;
        if (stop.signal.aborted) build.state = "stopped";
      }
      announce(session);
      if (build.again && !stop.signal.aborted && isLive(session, build)) {
        build.again = false;
        launch(session, build);
      }
    });
}

/** Watch the output (and a one-shot build's inputs). Resolves once the output
 * watcher is ready, so a command's first write is never missed; an input
 * folder's initial scan is not awaited. */
async function watchFiles(session: Session, build: LiveBuild): Promise<void> {
  const { root } = session;
  const output = path.join(root, ...build.setting.output.split("/"));
  // The watcher only sees files in folders that exist when it starts.
  await mkdir(path.dirname(output), { recursive: true }).catch(() => undefined);
  const outputWatcher = watchPaths(output, { ignoreInitial: true, persistent: false });
  const ready = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    timer.unref?.();
    outputWatcher.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  outputWatcher.on("all", () => {
    if (build.setting.watch && build.running) {
      build.state = "live";
      build.restarts = 0;
    }
    announce(session);
  });
  outputWatcher.on("error", () => undefined);
  build.watchers.push(outputWatcher);
  if (build.setting.watch || build.setting.inputs.length === 0) return ready;
  let pending = false;
  const inputs = watchPaths(
    build.setting.inputs.map((input) => path.join(root, ...input.split("/"))),
    {
      ignoreInitial: true,
      persistent: false,
      // Never re-run for the build's own output or dependency trees.
      ignored: (candidate: string) =>
        candidate === output || candidate.split(path.sep).some((part) => part === "node_modules" || part === ".git"),
    },
  );
  inputs.on("all", () => {
    if (pending) return;
    pending = true;
    later(build, INPUT_SETTLE_MS, () => {
      pending = false;
      if (build.running) build.again = true;
      else launch(session, build);
    });
  });
  inputs.on("error", () => undefined);
  build.watchers.push(inputs);
  return ready;
}

function stopBuild(build: LiveBuild): Promise<void> {
  if (build.stopping) return build.stopping;
  build.stopping = (async () => {
    for (const timer of build.timers) clearTimeout(timer);
    build.timers.clear();
    build.again = false;
    build.stop?.abort();
    await Promise.all(build.watchers.splice(0).map((watcher) => watcher.close().catch(() => undefined)));
    await build.running;
    if (build.teardownError !== undefined) {
      try {
        if (!build.proveStopped) throw build.teardownError;
        await build.proveStopped();
      } catch (error) {
        build.teardownError = error;
        build.error = failureText(build, error);
        build.state = "failed";
        throw error;
      }
      build.teardownError = undefined;
      build.proveStopped = null;
    }
    build.state = "stopped";
  })().finally(() => { build.stopping = null; });
  return build.stopping;
}

/** Start a new or changed build. Returning to Design also restarts builds
 * the idle timer stopped, and retries a failed command. */
async function startBuild(session: Session, setting: DesignStyleBuildSetting, entering: boolean): Promise<void> {
  const identity = JSON.stringify(setting);
  const current = session.builds.get(setting.output);
  if (current?.identity === identity) {
    if (!entering) return;
    if (current.state === "stopped") {
      current.restarts = 0;
      await watchFiles(session, current);
      launch(session, current);
    } else if (current.state === "failed" && !current.running && current.timers.size === 0) {
      current.restarts = 0;
      launch(session, current);
    }
    return;
  }
  if (current) await stopBuild(current);
  const build: LiveBuild = {
    setting,
    identity,
    command: setting.command,
    watch: setting.watch,
    inputs: setting.inputs,
    state: "starting",
    error: null,
    durationMs: null,
    stderr: [],
    stop: null,
    running: null,
    stopping: null,
    proveStopped: null,
    again: false,
    restarts: 0,
    watchers: [],
    timers: new Set(),
  };
  session.builds.set(setting.output, build);
  await watchFiles(session, build);
  launch(session, build);
}

async function stopSession(session: Session): Promise<void> {
  if (session.idle) clearTimeout(session.idle);
  if (session.expiry) clearTimeout(session.expiry);
  session.idle = session.expiry = null;
  session.present = false;
  await Promise.all([...session.builds.values()].map(stopBuild));
}

function leave(session: Session): void {
  session.present = false;
  if (session.expiry) clearTimeout(session.expiry);
  session.expiry = null;
  if (session.idle) return;
  session.idle = setTimeout(() => {
    session.idle = null;
    // A failed idle stop remains visible and authoritative until a later stop
    // proves it; observe the rejection without discarding the session.
    void stopSession(session).then(() => announce(session), () => announce(session));
  }, host?.idleMs ?? DESIGN_STYLE_BUILD_IDLE_MS);
  session.idle.unref?.();
}

/** A Design tab shows this checkout (`present`), or stopped showing it. The
 * renderer repeats `present` while it stays visible; returning before the idle
 * timer fires finds every build still running. Resolves once builds have been
 * started, without waiting for them to finish. */
export async function setDesignStyleBuildPresence(
  workspacePath: string,
  present: boolean,
  settings: readonly DesignStyleBuildSetting[],
): Promise<void> {
  const root = path.resolve(workspacePath);
  let session = sessions.get(root);
  if (!present) {
    if (session) leave(session);
    return;
  }
  if (!session) {
    session = { root, present: false, builds: new Map(), idle: null, expiry: null, changed: null };
    sessions.set(root, session);
    for (const [key, remembered] of sessions) {
      if (sessions.size <= MAX_SESSIONS) break;
      if (!remembered.present && !remembered.idle && ![...remembered.builds.values()].some((build) => build.running || build.stopping || build.teardownError !== undefined)) {
        sessions.delete(key);
      }
    }
  }
  const owner = session;
  const entering = !owner.present;
  owner.present = true;
  if (owner.idle) clearTimeout(owner.idle);
  owner.idle = null;
  if (owner.expiry) clearTimeout(owner.expiry);
  owner.expiry = setTimeout(() => leave(owner), host?.presenceExpiryMs ?? PRESENCE_EXPIRY_MS);
  owner.expiry.unref?.();
  const wanted = new Set(settings.map((setting) => setting.output));
  await Promise.all([
    ...[...owner.builds.values()]
      .filter((build) => !wanted.has(build.setting.output))
      .map(async (build) => {
        await stopBuild(build);
        owner.builds.delete(build.setting.output);
      }),
    ...settings.map((setting) => startBuild(owner, setting, entering)),
  ]);
}

/** Stop the builds of every checkout `owns` accepts and prove their
 * boundaries stopped, before that workspace is archived or removed. The caller
 * decides ownership, so a separately registered nested workspace is spared. */
export async function stopDesignStyleBuilds(owns: (checkout: string) => boolean): Promise<void> {
  const stopping = [...sessions.values()].filter((session) => owns(session.root));
  await Promise.all(stopping.map(stopSession));
  for (const session of stopping) sessions.delete(session.root);
}

/** Test hooks. `settle` waits for one-shot runs; a watcher never settles. */
export async function settleDesignStyleBuildRunsForTests(): Promise<void> {
  for (;;) {
    const running = [...sessions.values()].flatMap((session) =>
      [...session.builds.values()].filter((build) => !build.setting.watch).map((build) => build.running),
    );
    if (!running.some(Boolean)) return;
    await Promise.all(running);
  }
}
export async function resetDesignStyleBuildsForTests(): Promise<void> {
  await Promise.all([...sessions.values()].map(stopSession));
  sessions.clear();
}
