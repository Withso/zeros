// ──────────────────────────────────────────────────────────
// SetupManager — background setup-script runner
// ──────────────────────────────────────────────────────────
//
// Runs a new worktree's setup command (`scripts.setup`, e.g. `pnpm install`) in
// a worktree-scoped PTY AFTER workspace.create returns — so a slow install no
// longer blocks (or times out) creation. A real PTY (not piped exec) so the
// output is ANSI-colored in the Setup tab; one-shot (`zsh -l -c …`) so the exit
// code tells us pass/fail.
//
// Output is mirrored into a bounded in-memory buffer per workspace; the Setup
// tab reads it via the `workspace.setupInfo` op (delta-appended into a read-only
// xterm) and `setup_state` on the workspace row persists pass/fail across
// reloads. A failed setup is NOT fatal — the worktree stays and the user can
// Rerun from the tab.
//
// The trunk / "main" (the renderer's synthetic `local:<repoSlug>` workspace,
// which has no workspace row) runs through the SAME manager: callers pass an
// explicit SetupTarget (cwd = repo root) and the run's state lives on the
// in-memory entry instead of a row — so main gets the identical status
// language (running / passed / failed / stopped), just without restart
// durability.
// ──────────────────────────────────────────────────────────

import type { PtyService } from "../pty/service";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getWorkspaceById, updateWorkspace, listWorkspaces } from "./state";
import type { SetupState } from "./types";
import { buildSetupCommandEnv } from "./setup-hooks";
import type {
  BoundaryAuthoritySnapshot,
  BoundaryTerritoryContributionSnapshot,
  PreparedBoundary,
  RepoTaskBoundaryFactory,
} from "../agents/containment/types";
import { RetriableBoundaryRetirement } from "../agents/containment/boundary-retirement";

const SETUP_PREFIX = "setup:";
/** Keep at most the last 512 KB of setup output in memory (the tail is what a
 *  user reads after a failed install). Older bytes are dropped with a marker. */
const MAX_LOG_BYTES = 512 * 1024;
const TRUNCATION_MARKER = "\r\n[2m…[earlier setup output truncated]…[0m\r\n";

/** PTY session id for one setup RUN. `gen` makes it unique per run so a
 *  superseded run's late async exit (the one a Rerun just killed) can't clobber
 *  the new run's state. Format: `setup:<gen>:<workspaceId>` — recovered below
 *  as everything after the 2nd colon, so a workspaceId that itself contains
 *  ":" (the trunk's synthetic `local:<repoSlug>`) round-trips intact. */
export function setupSessionId(workspaceId: string, gen: number): string {
  return `${SETUP_PREFIX}${gen}:${workspaceId}`;
}
export function isSetupSession(sessionId: string): boolean {
  return sessionId.startsWith(SETUP_PREFIX);
}
function workspaceIdFromSetupSession(sessionId: string): string {
  // "setup:<gen>:<workspaceId>" → everything after the 2nd colon.
  return sessionId.split(":").slice(2).join(":");
}

export interface SetupInfo {
  state: SetupState | null;
  /** The command of the most recent run, or null if none has run this session. */
  command: string | null;
  /** Accumulated (ANSI) output of the most recent run. Empty when none ran. */
  log: string;
  truncated: boolean;
}

/** Where a ROWLESS setup run executes. A real worktree resolves all of this
 *  from its workspace row; the trunk / "main" — the renderer's synthetic
 *  `local:<repoSlug>` workspace, which has no row — passes it explicitly
 *  (cwd = the repo root itself). */
export interface SetupTarget {
  cwd: string;
  repoRoot: string;
  baseBranch: string;
}

interface SetupEntry {
  workspaceId: string;
  /** The CURRENT run's session id. appendData/handleExit ignore any event whose
   *  session id doesn't match this — that's a superseded (killed) run. */
  sessionId: string;
  command: string;
  log: string;
  truncated: boolean;
  /** In-memory state mirror — the source of truth for ROWLESS targets (the
   *  trunk has no workspace row to persist to). For a real workspace the
   *  durable row wins in info(). */
  state: SetupState | null;
  /** Set by stop() just before killing the PTY so handleExit records the run
   *  as "stopped" instead of "failed" (a killed process exits non-zero). */
  stopRequested: boolean;
  /** Fired once if THIS run ends "passed" — the workspace-create path hangs
   *  the run-on-create actions off it (never set for manual reruns). */
  onPassed?: () => void;
  boundary: PreparedBoundary;
  boundaryFinalized: boolean;
  boundaryTeardown?: Promise<void>;
}

