import type { ComposerAttachment } from "../features/agent/composer-attachments";
import type { AgentTextMessageAttachment } from "../features/agent/use-agent-session";
import type { WorkbenchScopeMap } from "../shell/workbench/tab-model";
import type { WorkspaceListFilter } from "./workspace-list-filter";
import type { Workspace } from "../platform/git";
import type {
  ProviderBinding,
  ProviderMetadata,
} from "@zeros/protocol/identities";

export { normalizeChatPermissionMode } from "./chat-permission";

// Re-exported so consumers keep importing from "./store".
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
  useWorkspaceListFilter,
  useWorkspaceActivityByFolder,
  recordWorkspaceActivity,
  useCreateWorkspaceProjectId,
  useActiveRepoId,
  useActiveChatId,
  useNewAgentFolder,
  useProjectConnection,
  useProjectGeneration,
  useBrowserPickerSelection,
  usePendingChatSubmission,
  usePendingAutoSend,
  usePendingAutoSendAt,
  usePendingComposerAppend,
  useChats,
  useChatById,
  useWorkbenchTabs,
  useActiveWorkbenchTabId,
  useRecentWorkbenchBrowsers,
  useEditComposerDraft,
  type Action,
} from "./workspace-store";

// Survives ChatView's remount on chat switch, so the next mount restores the
// last-typed state.
export interface ComposerDraft {
  text: string;
  attachments: ComposerAttachment[];
  /** TipTap editor state (text + inline mention/attachment pills). When
   *  present it is the source of truth for restoring the composer; `text`
   *  is kept for display/back-compat with pre-editor drafts. */
  json?: object | null;
  /** A parked send keeps its submitted canvas target, including explicit removal. */
  designFrame?: import("../features/agent/design-frame-attachment").DesignFrameAttachmentSelection | null;
}

// Lifted out of TurnPromptHeader so an edit survives the chat view's remount.
// Keyed `${chatId}:${messageId}`, so chat deletion cleans up by prefix.
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
  | "create"
  | "settings"
  | "dashboard"
  | "customize"
  | "repo";
/** Home's durable destinations. Create shares the Home shell/sidebar but has
 * its own top-bar destination and does not replace the Home button's memory. */
export type HomePage = Exclude<WorkspacePage, "workspace" | "create">;
export type { WorkspaceListFilter } from "./workspace-list-filter";
/** One repository hub's durable inner destination. */
export type RepoPageView =
  | "workspaces"
  | "environment"
  | "git"
  | "actions"
  | "files"
  | "paths";

