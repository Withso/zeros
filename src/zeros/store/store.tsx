import type { ComposerAttachment } from "../agent/composer-attachments";
import type { AgentTextMessageAttachment } from "../agent/use-agent-session";
import type { Column3ScopeMap } from "../../shell/column3-tab-manager";

export { normalizeChatPermissionMode } from "./chat-permission";

// Re-export the Zustand store + slice selector hooks so consumers keep
// importing from "./store" (their existing path) while migrating off the
// whole-store `useWorkspace()` shim. See ./workspace-store.ts for the hooks.
export {
  useWorkspaceStore,
  useWorkspaceDispatch,
  selectActiveFolder,
  selectLiveFolder,
  selectActiveChatForFolder,
  selectMostRecentChatForFolder,
  selectChatToRestoreForFolder,
  selectLastWorkspaceFolderForRepo,
  selectRepoPageView,
  useActivePage,
  useActiveRepoId,
  useActiveChatId,
  useNewAgentFolder,
  useProjectConnection,
  useProjectGeneration,
  useBrowserPickerSelection,
  usePendingChatSubmission,
  usePendingAutoSend,
  usePendingComposerAppend,
  useChats,
  useChatById,
  useColumn3Tabs,
  useActiveColumn3TabId,
  useRecentColumn3Browsers,
  useEditComposerDraft,
  type Action,
} from "./workspace-store";

// Phase D3 (2026-05-08): per-surface composer draft. Survives the
// Column2ChatView remount-on-chat-switch cycle (the chat view is
// keyed by activeChatId, so the underlying AgentChat is destroyed
// when the user navigates away). Storing here lets the next mount
// seed back to the user's last-typed state.
export interface ComposerDraft {
  text: string;
  attachments: ComposerAttachment[];
  /** TipTap editor state (text + inline mention/attachment pills). When
   *  present it is the source of truth for restoring the composer; `text`
   *  is kept for display/back-compat with pre-editor drafts. */
  json?: object | null;
}

// Per-message edit-mode draft. Same lifecycle reasoning as the
// composer drafts above: the chat view remounts on chat switch, so
// keeping this in TurnPromptHeader's local state lost the work
// whenever the user navigated away. Lifted here keyed by
// `${chatId}:${messageId}` so cleanup on chat delete is trivial.
export interface EditDraftStash {
  text: string;
  newAttachments: ComposerAttachment[];
  /** Subset of the original message's attachments the user wants to
   *  keep. Initialized to all originals; user can remove any while
   *  editing. */
  keptOriginals: AgentTextMessageAttachment[];
  /** TipTap editor state (text + inline mention/new-attachment pills). The
   *  source of truth for restoring an in-progress edit; `text`/`newAttachments`
   *  stay for back-compat + the pristine check. */
  json?: object | null;
}

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

export type ProjectConnection = {
  name: string;
  devServerUrl: string;
  productionUrl?: string;
  framework: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  errorMessage?: string;
};

/** Primary element picked in a browser tab (iframe picker). */
export type BrowserPickerSelection = {
  selector: string;
  tag: string;
  componentName?: string | null;
  styles?: Record<string, string>;
};

export type AppView = "onboarding" | "workspace";
export type WorkspacePage =
  | "workspace"
  | "settings"
  | "dashboard"
  | "customize"
  | "repo";
/** Home's durable destinations. `repo` is paired with `activeRepoId`. */
export type HomePage = Exclude<WorkspacePage, "workspace">;
/** One repository hub's durable inner destination. */
export type RepoPageView =
  | "workspaces"
  | "environment"
  | "git"
  | "actions"
  | "files"
  | "paths";

// Phase 4 introduces the CLI-subprocess backends. Legacy values
// ("chatgpt" / "openai" / "ide") stay in the union so existing
// saved settings round-trip — loadAiSettings() migrates them to
// the new values on read.
export type AiProvider =
  | "claude"
  | "codex"
  // legacy, kept for backward-compat on reload
  | "chatgpt"
  | "openai"
  | "ide";