interface BoundaryTeardownRecord {
  readonly retirement: RetriableBoundaryRetirement;
  readonly workspaceId: string;
  readonly territoryContributions:
    | readonly BoundaryTerritoryContributionSnapshot[]
    | undefined;
}

const missingRepoTaskBoundary: RepoTaskBoundaryFactory = async () => {
  throw new Error(
    "repository setup refused: no Zeros Sandbox Runtime boundary is configured",
  );
};

export class SetupManager {
  /** workspaceId → the CURRENT run's buffer + session id. */
  private readonly entries = new Map<string, SetupEntry>();
  /** Starts whose login-shell environment is still resolving. They have no
   *  PTY or entry yet, so stop()/archive needs this separate cancellation
   *  handle to prevent a setup shell from appearing after shutdown. */
  private readonly starting = new Map<
    string,
    { cancelled: boolean; authority?: BoundaryAuthoritySnapshot }
  >();
  /** Monotonic run counter → a unique session id per run (rerun-race guard). */
  private gen = 0;
  /** Failed teardown proof survives reruns until a background retry proves it,
   * so archive/delete cannot mistake a superseded entry for safe removal. */
  private readonly boundaryTeardowns = new Map<
    string,
    Set<BoundaryTeardownRecord>
  >();

  constructor(
    private readonly pty: PtyService,
    /** Nudge clients (DB_CHANGED) that a workspace's setup_state changed. */
    private readonly onChange: (workspaceId: string | null) => void,
    /** Injectable because resolving the login-shell PATH is asynchronous; the
     *  cancellation seam must be deterministic in unit tests. */
    private readonly envBuilder: typeof buildSetupCommandEnv = buildSetupCommandEnv,
    private readonly boundaryFactory: RepoTaskBoundaryFactory = missingRepoTaskBoundary,
  ) {}

  private beginBoundaryRevocation(entry: SetupEntry): void {
    void entry.boundary.revoke().catch((error) => {
      console.error("[setup] failed to revoke repo-task capabilities:", error);
    });
  }

  private finalizeBoundary(entry: SetupEntry): Promise<void> {
    if (entry.boundaryTeardown) return entry.boundaryTeardown;
    entry.boundaryFinalized = true;
    const promise = this.trackBoundaryTeardown(
      entry.boundary,
      entry.workspaceId,
    );
    entry.boundaryTeardown = promise;
    return promise;
  }

  /** Track teardown even when cancellation lands after boundary admission but
   * before a SetupEntry exists. The durable process-domain proof must remain a
   * lifecycle barrier if that detached teardown fails. */
  private trackBoundaryTeardown(
    boundary: PreparedBoundary,
    workspaceId: string,
  ): Promise<void> {
    const records =
      this.boundaryTeardowns.get(workspaceId) ??
      new Set<BoundaryTeardownRecord>();
    const retirement = new RetriableBoundaryRetirement(boundary, {
      onFailure: (error, attempt) => {
        console.error(
          `[setup] repo-task boundary teardown attempt ${attempt} failed; retrying automatically:`,
          error,
        );
      },
      onProven: (recovered) => {
        records.delete(record);
        if (records.size === 0) this.boundaryTeardowns.delete(workspaceId);
        if (recovered) {
          console.log("[setup] repo-task boundary teardown proof recovered");
        }
      },
    });
    const record = {
      retirement,
      workspaceId,
      territoryContributions: boundary.territoryContributions,
    } satisfies BoundaryTeardownRecord;
    records.add(record);
    this.boundaryTeardowns.set(workspaceId, records);
    return retirement.start();
  }

