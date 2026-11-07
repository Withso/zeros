// ──────────────────────────────────────────────────────────
// Zeros computer use: who may control the Mac, and how
// ──────────────────────────────────────────────────────────
//
// Several chats can use the Mac at once, each in its own apps. A chat leases
// every app it acts in until its turn ends, Stop or a driver failure; a chat
// that wants an app another chat holds waits in that app's line. Each chat
// drives through its own trusted driver session, whose label names its agent
// cursor. Input stays in the background, so only the actions macOS delivers
// to the frontmost window (modified clicks, drags, an ambiguous key) take
// turns.
//
// Every action names an app by process ID. Before anything reaches the
// driver, the app must be running and must not be Zeros or a blocked app.
// Window IDs must belong to that app. Tool arguments never choose the driver
// session, the desktop scope or configuration.
// ──────────────────────────────────────────────────────────

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
  type ComputerUsePreferences,
  type ComputerUseReleaseRequest,
  type ComputerUseStateSnapshot,
} from "@zeros/protocol/computer-use-tools";

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
  type ComputerControlPresentation,
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
  /** Hand an http(s) URL to an app through Launch Services without bringing
   * it to the front. Absent where the platform has no such service. */
  openUrl?(bundleId: string, url: string, signal: AbortSignal): Promise<void>;
  onState?(state: ComputerUseStateSnapshot): void;
  /** Zeros' own process, whose windows no agent may control. */
  selfPid: number;
  /** Stop the driver after this long with no chat using it. */
  idleStopMs?: number;
  /** How long a chat waits for another to finish before giving up. */
  waitTimeoutMs?: number;
  /** Each driver call's deadline. */
  actionTimeoutMs?: number;
}

const DEFAULT_IDLE_STOP_MS = 5 * 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ACTION_TIMEOUT_MS = 60_000;
const MAX_REMEMBERED_CHATS = 64;
/** The driver's app listing walks every installed app, about a second each
 * time, so every chat shares one this long. A listing that misses what a
 * call sees is read again; opening an app through Zeros discards it. */
const APP_LIST_TTL_MS = 30_000;
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

const OFF = "Computer use is turned off in Settings > General.";
const STOPPED_BY_USER =
  "The user stopped computer use. Do not use the computer again until the user asks.";
const ENDED = "Computer use ended for this turn.";
const CANCELLED = "The computer action was cancelled.";
const LOST = "Computer use stopped unexpectedly. Try again.";
const TIMED_OUT = "The computer action timed out.";
const UNAVAILABLE = "Computer use is unavailable. Restart Zeros and try again.";
const SELF = "Agents cannot control Zeros.";

const DRIVER_TOOLS: Record<
  Exclude<
    ComputerToolCall["tool"],
    "list_apps" | "list_windows" | "open_app" | "open_url"
  >,
  ComputerDriverTool
> = {
  screenshot: "get_window_state",
  click: "click",
  type_text: "type_text",
  press_key: "press_key",
  scroll: "scroll",
  drag: "drag",
};

/** One chat's computer use from its first action until its turn ends. */
interface ChatRun {
  key: string;
  workspaceId: string;
  conversationId: string;
  agent: AgentControlFamily;
  turnId: string;
  session: ComputerDriverSession | null;
  opening: boolean;
  label: string | null;
  /** The apps it holds, by lowercased bundle ID. */
  apps: Map<string, AppLease>;
  /** The app it acted in last, which the control bar names. */
  current: ComputerApp | null;
  /** One action at a time per chat, in order. */
  tail: Promise<unknown>;
  ended: AbortController;
  endReason: string | null;
}

interface AppLease {
  bundleId: string;
  app: ComputerApp;
  chat: ChatRun;
  ended: AbortController;
}