export type AiAuthMethod = "subscription" | "api-key";
export type AiThinkingEffort = "low" | "medium" | "high" | "xhigh";
export type AiPermissionMode = "plan" | "ask" | "auto-edit" | "full";

export type AiSettings = {
  provider: AiProvider;
  authMethod: AiAuthMethod;
  proxyUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  autoSendFeedback: boolean;
  thinkingEffort: AiThinkingEffort;
  /** Default permission mode for new chats. Individual chats may
   *  override this; today the composer reads/writes this global
   *  default — a per-chat override is not implemented yet. */
  permissionMode: AiPermissionMode;
  agentTeams: boolean;
};

// ── Theme / Token types ──
export type TokenSyntax =
  | "color"
  | "length-percentage"
  | "percentage"
  | "number"
  | "angle"
  | "time"
  | "*";

export type DesignToken = {
  name: string; // e.g. "--blue-500"
  /** themeId → value, e.g. { default: "#3B82F6", light: "#2563EB" } — check:ui ignore-line */
  values: Record<string, string>;
  syntax: TokenSyntax;
  description: string;
  inherits: boolean;
  group: string; // derived from name, e.g. "blue"
};

export type ThemeColumn = {
  id: string;
  name: string;
  isDefault: boolean;
};

export type ThemeFile = {
  id: string;
  name: string; // filename, e.g. "variables.css"
  // In the Mac app we keep an absolute path; the browser-only File
  // System Access API handle stays around for the legacy dev harness.
  // One of the two must be set.
  handle: FileSystemFileHandle | null;
  path: string | null;
  content: string; // raw CSS content
  tokens: DesignToken[];
  themes: ThemeColumn[];
  lastSynced: number;
};