// Current providers use CLI-subprocess backends. Legacy values
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

  /** Persisted sidebar grouping (Repository / Status / None), retaining the
   * grouped/ungrouped values. Older builds also stored Active and `repo:<id>`. */
  workspaceListFilter: WorkspaceListFilter;

  /** Bounded, persisted clock of deliberate workspace actions, keyed by the
   * exact folder that originated them. TopBar resolves descendants to their
   * semantic workspace owner; passive navigation never writes this map. */
  workspaceActivityByFolder: Record<string, number>;

  /** Repository initially selected by the routed Create Workspace page. */
  createWorkspaceProjectId: string | null;

  // Last destination inside the Home surface. Workspace navigation hides Home
  // without replacing this identity, so returning through the Home button
  // restores Dashboard / Settings / the repository hub in the first snapshot.
  lastHomePage: HomePage;

  // Kept when navigating away so the Home tab returns to the same repo; validated
  // against the live project list at render, so a removed repo falls back to the
  // Dashboard.
  activeRepoId: string | null;
  /** Ephemeral native-link destination. Its fresh ownership snapshot supports
   * explicit main-checkout links; passive navigation cannot create or resume. */
  localLinkNavigation?: { workspace: Workspace; folder: string; passive: boolean };
  /** Ephemeral selection clock. Background hydration is not a new intent. */
  navigationVersion?: number;
  // Repository-hub tabs belong to their repository, not to the app. Switching
  // repo A → B → A therefore restores A's own last view rather than leaking B's.
  repoPageViewByProject: Record<string, RepoPageView>;
  isLoading: boolean;

  aiSettings: AiSettings;

  // Messages live in the sessions store, not here; recent transcript DOM lives in
  // a bounded retained deck.
  chats: ChatThread[];
  activeChatId: string | null;

  // One-shot handoff into the Conversation pane's chat, which auto-submits the
  // text and clears it through CONSUME_CHAT_SUBMISSION.
  pendingChatSubmission: PendingChatSubmission | null;

  // Exact-chat auto-send intents. A prepared workspace can show its composer
  // before checkout finishes, so Send records the chat id and AgentChat
  // serializes its own composer once the session is ready. The value is when the
  // turn was parked: that stamp bounds the wait, since a session that never
  // settles has no transition to notice. Persisted with the draft, so a reload
  // during setup still delivers it.
  pendingAutoSend: Record<string, number>;

  // ⌥+click element context, appended to the active chat's composer without
  // submitting; AgentChat consumes it with CONSUME_COMPOSER_APPEND.
  pendingComposerAppend: PendingComposerAppend | null;

  // EmptyComposer scope override: "+" on a secondary workspace makes the first
  // chat land in that workspace instead of the engine root. Cleared after
  // ADD_CHAT.
  newAgentFolder: string | null;

  // The last active-workspace folder, persisted so a reopen lands on the same
  // workspace. Unlike newAgentFolder it is never cleared, so it is the final
  // fallback in selectActiveFolder before chats hydrate.
  lastWorkspaceFolder: string | null;

  // Last workspace selection PER repository root. `lastWorkspaceFolder` stays
  // as the live/boot fallback; this map owns repository round trips so choosing
  // another repo never overwrites the workspace remembered for the first one.
  lastWorkspaceByRepoRoot: Record<string, string>;

  // Cold-cache repository switches publish their remembered folder immediately
  // but defer default-chat creation until the exact workspace-list key confirms
  // it. In-memory only: a reload starts normal boot validation again.
  pendingWorkspaceValidationFolder: string | null;

  // On reload, knowing that a workspace exists does not mean its chat list is
  // loaded. Keep the default-chat keeper idle until that backend has replied.
  pendingChatHydrationFolder: string | null;

  // The chat last viewed per workspace folder; viewing never bumps `updatedAt`,
  // so that cannot stand in for it. Recorded after every dispatch, validated on
  // restore and persisted across reloads; keyed by the exact folder string.
  activeChatByFolder: Record<string, string>;

  // Bumps when Open Workspace swaps the engine root; project-scoped consumers
  // include it in effect deps. The root itself lives in the engine.
  projectGeneration: number;

  // Composer drafts keyed by chatId, persisted by persist-composer-drafts and
  // seeded synchronously on reload, so switching chats never loses work. Cleared
  // on submit.
  chatComposerDrafts: Record<string, ComposerDraft>;

  // Edit drafts keyed `${chatId}:${messageId}`, so chat deletion cleans up with a
  // prefix scan.
  editComposerDrafts: Record<string, EditDraftStash>;

  // Workbench tabs per worktree folder, persisted by tab-model.saveScopes and read
  // through selectWorkbench so tabs never leak across worktrees.
  workbenchByScope: WorkbenchScopeMap;
};

/** A summary imported from a prior chat in the same folder. On submit it is
 *  serialized into a <from_previous_chat> block prepended to the prompt, which
 *  every agent reads as plain context. */
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

