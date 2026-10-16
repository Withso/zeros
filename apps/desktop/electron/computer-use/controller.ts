// ──────────────────────────────────────────────────────────
// Zeros computer use: who may control the Mac, and how
// ──────────────────────────────────────────────────────────
//
// One chat controls the Mac at a time. Its lease owns one trusted driver
// session, labelled with the agent's name, and ends on turn end, Stop, Esc, a
// driver failure or a denied approval. Other chats wait in order, and Codex's
// built-in computer use, which runs outside Zeros, holds the Mac too while the
// engine reports it running.
//
// Every action names an app by process ID. Before anything reaches the
// driver, the app must be running, must not be Zeros or a blocked app, and
// must be allowed by the user in this chat. Window IDs must belong to that
// app. Tool arguments never choose the driver session, the desktop scope or
// configuration.
// ──────────────────────────────────────────────────────────

import type { AgentControlConfirmationDecision } from "@zeros/protocol/agent-control";
import {
  agentControlName,
  isAgentControlFamily,
  isBrowserProductId,
  type AgentControlFamily,
} from "@zeros/protocol/browser-tools";
import {
  COMPUTER_USE_SERVICE_VERSION,
  computerControlDetail,
  isComputerBundleId,
  isComputerToolName,
  parseComputerToolCall,
  sameComputerBundleId,
  type ComputerToolCall,
  type ComputerToolContent,
  type ComputerToolInvokeRequest,
  type ComputerToolResult,
  type ComputerUseHolder,
  type ComputerUseNativeActivityRequest,
  type ComputerUsePreferences,
  type ComputerUseReleaseRequest,
  type ComputerUseStateSnapshot,
} from "@zeros/protocol/computer-use-tools";

import type { AgentControlConfirmationInput } from "../agent-control/confirmations";
import {
  agentImages,
  agentText,
  driverFailureText,
  formatApps,
  formatWindows,
  formatWindowState,
  readApps,
  readWindows,
  type ComputerApp,
  type ComputerWindow,
} from "./driver-output";
import {
  ComputerDriverLostError,
  type ComputerControlPanel,
  type ComputerDriverHost,
  type ComputerDriverResult,
  type ComputerDriverSession,
  type ComputerDriverTool,
  type ComputerPermissions,
  type ComputerPermissionStatus,
} from "./ports";

export interface ComputerUseControllerOptions {
  host: ComputerDriverHost;
  permissions: ComputerPermissions;
  panel: ComputerControlPanel;
  confirm(
    input: AgentControlConfirmationInput,
    signal: AbortSignal,
  ): Promise<AgentControlConfirmationDecision>;
  denyConfirmations(workspaceId: string, conversationId: string): void;
  onState?(state: ComputerUseStateSnapshot): void;
  /** Zeros' own process, whose windows no agent may control. */
  selfPid: number;
  /** Stop the driver after this long with no chat using it. */
  idleStopMs?: number;
  /** How long a chat waits for another to finish before giving up. */
  waitTimeoutMs?: number;
  /** One driver call, not counting an approval the user is answering. */
  actionTimeoutMs?: number;
  /** Codex's built-in computer use counts as running this long after the
   * engine last reported it, in case its end is never reported. */
  nativeActivityTtlMs?: number;
}

const DEFAULT_IDLE_STOP_MS = 5 * 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ACTION_TIMEOUT_MS = 60_000;
const DEFAULT_NATIVE_ACTIVITY_TTL_MS = 3 * 60_000;
const MAX_REMEMBERED_CHATS = 64;
const MAX_APPROVED_APPS = 64;
const ZEROS_BUNDLE = /^com\.zeros(?:\.|$)/i;
const PERMISSION_ERROR_CODES = new Set([
  "permission_denied",
  "accessibility_permission_denied",
  "screen_recording_permission_denied",
]);
/** The driver refused before acting because the session was gone, so the
 * call is safe to repeat once on a new session. */