export type WorkspaceState = {
  currentView: AppView;
  project: ProjectConnection | null;

  /** Browser tab iframe picker — drives @selection mentions. */
  browserPickerSelection: BrowserPickerSelection | null;

  activePage: WorkspacePage;

  // Last destination inside the Home surface. Workspace navigation hides Home
  // without replacing this identity, so returning through the Home button
  // restores Dashboard / Settings / the repository hub in the first snapshot.
  lastHomePage: HomePage;

  // The project (repo) whose Home-tab repo page is open when activePage ===
  // "repo". Kept when navigating away so returning to the Home tab can land
  // back on the same repo. Validated against the live project list at render
  // time (MainShellBody) — a removed repo falls back to the Dashboard rather
  // than rendering a dead page.
  activeRepoId: string | null;
  // Repository-hub tabs belong to their repository, not to the app. Switching
  // repo A → B → A therefore restores A's own last view rather than leaking B's.
  repoPageViewByProject: Record<string, RepoPageView>;
  isLoading: boolean;

  // AI settings
  aiSettings: AiSettings;

  // Chat threads (Phase 1B-e). Persisted via src/native/settings.ts;
  // `activeChatId` scopes which conversation the Column 2 Chat panel is
  // currently rendering. Session messages live in the sessions store and
  // recent transcript DOM lives in a bounded retained deck.
  chats: ChatThread[];
  activeChatId: string | null;

  // One-shot hand-off to Column 2's chat panel (Phase 2-B). InlineEdit
  // and the feedback pill used to call the AI themselves; in the Mac
  // app all AI flows route into the integrated chat instead. Setting
  // this triggers Column 2 to switch to the Chat tab, AIChatPanel to
  // auto-submit the text, then clear via CONSUME_CHAT_SUBMISSION.
  pendingChatSubmission: PendingChatSubmission | null;

  // Exact-chat auto-send intents. A prepared workspace can expose its composer
  // before checkout finishes; pressing Send records that chat id here and keeps
  // its full TipTap draft intact. Once the exact create lifecycle publishes and
  // the session is ready, AgentChat serializes its own composer and consumes
  // only that id. A map (rather than the former single slot) lets many workspace
  // creates queue independently without the newest one overwriting the others.
  pendingAutoSend: Record<string, true>;

  // Roadmap 03b Phase 4.5: ⌥+click in the browser-tab element picker
  // appends element context to the active chat's composer WITHOUT
  // submitting (unlike pendingChatSubmission which auto-fires). The
  // AgentChat component picks this up, merges text into its local
  // input state, and dispatches CONSUME_COMPOSER_APPEND.
  pendingComposerAppend: PendingComposerAppend | null;

  // Scope override for the EmptyComposer. Normally the new-agent
  // surface resolves its folder from the engine's project root. When
  // the user clicks "+" on a secondary workspace section in Column 1,
  // we want the empty composer to be contextual to *that* workspace,
  // not the engine root — so the first chat created from it lands in
  // the right project. Cleared by the composer after ADD_CHAT.
  newAgentFolder: string | null;

  // Last resolved active-workspace folder — the workspace the user was
  // looking at, persisted across restarts so a reopen lands on the SAME
  // workspace. Unlike `newAgentFolder` (the empty-composer scope, which is
  // CLEARED the moment a chat becomes active), this mirrors the active chat's
  // folder OR newAgentFolder and is NEVER cleared, so it survives the boot
  // window before chats hydrate. It is the final fallback in the folder
  // resolution chain (selectActiveFolder) — without it the topbar/tabs
  // flash "No workspace selected" until HYDRATE_CHATS lands.
  lastWorkspaceFolder: string | null;

  // Last workspace selection PER repository root. `lastWorkspaceFolder` stays
  // as the live/boot fallback; this map owns repository round trips so choosing
  // another repo never overwrites the workspace remembered for the first one.
  lastWorkspaceByRepoRoot: Record<string, string>;

  // Cold-cache repository switches publish their remembered folder immediately
  // but defer default-chat creation until the exact workspace-list key confirms
  // it. In-memory only: a reload starts normal boot validation again.
  pendingWorkspaceValidationFolder: string | null;

  // Per-workspace last-active chat — maps a workspace folder path to the id of
  // the chat the user was last VIEWING there. Restores your place when you
  // switch away from a workspace and back. Without it, returning to a workspace
  // re-derived the chat by `updatedAt DESC` (the most recently *edited* chat),
  // which is not the one you were *looking at* — selecting/viewing a chat never
  // bumps updatedAt, so the strip silently jumped to whichever chat had the
  // latest activity. Recorded after every dispatch (rememberActiveChatForFolder),
  // validated against the live chat list on restore, and persisted across
  // reloads via persist-ui-state so a reopen + switch still lands on the right
  // chat. Keyed by the exact folder string (same identity chats match on).
  activeChatByFolder: Record<string, string>;

  // Bumps every time the user swaps the engine project root via Open
  // Workspace. Project-scoped consumers (column 1's currentRoot probe,
  // column 3 file tree, terminal, git panel) read this in their effect
  // deps so they refresh without needing a full webview reload.
  // Source-of-truth on the new root lives in the native engine — we
  // don't carry the path in the store, only the generation counter.
  projectGeneration: number;

  // Phase D3 (2026-05-08): persistent draft state per composer surface
  // so a user who's typing/attaching can switch chats (or away and
  // back to the new-agent landing) without losing their work. Stored
  // in-memory only — drops on app reload, like any unsaved chat input.
  // - chatComposerDrafts: keyed by chatId for the AgentChat composer
  // Cleared on submit; the cleanup-on-unmount writes the live state
  // back through SET_*_DRAFT.
  chatComposerDrafts: Record<string, ComposerDraft>;

  // Per-past-user-message edit drafts. Keyed by `${chatId}:${messageId}`
  // so cleanup on chat delete is a prefix scan. Survives chat switches
  // — that was the bug: the local state in TurnPromptHeader died with
  // AgentChat's unmount, and a user who clicked away after editing
  // came back to find their work gone.
  editComposerDrafts: Record<string, EditDraftStash>;

  // Column 3 tabs, scoped PER WORKTREE (keyed by folder path). The tab strip
  // in column 3's own header drives the active worktree's slice; one tab body
  // renders at a time. Persisted to localStorage via
  // column3-tab-manager.saveScopes; hydrated at store init from loadScopes().
  // The active slice is read via selectColumn3 (workspace-store.ts) so tabs
  // stay with their worktree instead of leaking across all of them.
  column3ByScope: Column3ScopeMap;
};