/** Append, without submitting, into one chat's composer (⌥+click element
 *  context). AgentChat ignores appends for other chats; a null chatId has no
 *  consumer since the new-agent landing was removed. */
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
  /** Summary imports from prior chats. The
   *  EmptyComposer attaches them as chips; the submission consumer
   *  in agent-chat serializes them into <from_previous_chat> blocks
   *  and prepends to the prompt text on first send. */
  imports?: SummaryImport[];
  /** Inline image attachments in the bridge's ContentBlock shape
   *  (platform/bridge/agent-events.ts), typed `unknown[]` so the store layer
   *  never imports the bridge. */
  attachments?: unknown[];
  /** Staged composer attachment records whose image bytes still need to pass
   *  through the canonical encoder/disk writer. Used by browser captures so
   *  their full-resolution base64 never becomes bubble metadata. */
  composerAttachments?: unknown[];
  /** Bubble chip metadata (AgentTextMessageAttachment shape), `unknown[]` for the
   *  same decoupling. */
  bubbleAttachments?: unknown[];
  /** Ordered bubble segments, so the first user bubble renders exactly as
   *  composed (MessageContentSegment shape, `unknown[]` likewise). */
  segments?: unknown[];
};

/** Reasoning effort, mapped per agent at spawn. The ladder is low · medium ·
 *  high · xhigh · max · ultracode; effortLevelsFor() in model-catalog.ts says
 *  what each model supports. Claude maps "ultracode" to `xhigh` plus the
 *  `ultracode` setting; Codex maps it to its native `ultra` token and back. */
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

export type ChatThread = {
  id: string;
  /** Engine-confirmed authoring intent; independent of provider permissions. */
  composerMode?: "code" | "design";
  composerModeRevision?: number;
  /** Absolute path of the project this chat belongs to, or "" for the
   *  ambient "No project" folder when Zeros hasn't been rooted yet.
   *  Doubles as the cwd for the agent session, git panel, terminal, env. */
  folder: string;
  /** Discriminator. `"chat"` (default when undefined for back-compat) is
   *  the engine-driven AgentChat session. `"terminal"` is a PTY-backed
   *  terminal-agent tab — `agentId` holds a terminal-agents catalog id
   *  and ChatView mounts a `TerminalSessionView` instead of
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
   *  null means "use the agent's default". Native adapters apply changes live;
   *  adapters without that capability pick it up on their next session. */
  model: string | null;
  /** Reasoning effort — mapped to each agent's flag/env at spawn. */
  effort: ChatEffort;
  /** Fast mode — lower-latency inference at higher token cost. Claude maps it
   *  to the SDK `fastMode` setting; Codex to `service_tier: "fast"`; Cursor to
   *  an account-advertised fast model variant. Carried via ZEROS_FAST_MODE and
   *  applied live by native adapters. undefined ≡ off. */
  fast?: boolean;
  /** Extra working directories Claude can access beyond `folder` (the `/add-dir`
   *  command, SDK `Options.additionalDirectories`). Absolute paths, de-duped.
   *  Carried via env (ZEROS_ADDITIONAL_DIRS) and applied live by the Claude
   *  adapter; a later (re)spawn restores the same authoritative selection.
   *  Claude only today; undefined/[] ≡ none. */
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
  /** Deprecated pre-v28 provider/session locator. Retained for boot-cache and
   * downgrade compatibility only; never use it to route a live execution. */
  sessionId?: string;
  /** Provider-owned durable resume identity. Zeros conversation identity stays
   * `id`; a live runtime is separately keyed by executionId. */
  providerBinding?: ProviderBinding;
  /** Provider-authored descriptive state. Never drives routing or checkout. */
  providerMetadata?: ProviderMetadata;
  /** Pinned to the top of the sidebar, independent of project grouping.
   *  Defaults to false / undefined for old records. */
  pinned?: boolean;
  /** Soft-deleted: hidden from the main groupings and listed under Archived for
   *  restore or permanent deletion. Archive never touches the transcript; only
   *  DELETE_CHAT removes the metadata entry. */
  archived?: boolean;
  /** Zeros conversation that this chat branched from. This is product-owned
   * lineage only: it never identifies or resumes a provider session. The
   * current fork flow separately stages a bounded transcript attachment in
   * the new composer. */
  sourceChatId?: string;
};