const SESSION_GONE_CODES = new Set(["session_unavailable", "session_not_bound"]);
/** Plain motion, no trail or glow, a small pulse on click. */
const QUIET_CURSOR_MOTION = {
  style: "signature_arc",
  arc_size: 0,
  timing: "fitts",
  effects: {
    trail: false,
    glow: false,
    magnet: false,
    squish: false,
    ripple: true,
  },
  idle_hide_ms: 3_000,
} as const;

const OFF = "Computer use is turned off in Settings > Computer use.";
const STOPPED_BY_USER =
  "The user stopped computer use. Do not use the computer again until the user asks.";
const ENDED = "Computer use ended for this turn.";
const CANCELLED = "The computer action was cancelled.";
const LOST = "Computer use stopped unexpectedly. Try again.";
const BUSY = "Another chat is still using the computer. Try again when it finishes.";
const TIMED_OUT = "The computer action timed out.";
const UNAVAILABLE = "Computer use is unavailable. Restart Zeros and try again.";
const SELF = "Agents cannot control Zeros.";

const DRIVER_TOOLS: Record<
  Exclude<ComputerToolCall["tool"], "list_apps" | "list_windows" | "open_app">,
  ComputerDriverTool
> = {
  screenshot: "get_window_state",
  click: "click",
  type_text: "type_text",
  press_key: "press_key",
  scroll: "scroll",
  drag: "drag",
};

interface Lease {
  key: string;
  workspaceId: string;
  conversationId: string;
  agent: AgentControlFamily;
  turnId: string;
  session: ComputerDriverSession | null;
  label: string | null;
  app: ComputerApp | null;
  ended: AbortController;
  endReason: string | null;
}

interface WaitEntry {
  key: string;
  workspaceId: string;
  conversationId: string;
  agent: AgentControlFamily;
  wakers: Set<(error: Error | null) => void>;
}

interface NativeHolder {
  workspaceId: string;
  conversationId: string;
  agent: AgentControlFamily;
  timer: ReturnType<typeof setTimeout>;
}

class RefusedError extends Error {}

/** The driver dropped this session before acting, for example after its idle
 * expiry. The next call opens a new one. */
class SessionExpiredError extends Error {}

function ownerKey(workspaceId: string, conversationId: string): string {
  return `${workspaceId}\u0000${conversationId}`;
}

function failure(text: string): ComputerToolResult {
  return {
    version: COMPUTER_USE_SERVICE_VERSION,
    success: false,
    content: [{ type: "text", text }],
  };
}

function success(content: ComputerToolContent[]): ComputerToolResult {
  return {
    version: COMPUTER_USE_SERVICE_VERSION,
    success: true,
    content: content.length ? content : [{ type: "text", text: "Done." }],
  };
}

function permissionProblem(status: ComputerPermissionStatus): string | null {
  if (status.accessibility && status.screenRecording) return null;
  const missing =
    !status.accessibility && !status.screenRecording
      ? "Accessibility and Screen Recording access"
      : !status.accessibility
        ? "Accessibility access"
        : "Screen Recording access";
  return `Zeros needs ${missing} to use your Mac. The user can turn ${
    !status.accessibility && !status.screenRecording ? "them" : "it"
  } on in Settings > Computer use.`;
}