/** Phase D2 (2026-05-07): a summary imported from a prior chat in the
 *  same folder. The EmptyComposer surfaces these as monochrome chips
 *  above its textarea; on submit they're serialized into
 *  <from_previous_chat> blocks and prepended to the user's prompt
 *  text. The new chat's agent then reads them as plain context — the
 *  format is universal across agents. */
export interface SummaryImport {
  /** Source chat id — for dedupe + provenance. */
  chatId: string;
  /** Source chat title — surfaced inside the <from_previous_chat>
   *  tag's `name` attribute so the consuming agent has a label. */
  title: string;
  /** Source agent id — surfaced inside the `agent` attribute and
   *  used by the chip to render the right monochrome logo. */
  agentId: string | null;
  /** The actual summary body. Plain text, agent-agnostic. */
  summary: string;
}

/** Roadmap 03b Phase 4.5: append (don't submit) into a chat's
 *  composer. Used by ⌥+click in the browser-tab element picker to
 *  drop element context into the user's prompt without submitting.
 *  Distinct from PendingChatSubmission, which auto-fires.
 *
 *  Targeting: `chatId` pins the append to a specific chat thread.
 *  (A null chatId once landed in the new-agent landing's draft; that
 *  landing was removed 2026-06-18, so a null-chatId append now has no
 *  consumer.) AgentChat consumers ignore appends for other chatIds. */
export type PendingComposerAppend = {
  id: string;
  /** Text to append (typically formatted element context). */
  text: string;
  /** Target chat. Null = the (removed) new-agent landing — no consumer. */
  chatId: string | null;
  source: "element-picker" | "manual";
};

export type PendingChatSubmission = {
  id: string;
  text: string;
  source: "inline-edit" | "feedback" | "manual";
  /** Phase D2 (2026-05-07): summary imports from prior chats. The
   *  EmptyComposer attaches them as chips; the submission consumer
   *  in agent-chat serializes them into <from_previous_chat> blocks
   *  and prepends to the prompt text on first send. */
  imports?: SummaryImport[];
  /** Phase D2 (2026-05-07): inline image attachments encoded as
   *  ContentBlocks. Previously the EmptyComposer's image picker
   *  built these in-place but they were never carried to the new
   *  chat — only `text` survived through ENQUEUE_CHAT_SUBMISSION.
   *  Putting them here so any submission path can ride along. The
   *  shape is the bridge's `ContentBlock` (see
   *  src/zeros/bridge/agent-events.ts) — kept as `unknown[]` here to
   *  avoid pulling the bridge type into the store layer. */
  attachments?: unknown[];
  /** Phase D2 iter 4: metadata to stamp on the user-message bubble
   *  when the new chat opens — names + thumbnails for the chip row
   *  the renderer paints above the user's text. Shape mirrors
   *  `AgentTextMessageAttachment` from
   *  src/zeros/agent/use-agent-session.tsx; kept as `unknown[]` here
   *  for the same store-layer-decoupling reason as `attachments`. */
  bubbleAttachments?: unknown[];
  /** 2026-06-08: ordered bubble segments (text + inline mention/attachment
   *  pills) so the new chat's first user bubble renders exactly as composed.
   *  Shape mirrors `MessageContentSegment`; kept as `unknown[]` for the same
   *  store-layer decoupling as the fields above. */
  segments?: unknown[];
};