interface WaitEntry {
  key: string;
  workspaceId: string;
  conversationId: string;
  agent: AgentControlFamily;
  bundleId: string;
  appName: string;
  wakers: Set<(error: Error | null) => void>;
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
  } on in Settings > General.`;
}

function blockedText(appName: string): string {
  return `${appName} is blocked in Settings > General.`;
}

function busyText(appName: string): string {
  return `Another chat is still using ${appName}. Try again when it finishes.`;
}

function deadlockText(appName: string): string {
  return `Another chat is using ${appName} and is waiting for an app this chat is using. Try again when that chat finishes.`;
}

/** Whether a listing still matches the windows on screen: an app it lists
 * with a window must be running with that window's process. Windows of
 * processes that are not apps, such as the Dock, never count. */
function listingMatchesWindows(
  apps: readonly ComputerApp[],
  windows: readonly ComputerWindow[],
): boolean {
  return windows.every((window) => {
    const named = apps.filter((app) => app.name === window.appName);
    return named.length === 0 || named.some((app) => app.running && app.pid === window.pid);
  });
}

/** The process a launch started: the driver's structured pid, else its
 * "Launched Calculator (pid 16731) in background." text. */
function launchedPid(result: ComputerDriverResult): number | null {
  const structured = result.structured?.pid;
  if (typeof structured === "number" && Number.isSafeInteger(structured) && structured > 0) {
    return structured;
  }
  const match = /\(pid (\d{1,10})\)/.exec(result.text);
  const pid = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function andList(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The control bar for every chat acting now: "Codex" "is using Safari", or
 * "Claude Code and Codex" "are using Safari and Notes". Cursor labels are
 * unique per session, so two chats of one agent read "Claude Code and Claude
 * Code 2". */
export function computerControlBar(
  chats: readonly { label: string; app: string | null }[],
): ComputerControlPresentation | null {
  if (chats.length === 0) return null;
  if (chats.length === 1) {
    return { title: chats[0]!.label, detail: computerControlDetail(chats[0]!.app) };
  }
  const labels = [...new Set(chats.map((chat) => chat.label))];
  const apps = [...new Set(chats.flatMap((chat) => (chat.app ? [chat.app] : [])))];
  return {
    title:
      labels.length === chats.length && labels.length === 2
        ? andList(labels)
        : `${chats.length} agents`,
    detail:
      apps.length === 0
        ? "are using your Mac"
        : apps.length > 2
          ? `are using ${apps.length} apps`
          : `are using ${andList(apps)}`,
  };
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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

/** Background keys cannot be proven to reach one window of an app with
 * several, so the named window comes forward for this key, as it does for
 * drags and modified clicks. */
function keyboardNeedsForeground(result: ComputerDriverResult): boolean {
  return (
    result.isError &&
    (result.errorCode === "same_pid_keyboard_ambiguity" ||
      result.text.includes("same_pid_keyboard_ambiguity"))
  );
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
  private appList: { at: number; apps: ComputerApp[] } | null = null;
  /** The listing being read now, which every chat that asks joins. */
  private appListRead: {
    promise: Promise<ComputerApp[]>;
    session: ComputerDriverSession;
  } | null = null;
  private appListGeneration = 0;
  private readonly chats = new Map<string, ChatRun>();
  /** Who holds each app, by lowercased bundle ID. */
  private readonly leases = new Map<string, AppLease>();
  /** Every waiting chat in arrival order; each app's line is its own entries. */
  private readonly waiting: WaitEntry[] = [];
  /** Actions macOS delivers only to the frontmost window take turns. */
  private foreground: Promise<void> = Promise.resolve();
  private readonly stoppedTurns = new Map<string, string>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private hostRunning = false;
  private permissionKey: string | null = null;
  private restartForPermissions = false;
  private published = "";
  private disposed = false;
  private readonly idleStopMs: number;
  private readonly waitTimeoutMs: number;
  private readonly actionTimeoutMs: number;

  constructor(private readonly options: ComputerUseControllerOptions) {
    this.idleStopMs = options.idleStopMs ?? DEFAULT_IDLE_STOP_MS;
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
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
      for (const chat of [...this.chats.values()]) this.end(chat, OFF);
      this.rejectWaiting(OFF);
      return;
    }
    for (const lease of [...this.leases.values()]) {
      if (this.blocked(lease.app)) this.endLease(lease, blockedText(lease.app.name));
    }
    for (const entry of [...this.waiting]) {
      if (this.blockedBundle(entry.bundleId)) {
        this.rejectEntry(entry, blockedText(entry.appName));
      }
    }
    if (!cursorChanged) return;
    for (const chat of this.chats.values()) {
      if (!chat.session) continue;
      void this.serialize(chat, async () => {
        const session = chat.session;
        if (this.chats.get(chat.key) !== chat || !session) return;
        await this.applyCursor(chat, session, chat.ended.signal).catch(
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
    for (const lease of this.leases.values()) {
      holders.push({
        workspaceId: lease.chat.workspaceId,
        conversationId: lease.chat.conversationId,
        agent: lease.chat.agent,
        app: lease.app.name,
      });
    }
    return {
      version: COMPUTER_USE_SERVICE_VERSION,
      holders: holders.slice(0, 64),
      waiting: this.waiting.slice(0, 64).map((entry) => ({
        workspaceId: entry.workspaceId,
        conversationId: entry.conversationId,
        agent: entry.agent,
        app: entry.appName,
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
    const chat = this.chatFor(request, key);
    return this.serialize(chat, () =>
      this.perform(chat, request.turnId, parsed.call, signal),
    );
  }

  /** Turn end, composer Stop or conversation retirement in the engine. Only
   * that chat stops; other chats keep their apps. */
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
    this.stoppedTurns.delete(key);
    const chat = this.chats.get(key);
    if (!chat) {
      this.publish();
      this.pump();
      return false;
    }
    this.end(chat, request.reason === "stop" ? CANCELLED : ENDED);
    return true;
  }

  /** The control bar's Stop. Ends every chat the bar names and
   * refuses the rest of their turns. */
  stopFromUser(): boolean {
    const shown = [...this.chats.values()].filter((chat) => chat.apps.size > 0);
    if (shown.length === 0) return false;
    for (const chat of shown) {
      remember(this.stoppedTurns, chat.key, chat.turnId);
      this.end(chat, STOPPED_BY_USER);
    }
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const chat of [...this.chats.values()]) this.end(chat, UNAVAILABLE);
    this.rejectWaiting(UNAVAILABLE);
    this.cancelIdle();
    await this.stopHost();
  }

  private chatFor(request: ComputerToolInvokeRequest, key: string): ChatRun {
    const existing = this.chats.get(key);
    if (existing) {
      existing.turnId = request.turnId;
      existing.agent = request.agent;
      return existing;
    }
    const chat: ChatRun = {
      key,
      workspaceId: request.owner.workspaceId,
      conversationId: request.owner.conversationId,
      agent: request.agent,
      turnId: request.turnId,
      session: null,
      opening: false,
      label: null,
      apps: new Map(),
      current: null,
      tail: Promise.resolve(),
      ended: new AbortController(),
      endReason: null,
    };
    this.chats.set(key, chat);
    this.cancelIdle();
    return chat;
  }

  private serialize<T>(chat: ChatRun, work: () => Promise<T>): Promise<T> {
    const run = chat.tail.then(work, work);
    chat.tail = run.catch(() => undefined);
    return run;
  }

  /** The chat's lease on `app`, waiting in that app's line while another
   * chat holds it. */
  private async acquireApp(
    chat: ChatRun,
    app: ComputerApp,
    scope: AbortSignal,
  ): Promise<AppLease> {
    const bundleId = app.bundleId.toLowerCase();
    const deadline = Date.now() + this.waitTimeoutMs;
    try {
      for (;;) {
        if (this.chats.get(chat.key) !== chat || chat.ended.signal.aborted) {
          throw new RefusedError(chat.endReason ?? ENDED);
        }
        if (scope.aborted) throw new RefusedError(CANCELLED);
        if (this.disposed) throw new RefusedError(UNAVAILABLE);
        if (!this.preferences.enabled) throw new RefusedError(OFF);
        if (this.blocked(app)) throw new RefusedError(blockedText(app.name));
        const held = this.leases.get(bundleId);
        if (held?.chat === chat) {
          this.present(chat, held, app);
          return held;
        }
        const first = this.waiting.find((entry) => entry.bundleId === bundleId);
        if (
          !held &&
          (!first || first.key === chat.key)
        ) {
          if (first) this.waiting.splice(this.waiting.indexOf(first), 1);
          const lease: AppLease = {
            bundleId,
            app,
            chat,
            ended: new AbortController(),
          };
          this.leases.set(bundleId, lease);
          chat.apps.set(bundleId, lease);
          this.cancelIdle();
          this.present(chat, lease, app);
          return lease;
        }
        if (held && this.waitsOn(held.chat, chat)) {
          throw new RefusedError(deadlockText(app.name));
        }
        await this.wait(chat, bundleId, app.name, scope, deadline);
      }
    } catch (error) {
      // A woken chat that gives up must not hold the head of its app's line.
      const entry = this.waiting.find(
        (candidate) => candidate.key === chat.key && candidate.bundleId === bundleId,
      );
      if (entry && entry.wakers.size === 0) this.dropWaiting(entry);
      throw error;
    }
  }

  /** Whether `holder` waits, directly or through other chats, for an app
   * `requester` holds. Each chat waits for at most one app at a time. */
  private waitsOn(holder: ChatRun, requester: ChatRun): boolean {
    const seen = new Set<ChatRun>();
    let current: ChatRun | undefined = holder;
    while (current && !seen.has(current)) {
      seen.add(current);
      const key: string = current.key;
      const entry: WaitEntry | undefined = this.waiting.find(
        (candidate) => candidate.key === key && candidate.wakers.size > 0,
      );
      if (!entry) return false;
      const next: ChatRun | undefined = this.leases.get(entry.bundleId)?.chat;
      if (next === requester) return true;
      current = next;
    }
    return false;
  }

  private wait(
    chat: ChatRun,
    bundleId: string,
    appName: string,
    scope: AbortSignal,
    deadline: number,
  ): Promise<void> {
    let entry = this.waiting.find(
      (candidate) => candidate.key === chat.key && candidate.bundleId === bundleId,
    );
    if (!entry) {
      entry = {
        key: chat.key,
        workspaceId: chat.workspaceId,
        conversationId: chat.conversationId,
        agent: chat.agent,
        bundleId,
        appName,
        wakers: new Set(),
      };
      this.waiting.push(entry);
      this.publish();
    }
    const waitEntry = entry;
    return new Promise<void>((resolve, reject) => {
      const finish = (error: Error | null) => {
        clearTimeout(timer);
        scope.removeEventListener("abort", onAbort);
        waitEntry.wakers.delete(finish);
        if (error) {
          if (waitEntry.wakers.size === 0) this.dropWaiting(waitEntry);
          reject(error);
        } else {
          resolve();
        }
      };
      const onAbort = () => finish(new RefusedError(CANCELLED));
      const timer = setTimeout(
        () => finish(new RefusedError(busyText(appName))),
        Math.max(0, deadline - Date.now()),
      );
      timer.unref?.();
      waitEntry.wakers.add(finish);
      scope.addEventListener("abort", onAbort, { once: true });
    });
  }

  private dropWaiting(entry: WaitEntry): void {
    const index = this.waiting.indexOf(entry);
    if (index < 0) return;
    this.waiting.splice(index, 1);
    this.publish();
    this.pump();
  }

  /** Wake the first chat in each free app's line. */
  private pump(): void {
    if (this.disposed) return;
    const seen = new Set<string>();
    for (const entry of [...this.waiting]) {
      if (seen.has(entry.bundleId)) continue;
      seen.add(entry.bundleId);
      if (this.leases.has(entry.bundleId)) continue;
      for (const wake of [...entry.wakers]) wake(null);
    }
  }

  private rejectEntry(entry: WaitEntry, reason: string): void {
    for (const wake of [...entry.wakers]) wake(new RefusedError(reason));
    this.dropWaiting(entry);
  }

  private rejectWaiting(reason: string, key?: string): void {
    for (const entry of [...this.waiting]) {
      if (key === undefined || entry.key === key) this.rejectEntry(entry, reason);
    }
  }

  /** Bring a window forward for one driver call, one chat at a time, so two
   * chats never take focus from each other. */
  private async inForeground<T>(
    scope: AbortSignal,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.foreground;
    let release!: () => void;
    this.foreground = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await untilAborted(previous, scope);
      return await work();
    } finally {
      // A chat that gave up waiting still hands over only after the chat
      // before it finished.
      void previous.then(release);
    }
  }

  private async perform(
    chat: ChatRun,
    turnId: string,
    call: ComputerToolCall,
    signal: AbortSignal,
  ): Promise<ComputerToolResult> {
    if (this.chats.get(chat.key) !== chat || chat.ended.signal.aborted) {
      return failure(chat.endReason ?? ENDED);
    }
    if (this.stoppedTurns.get(chat.key) === turnId) {
      return failure(STOPPED_BY_USER);
    }
    if (signal.aborted) return failure(CANCELLED);
    const scope = AbortSignal.any([signal, chat.ended.signal]);
    try {
      return await this.run(chat, call, scope);
    } catch (error) {
      if (chat.ended.signal.aborted) return failure(chat.endReason ?? ENDED);
      if (signal.aborted) return failure(CANCELLED);
      if (error instanceof RefusedError) return failure(error.message);
      if (error instanceof SessionExpiredError) {
        const expired = chat.session;
        chat.session = null;
        try {
          expired?.close();
        } catch {
          // Already gone on the driver side.
        }
        return failure("The computer-use session expired. Try the action again.");
      }
      if (error instanceof ComputerDriverLostError) {
        // Every session lived in that driver.
        for (const other of [...this.chats.values()]) this.end(other, LOST);
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
    chat: ChatRun,
    call: ComputerToolCall,
    scope: AbortSignal,
  ): Promise<ComputerToolResult> {
    const session = await this.session(chat, scope);
    switch (call.tool) {
      case "list_apps": {
        // Windows are cheap to list and show apps opened outside Zeros.
        const onScreen = await this.windows(session, undefined, true, scope);
        const apps = (
          await this.appListing(session, scope, (listed) =>
            listingMatchesWindows(listed, onScreen),
          )
        ).filter((app) => !this.blocked(app) && (!call.runningOnly || app.running));
        return success([{ type: "text", text: formatApps(apps) }]);
      }
      case "list_windows": {
        const onScreen = await this.windows(session, call.pid, true, scope);
        const controllable = new Map<number, ComputerApp>();
        const listed = await this.appListing(session, scope, (apps) =>
          listingMatchesWindows(apps, onScreen),
        );
        for (const app of listed) {
          if (app.running && !this.blocked(app)) controllable.set(app.pid, app);
        }
        const windows = onScreen.flatMap((window): ComputerWindow[] => {
          const app = controllable.get(window.pid);
          return app ? [{ ...window, appName: app.name }] : [];
        });
        return success([{ type: "text", text: formatWindows(windows) }]);
      }
      case "open_app": {
        const bundleId = call.bundleId ?? "";
        const apps = (
          await this.appListing(session, scope, (listed) =>
            listed.some((app) => sameComputerBundleId(app.bundleId, bundleId)),
          )
        ).filter((app) => sameComputerBundleId(app.bundleId, bundleId));
        const app = apps.find((entry) => entry.running) ?? apps[0];
        if (!app) {
          return failure(`No installed app has bundle ID ${bundleId}. Call list_apps.`);
        }
        const appScope = await this.claim(chat, app, scope);
        let launched: ComputerDriverResult | null = null;
        try {
          launched = await this.call(
            session,
            "launch_app",
            { bundle_id: app.bundleId },
            appScope,
          );
          return this.actionResult(launched);
        } finally {
          const ok = launched !== null && !launched.isError;
          const pid = ok ? launchedPid(launched!) : null;
          if (pid !== null) this.recordLaunch(app, pid);
          // An app that was running keeps its process.
          else if (!ok || !app.running) this.discardAppListing();
        }
      }
      case "open_url": {
        const bundleId = call.bundleId ?? "";
        const app = (
          await this.appListing(session, scope, (listed) =>
            listed.some((entry) => sameComputerBundleId(entry.bundleId, bundleId)),
          )
        ).find((entry) => sameComputerBundleId(entry.bundleId, bundleId));
        if (!app) {
          return failure(`No installed app has bundle ID ${bundleId}. Call list_apps.`);
        }
        if (!this.options.openUrl) return failure(UNAVAILABLE);
        const appScope = await this.claim(chat, app, scope);
        let opened = false;
        try {
          await this.options.openUrl(app.bundleId, call.url ?? "", appScope);
          opened = true;
        } finally {
          // A running app keeps its process; one that was not may start now.
          if (!opened || !app.running) this.discardAppListing();
        }
        return success([{ type: "text", text: `Opened ${call.url} in ${app.name}.` }]);
      }
      default:
        return this.act(chat, session, call, scope);
    }
  }

  /** Allowed, then leased: the scope ends with the chat or with this app's
   * lease, whichever ends first. */
  private async claim(
    chat: ChatRun,
    app: ComputerApp,
    scope: AbortSignal,
  ): Promise<AbortSignal> {
    if (this.isSelf(app)) throw new RefusedError(SELF);
    if (this.blocked(app)) throw new RefusedError(blockedText(app.name));
    const lease = await this.acquireApp(chat, app, scope);
    return AbortSignal.any([scope, lease.ended.signal]);
  }

  private async act(
    chat: ChatRun,
    session: ComputerDriverSession,
    call: ComputerToolCall,
    scope: AbortSignal,
  ): Promise<ComputerToolResult> {
    const pid = call.pid ?? 0;
    if (pid === this.options.selfPid) return failure(SELF);
    const app = (
      await this.appListing(session, scope, (apps) =>
        apps.some((entry) => entry.running && entry.pid === pid),
      )
    ).find((entry) => entry.running && entry.pid === pid);
    if (!app) {
      return failure(`No app you can control has process ID ${pid}. Call list_apps.`);
    }
    const appScope = await this.claim(chat, app, scope);
    if (call.windowId !== undefined) {
      const windows = await this.windows(session, pid, false, appScope);
      if (!windows.some((window) => window.windowId === call.windowId)) {
        return failure(
          `Window ${call.windowId} is not a window of ${app.name}. Call list_windows.`,
        );
      }
    }
    const tool = DRIVER_TOOLS[call.tool as keyof typeof DRIVER_TOOLS];
    const args = computerDriverArguments(call);
    const send = (driverArgs: Record<string, unknown>) => {
      const deliver = () => this.call(session, tool, driverArgs, appScope);
      return driverArgs.delivery_mode === "foreground"
        ? this.inForeground(appScope, deliver)
        : deliver();
    };
    let result = await send(args);
    if (
      call.tool === "press_key" &&
      call.windowId !== undefined &&
      keyboardNeedsForeground(result)
    ) {
      result = await send({ ...args, delivery_mode: "foreground" });
    }
    if (call.tool !== "screenshot") return this.actionResult(result);
    if (result.isError) return failure(driverFailureText(result));
    return success([
      ...agentImages(result),
      { type: "text", text: formatWindowState(result, app.name) },
    ]);
  }

  /** The chat now acts in `app`: name it in the state and on the bar. */
  private present(chat: ChatRun, lease: AppLease, app: ComputerApp): void {
    lease.app = app;
    chat.current = app;
    this.publish();
    this.refreshPanel();
  }

  private refreshPanel(): void {
    const presentation = computerControlBar(
      [...this.chats.values()]
        .filter((chat) => chat.apps.size > 0)
        .map((chat) => ({
          label: chat.label ?? agentControlName(chat.agent),
          app: chat.current?.name ?? null,
        })),
    );
    if (presentation) this.options.panel.show(presentation);
    else this.options.panel.hide();
  }

  private async session(
    chat: ChatRun,
    scope: AbortSignal,
  ): Promise<ComputerDriverSession> {
    if (chat.session) return chat.session;
    this.cancelIdle();
    // Restarting the driver would end other chats' sessions; it waits until
    // a session opens with none of theirs open.
    if (this.restartForPermissions && !this.otherSessionOpen(chat)) {
      this.restartForPermissions = false;
      if (this.hostRunning) await this.stopHost();
    }
    const label = agentControlName(chat.agent);
    chat.opening = true;
    let session: ComputerDriverSession;
    try {
      session = await this.options.host.openSession(label, scope);
    } finally {
      chat.opening = false;
    }
    this.hostRunning = true;
    if (this.chats.get(chat.key) !== chat || chat.ended.signal.aborted) {
      session.close();
      throw new RefusedError(chat.endReason ?? ENDED);
    }
    chat.session = session;
    chat.label = session.label ?? label;
    await this.applyCursor(chat, session, scope).catch((error: unknown) => {
      if (error instanceof ComputerDriverLostError) throw error;
    });
    return session;
  }

  private otherSessionOpen(chat: ChatRun): boolean {
    for (const other of this.chats.values()) {
      if (other !== chat && (other.session || other.opening)) return true;
    }
    return false;
  }

  private async applyCursor(
    chat: ChatRun,
    session: ComputerDriverSession,
    scope: AbortSignal,
  ): Promise<void> {
    const label = chat.label;
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

  /** The Mac's app listing, shared by every chat. When `matches` says the
   * cached listing misses what the caller sees, it is read once more. */
  private async appListing(
    session: ComputerDriverSession,
    scope: AbortSignal,
    matches: (apps: readonly ComputerApp[]) => boolean = () => true,
  ): Promise<ComputerApp[]> {
    const cached = this.appList;
    if (cached && Date.now() - cached.at < APP_LIST_TTL_MS && matches(cached.apps)) {
      return cached.apps;
    }
    const reading = this.appListRead;
    if (reading) {
      try {
        return await untilAborted(reading.promise, scope);
      } catch (error) {
        // Another chat's read failed on its own session; read on this one.
        if (scope.aborted || reading.session === session) throw error;
      }
    }
    return untilAborted(this.readAppListing(session), scope);
  }

  /** One driver read for every chat that asks meanwhile. A chat that stops
   * waiting does not cancel it for the others. */
  private readAppListing(session: ComputerDriverSession): Promise<ComputerApp[]> {
    const generation = this.appListGeneration;
    const promise = this.call(
      session,
      "list_apps",
      {},
      new AbortController().signal,
    ).then((result) => {
      if (result.isError) throw new RefusedError(driverFailureText(result));
      const apps = readApps(result);
      if (this.appListGeneration === generation) this.appList = { at: Date.now(), apps };
      return apps;
    });
    const read = { promise, session };
    this.appListRead = read;
    const settle = () => {
      if (this.appListRead === read) this.appListRead = null;
    };
    promise.then(settle, settle);
    return promise;
  }

  /** An app opened through Zeros has a new process; a read already under way
   * may predate it. */
  private discardAppListing(): void {
    this.appList = null;
    this.appListRead = null;
    this.appListGeneration += 1;
  }

  /** A launch the driver reported leaves every other app as listed. */
  private recordLaunch(app: ComputerApp, pid: number): void {
    const listing = this.appList;
    this.appListRead = null;
    this.appListGeneration += 1;
    if (!listing) return;
    const index = listing.apps.findIndex(
      (entry) => sameComputerBundleId(entry.bundleId, app.bundleId) && entry.name === app.name,
    );
    if (index < 0) {
      this.appList = null;
      return;
    }
    const apps = [...listing.apps];
    apps[index] = { ...apps[index]!, pid, running: true };
    this.appList = { at: listing.at, apps };
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
    return this.isSelf(app) || this.blockedBundle(app.bundleId);
  }

  private blockedBundle(bundleId: string): boolean {
    return (
      ZEROS_BUNDLE.test(bundleId) ||
      this.preferences.blockedApps.some((blocked) =>
        sameComputerBundleId(blocked, bundleId),
      )
    );
  }

  /** End one chat: its in-flight actions fail with `reason`, its apps free
   * up for the next chat in line, and its cursor goes away. */
  private end(chat: ChatRun, reason: string): void {
    if (chat.ended.signal.aborted) return;
    chat.endReason = reason;
    chat.ended.abort(new Error(reason));
    if (this.chats.get(chat.key) === chat) this.chats.delete(chat.key);
    for (const lease of chat.apps.values()) {
      lease.ended.abort(new Error(reason));
      if (this.leases.get(lease.bundleId) === lease) this.leases.delete(lease.bundleId);
    }
    chat.apps.clear();
    const session = chat.session;
    chat.session = null;
    try {
      session?.close();
    } catch {
      // Closing is best effort; the driver's own idle expiry reclaims it.
    }
    this.refreshPanel();
    this.publish();
    this.pump();
    this.scheduleIdle();
  }

  /** End one app's lease, such as an app the user just blocked. The chat
   * keeps its other apps. */
  private endLease(lease: AppLease, reason: string): void {
    if (lease.ended.signal.aborted) return;
    lease.ended.abort(new Error(reason));
    if (this.leases.get(lease.bundleId) === lease) this.leases.delete(lease.bundleId);
    const chat = lease.chat;
    chat.apps.delete(lease.bundleId);
    if (chat.current?.bundleId.toLowerCase() === lease.bundleId) {
      chat.current = [...chat.apps.values()].at(-1)?.app ?? null;
    }
    this.refreshPanel();
    this.publish();
    this.pump();
  }

  private scheduleIdle(): void {
    if (
      this.disposed ||
      !this.hostRunning ||
      this.chats.size > 0 ||
      this.waiting.length > 0
    ) {
      return;
    }
    this.cancelIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.chats.size === 0 && this.waiting.length === 0) void this.stopHost();
    }, this.idleStopMs);
    this.idleTimer.unref?.();
  }

  private cancelIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async stopHost(): Promise<void> {
    this.hostRunning = false;
    // A new driver starts with the current macOS grants.
    this.restartForPermissions = false;
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