function deniedText(agent: AgentControlFamily, appName: string): string {
  return `The user did not allow ${agentControlName(agent)} to control ${appName}.`;
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_REMEMBERED_CHATS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function validOwner(value: unknown): value is {
  workspaceId: string;
  conversationId: string;
} {
  if (!value || typeof value !== "object") return false;
  const owner = value as Record<string, unknown>;
  return (
    isBrowserProductId(owner.workspaceId) &&
    isBrowserProductId(owner.conversationId)
  );
}

function isEscapeKey(key: string | undefined): boolean {
  const name = key?.toLowerCase();
  return name === "escape" || name === "esc";
}

/** The driver arguments for one validated call. Never a session, scope or
 * configuration. */
export function computerDriverArguments(
  call: ComputerToolCall,
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (call.pid !== undefined) args.pid = call.pid;
  if (call.elementToken !== undefined) args.element_token = call.elementToken;
  if (call.windowId !== undefined) args.window_id = call.windowId;
  switch (call.tool) {
    case "screenshot":
      if (call.query !== undefined) args.query = call.query;
      if (call.elements === false) args.include_accessibility_tree = false;
      return args;
    case "click":
      if (call.x !== undefined) {
        args.x = call.x;
        args.y = call.y;
      }
      if (call.button) args.button = call.button;
      if (call.count !== undefined) args.count = call.count;
      if (call.modifiers?.length) {
        args.modifier = call.modifiers;
        // macOS only sees modifier keys held for a click the window receives
        // in front.
        args.delivery_mode = "foreground";
      }
      return args;
    case "type_text":
      args.text = call.text;
      if (call.x !== undefined) {
        args.x = call.x;
        args.y = call.y;
      }
      return args;
    case "press_key":
      args.key = call.key;
      if (call.modifiers?.length) args.modifiers = call.modifiers;
      return args;
    case "scroll":
      args.direction = call.direction;
      if (call.amount !== undefined) args.amount = call.amount;
      if (call.by) args.by = call.by;
      if (call.x !== undefined) {
        args.x = call.x;
        args.y = call.y;
      }
      return args;
    case "drag":
      args.from_x = call.x;
      args.from_y = call.y;
      args.to_x = call.toX;
      args.to_y = call.toY;
      // macOS has no background drag; the window comes to the front.
      args.delivery_mode = "foreground";
      return args;
    default:
      return args;
  }
}

export class ComputerUseController {
  private preferences: ComputerUsePreferences = {
    enabled: false,
    showAgentCursor: true,
    blockedApps: [],
  };
  private lease: Lease | null = null;
  private readonly waiting: WaitEntry[] = [];
  private readonly native = new Map<string, NativeHolder>();
  private readonly approvals = new Map<string, Set<string>>();
  private readonly refusals = new Map<
    string,
    { turnId: string; bundleIds: Set<string> }
  >();
  private readonly stoppedTurns = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private hostRunning = false;
  private permissionKey: string | null = null;
  private restartForPermissions = false;
  private published = "";
  private disposed = false;
  private readonly idleStopMs: number;
  private readonly waitTimeoutMs: number;
  private readonly actionTimeoutMs: number;
  private readonly nativeActivityTtlMs: number;

  constructor(private readonly options: ComputerUseControllerOptions) {
    this.idleStopMs = options.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    this.nativeActivityTtlMs =
      options.nativeActivityTtlMs ?? DEFAULT_NATIVE_ACTIVITY_TTL_MS;
  }

  /** Settings pushed by the trusted renderer. Until the first push computer
   * use stays off. */
  setPreferences(next: ComputerUsePreferences): void {
    const blockedApps = next.blockedApps.filter(isComputerBundleId);
    const cursorChanged =
      next.showAgentCursor !== this.preferences.showAgentCursor;
    this.preferences = {
      enabled: next.enabled,
      showAgentCursor: next.showAgentCursor,
      blockedApps,
    };
    if (!next.enabled) {
      if (this.lease) this.end(this.lease, OFF);
      this.rejectWaiting(OFF);
      return;
    }
    const lease = this.lease;
    if (lease?.app && this.blocked(lease.app)) {
      this.end(lease, `${lease.app.name} is blocked in Settings > Computer use.`);
      return;
    }
    if (cursorChanged && lease?.session) {
      void this.serialize(async () => {
        if (this.lease !== lease || !lease.session) return;
        await this.applyCursor(lease, lease.session, lease.ended.signal).catch(
          () => undefined,
        );
      });
    }
  }

  /** The current macOS grants, as Settings shows them. A change since the
   * driver started means it restarts before its next session. */
  permissionStatus(): ComputerPermissionStatus {
    const status = this.options.permissions.status();
    const key = `${status.accessibility}:${status.screenRecording}`;
    if (this.permissionKey !== null && this.permissionKey !== key) {
      this.restartForPermissions = true;
    }
    this.permissionKey = key;
    return status;
  }

  state(): ComputerUseStateSnapshot {
    const holders: ComputerUseHolder[] = [];
    if (this.lease) {
      holders.push({
        workspaceId: this.lease.workspaceId,
        conversationId: this.lease.conversationId,
        agent: this.lease.agent,
        app: this.lease.app?.name ?? null,
        native: false,
      });
    }
    for (const holder of this.native.values()) {
      holders.push({
        workspaceId: holder.workspaceId,
        conversationId: holder.conversationId,
        agent: holder.agent,
        app: null,
        native: true,
      });
    }
    return {
      version: COMPUTER_USE_SERVICE_VERSION,
      holders: holders.slice(0, 64),
      waiting: this.waiting.slice(0, 64).map((entry) => ({
        workspaceId: entry.workspaceId,
        conversationId: entry.conversationId,
        agent: entry.agent,
      })),
    };
  }

  async invoke(
    request: ComputerToolInvokeRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ComputerToolResult> {
    if (this.disposed) return failure(UNAVAILABLE);
    if (
      request?.version !== COMPUTER_USE_SERVICE_VERSION ||
      !validOwner(request.owner) ||
      !isAgentControlFamily(request.agent) ||
      !isBrowserProductId(request.turnId) ||
      !isComputerToolName(request.tool)
    ) {
      return failure("Invalid Zeros computer tool request.");
    }
    if (!this.preferences.enabled) return failure(OFF);
    const parsed = parseComputerToolCall(request.tool, request.arguments);
    if (!parsed.ok) return failure(parsed.error);
    const problem = permissionProblem(this.permissionStatus());
    if (problem) return failure(problem);
    const key = ownerKey(request.owner.workspaceId, request.owner.conversationId);
    if (this.stoppedTurns.get(key) === request.turnId) {
      return failure(STOPPED_BY_USER);
    }
    let lease: Lease;
    try {
      lease = await this.acquire(request, key, signal);
    } catch (error) {
      return failure(error instanceof Error ? error.message : CANCELLED);
    }
    return this.serialize(() =>
      this.perform(lease, request.turnId, parsed.call, signal),
    );
  }

  /** Turn end, composer Stop or conversation retirement in the engine. */
  release(request: ComputerUseReleaseRequest): boolean {
    if (
      request?.version !== COMPUTER_USE_SERVICE_VERSION ||
      !validOwner(request.owner) ||
      (request.reason !== "turn-end" &&
        request.reason !== "stop" &&
        request.reason !== "retire")
    ) {
      return false;
    }
    const { workspaceId, conversationId } = request.owner;
    const key = ownerKey(workspaceId, conversationId);
    this.rejectWaiting(ENDED, key);
    this.options.denyConfirmations(workspaceId, conversationId);
    this.stoppedTurns.delete(key);
    this.refusals.delete(key);
    this.clearNative(key);
    if (request.reason === "retire") this.approvals.delete(key);
    const lease = this.lease;
    if (lease?.key !== key) {
      this.publish();
      this.pump();
      return false;
    }
    this.end(lease, request.reason === "stop" ? CANCELLED : ENDED);
    return true;
  }

  /** The engine saw Codex's built-in computer use start or finish a turn. */
  nativeActivity(request: ComputerUseNativeActivityRequest): boolean {
    if (
      request?.version !== COMPUTER_USE_SERVICE_VERSION ||
      !validOwner(request.owner) ||
      !isAgentControlFamily(request.agent) ||
      typeof request.active !== "boolean"
    ) {
      return false;
    }
    const { workspaceId, conversationId } = request.owner;
    const key = ownerKey(workspaceId, conversationId);
    if (!request.active) {
      this.clearNative(key);
      this.publish();
      this.pump();
      return true;
    }
    const existing = this.native.get(key);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      if (this.native.get(key)?.timer !== timer) return;
      this.native.delete(key);
      this.publish();
      this.pump();
    }, this.nativeActivityTtlMs);
    timer.unref?.();
    this.native.set(key, {
      workspaceId,
      conversationId,
      agent: request.agent,
      timer,
    });
    this.publish();
    return true;
  }

  /** The control bar's Stop or Esc. Ends the lease and refuses the rest of
   * that turn. */
  stopFromUser(): boolean {
    const lease = this.lease;
    if (!lease) return false;
    remember(this.stoppedTurns, lease.key, lease.turnId);
    this.end(lease, STOPPED_BY_USER);
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.lease) this.end(this.lease, UNAVAILABLE);
    this.rejectWaiting(UNAVAILABLE);
    for (const key of [...this.native.keys()]) this.clearNative(key);
    this.cancelIdle();
    await this.stopHost();
  }

  private async acquire(
    request: ComputerToolInvokeRequest,
    key: string,
    signal: AbortSignal,
  ): Promise<Lease> {
    try {
      return await this.acquireInOrder(request, key, signal);
    } catch (error) {
      // A woken chat that gives up must not hold the head of the line.
      const entry = this.waiting.find((candidate) => candidate.key === key);
      if (entry && entry.wakers.size === 0) this.dropWaiting(entry);
      throw error;
    }
  }

  private async acquireInOrder(
    request: ComputerToolInvokeRequest,
    key: string,
    signal: AbortSignal,
  ): Promise<Lease> {
    const deadline = Date.now() + this.waitTimeoutMs;
    for (;;) {
      if (signal.aborted) throw new Error(CANCELLED);
      if (this.disposed) throw new Error(UNAVAILABLE);
      if (!this.preferences.enabled) throw new Error(OFF);
      if (this.stoppedTurns.get(key) === request.turnId) {
        throw new Error(STOPPED_BY_USER);
      }
      const current = this.lease;
      if (current?.key === key) {
        current.turnId = request.turnId;
        current.agent = request.agent;
        return current;
      }
      const first = this.waiting[0];
      if (!current && !this.nativeBlocks(key) && (!first || first.key === key)) {
        if (first?.key === key) this.waiting.shift();
        const lease: Lease = {
          key,
          workspaceId: request.owner.workspaceId,
          conversationId: request.owner.conversationId,
          agent: request.agent,
          turnId: request.turnId,
          session: null,
          label: null,
          app: null,
          ended: new AbortController(),
          endReason: null,
        };
        this.lease = lease;
        this.cancelIdle();
        this.publish();
        return lease;
      }
      await this.wait(request, key, signal, deadline);
    }
  }

  private wait(
    request: ComputerToolInvokeRequest,
    key: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void> {
    let entry = this.waiting.find((candidate) => candidate.key === key);
    if (!entry) {
      entry = {
        key,
        workspaceId: request.owner.workspaceId,
        conversationId: request.owner.conversationId,
        agent: request.agent,
        wakers: new Set(),
      };
      this.waiting.push(entry);
      this.publish();
    }
    const waitEntry = entry;
    return new Promise<void>((resolve, reject) => {
      const finish = (error: Error | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        waitEntry.wakers.delete(finish);
        if (error) {
          if (waitEntry.wakers.size === 0) this.dropWaiting(waitEntry);
          reject(error);
        } else {
          resolve();
        }
      };
      const onAbort = () => finish(new Error(CANCELLED));
      const timer = setTimeout(
        () => finish(new Error(BUSY)),
        Math.max(0, deadline - Date.now()),
      );
      timer.unref?.();
      waitEntry.wakers.add(finish);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private dropWaiting(entry: WaitEntry): void {
    const index = this.waiting.indexOf(entry);
    if (index < 0) return;
    this.waiting.splice(index, 1);
    this.publish();
    this.pump();
  }

  /** Wake the next chat in line once the Mac is free. */
  private pump(): void {
    if (this.lease || this.disposed) return;
    const first = this.waiting[0];
    if (!first || this.nativeBlocks(first.key)) return;
    for (const wake of [...first.wakers]) wake(null);
  }

  private rejectWaiting(reason: string, key?: string): void {
    for (const entry of [...this.waiting]) {
      if (key !== undefined && entry.key !== key) continue;
      for (const wake of [...entry.wakers]) wake(new Error(reason));
      this.dropWaiting(entry);
    }
  }

  private nativeBlocks(key: string): boolean {
    for (const holderKey of this.native.keys()) {
      if (holderKey !== key) return true;
    }
    return false;
  }

  private clearNative(key: string): void {
    const holder = this.native.get(key);
    if (!holder) return;
    clearTimeout(holder.timer);
    this.native.delete(key);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async perform(
    lease: Lease,
    turnId: string,
    call: ComputerToolCall,
    signal: AbortSignal,
  ): Promise<ComputerToolResult> {
    if (this.lease !== lease || lease.ended.signal.aborted) {
      return failure(lease.endReason ?? ENDED);
    }
    if (this.stoppedTurns.get(lease.key) === turnId) {
      return failure(STOPPED_BY_USER);
    }
    if (signal.aborted) return failure(CANCELLED);
    const scope = AbortSignal.any([signal, lease.ended.signal]);
    try {
      return await this.run(lease, call, scope);
    } catch (error) {
      if (lease.ended.signal.aborted) return failure(lease.endReason ?? ENDED);
      if (signal.aborted) return failure(CANCELLED);
      if (error instanceof RefusedError) return failure(error.message);
      if (error instanceof SessionExpiredError) {
        const expired = lease.session;
        lease.session = null;
        try {
          expired?.close();
        } catch {
          // Already gone on the driver side.
        }
        return failure("The computer-use session expired. Try the action again.");
      }
      if (error instanceof ComputerDriverLostError) {
        this.end(lease, LOST);
        await this.stopHost();
        return failure(LOST);
      }
      return failure(
        error instanceof Error && error.message ? error.message : "The action failed.",
      );
    } finally {
      this.scheduleIdle();
    }
  }

  private async run(
    lease: Lease,
    call: ComputerToolCall,
    scope: AbortSignal,
  ): Promise<ComputerToolResult> {
    const session = await this.session(lease, scope);
    switch (call.tool) {
      case "list_apps": {
        const apps = (await this.apps(session, scope)).filter(
          (app) => !this.blocked(app) && (!call.runningOnly || app.running),
        );
        return success([{ type: "text", text: formatApps(apps) }]);
      }
      case "list_windows": {
        const controllable = new Map<number, ComputerApp>();
        for (const app of await this.apps(session, scope)) {
          if (app.running && !this.blocked(app)) controllable.set(app.pid, app);
        }
        const windows = (
          await this.windows(session, call.pid, true, scope)
        ).flatMap((window): ComputerWindow[] => {
          const app = controllable.get(window.pid);
          return app ? [{ ...window, appName: app.name }] : [];
        });
        return success([{ type: "text", text: formatWindows(windows) }]);
      }
      case "open_app": {
        const bundleId = call.bundleId ?? "";
        const apps = (await this.apps(session, scope)).filter((app) =>
          sameComputerBundleId(app.bundleId, bundleId),
        );
        const app = apps.find((entry) => entry.running) ?? apps[0];
        if (!app) {
          return failure(`No installed app has bundle ID ${bundleId}. Call list_apps.`);
        }
        await this.authorize(lease, app, scope);
        return this.actionResult(
          await this.call(session, "launch_app", { bundle_id: app.bundleId }, scope),
        );
      }
      default:
        return this.act(lease, session, call, scope);
    }
  }

  private async act(
    lease: Lease,
    session: ComputerDriverSession,
    call: ComputerToolCall,
    scope: AbortSignal,
  ): Promise<ComputerToolResult> {
    const pid = call.pid ?? 0;
    if (pid === this.options.selfPid) return failure(SELF);
    const app = (await this.apps(session, scope)).find(
      (entry) => entry.running && entry.pid === pid,
    );
    if (!app) {
      return failure(`No app you can control has process ID ${pid}. Call list_apps.`);
    }
    await this.authorize(lease, app, scope);
    if (call.windowId !== undefined) {
      const windows = await this.windows(session, pid, false, scope);
      if (!windows.some((window) => window.windowId === call.windowId)) {
        return failure(
          `Window ${call.windowId} is not a window of ${app.name}. Call list_windows.`,
        );
      }
    }
    const tool = DRIVER_TOOLS[call.tool as keyof typeof DRIVER_TOOLS];
    const args = computerDriverArguments(call);
    const result =
      call.tool === "press_key" && isEscapeKey(call.key)
        ? await this.options.panel.withoutEscape(() =>
            this.call(session, tool, args, scope),
          )
        : await this.call(session, tool, args, scope);
    if (call.tool !== "screenshot") return this.actionResult(result);
    if (result.isError) return failure(driverFailureText(result));
    return success([
      ...agentImages(result),
      { type: "text", text: formatWindowState(result, app.name) },
    ]);
  }

  /** Refuses Zeros, blocked apps and apps the user has not allowed in this
   * chat, asking once per app. */
  private async authorize(
    lease: Lease,
    app: ComputerApp,
    scope: AbortSignal,
  ): Promise<void> {
    if (this.isSelf(app)) throw new RefusedError(SELF);
    if (this.blocked(app)) {
      throw new RefusedError(`${app.name} is blocked in Settings > Computer use.`);
    }
    const bundleId = app.bundleId.toLowerCase();
    if (!this.approvals.get(lease.key)?.has(bundleId)) {
      const refused = this.refusals.get(lease.key);
      if (refused?.turnId === lease.turnId && refused.bundleIds.has(bundleId)) {
        throw new RefusedError(deniedText(lease.agent, app.name));
      }
      const decision = await this.options.confirm(
        {
          kind: "app",
          workspaceId: lease.workspaceId,
          conversationId: lease.conversationId,
          agent: lease.agent,
          subject: app.name,
          subjectId: app.bundleId,
        },
        scope,
      );
      if (this.lease !== lease || lease.ended.signal.aborted) {
        throw new RefusedError(lease.endReason ?? ENDED);
      }
      if (scope.aborted) throw new RefusedError(CANCELLED);
      if (decision !== "allow") {
        const entry =
          refused?.turnId === lease.turnId
            ? refused
            : { turnId: lease.turnId, bundleIds: new Set<string>() };
        entry.bundleIds.add(bundleId);
        remember(this.refusals, lease.key, entry);
        const text = deniedText(lease.agent, app.name);
        this.end(lease, text);
        throw new RefusedError(text);
      }
      // Settings may have changed while the card was open.
      if (this.blocked(app)) {
        throw new RefusedError(`${app.name} is blocked in Settings > Computer use.`);
      }
      const approved = this.approvals.get(lease.key) ?? new Set<string>();
      if (approved.size >= MAX_APPROVED_APPS) approved.clear();
      approved.add(bundleId);
      remember(this.approvals, lease.key, approved);
    }
    if (lease.app?.pid !== app.pid || lease.app.bundleId !== app.bundleId) {
      lease.app = app;
      this.publish();
    }
    this.options.panel.show({
      title: agentControlName(lease.agent),
      detail: computerControlDetail(app.name),
    });
  }

  private async session(
    lease: Lease,
    scope: AbortSignal,
  ): Promise<ComputerDriverSession> {
    if (lease.session) return lease.session;
    this.cancelIdle();
    if (this.restartForPermissions) {
      this.restartForPermissions = false;
      if (this.hostRunning) await this.stopHost();
    }
    const label = agentControlName(lease.agent);
    const session = await this.options.host.openSession(label, scope);
    this.hostRunning = true;
    if (this.lease !== lease || lease.ended.signal.aborted) {
      session.close();
      throw new RefusedError(lease.endReason ?? ENDED);
    }
    lease.session = session;
    lease.label = label;
    await this.applyCursor(lease, session, scope).catch((error: unknown) => {
      if (error instanceof ComputerDriverLostError) throw error;
    });
    return session;
  }

  private async applyCursor(
    lease: Lease,
    session: ComputerDriverSession,
    scope: AbortSignal,
  ): Promise<void> {
    const label = lease.label;
    if (!label) return;
    if (this.preferences.showAgentCursor) {
      await this.call(
        session,
        "set_agent_cursor_motion",
        { session: label, ...QUIET_CURSOR_MOTION },
        scope,
      );
    }
    await this.call(
      session,
      "set_agent_cursor_enabled",
      { session: label, enabled: this.preferences.showAgentCursor },
      scope,
    );
  }

  /** One driver call with a deadline. A session the driver already dropped
   * is replaced once. */
  private async call(
    session: ComputerDriverSession,
    tool: ComputerDriverTool,
    args: Record<string, unknown>,
    scope: AbortSignal,
  ): Promise<ComputerDriverResult> {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error(TIMED_OUT)),
      this.actionTimeoutMs,
    );
    timer.unref?.();
    try {
      const signal = AbortSignal.any([scope, deadline.signal]);
      const result = await session.call(tool, args, signal);
      if (result.isError && result.errorCode) {
        if (PERMISSION_ERROR_CODES.has(result.errorCode)) {
          this.restartForPermissions = true;
          const problem = permissionProblem(this.permissionStatus());
          if (problem) throw new RefusedError(problem);
        }
        if (SESSION_GONE_CODES.has(result.errorCode)) {
          throw new SessionExpiredError();
        }
      }
      return result;
    } catch (error) {
      if (deadline.signal.aborted && !scope.aborted) {
        throw new RefusedError(TIMED_OUT);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private actionResult(result: ComputerDriverResult): ComputerToolResult {
    if (result.isError) return failure(driverFailureText(result));
    return success([{ type: "text", text: agentText(result.text) || "Done." }]);
  }

  private async apps(
    session: ComputerDriverSession,
    scope: AbortSignal,
  ): Promise<ComputerApp[]> {
    const result = await this.call(session, "list_apps", {}, scope);
    if (result.isError) throw new RefusedError(driverFailureText(result));
    return readApps(result);
  }

  private async windows(
    session: ComputerDriverSession,
    pid: number | undefined,
    onScreenOnly: boolean,
    scope: AbortSignal,
  ): Promise<ComputerWindow[]> {
    const args: Record<string, unknown> = {};
    if (pid !== undefined) args.pid = pid;
    if (onScreenOnly) args.on_screen_only = true;
    const result = await this.call(session, "list_windows", args, scope);
    if (result.isError) throw new RefusedError(driverFailureText(result));
    return readWindows(result).filter(
      (window) =>
        window.pid !== this.options.selfPid &&
        (pid === undefined || window.pid === pid),
    );
  }

  private isSelf(app: ComputerApp): boolean {
    return (
      ZEROS_BUNDLE.test(app.bundleId) ||
      (app.running && app.pid === this.options.selfPid)
    );
  }

  private blocked(app: ComputerApp): boolean {
    return (
      this.isSelf(app) ||
      this.preferences.blockedApps.some((bundleId) =>
        sameComputerBundleId(bundleId, app.bundleId),
      )
    );
  }

  private end(lease: Lease, reason: string): void {
    if (lease.ended.signal.aborted) return;
    lease.endReason = reason;
    lease.ended.abort(new Error(reason));
    const session = lease.session;
    lease.session = null;
    try {
      session?.close();
    } catch {
      // Closing is best effort; the driver's own idle expiry reclaims it.
    }
    this.options.denyConfirmations(lease.workspaceId, lease.conversationId);
    if (this.lease === lease) {
      this.lease = null;
      this.options.panel.hide();
    }
    this.publish();
    this.pump();
    this.scheduleIdle();
  }

  private scheduleIdle(): void {
    if (
      this.disposed ||
      !this.hostRunning ||
      this.lease ||
      this.waiting.length > 0
    ) {
      return;
    }
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.lease && this.waiting.length === 0) void this.stopHost();
    }, this.idleStopMs);
    this.idleTimer.unref?.();
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async stopHost(): Promise<void> {
    this.hostRunning = false;
    try {
      await this.options.host.stop();
    } catch {
      // A driver that fails to stop is replaced on its next start.
    }
  }

  private publish(): void {
    const state = this.state();
    const serialized = JSON.stringify(state);
    if (serialized === this.published) return;
    this.published = serialized;
    try {
      this.options.onState?.(state);
    } catch {
      // The renderer's copy is advisory; main stays authoritative.
    }
  }
}