/** How much reasoning effort the model should spend before replying.
 *  Mapped per-agent to the right flag/env on session spawn.
 *
 *  The effort ladder Zeros exposes (per the composer effort toggle):
 *    low · medium · high · xhigh · max · ultracode
 *  Not every model supports the whole ladder — see effortLevelsFor() in
 *  model-catalog.ts (Opus = all six; Sonnet/GPT = low…xhigh; Haiku = low…high).
 *  Mapping to the agent: Claude takes `low|medium|high|xhigh|max` as the SDK
 *  `effort` option, and "ultracode" → `xhigh` + the `ultracode` setting
 *  (xhigh effort plus standing multi-agent-workflow permission). Codex
 *  has no `max`/`ultracode`, so it clamps to `xhigh`. */
export type ChatEffort =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultracode";

/** Permission posture for a chat — the user-facing "Permissions" choice, mapped
 *  per agent to a concrete native mode (see agentModeForPermission):
 *    plan          → Claude "plan" / Codex "read-only" — design, no execution
 *    auto          → Claude "auto" (classifier) / Codex "auto-edit" (on-failure +
 *                    sandbox) — the SAFE default every new chat is born with
 *    tool-approval → Claude "default" / Codex "ask" — prompt before tools run
 *    danger        → Claude "bypass" / Codex "full-access" — no checks at all */
export type ChatPermissionMode = "plan" | "auto" | "tool-approval" | "danger";

/** Map a persisted (possibly legacy) permission value onto the current posture.
 *  The pre-2026-07 vocabulary was full/auto-edit/ask/plan-only; normalize it so
 *  old chats open in a sensible posture. This only backs the coarse posture
 *  bucket — a chat's `lastModeId` still restores its EXACT native mode when set. */