  /** Lifecycle barrier used after PTY exit and before checkout removal. */
  async proveWorkspaceBoundaryStopped(workspaceId: string): Promise<void> {
    const entry = this.entries.get(workspaceId);
    if (entry) void this.finalizeBoundary(entry);
    const records = [...(this.boundaryTeardowns.get(workspaceId) ?? [])];
    const results = await Promise.allSettled(
      records.map((record) => record.retirement.promise),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "repository setup containment teardown was not proven. Automatic recovery is still retrying; removing the workspace or changing its Design territory remains blocked until proof succeeds.",
      );
    }
  }

  /** Revoke every repository-controlled setup boundary before the app-wide
   * Design-owner map changes. Human terminals are deliberately unrelated; a
   * setup script is code authority and must not retain an older deny union. */
  async stopAllAndProve(): Promise<void> {
    const workspaceIds = new Set([
      ...this.starting.keys(),
      ...this.entries.keys(),
      // A superseded entry is removed before its replacement builds the env.
      // If that replacement aborts, this ledger is the only remaining handle
      // to an older teardown whose process-domain proof may have failed.
      ...this.boundaryTeardowns.keys(),
    ]);
    for (const workspaceId of workspaceIds) this.stop(workspaceId);
    const results = await Promise.allSettled(
      [...workspaceIds].map((workspaceId) =>
        this.proveWorkspaceBoundaryStopped(workspaceId),
      ),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "repository setup boundaries were not all proven stopped. Automatic recovery is still retrying; registered Design territory changes remain blocked until proof succeeds.",
      );
    }
  }

  /** Retire only setup boundaries whose immutable authority includes one
   * managed workspace. A sibling workspace's Design pointer is not part of
   * this boundary unless the setup owns that workspace or explicitly carries
   * its contribution. The engine calls this before and after draining matching
   * admissions, so both already-published and late-published boundaries are
   * stopped without touching unrelated starts. */
  async stopForWorkspaceTerritoryAndProve(
    workspaceId: string,
    workspaceRoot: string,
  ): Promise<void> {
    const normalizedWorkspace = path.resolve(workspaceRoot);
    const includesWorkspace = (
      owner: string,
      contributions:
        | readonly BoundaryTerritoryContributionSnapshot[]
        | undefined,
    ): boolean =>
      owner === workspaceId ||
      contributions?.some(
        (contribution) =>
          path.resolve(contribution.workspaceRoot) === normalizedWorkspace,
      ) === true;

    const workspaceIds = new Set<string>();
    for (const [owner, flight] of this.starting) {
      if (includesWorkspace(owner, flight.authority?.territoryContributions)) {
        workspaceIds.add(owner);
      }
    }
    for (const entry of this.entries.values()) {
      if (
        includesWorkspace(
          entry.workspaceId,
          entry.boundary.territoryContributions,
        )
      ) {
        workspaceIds.add(entry.workspaceId);
      }
    }
    for (const owner of workspaceIds) this.stop(owner);

    const records = [...this.boundaryTeardowns.values()]
      .flatMap((entries) => [...entries])
      .filter((record) =>
        includesWorkspace(record.workspaceId, record.territoryContributions),
      );
    const results = await Promise.allSettled(
      records.map((record) => record.retirement.promise),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "repository setup boundaries for this Design territory were not proven stopped. Automatic recovery is still retrying; this territory change remains blocked until proof succeeds.",
      );
    }
  }

  /** Whether a live or admitting setup task was compiled from a different
   * app-wide Design subtraction. An in-flight admission has not published its
   * identity yet, so a concurrent external territory event is conservatively
   * treated as changed and the global start drain resolves the race. */
  registeredDesignAuthorityChanged(identity: string | null): boolean {
    if (this.boundaryTeardowns.size > 0) return true;
    for (const flight of this.starting.values()) {
      if (
        flight.authority &&
        flight.authority.registeredDesignAuthorityIdentity !== identity
      ) {
        return true;
      }
    }
    for (const entry of this.entries.values()) {
      if (entry.state !== "running" || entry.boundaryFinalized) continue;
      if (
        !entry.boundary ||
        entry.boundary.registeredDesignAuthorityIdentity !== identity
      ) {
        return true;
      }
    }
    return false;
  }

  workspaceTerritoryChanged(
    workspaceRoot: string,
    territoryIdentity: string | null,
  ): boolean {
    const normalizedWorkspace = path.resolve(workspaceRoot);
    const changed = (snapshot: BoundaryAuthoritySnapshot): boolean =>
      snapshot.territoryContributions.some(
        (contribution) =>
          path.resolve(contribution.workspaceRoot) === normalizedWorkspace &&
          contribution.identity !== territoryIdentity,
      );
    for (const flight of this.starting.values()) {
      if (flight.authority && changed(flight.authority)) return true;
    }
    for (const entry of this.entries.values()) {
      if (entry.state !== "running" || entry.boundaryFinalized) continue;
      const contributions = entry.boundary.territoryContributions;
      if (
        !contributions ||
        changed({
          registeredDesignAuthorityIdentity:
            entry.boundary.registeredDesignAuthorityIdentity ?? null,
          territoryContributions: contributions,
        })
      ) {
        return true;
      }
    }
    return false;
  }

  hasRepositoryCodeAuthority(): boolean {
    return (
      this.starting.size > 0 ||
      this.boundaryTeardowns.size > 0 ||
      [...this.entries.values()].some(
        (entry) => entry.state === "running" && !entry.boundaryFinalized,
      )
    );
  }

  /** On engine start the in-memory buffers are empty, so any workspace row still
   *  marked "running" is an orphan from a previous process (the engine was quit
   *  mid-install). Mark it "stopped" so the Setup tab explains the interrupted
   *  run instead of spinning forever — the user can Rerun. Best-effort. */
  reconcileStaleRuns(): void {
    try {
      for (const ws of listWorkspaces({})) {
        if (ws.setupState === "running") {
          updateWorkspace(ws.id, { setupState: "stopped" });
        }
      }
    } catch {
      /* state db unavailable — nothing to reconcile */
    }
  }

  /** Record a run's state: mirrored on the in-memory entry (the only home a
   *  ROWLESS trunk run has) and persisted on the workspace row when one exists.
   *  Nudges clients either way — the trunk's state changes matter to the Setup
   *  tab too, and DB_CHANGED is the tab's refresh signal. */
  private setState(id: string, state: SetupState): void {
    const entry = this.entries.get(id);
    if (entry) entry.state = state;
    const workspace = getWorkspaceById(id);
    if (workspace) updateWorkspace(id, { setupState: state });
    this.onChange(workspace ? id : null);
  }

  /** (Re)start setup. Kills any in-flight setup PTY, resets the buffer under a
   *  NEW unique session id, marks the run "running", and spawns the one-shot
   *  setup PTY. The engine's pty.onData/onExit feed appendData/handleExit
   *  (which ignore a superseded run's events). A real workspace resolves its
   *  cwd/repo from the row; a ROWLESS caller (the trunk / "main") must pass
   *  `target` — with neither, this is a no-op (workspace vanished between
   *  create and setup). */
  async start(args: {
    workspaceId: string;
    command: string;
    target?: SetupTarget;
    /** Called once if this run PASSES (see SetupEntry.onPassed). */
    onPassed?: () => void;
  }): Promise<void> {
    const ws = getWorkspaceById(args.workspaceId);
    if (!ws && !args.target) return;
    const cwd = ws?.path ?? args.target!.cwd;
    const repoRoot = ws?.repoRoot ?? args.target!.repoRoot;
    const baseBranch = ws?.baseBranch ?? args.target!.baseBranch;
    // A newer rerun supersedes a start that has not spawned yet. Its finally
    // block checks identity, so it cannot retire this replacement's slot.
    const priorFlight = this.starting.get(args.workspaceId);
    if (priorFlight) priorFlight.cancelled = true;
    const flight: {
      cancelled: boolean;
      authority?: BoundaryAuthoritySnapshot;
    } = { cancelled: false };
    this.starting.set(args.workspaceId, flight);
    // Orphan the previous run BEFORE killing it, then kill.
    //
    // The ordering is the whole point. appendData/handleExit ignore an exit whose
    // session id no longer matches the workspace's entry — that is the only guard
    // against a superseded run mislabelling this one — and the env build below
    // AWAITS, so leaving the old entry in place across that await left it
    // matching its own id when the kill's exit landed. node-pty reports a kill()
    // as `exitCode 0, signal 1`, and handleExit read exitCode 0 as "passed": the
    // killed install scored a PASS and fired `onPassed`, which is what starts the
    // workspace's `run_on_create` actions — a dev server booted against a
    // half-deleted node_modules. Dropping the entry first makes the dying PTY
    // unambiguously an orphan. Nothing is lost: the new entry replaces its log
    // and state either way.
    const prev = this.entries.get(args.workspaceId);
    if (prev) {
      this.entries.delete(args.workspaceId);
      this.beginBoundaryRevocation(prev);
      if (this.pty.has(prev.sessionId)) this.pty.kill(prev.sessionId);
      void this.finalizeBoundary(prev);
    }
    // Resolve the env BEFORE publishing "running". It awaits the login-shell
    // PATH probe (up to 3s cold), and with the entry already registered a Stop
    // in that window found no live PTY to kill: it flipped the row to "stopped"
    // and returned, then create() spawned the install anyway — an unkillable
    // script running in a worktree the UI says is idle.
    try {
      const env = await this.envBuilder({
        workspaceId: args.workspaceId,
        worktreePath: cwd,
        repoRoot,
        baseBranch,
      });
      // Stop/archive can land while the login-shell PATH probe is awaiting.
      // The request has already been acknowledged, but no child may spawn now.
      if (flight.cancelled) return;
      const boundary = await this.boundaryFactory({
        executionId: `repo-setup-${randomUUID()}`,
        cwd,
        workspaceRoot: cwd,
        repoRoot,
        env,
        onAuthorityResolved: (authority) => {
          if (!flight.cancelled) flight.authority = authority;
        },
      });
      if (flight.cancelled) {
        await this.trackBoundaryTeardown(boundary, args.workspaceId);
        return;
      }
      const sessionId = setupSessionId(args.workspaceId, ++this.gen);
      this.entries.set(args.workspaceId, {
        workspaceId: args.workspaceId,
        sessionId,
        command: args.command,
        log: "",
        truncated: false,
        state: "running",
        stopRequested: false,
        onPassed: args.onPassed,
        boundary,
        boundaryFinalized: false,
      });
      this.setState(args.workspaceId, "running");
      try {
        this.pty.create({
          sessionId,
          resolvedCwd: cwd,
          command: args.command,
          env,
          cols: 120,
          rows: 30,
          scrubEnv: false, // env is supplied verbatim (already scrubbed)
          wrapSpawn: (request) => {
            const launch = boundary.wrapSpawn(request);
            if (launch.stdio !== "inherit") {
              throw new Error("setup boundary did not preserve PTY stdio");
            }
            return { ...launch, stdio: "inherit" as const };
          },
          onSpawned: (pid, leaderExited) => {
            boundary.trackProcessGroup(pid, { leaderExited });
          },
        });
      } catch (error) {
        this.setState(args.workspaceId, "failed");
        const entry = this.entries.get(args.workspaceId)!;
        this.beginBoundaryRevocation(entry);
        try {
          await this.finalizeBoundary(entry);
        } catch (teardownError) {
          throw new AggregateError(
            [error, teardownError],
            "setup spawn failed and containment teardown was not proven",
          );
        }
        throw error;
      }
    } finally {
      if (this.starting.get(args.workspaceId) === flight) {
        this.starting.delete(args.workspaceId);
      }
    }
  }

  /** Cancel a start that has NOT spawned yet, without touching a live PTY.
   *  Retires the slot so an immediate rerun isn't blocked by a flight that is
   *  only going to abort; the aborting start's `finally` checks identity, so
   *  handing the slot over here is safe. Returns true when one was retired.
   *
   *  Separate from stop() because the archive/delete reaper must cancel these
   *  BEFORE it enumerates processes — a pre-spawn flight owns no PTY to
   *  enumerate, and its login-shell probe would otherwise spend the lifecycle
   *  drain deadline on a child that must never exist. Killing live PTYs that
   *  early would be actively wrong: PtyService.kill() drops the session
   *  synchronously and waitForExit() resolves true for an unknown one, so a
   *  setup PTY killed before enumeration is invisible to the reaper's exit
   *  wait and the worktree could be removed while the install still runs. */
  cancelPendingStart(workspaceId: string): boolean {
    const flight = this.starting.get(workspaceId);
    if (!flight) return false;
    flight.cancelled = true;
    this.starting.delete(workspaceId);
    return true;
  }

  /** Stop a live run without treating it as a failure. Flags the entry so the
   *  PTY's kill-exit records "stopped" (not "failed"), flips the state now for
   *  a snappy UI, and kills the PTY. With no live PTY (the run already ended,
   *  or the engine restarted mid-run) it just clears a stale "running" marker. */
  stop(workspaceId: string): void {
    // A pre-spawn flight never published "running" itself, so a user-driven
    // Stop publishes the stopped state on its behalf.
    if (this.cancelPendingStart(workspaceId)) {
      this.setState(workspaceId, "stopped");
    }
    const entry = this.entries.get(workspaceId);
    if (entry && this.pty.has(entry.sessionId)) {
      entry.stopRequested = true;
      this.setState(workspaceId, "stopped");
      this.beginBoundaryRevocation(entry);
      this.pty.kill(entry.sessionId);
      void this.finalizeBoundary(entry);
      return;
    }
    const rowState = getWorkspaceById(workspaceId)?.setupState ?? entry?.state;
    if (rowState === "running") {
      this.setState(workspaceId, "stopped");
      if (entry) {
        this.beginBoundaryRevocation(entry);
        void this.finalizeBoundary(entry);
      }
    }
  }

  /** Append a chunk of the CURRENT setup PTY's output (ignores non-setup AND
   *  superseded-run sessions). */
  appendData(sessionId: string, data: string): void {
    if (!isSetupSession(sessionId)) return;
    const entry = this.entries.get(workspaceIdFromSetupSession(sessionId));
    if (!entry || entry.sessionId !== sessionId) return; // superseded — ignore
    entry.log += data;
    if (entry.log.length > MAX_LOG_BYTES) {
      entry.log =
        TRUNCATION_MARKER + entry.log.slice(entry.log.length - MAX_LOG_BYTES);
      entry.truncated = true;
    }
  }

  /** Flip the run's state on the CURRENT setup PTY's exit. A superseded run's
   *  exit (e.g. the one a Rerun just killed) no longer matches the workspace's
   *  entry session id, so it's ignored and can't mislabel the new run. A
   *  stop()-killed run records "stopped", not "failed".
   *
   *  `signal` is load-bearing, not decoration: node-pty reports a killed PTY as
   *  `exitCode 0, signal N`, so reading the code alone scored ANY killed install
   *  as "passed" — and "passed" is what fires `onPassed`, i.e. what starts the
   *  workspace's `run_on_create` actions. An OOM-killed `pnpm install` would hand
   *  a dev server a half-written node_modules and call it success. */
  handleExit(
    sessionId: string,
    exitCode: number | null,
    signal?: number | null,
  ): void {
    if (!isSetupSession(sessionId)) return;
    const workspaceId = workspaceIdFromSetupSession(sessionId);
    const entry = this.entries.get(workspaceId);
    if (!entry || entry.sessionId !== sessionId) return; // superseded — ignore
    const killed = typeof signal === "number" && signal > 0;
    const state: SetupState = entry.stopRequested
      ? "stopped"
      : exitCode === 0 && !killed
        ? "passed"
        : "failed";
    this.setState(workspaceId, state);
    void this.finalizeBoundary(entry);
    if (state === "passed" && entry.onPassed) {
      const cb = entry.onPassed;
      entry.onPassed = undefined; // fire once
      try {
        cb();
      } catch {
        /* a run-on-create failure must never mislabel the setup run */
      }
    }
  }

  /** Snapshot for the Setup tab. `state` prefers the durable row (a real
   *  workspace) and falls back to the in-memory entry (a rowless trunk run);
   *  `log`/`command` come from the in-memory buffer either way (empty after an
   *  engine restart — the user can Rerun to repopulate). */
  info(workspaceId: string): SetupInfo {
    const ws = getWorkspaceById(workspaceId);
    const entry = this.entries.get(workspaceId);
    return {
      state: ws ? (ws.setupState ?? null) : (entry?.state ?? null),
      command: entry?.command ?? null,
      log: entry?.log ?? "",
      truncated: entry?.truncated ?? false,
    };
  }
}