export type ChatThread = {
  id: string;
  /** Backend contract. Both values render through the exact same Column 2 chat
   * components; design changes only instructions, tools, and workspace shell. */
  mode?: "code" | "design";
  /** Absolute path of the project this chat belongs to, or "" for the
   *  ambient "No project" folder when Zeros hasn't been rooted yet.
   *  Doubles as the cwd for the agent session, git panel, terminal, env. */
  folder: string;
  /** Discriminator. `"chat"` (default when undefined for back-compat) is
   *  the engine-driven AgentChat session. `"terminal"` is a PTY-backed
   *  terminal-agent tab — `agentId` holds a terminal-agents catalog id
   *  and Column2ChatView mounts a `TerminalSessionView` instead of
   *  `AgentChat`. The two paths share the tab strip + history surface so
   *  the user manages both with one mental model. */
  kind?: "chat" | "terminal";
  /** agent id bound to this chat. null means "pick the default agent
   *  when the session first starts" — set once and immutable thereafter.
   *  For `kind: "terminal"` this is a terminal-agents catalog id
   *  (e.g. "claude", "codex") rather than a bridge-registry id. */
  agentId: string | null;
  /** Human label for the agent (e.g. "Claude Agent"). Cached on chat
   *  creation so the header can render without a registry lookup. */
  agentName: string | null;
  /** Model id (agent-specific — e.g. "claude-opus-4-7" for claude).
   *  null means "use the agent's default". Changing forces session respawn
   *  because most agents read the model from env at spawn time. */
  model: string | null;
  /** Reasoning effort — mapped to each agent's flag/env at spawn. */
  effort: ChatEffort;
  /** Fast mode — lower-latency inference at higher token cost. Claude maps
   *  it to the SDK `fastMode` setting (Opus only); Codex to `service_tier:
   *  "fast"` (GPT-5.x only). Carried via env (ZEROS_FAST_MODE) and applied on
   *  the next session (re)spawn, like effort. undefined ≡ off. */
  fast?: boolean;
  /** Extra working directories Claude can access beyond `folder` (the `/add-dir`
   *  command, SDK `Options.additionalDirectories`). Absolute paths, de-duped.
   *  Carried via env (ZEROS_ADDITIONAL_DIRS) and applied on the next session
   *  (re)spawn, like effort/fast (Claude resumes, so context survives). Claude
   *  only today; undefined/[] ≡ none. */
  additionalDirectories?: string[];
  /** Permission gate. Plumbed via agent session/set_mode when the agent
   *  advertises mode support; otherwise stored and applied to new
   *  sessions. Persisted, so it's re-applied on every (re)spawn — a mode the
   *  user picks (pill / "+" menu / plan toggle) survives an effort/model/fast
   *  respawn and an app restart. */
  permissionMode: ChatPermissionMode;
  /** The EXACT agent mode id the user last selected in-session (Claude:
   *  default/plan/accept-edits/auto/bypass; Codex: ask/auto-edit/full-access/
   *  read-only). Unlike `permissionMode` (a coarse posture that can't tell
   *  accept-edits from auto, or default from ask), this round-trips losslessly
   *  so reconcile re-applies the user's EXACT mode after an effort/model/fast
   *  respawn. Set on every in-session mode change; undefined for a chat that
   *  hasn't changed mode in-session (reconcile then uses the posture bucket). */
  lastModeId?: string;
  /** The exact agent mode id to return to when the Plan toggle is switched OFF
   *  (the mode the user was in before entering plan — e.g. "bypass"/"auto").
   *  Set when the toggle enters plan, cleared on exit or an explicit mode pick.
   *  Stored as the exact id (not a bucket) so "exit plan → previous mode"
   *  restores bypass/auto exactly. undefined ≡ exit → the agent's default. */
  prePlanModeId?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Persistent agent sessionId. Source-of-truth link from a chat
   *  in our sidebar to the on-disk transcript the agent CLI writes
   *  (Claude: ~/.claude/projects/<hash>/<sessionId>.jsonl, Codex:
   *  ~/.codex/sessions/...). Set in three ways:
   *    - "Resume from recent thread" UI seeds it on chat creation.
   *    - First successful new-session creation writes it back.
   *    - It updates whenever the active agent forks / starts a new
   *      session under the same chat (model swap with force=true).
   *  Provider state is a hot cache; this field survives app restarts
   *  and is what lets us replay history on next mount. Cleared if a
   *  loadIntoChat fails so retry can fall through to a fresh session. */
  sessionId?: string;
  /** Pinned to the top of the sidebar, independent of project grouping.
   *  Cursor-style favorites. Defaults to false / undefined for old records. */
  pinned?: boolean;
  /** Soft-deleted. Archived chats hide from the main sidebar groupings
   *  (pinned + per-project) and surface in a collapsible "Archived"
   *  section at the bottom, where they can be restored or permanently
   *  deleted. The on-disk transcript is never touched by archive —
   *  only DELETE_CHAT removes the metadata entry. */
  archived?: boolean;
  /** Chat that spawned this one via agent-switch. When set and this chat
   *  has no messages yet, the composer offers a "summary handoff" pill
   *  at the top so the user can paste the prior conversation into the
   *  new agent's first turn. Cleared the moment the user either accepts
   *  or dismisses the handoff. */
  sourceChatId?: string;
};

// The `Action` union, `initialState`, and the `reducer` moved to
// ./workspace-store.ts during the Zustand migration (2026-05-31). They are
// reused there verbatim as the store's engine — see that file's header. The
// type definitions above stay here as the module's public surface.

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

// The Zustand store, slice selectors, `useWorkspaceDispatch`, and reload
// persistence now live in ./workspace-store.ts (re-exported at the top of
// this file). The old `WorkspaceProvider` + `useWorkspace()` Context shim
// were removed once every consumer moved to slice selectors.
