// ──────────────────────────────────────────────────────────
// Repository settings — Settings → Repo → <repo>
// ──────────────────────────────────────────────────────────
//
// Shown when a Repo section (Environment / Git / Actions / Paths)
// is active on the repo page. `RepoDetail` renders the active section's body
// — one section at a time. (Providers is USER-scope only — there is no
// per-repo provider config; MCP left the repo scope entirely on 2026-07-17.)
//
// TOML-backed, flat settings with inheritance.
// Values live in engine-owned layer files — which, since the 2026-07-17
// repo-file slimming, carry only scripts + the git/prompts tables these tabs
// edit (+ repo-local's workspaces.path):
//   <repo>/.zeros/settings.toml        — shared (committed): scripts, git, prompts
//   <repo>/.zeros/settings.local.toml  — personal (gitignored): + machine paths
// (Environment is Keychain-vault-backed, not file-backed — env-vault.ts.)
// Each section reads BOTH the resolved tree (effective value + per-leaf
// provenance, via settings.resolve) and the raw repo layer (what THIS repo
// file sets, via settings.read) so it can show what's inherited from User and
// offer Override / Reset. Writes ride settings.write; external edits arrive via
// DB_CHANGED { kinds: ["settings"] }.
//
// Zeros Foundation: flat sections (SettingsSection/Row/Field/List), default
// text fg2 / focal fg1, hairline dividers, strict 12/14 type, no cards.
// ──────────────────────────────────────────────────────────

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronsUpDown,
  Copy,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  GitBranch,
  Globe,
  KeyRound,
  LaptopMinimal,
  Pencil,
  Plus,
  Trash2,
  Wand2,
  type LucideIcon,
} from "lucide-react";

import { Button, Input, Textarea } from "../../shared/ui";
import { CodeTextarea, Tooltip } from "@/renderer/shared/ui/primitives";
import { HighlightedCode } from "../agent/renderers/highlighted-code";
import { toast } from "../../shared/ui/primitives/elements";
import { cn } from "@/renderer/shared/ui/cn";
import { removeProject, type Project } from "../../state/projects-store";
import {
  clearRepoSettings,
  DEFAULT_BASE_BRANCH,
  DEFAULT_REMOTE_ORIGIN,
} from "./repo-settings";
import {
  useResolvedSettings,
  useSettingsChanged,
  useSettingsLayer,
  useSyncedDraft,
} from "../settings/use-settings";
import type {
  ResolvedSettingsWire,
  SettingsLayer,
} from "../../platform/bridge/workspace-bridge";

/** Mask the engine sends for a secret-shaped env value over the relay. */
const REDACTED = "<redacted>";
import {
  dialogPickFolder,
  gitRepoBranchCatalog,
  isGitErrorShape,
  workspaceDelete,
  workspaceList,
  type RepoBranchCatalog,
  type Workspace,
} from "../../platform/git";
import {
  forgetRepoBranchCatalog,
  hasRepoBranchCatalog,
  readRepoBranchCatalog,
  writeRepoBranchCatalog,
} from "./repo-branch-catalog-cache";

function clearRepoPerformanceSnapshots(repoRoot: string): void {
  forgetRepoBranchCatalog(repoRoot);
}
import { GithubIcon } from "../../shared/ui/github-icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../shared/ui/primitives/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../shared/ui/primitives/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../../shared/ui/primitives/dialog";
import {
  selectChatToRestoreForFolder,
  useActiveChatId,
  useChats,
  useNewAgentFolder,
  useWorkspaceDispatch,
  useWorkspaceStore,
} from "../../state/store";
import {
  forgetWorkspacesFor,
  notifyProjectsChanged,
  notifyWorkspacesChanged,
  peekWorkspacesFor,
  useProjects,
} from "../../state/use-projects";
import { isLocalMainWorkspace } from "../../state/local-main-workspace";
import {
  CHATS_BACKUP_KEY,
  CHATS_TOMBSTONE_KEY,
} from "../../state/chats-local-cache";
import { dbDeleteChat } from "../agent/agent-history-client";
import { setSetting } from "../../platform/settings";
import { clearChangesFilters } from "../../shell/workbench/tabs/changes-filter-store";
import { forgetChangesSnapshots } from "../../shell/workbench/tabs/changes-snapshot-cache";
import { clearTerminalFolders } from "../../shell/terminal/terminal-store";
import { clearChatPaneFolders } from "../../state/chat-panes-store";
import { clearDashboardRepoFilter } from "../dashboard/preferences";
import { folderIsOwnedByProject } from "../../state/workspace-resolution";
import {
  isInheritedSource,
  ResetToInherited,
  SettingsActions,
  SettingsEmpty,
  SettingsEmptyCard,
  SettingsField,
  SettingsList,
  SettingsRow,
  SettingsSection,
  SourceTag,
  type SettingsSource,
} from "../settings/settings-ui";
import { RunActionsSection } from "./run-actions-section";
import { FilesToCopySection } from "./files-to-copy-section";
import { AddEnvVariableDialog } from "./add-env-variable-dialog";
import { MCP_SECRET_SENTINEL } from "../agent-extensions/mcp-server-model";
import {
  readEnvVault,
  readEnvVaultForEdit,
  writeEnvVault,
  type EnvVaultScope,
} from "../agent/env-vault";
import { getSecret } from "../../platform/secrets";
import {
  getProviderPrefs,
  PROVIDER_KEY_ENV_VARS,
} from "../settings/provider-prefs";
import { resetEngineToDefault } from "../../platform/app";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";

// ── Section model ────────────────────────────────────────

export type RepoSectionId =
  | "environment"
  | "git"
  | "actions"
  | "files"
  | "paths";

export const REPO_SECTIONS: {
  id: RepoSectionId;
  label: string;
  icon: LucideIcon;
}[] = [
  { id: "environment", label: "Environment", icon: KeyRound },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "actions", label: "Actions", icon: Wand2 },
  // "What does a new workspace of this repo contain?" — sits next to Paths,
  // which answers "where does it live", and before it, because this is the one
  // people hit on day one when a fresh workspace won't boot without its .env.
  { id: "files", label: "Files", icon: Copy },
  { id: "paths", label: "Paths", icon: Folder },
];

const REPO_SECTION_IDS = REPO_SECTIONS.map((s) => s.id);

export function isRepoSectionId(value: string): value is RepoSectionId {
  return (REPO_SECTION_IDS as string[]).includes(value);
}

// ── Resolved-tree helpers (effective value + provenance) ──

/** Read a dot-path leaf out of the resolved effective tree + its source. */
function pick(
  resolved: ResolvedSettingsWire | null,
  path: string,
): { value: unknown; source: SettingsSource | undefined } {
  const value = path
    .split(".")
    .reduce<unknown>(
      (o, k) =>
        o && typeof o === "object"
          ? (o as Record<string, unknown>)[k]
          : undefined,
      resolved?.effective,
    );
  return {
    value,
    source: resolved?.sources[path] as SettingsSource | undefined,
  };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Clear a repo override (write `null` to delete the key → fall back to the
 *  inherited value) and blank the draft. */
async function resetKey(
  layer: { write: (patch: Record<string, unknown>) => Promise<void> },
  patch: Record<string, unknown>,
  clearDraft: (v: string) => void,
): Promise<void> {
  try {
    await layer.write(patch);
    clearDraft("");
    toast.success("Reset to inherited");
  } catch {
    toast.error("Couldn't reset");
  }
}

// ──────────────────────────────────────────────────────────
// RepoDetail — floating section nav (no bg) + active section body
// ──────────────────────────────────────────────────────────

/** Which repo-scoped layer the config sections edit. "repo" = the committed
 *  `.zeros/settings.toml` (shared with the team); "repo-local" = the gitignored
 *  `.zeros/settings.local.toml` ("This Mac"); "workspace-local" = a single
 *  worktree's own `.zeros/settings.local.toml` ("This Workspace"). */
export type EditableRepoLayer = "repo" | "repo-local" | "workspace-local";

/** A highlighted TOML editor: a transparent textarea (caret + input) overlaid
 *  on a Shiki-highlighted layer, with a line-number gutter. AUTO-HEIGHT — it
 *  grows with content and the settings pane scrolls (no inner scroll, so no
 *  scroll-sync to drift). Lines wrap (whitespace-pre-wrap); the gutter is one
 *  number per logical line. Identical font/leading/padding on all three layers
 *  so the caret sits exactly over the colored glyphs (mirrors CodeWithGutter). */
function TomlSourceEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const lines = value.length === 0 ? 1 : value.split("\n").length;
  const TEXT = "font-mono text-sm leading-[1.6]";
  return (
    <div className="border-border1 bg-bg2/60 flex min-h-[360px] overflow-hidden rounded-lg border">
      <div
        aria-hidden
        className={cn(
          "border-border1 text-fg2/45 shrink-0 border-r px-2 py-2 text-right tabular-nums select-none",
          TEXT,
        )}
      >
        {Array.from({ length: lines }, (_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <div className="relative min-w-0 flex-1">
        <HighlightedCode
          code={value.length ? value : " "}
          lang="toml"
          className={cn(
            "text-fg1 px-3 py-2",
            TEXT,
            "[&_.line]:!leading-[1.6] [&_code]:!whitespace-pre-wrap [&_pre]:!leading-[1.6] [&_pre]:!break-words [&_pre]:!whitespace-pre-wrap",
          )}
        />
        <textarea
          aria-label="settings.toml"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          placeholder={placeholder}
          className={cn(
            "caret-fg1 placeholder:text-muted-fg absolute inset-0 resize-none overflow-hidden border-0 bg-transparent px-3 py-2 break-words whitespace-pre-wrap text-transparent outline-none",
            TEXT,
          )}
        />
      </div>
    </div>
  );
}

/** Basename of a settings-file path, for the raw editor header. */
function settingsFileName(path?: string): string {
  if (!path) return "settings.toml";
  return path.split("/").pop() || "settings.toml";
}

/** Full-file raw TOML editor for one layer ("Edit settings.toml"). The textarea
 *  is the source of truth; Save validates server-side (an unparseable file is
 *  rejected with a banner, never written) and writes the bytes verbatim — so
 *  comments + layout survive. Each retained repo/layer view owns its own editor
 *  instance. Desktop-only (the engine refuses raw writes from a remote client). */
export function RawTomlEditor({
  layer,
  root,
}: {
  layer: SettingsLayer;
  root?: string;
}) {
  const { layer: read, loading, writeRaw } = useSettingsLayer(layer, root);
  const savedText = read?.text ?? "";
  const [draft, setDraft] = useSyncedDraft(savedText);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = draft !== savedText;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await writeRaw(draft);
      toast.success("settings.toml saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      toast.error("Couldn't save — check the TOML");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <p className="text-fg1 truncate text-[14px] font-medium">
            {settingsFileName(read?.path)}
          </p>
          <Tooltip label={read?.path}>
            <p className="text-fg2 min-w-0 truncate font-mono text-xs">
              {read?.path ?? ""}
            </p>
          </Tooltip>
        </div>
        <Button
          variant="secondary"
          size="md"
          onClick={() => void handleSave()}
          disabled={loading || saving || !dirty}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
      {error && (
        <div className="bg-red-bg text-red-fg rounded-md px-3 py-2 font-mono text-xs">
          {error}
        </div>
      )}
      <TomlSourceEditor
        value={draft}
        onChange={setDraft}
        placeholder={
          '# Edit this layer\'s settings.toml directly.\n# Comments and formatting are preserved.\n\n[env]\n# MY_VAR = "value"\n'
        }
      />
    </div>
  );
}

/** Renders the body of ONE repo settings section against the chosen layer
 *  ("repo" = Team/committed `.zeros/settings.toml`, "repo-local" = You/this-Mac
 *  `.zeros/settings.local.toml`). The section nav, the You/Team toggle, and the
 *  "Edit settings.toml" raw toggle all live in the settings-page shell now — this
 *  is purely the active section's form. Paths manages its own scope and
 *  ignores `layer`. */
export function RepoDetail({
  project,
  section,
  layer,
  root,
  surfaceActive = true,
}: {
  project: Project;
  section: RepoSectionId;
  layer: EditableRepoLayer;
  root: string;
  /** False while RepoPage keeps this completed form in its bounded deck. */
  surfaceActive?: boolean;
}) {
  switch (section) {
    case "paths":
      return <PathsSection project={project} />;
    case "files":
      // Per-repo by design: saving writes THIS project's
      // `.zeros/settings.local.toml`, never a global list (see the section
      // header). Gated on surfaceActive so a retained-but-hidden copy of this
      // pane never scans the repo.
      return (
        <FilesToCopySection
          project={project}
          layer={layer}
          root={root}
          surfaceActive={surfaceActive}
        />
      );
    case "environment":
      // Secrets and every workspace command belong to the same Environment
      // view. Keep the three modules independent so each retains its own save
      // behavior while presenting one consolidated settings surface.
      //
      // Scripts (setup / archive / run actions) are REPO settings: they always
      // edit the committed `.zeros/settings.toml` — deliberately shared by
      // every Zeros install (dev worktree instances, beta, stable) that opens
      // the repo, like `.vscode/`. The gitignored settings.local.toml carries
      // personal-only keys and is no longer read for scripts (schema.ts).
      return (
        <div className="flex flex-col gap-9">
          <EnvironmentSection project={project} layer={layer} root={root} />
          <ScriptsSection project={project} layer="repo" root={root} />
          <RunActionsSection project={project} layer="repo" root={root} />
        </div>
      );
    case "git":
      return (
        <GitSection
          project={project}
          layer={layer}
          root={root}
          surfaceActive={surfaceActive}
        />
      );
    case "actions":
      return <ActionsSection project={project} layer={layer} root={root} />;
    default:
      return null;
  }
}

/** A script field that edits the repo layer while surfacing inheritance. The
 *  editor holds only what THIS repo sets; empty + save means inherit. */
function OverrideField({
  id,
  label,
  description,
  source,
  draft,
  onChange,
  onReset,
  layer,
}: {
  id: string;
  label: string;
  description: string;
  source: SettingsSource | undefined;
  draft: string;
  onChange: (v: string) => void;
  /** Clear this layer's override and fall back to the inherited value. Shown
   *  only when the value is currently set in the edited layer (overridden). */
  onReset?: () => void;
  /** The layer being edited — inheritance is relative to it: a value is
   *  "inherited" when it comes from ANY other layer, "overridden" when it's set
   *  at this one. */
  layer: EditableRepoLayer;
}) {
  const inherited =
    source !== undefined && source !== layer && draft.trim() === "";
  const overridden = source === layer && draft.trim() !== "";
  return (
    <SettingsField
      htmlFor={id}
      label={
        <span className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            {label}
            {inherited && <SourceTag source={source} />}
          </span>
          {overridden && onReset && <ResetToInherited onReset={onReset} />}
        </span>
      }
    >
      <CodeTextarea
        id={id}
        value={draft}
        onChange={onChange}
        description={description}
        aria-label={`${label} script`}
      />
    </SettingsField>
  );
}

// ── Environment (repo vars + Inherited from User config) ──

/** The renderer's typed view of a repo-scoped layer document — the keys those
 *  files carry: scripts plus the git/prompts
 *  tables the Git and Actions tabs edit). */
interface RepoSharedDoc {
  git?: { remote?: string; base_branch?: string };
  scripts?: { setup?: string; run?: string; archive?: string };
  prompts?: { general?: string };
}

/** The card every variable list renders in: lifted `bg1-highlight` fill, `border1`
 *  frame, hairline dividers, no lock icons. */
function EnvVarList({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-border1 border-border1 bg-bg1-highlight divide-y overflow-hidden rounded-lg border">
      {children}
    </div>
  );
}

/** A labelled variable group (inherited / managed-elsewhere rows) in the same
 *  card design as the scope's own list. Deliberately NOT the shared
 *  InheritedGroup — that one carries a lock icon, this design has none. */
function EnvVarGroup({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 pt-2">
      <span className="text-fg2 text-xs font-medium">{label}</span>
      <EnvVarList>{children}</EnvVarList>
    </section>
  );
}

/** One variable, one row: NAME · eye (reveal / hide) · the value, masked as
 *  dots until revealed, copied to the clipboard on click · pencil · trash.
 *  Rows are never editable in place — the pencil reopens the Add dialog
 *  pre-filled. `value === undefined` marks a presence-only row (the real
 *  value isn't readable here): a static hint, no reveal, no copy. */
function EnvVarRow({
  name,
  value,
  hint,
  onEdit,
  onRemove,
  disabled,
}: {
  name: string;
  value?: string;
  /** Presence-only rows: shown in place of the masked value. */
  hint?: string;
  onEdit?: () => void;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);
  const copy = async () => {
    if (value === undefined) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`Copied ${name}`);
    } catch {
      toast.error("Couldn't copy to the clipboard");
    }
  };
  return (
    <div className="flex items-center gap-2 py-1.5 pr-2 pl-3">
      <span className="text-fg1 min-w-0 flex-1 truncate font-mono text-sm">
        {name}
      </span>
      {value !== undefined ? (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <Tooltip label={revealed ? "Hide value" : "Reveal value"}>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setRevealed((v) => !v)}
              aria-pressed={revealed}
              aria-label={
                revealed ? `Hide value of ${name}` : `Reveal value of ${name}`
              }
              className="text-fg2 hover:text-fg1 shrink-0"
            >
              {revealed ? (
                <EyeOff
                  className="size-3.5"
                  strokeWidth={1}
                  aria-hidden="true"
                />
              ) : (
                <Eye className="size-3.5" strokeWidth={1} aria-hidden="true" />
              )}
            </Button>
          </Tooltip>
          <Tooltip label="Copy">
            <button
              type="button"
              onClick={() => void copy()}
              aria-label={`Copy value of ${name}`}
              className="text-fg2 hover:text-fg1 min-w-0 flex-1 cursor-pointer truncate rounded-sm px-1.5 py-1 text-left font-mono text-sm transition-colors"
            >
              {revealed ? (
                value === "" ? (
                  <span className="text-muted-fg italic">empty</span>
                ) : (
                  value
                )
              ) : (
                <span className="tracking-[0.25em]">••••••••</span>
              )}
            </button>
          </Tooltip>
        </div>
      ) : (
        <span className="text-muted-fg min-w-0 flex-1 truncate text-xs">
          {hint ?? "••••••••"}
        </span>
      )}
      {(onEdit || onRemove) && (
        <div className="flex shrink-0 items-center gap-0.5">
          {onEdit && (
            <Tooltip label="Edit secret">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onEdit}
                disabled={disabled}
                aria-label={`Edit ${name}`}
                className="text-fg2 hover:text-fg1"
              >
                <Pencil
                  className="size-3.5"
                  strokeWidth={1}
                  aria-hidden="true"
                />
              </Button>
            </Tooltip>
          )}
          {onRemove && (
            <Tooltip label="Remove secret">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onRemove}
                disabled={disabled}
                aria-label={`Remove ${name}`}
                className="text-fg2 hover:bg-red-primary/10 hover:text-red-primary"
              >
                <Trash2
                  className="size-3.5"
                  strokeWidth={1}
                  aria-hidden="true"
                />
              </Button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
}

/** Environment vars for one scope — Keychain-only (env-vault.ts): nothing is
 *  ever written to settings.toml / settings.local.toml, every value is
 *  encrypted at rest. Rows render masked and are never edited in place: the
 *  eye reveals a value on demand, clicking it copies, and the pencil reopens
 *  the Add dialog pre-filled (every mutation is a whole-map vault write).
 *  `layer === "user"` edits the user scope (every agent, this Mac); any repo
 *  layer edits the repo scope keyed by `root` (agents in every worktree of
 *  the repo). File-based `[env]` resolves from the USER file (and team/managed
 *  policy) only — repo settings files stopped carrying env in the 2026-07-17
 *  slimming — and shows read-only below, as do user-scope vault vars on a
 *  repo page under "Inherited from User config" (no Override: user vars reach
 *  every repo by definition). */
export function EnvironmentSection({
  layer,
  root,
  mainRepoRoot,
}: {
  project?: Project;
  layer: EditableRepoLayer | "user";
  root?: string;
  mainRepoRoot?: string;
}) {
  const resolved = useResolvedSettings(root, mainRepoRoot);
  const scope = useMemo<EnvVaultScope>(
    () =>
      layer === "user"
        ? { kind: "user" }
        : { kind: "repo", repoRoot: root ?? "" },
    [layer, root],
  );
  // Secrets stay only in this mounted form instance. RepoPage's bounded view
  // deck preserves common round trips without introducing a second module-
  // lifetime copy of decrypted Keychain values.
  const [vault, setVault] = useState<Record<string, string>>({});
  /** Repo scope: the user scope's vars — read-only "Inherited from User
   *  config" rows, and reserved as repo names (there is no override concept). */
  const [userScopeVars, setUserScopeVars] = useState<Record<string, string>>(
    {},
  );
  const [vaultLoading, setVaultLoading] = useState(true);
  /** The initial read FAILED (Keychain/IPC error — not "empty"). Editing
   *  stays disabled: every save writes the whole scope map, so editing on
   *  top of a failed read would wipe the stored variables. */
  const [vaultUnreadable, setVaultUnreadable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Re-arm loading on a scope CHANGE, not just on mount: a dialog save
    // riding the previous scope's `vault` into the new scope would copy one
    // repo's secrets into another. The identity guard remains required even
    // though common repo targets now stay mounted in a bounded deck.
    setVault({});
    setUserScopeVars({});
    setVaultLoading(true);
    setVaultUnreadable(false);
    void (async () => {
      let vars: Record<string, string>;
      try {
        vars = await readEnvVaultForEdit(scope);
      } catch {
        if (!cancelled) {
          setVaultUnreadable(true);
          setVaultLoading(false);
        }
        return;
      }
      const inherited =
        scope.kind === "repo" ? await readEnvVault({ kind: "user" }) : {};
      if (cancelled) return;
      setVault(vars);
      setUserScopeVars(inherited);
      setVaultUnreadable(false);
      setVaultLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [scope]);

  // Provider API keys (Settings → Providers) that WILL be injected into the
  // agent's process env at spawn — shown read-only here so the Environment
  // panel is a truthful picture of what agents actually receive. Presence
  // only: the value never leaves the encrypted secret store. A key row shows
  // iff (a) a key is stored AND (b) the provider is in API-key auth mode
  // (deriveProviderEnv's exact injection condition). User layer only — keys
  // are global, not per-repo.
  const [providerKeyVars, setProviderKeyVars] = useState<
    Array<{ envVar: string; vendor: string }>
  >([]);
  useEffect(() => {
    if (layer !== "user") return;
    let cancelled = false;
    (async () => {
      const found: Array<{ envVar: string; vendor: string }> = [];
      for (const p of PROVIDER_KEY_ENV_VARS) {
        if (getProviderPrefs(p.agentId).authMethod !== "apiKey") continue;
        try {
          const v = await getSecret(p.secretAccount);
          if (v?.trim()) found.push({ envVar: p.envVar, vendor: p.vendor });
        } catch {
          /* keychain miss — skip */
        }
      }
      if (!cancelled) setProviderKeyVars(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [layer]);

  // FILE-based env still visible to agents (the user's own `[env]` table, team
  // policy — resolved by the engine's hazard-filtered spawn-env; repo-scoped
  // files can't carry env anymore): shown read-only so this panel stays a
  // truthful picture of what agents receive. Values that are secret markers
  // (sentinel) or engine-masked stay presence-only (no reveal, no copy — the
  // real value isn't readable here). Entries the USER layer file sets group
  // under "Inherited from User config", next to the user-scope vault vars;
  // team/managed entries keep the generic settings-files label.
  const effectiveEnv = (resolved.resolved?.effective.env ?? {}) as Record<
    string,
    unknown
  >;
  const envSources = resolved.resolved?.sources ?? {};
  // Set membership, not `in` — a var named `toString` must not be swallowed
  // by the prototype chain.
  const scopeNames = new Set(Object.keys(vault));
  const userNames = new Set(Object.keys(userScopeVars));
  const fileEntries = Object.entries(effectiveEnv)
    .filter(([key]) => !scopeNames.has(key) && !userNames.has(key))
    .map(([key, value]) => ({
      key,
      value:
        value === MCP_SECRET_SENTINEL || value === REDACTED
          ? undefined
          : String(value),
      fromUser: envSources[`env.${key}`] === "user",
    }));
  const userFileEntries = fileEntries.filter((e) => e.fromUser);
  const otherFileEntries = fileEntries.filter((e) => !e.fromUser);

  // "Add secrets" dialog — also the EDIT dialog (the pencil reopens it
  // pre-filled; rows are never edited in place). Every save is a whole-map
  // vault write merged over the last-loaded map.
  const [addOpen, setAddOpen] = useState(false);
  /** NAME the pencil is editing, or null. Non-null opens the dialog. */
  const [editing, setEditing] = useState<string | null>(null);
  /** Serializes the row-level writes (Remove) — whole-map writes racing each
   *  other would resurrect deleted variables. The modal dialog serializes its
   *  own saves. */
  const [mutating, setMutating] = useState(false);

  // Referentially stable while the dialog is open — its seed effect keys on it.
  const editingInitial = useMemo(
    () =>
      editing !== null ? { name: editing, value: vault[editing] ?? "" } : null,
    [editing, vault],
  );

  const dialogOpen = addOpen || editing !== null;
  const handleDialogOpenChange = (next: boolean) => {
    if (!next) {
      setAddOpen(false);
      setEditing(null);
    }
  };

  const handleDialogSave = async (
    newVars: Record<string, string>,
    { renamedFrom }: { renamedFrom?: string },
  ): Promise<boolean> => {
    const next = { ...vault, ...newVars };
    // An edit saved under a new NAME moved the variable — drop the old key.
    // (hasOwn, not `in`: a var named `toString` must still get deleted.)
    if (
      renamedFrom &&
      !Object.prototype.hasOwnProperty.call(newVars, renamedFrom)
    )
      delete next[renamedFrom];
    try {
      await writeEnvVault(scope, next);
    } catch {
      toast.error("Couldn't save to the Keychain");
      return false;
    }
    setVault(next);
    const n = Object.keys(newVars).length;
    toast.success(
      n === 1 ? "Saved to the Keychain" : `Added ${n} secrets to the Keychain`,
    );
    return true;
  };

  const handleRemove = async (name: string) => {
    if (mutating) return;
    setMutating(true);
    try {
      const next = { ...vault };
      delete next[name];
      try {
        await writeEnvVault(scope, next);
      } catch {
        toast.error("Couldn't save to the Keychain");
        return;
      }
      setVault(next);
      toast.success(`Removed ${name}`);
    } finally {
      setMutating(false);
    }
  };

  const names = Object.keys(vault);
  // Until the initial vault read lands (or if it failed), `vault` is {} — a
  // dialog Save in that window would overwrite the whole stored scope with
  // just the new entries. A concurrent Remove has the same stale-map risk.
  const addDisabled = vaultLoading || vaultUnreadable || mutating;
  /** Repo scope: user-level vars NOT shadowed by a repo var of the same name.
   *  A shadowed one is hidden (repo wins at spawn, so it never reaches this
   *  repo's agents) and is NOT reserved — the dialog edits the repo entry. */
  const inheritedUserNames = Object.keys(userScopeVars).filter(
    (n) => !scopeNames.has(n),
  );

  return (
    <SettingsSection
      title={layer === "user" ? undefined : "Secrets"}
      description={
        layer === "user"
          ? "These secrets are passed to every agent on this Mac. Stored encrypted in your Keychain."
          : "These secrets are passed to agents in this repo, for all workspaces"
      }
      action={
        names.length > 0 ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => setAddOpen(true)}
            className="gap-1.5"
            disabled={addDisabled}
          >
            <Plus className="size-3.5" strokeWidth={1} aria-hidden="true" />
            Add secrets
          </Button>
        ) : undefined
      }
    >
      <AddEnvVariableDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        isUserScope={scope.kind === "user"}
        existingNames={names}
        reservedNames={inheritedUserNames}
        initial={editingInitial}
        onSave={handleDialogSave}
      />
      {vaultUnreadable ? (
        <SettingsEmpty title="Couldn't read the Keychain — close and reopen Settings to retry" />
      ) : names.length === 0 ? (
        !vaultLoading && (
          <SettingsEmptyCard
            title="No secrets yet"
            action={
              <Button
                variant="primary"
                size="sm"
                onClick={() => setAddOpen(true)}
                disabled={addDisabled}
                className="gap-1.5"
              >
                <Plus className="size-3.5" strokeWidth={1} aria-hidden="true" />
                Add
              </Button>
            }
          />
        )
      ) : (
        <EnvVarList>
          {names.map((name) => (
            <EnvVarRow
              key={name}
              name={name}
              value={vault[name]}
              onEdit={() => setEditing(name)}
              onRemove={() => void handleRemove(name)}
              disabled={mutating}
            />
          ))}
        </EnvVarList>
      )}

      {/* User-level vars on a repo page: they already reach every repo's
          agents, so they're read-only here — no Override, no pencil/trash.
          The user's own vault vars plus any `[env]` the user settings file
          sets, in the same row design. */}
      {(scope.kind === "repo" && inheritedUserNames.length > 0) ||
      userFileEntries.length > 0 ? (
        <EnvVarGroup label="Inherited from User config">
          {scope.kind === "repo" &&
            inheritedUserNames.map((name) => (
              <EnvVarRow key={name} name={name} value={userScopeVars[name]} />
            ))}
          {userFileEntries.map((e) => (
            <EnvVarRow key={e.key} name={e.key} value={e.value} hint="••••" />
          ))}
        </EnvVarGroup>
      ) : null}

      {otherFileEntries.length > 0 && (
        <EnvVarGroup label="From settings files (read-only)">
          {otherFileEntries.map((e) => (
            <EnvVarRow key={e.key} name={e.key} value={e.value} hint="••••" />
          ))}
        </EnvVarGroup>
      )}

      {/* Provider API keys — injected into every agent's env at spawn, so
          they belong in this picture, but they're MANAGED in Settings →
          Providers and stored encrypted: read-only, presence-only rows. */}
      {layer === "user" && providerKeyVars.length > 0 && (
        <EnvVarGroup label="Provider API keys — managed in Settings → Agent providers">
          {providerKeyVars.map((p) => (
            <EnvVarRow
              key={p.envVar}
              name={p.envVar}
              hint={`•••• ${p.vendor} key, stored encrypted`}
            />
          ))}
        </EnvVarGroup>
      )}
    </SettingsSection>
  );
}

/** The User-scope Environment section (Settings → Environment) — the same editor
 *  as the per-repo layers, bound to the global user layer (~/.zeros/settings.toml)
 *  that every project inherits. A no-props Panel for the Settings page. */
export function UserEnvironmentPanel() {
  return <EnvironmentSection layer="user" />;
}

// ── Git (branch-from + remote pickers) ───────────────────
//
// Two dropdowns backed by the layered `git.remote` / `git.base_branch` keys,
// replacing freetext Remote / Base-branch inputs:
//   • "Branch new workspaces from" — the remote branches of the effective
//     remote (GitHub glyph when that remote is github.com, globe for another
//     host, laptop + LOCAL branches when the repo has no usable remote).
//     Picking writes `git.base_branch` (a PLAIN name — createWorkspace forks
//     from `<remote>/<name>`); unset = auto-detect the remote's HEAD.
//   • "Remote origin" — which git remote push / pull / PR-create target.
//     Picking writes `git.remote`; the engine ops resolve it live
//     (settings/repo-git.ts), so the choice applies to existing workspaces too.
// Selections save immediately (no Save button); inheritance keeps the section
// idiom — a SourceTag on values from weaker layers, Reset on this layer's own.

/** The repo's remotes + forkable branches, freshened in two passes: an
 *  instant local-refs read paints first, then a network pass (bounded
 *  best-effort `git fetch`) replaces it so the list reflects the live remote.
 *  `refresh()` re-runs both passes (after a save). */
function useRepoBranchCatalog(
  repoRoot: string,
  surfaceActive: boolean,
): {
  catalog: RepoBranchCatalog | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  // Local refs are usable immediately on a return visit; network freshness
  // still replaces them later without clearing either picker.
  const [catalogSnapshot, setCatalogSnapshot] = useState<{
    repoRoot: string;
    catalog: RepoBranchCatalog | null;
  }>(() => ({
    repoRoot,
    catalog: readRepoBranchCatalog(repoRoot),
  }));
  const catalog =
    catalogSnapshot.repoRoot === repoRoot
      ? catalogSnapshot.catalog
      : readRepoBranchCatalog(repoRoot);
  const [loadingSnapshot, setLoadingSnapshot] = useState({
    repoRoot,
    loading: !hasRepoBranchCatalog(repoRoot),
  });
  const loading =
    loadingSnapshot.repoRoot === repoRoot
      ? loadingSnapshot.loading
      : !hasRepoBranchCatalog(repoRoot);
  // Monotonic guard: a stale pass (unmount, repoRoot switch, older refresh)
  // must never clobber a newer one's result.
  const epoch = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++epoch.current;
    setLoadingSnapshot({
      repoRoot,
      loading: !hasRepoBranchCatalog(repoRoot),
    });
    try {
      const instant = await gitRepoBranchCatalog({ repoRoot });
      if (epoch.current === mine && instant) {
        writeRepoBranchCatalog(repoRoot, instant);
        setCatalogSnapshot({ repoRoot, catalog: instant });
      }
    } catch {
      /* not a repo / engine unavailable — pickers render their empty state */
    } finally {
      if (epoch.current === mine) {
        setLoadingSnapshot({ repoRoot, loading: false });
      }
    }
    // Freshen in the BACKGROUND — the awaited part of refresh() is only the
    // instant pass, so a save's `await refresh()` can't hold the section's
    // controls hostage for a slow/unreachable remote (the fetch pass is
    // bounded at ~13s worst case). The epoch guard keeps it safe: any newer
    // refresh invalidates this pass's result.
    void (async () => {
      try {
        const fresh = await gitRepoBranchCatalog({ repoRoot, fetch: true });
        if (epoch.current === mine && fresh) {
          writeRepoBranchCatalog(repoRoot, fresh);
          setCatalogSnapshot({ repoRoot, catalog: fresh });
        }
      } catch {
        /* offline — the instant (local-refs) pass stands */
      }
    })();
  }, [repoRoot]);

  useEffect(() => {
    if (!surfaceActive) return;
    // A repoRoot change or retained-view park invalidates the prior pass. The
    // transport may finish, but a hidden form does not publish new local UI.
    void refresh();
    return () => {
      epoch.current += 1;
    };
  }, [refresh, surfaceActive]);

  // Stay live: a `git.remote`/`git.base_branch` change from another device,
  // an agent, or a hand-edited TOML must re-list (the section prefers the
  // catalog's effective values, which would otherwise go stale).
  const refreshWhileActive = useCallback(() => {
    if (surfaceActive) void refresh();
  }, [refresh, surfaceActive]);
  useSettingsChanged(refreshWhileActive);

  return { catalog, loading, refresh };
}

// Same secondary-control family as the target-branch dropdown, sized for the
// settings page (28px, 13px text). `min-w-0`+truncate so a long branch name
// shrinks instead of overflowing the centered column.
const GIT_PICKER_TRIGGER_CLS =
  "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border2 bg-transparent pl-2.5 pr-2 text-xs text-fg1 transition-colors duration-120 ease-out hover:border-border3 hover:bg-bg2-hover disabled:opacity-50";

/** The source glyph shown inside the branch trigger: where new workspaces
 *  come from — GitHub, another git host, or this machine's local branches. */
function BranchSourceIcon({ catalog }: { catalog: RepoBranchCatalog | null }) {
  if (!catalog) {
    return (
      <GitBranch className="text-fg2 size-3.5 shrink-0" aria-hidden="true" />
    );
  }
  if (catalog?.branchSource === "remote") {
    const listed = catalog.remotes.find((r) => r.name === catalog.listedRemote);
    return listed?.isGitHub ? (
      <GithubIcon className="text-fg2 size-3.5 shrink-0" strokeWidth={1.75} />
    ) : (
      <Globe className="text-fg2 size-3.5 shrink-0" aria-hidden="true" />
    );
  }
  return (
    <LaptopMinimal className="text-fg2 size-3.5 shrink-0" aria-hidden="true" />
  );
}

function GitSection({
  project,
  layer,
  root,
  mainRepoRoot,
  surfaceActive = true,
}: {
  project: Project;
  layer: EditableRepoLayer;
  root: string;
  mainRepoRoot?: string;
  surfaceActive?: boolean;
}) {
  const resolved = useResolvedSettings(root, mainRepoRoot);
  const repo = useSettingsLayer(layer, root);
  // Catalog always reads the MAIN checkout (a registered repo root — the
  // engine clamps the op to known roots); `root` may be a worktree when this
  // section edits the workspace-local layer, and refs are repo-wide anyway.
  const {
    catalog,
    loading: catalogLoading,
    refresh,
  } = useRepoBranchCatalog(project.repoRoot, surfaceActive);
  const [saving, setSaving] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);

  const remotePick = pick(resolved.resolved, "git.remote");
  const basePick = pick(resolved.resolved, "git.base_branch");
  const resolvedReady = resolved.resolved !== null;

  // Effective values — the catalog's view wins (it folds in HEAD
  // auto-detection); the resolved tree covers the pre-catalog frame.
  const effectiveRemote =
    catalog?.effectiveRemote ??
    (asString(remotePick.value) || DEFAULT_REMOTE_ORIGIN);
  const effectiveBase =
    catalog?.effectiveBase ?? (asString(basePick.value) || DEFAULT_BASE_BRANCH);

  const saveGit = async (
    patch: { remote?: string | null; base_branch?: string | null },
    successMsg: string,
  ) => {
    setSaving(true);
    try {
      await repo.write({ git: patch });
      toast.success(successMsg);
      // Re-list against the just-saved values (write awaits the engine, so
      // the next resolve sees them).
      await refresh();
    } catch {
      toast.error("Couldn't save Git settings");
    } finally {
      setSaving(false);
    }
  };

  // Inheritance chrome, same semantics as OverrideField: a value set by THIS
  // layer gets Reset; one supplied by any other layer gets its provenance tag
  // ("Default" = auto-detected / built-in).
  const branchOverridden = basePick.source === layer;
  const remoteOverridden = remotePick.source === layer;

  // Passive reads never disable an already-rendered control. A selection can
  // write its exact patch without waiting for the raw layer document; only the
  // user's own save operation is mutually exclusive.
  const busy = saving;

  // ── Branch picker rows ──
  // The saved base may no longer exist on the remote (deleted branch) — keep
  // it pickable at the top, flagged, so the trigger value is always in the
  // list and the user can see why creation would fall back.
  const branchRows: { name: string; missing?: boolean }[] = catalog
    ? catalog.branches.some((b) => b.name === effectiveBase) ||
      catalog.branches.length === 0
      ? catalog.branches
      : [{ name: effectiveBase, missing: true }, ...catalog.branches]
    : resolvedReady
      ? [{ name: effectiveBase }]
      : [];
  const baseMissing =
    catalog !== null &&
    catalog.branchSource === "remote" &&
    catalog.branches.length > 0 &&
    !catalog.branches.some((b) => b.name === effectiveBase);

  const branchLabel = catalog
    ? catalog.branchSource === "remote"
      ? `${catalog.listedRemote}/${effectiveBase}`
      : effectiveBase
    : resolvedReady
      ? `${effectiveRemote}/${effectiveBase}`
      : "Choose branch";

  // Resolved settings are already an exact-key value, so they are a useful
  // first row while the richer Git catalog revalidates. An authoritative empty
  // catalog replaces this fallback with the real "No remotes" state.
  const remoteRows =
    catalog?.remotes ??
    (resolvedReady
      ? [{ name: effectiveRemote, url: "", isGitHub: false }]
      : []);

  // The configured remote isn't in `git remote` output (renamed/removed) —
  // say so instead of silently listing local branches.
  const remoteGone =
    catalog !== null && !catalog.remoteExists && catalog.remotes.length > 0;
  // The remote IS configured but its remote-tracking namespace is empty
  // (freshly added, or offline before the first fetch) — the engine fell back
  // to local branches; creation does the same in this state.
  const remoteEmpty =
    catalog !== null &&
    catalog.remoteExists &&
    catalog.branchSource === "local";

  return (
    <div className="flex flex-col gap-9">
      <SettingsSection
        title={
          <span className="flex items-center gap-2">
            Branch new workspaces from
            {!branchOverridden && resolvedReady && (
              <SourceTag source={basePick.source} />
            )}
          </span>
        }
        description="Each workspace is an isolated copy of your codebase."
      >
        <div className="flex items-center gap-3">
          <Popover open={branchOpen} onOpenChange={setBranchOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={GIT_PICKER_TRIGGER_CLS}
                disabled={busy}
                aria-label="Branch new workspaces from"
                aria-busy={catalogLoading || undefined}
              >
                <BranchSourceIcon catalog={catalog} />
                <span className="min-w-0 truncate font-medium tabular-nums">
                  {branchLabel}
                </span>
                <ChevronsUpDown
                  className="text-fg2 size-3.5 shrink-0"
                  aria-hidden="true"
                />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={4}
              className="w-[300px] p-0"
            >
              <Command defaultValue={effectiveBase}>
                <CommandInput placeholder="Search branches…" />
                <CommandList className="max-h-[260px]">
                  {branchRows.length === 0 && !catalogLoading && (
                    <CommandEmpty>No branches found.</CommandEmpty>
                  )}
                  {branchRows.map((b) => (
                    <CommandItem
                      key={b.name}
                      value={b.name}
                      disabled={busy}
                      onSelect={() => {
                        setBranchOpen(false);
                        if (b.name === effectiveBase && branchOverridden)
                          return;
                        void saveGit(
                          { base_branch: b.name },
                          `New workspaces branch from ${
                            catalog?.listedRemote
                              ? `${catalog.listedRemote}/${b.name}`
                              : b.name
                          }`,
                        );
                      }}
                    >
                      {b.name === effectiveBase ? (
                        <Check className="text-fg1 size-3.5 shrink-0" />
                      ) : (
                        <span className="size-3.5 shrink-0" />
                      )}
                      <span className="truncate">{b.name}</span>
                      {b.missing ? (
                        <span className="text-muted-fg ml-auto shrink-0 text-xs">
                          {catalog?.listedRemote
                            ? `not on ${catalog.listedRemote}`
                            : "not found"}
                        </span>
                      ) : (
                        b.name === catalog?.detectedDefault && (
                          <span className="text-muted-fg ml-auto shrink-0 text-xs">
                            default
                          </span>
                        )
                      )}
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {branchOverridden && (
            <ResetToInherited
              onReset={() => {
                if (busy) return; // single-flight: a save is already running
                void saveGit(
                  { base_branch: null },
                  "Branch reset — auto-detects the remote's default",
                );
              }}
            />
          )}
        </div>
        {baseMissing && (
          <p className="text-yellow-fg text-xs">
            “{effectiveBase}” wasn’t found on {catalog?.listedRemote} — new
            workspaces will fall back to a local branch until it exists there.
          </p>
        )}
        {remoteGone && (
          <p className="text-yellow-fg text-xs">
            Remote “{effectiveRemote}” isn’t configured in this repository —
            showing local branches instead.
          </p>
        )}
        {remoteEmpty && (
          <p className="text-yellow-fg text-xs">
            No branches from “{effectiveRemote}” yet (not fetched, or offline) —
            showing local branches. New workspaces fall back the same way.
          </p>
        )}
      </SettingsSection>

      <SettingsSection
        title={
          <span className="flex items-center gap-2">
            Remote origin
            {!remoteOverridden && resolvedReady && (
              <SourceTag source={remotePick.source} />
            )}
          </span>
        }
        description="Where should we push, pull, and create PRs?"
      >
        <div className="flex items-center gap-3">
          <Popover open={remoteOpen} onOpenChange={setRemoteOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={GIT_PICKER_TRIGGER_CLS}
                disabled={busy}
                aria-label="Remote for push, pull, and PRs"
                aria-busy={catalogLoading || undefined}
              >
                <span className="min-w-0 truncate font-medium tabular-nums">
                  {catalog && catalog.remotes.length === 0
                    ? "No remotes"
                    : catalog || resolvedReady
                      ? effectiveRemote
                      : "Choose remote"}
                </span>
                <ChevronsUpDown
                  className="text-fg2 size-3.5 shrink-0"
                  aria-hidden="true"
                />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="start"
              sideOffset={4}
              className="w-[340px] p-0"
            >
              <Command defaultValue={effectiveRemote}>
                <CommandList className="max-h-[260px]">
                  {remoteRows.length === 0 && !catalogLoading && (
                    <CommandEmpty>No remotes configured.</CommandEmpty>
                  )}
                  {remoteRows.map((r) => (
                    <CommandItem
                      key={r.name}
                      value={r.name}
                      disabled={busy}
                      onSelect={() => {
                        setRemoteOpen(false);
                        if (r.name === effectiveRemote && remoteOverridden)
                          return;
                        void saveGit(
                          { remote: r.name },
                          `Push, pull, and PRs use ${r.name}`,
                        );
                      }}
                    >
                      {r.name === effectiveRemote ? (
                        <Check className="text-fg1 size-3.5 shrink-0" />
                      ) : (
                        <span className="size-3.5 shrink-0" />
                      )}
                      {r.isGitHub ? (
                        <GithubIcon
                          className="text-fg2 size-3.5 shrink-0"
                          strokeWidth={1.75}
                        />
                      ) : (
                        <Globe
                          className="text-fg2 size-3.5 shrink-0"
                          aria-hidden="true"
                        />
                      )}
                      <span className="shrink-0">{r.name}</span>
                      <span className="text-muted-fg ml-auto min-w-0 truncate text-xs">
                        {r.url}
                      </span>
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          {remoteOverridden && (
            <ResetToInherited
              onReset={() => {
                if (busy) return; // single-flight: a save is already running
                void saveGit({ remote: null }, "Remote reset to inherited");
              }}
            />
          )}
        </div>
        {catalog && catalog.remotes.length === 0 && (
          <p className="text-fg2 text-xs">
            This repository has no git remotes. New workspaces branch from local
            branches; add a remote (e.g.{" "}
            <code className="bg-bg2-hover rounded-sm px-1 py-0.5 font-mono">
              git remote add origin &lt;url&gt;
            </code>
            ) to push and open pull requests.
          </p>
        )}
      </SettingsSection>
    </div>
  );
}

// ── Scripts (setup / run / archive) ──────────────────────

const SCRIPT_AUTOSAVE_DELAY_MS = 500;

function ScriptsSection({
  project,
  layer,
  root,
  mainRepoRoot,
}: {
  project: Project;
  layer: EditableRepoLayer;
  root: string;
  mainRepoRoot?: string;
}) {
  const resolved = useResolvedSettings(root, mainRepoRoot);
  const {
    layer: scriptLayer,
    loading: scriptsLoading,
    write: writeScripts,
  } = useSettingsLayer(layer, root);
  const saved = ((scriptLayer?.doc ?? {}) as RepoSharedDoc).scripts ?? {};

  const [setupDraft, setSetupDraft] = useSyncedDraft(saved.setup ?? "");
  const [archiveDraft, setArchiveDraft] = useSyncedDraft(saved.archive ?? "");

  const latestDraftsRef = useRef({ setup: setupDraft, archive: archiveDraft });
  latestDraftsRef.current = { setup: setupDraft, archive: archiveDraft };
  const autosaveRunningRef = useRef(false);
  const autosaveQueuedRef = useRef(false);

  // NOTE: no "Run" field here anymore — run commands are configured in the
  // "Run actions" module rendered below this one (which supersedes the legacy
  // `scripts.run` string and clears it on save). Setup / Archive autosave as a
  // pair, never touching `run`, so the two modules can't fight over the key.
  // Writes are serialized: if the user keeps typing during one bridge write,
  // the latest complete pair follows it instead of racing an older snapshot.
  const autosaveLatest = useCallback(async () => {
    if (autosaveRunningRef.current) {
      autosaveQueuedRef.current = true;
      return;
    }

    autosaveRunningRef.current = true;
    try {
      do {
        autosaveQueuedRef.current = false;
        const snapshot = { ...latestDraftsRef.current };
        try {
          await writeScripts({
            scripts: {
              setup: snapshot.setup || null,
              archive: snapshot.archive || null,
            },
          });
        } catch {
          toast.error("Couldn't autosave scripts");
          break;
        }

        const latest = latestDraftsRef.current;
        if (
          latest.setup !== snapshot.setup ||
          latest.archive !== snapshot.archive
        ) {
          autosaveQueuedRef.current = true;
        }
      } while (autosaveQueuedRef.current);
    } finally {
      autosaveRunningRef.current = false;
    }
  }, [writeScripts]);

  useEffect(() => {
    const dirty =
      setupDraft !== (saved.setup ?? "") ||
      archiveDraft !== (saved.archive ?? "");
    if (scriptsLoading || !dirty) return;

    const timeout = window.setTimeout(
      () => void autosaveLatest(),
      SCRIPT_AUTOSAVE_DELAY_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [
    archiveDraft,
    autosaveLatest,
    saved.archive,
    saved.setup,
    scriptsLoading,
    setupDraft,
  ]);

  const setup = pick(resolved.resolved, "scripts.setup");
  const archive = pick(resolved.resolved, "scripts.archive");

  return (
    <SettingsSection>
      <div className="flex flex-col gap-3">
        <OverrideField
          id={`script-setup-${project.id}`}
          label="Setup"
          description="Runs on every worktree creation"
          source={setup.source}
          draft={setupDraft}
          onChange={setSetupDraft}
          onReset={() => setSetupDraft("")}
          layer={layer}
        />
        <OverrideField
          id={`script-archive-${project.id}`}
          label="Archive"
          description="Runs before a workspace is archived"
          source={archive.source}
          draft={archiveDraft}
          onChange={setArchiveDraft}
          onReset={() => setArchiveDraft("")}
          layer={layer}
        />
      </div>
    </SettingsSection>
  );
}

// ── Actions (per-repo agent instructions) ───────────────
//
// "General preferences" = the repo's `[prompts] general` in .zeros/settings.toml.
// spawn-env emits it as ZEROS_PROMPTS_GENERAL → the gateway folds it into the
// first-turn <system_instruction> (see system-instructions/). Review /
// Create-PR / Fix-errors / Resolve-conflicts / Branch-rename prompts are
// planned as well; those land when their buttons are built (the schema
// already reserves them, and the text home is system-instructions/templates.ts).
function ActionsSection({
  project,
  layer,
  root,
  mainRepoRoot,
}: {
  project: Project;
  layer: EditableRepoLayer;
  root: string;
  mainRepoRoot?: string;
}) {
  const resolved = useResolvedSettings(root, mainRepoRoot);
  const repo = useSettingsLayer(layer, root);
  const saved = ((repo.layer?.doc ?? {}) as RepoSharedDoc).prompts ?? {};
  const [generalDraft, setGeneralDraft] = useSyncedDraft(saved.general ?? "");
  const dirty = generalDraft.trim() !== (saved.general ?? "");

  const handleSave = async () => {
    try {
      await repo.write({ prompts: { general: generalDraft.trim() || null } });
      toast.success("Preferences saved");
    } catch {
      toast.error("Couldn't save preferences");
    }
  };

  const general = pick(resolved.resolved, "prompts.general");
  const inherited =
    general.source !== undefined &&
    general.source !== layer &&
    generalDraft.trim() === "";
  const overridden = general.source === layer && generalDraft.trim() !== "";
  const id = `prompts-general-${project.id}`;

  return (
    <SettingsSection
      title="Actions"
      description="Configure action-specific instructions for this repository."
    >
      <SettingsList>
        <SettingsField
          htmlFor={id}
          label={
            <span className="flex items-start justify-between gap-2">
              <span className="flex flex-col gap-0.5">
                <span className="flex items-center gap-2">
                  General preferences
                  {inherited && <SourceTag source={general.source} />}
                </span>
                <span className="text-fg2 text-xs font-normal">
                  Custom instructions sent to the agent at the start of every
                  new chat.
                </span>
              </span>
              {overridden && (
                <ResetToInherited
                  onReset={() =>
                    void resetKey(
                      repo,
                      { prompts: { general: null } },
                      setGeneralDraft,
                    )
                  }
                />
              )}
            </span>
          }
        >
          <Textarea
            id={id}
            value={generalDraft}
            onChange={(e) => setGeneralDraft(e.target.value)}
            placeholder={
              asString(general.value) ||
              "Add custom instructions for all agents working in this repo."
            }
            rows={6}
            spellCheck={false}
            className="font-mono"
          />
        </SettingsField>
      </SettingsList>
      <SettingsActions>
        <Button
          variant="secondary"
          size="md"
          onClick={() => void handleSave()}
          disabled={repo.loading || !dirty}
        >
          Save
        </Button>
      </SettingsActions>
    </SettingsSection>
  );
}

// ── Paths (identity read-only + workspaces path, repo-local) ──

interface RepoLocalDoc {
  workspaces?: { path?: string };
}

function PathsSection({ project }: { project: Project }) {
  const resolved = useResolvedSettings(project.repoRoot);
  const local = useSettingsLayer("repo-local", project.repoRoot);
  const repoPath =
    ((local.layer?.doc ?? {}) as RepoLocalDoc).workspaces?.path ?? "";
  const effective = pick(resolved.resolved, "workspaces.path");

  const [draft, setDraft] = useSyncedDraft(repoPath);

  const handleSave = async () => {
    const trimmed = draft.trim();
    try {
      await local.write({ workspaces: { path: trimmed || null } });
      toast.success(
        trimmed
          ? "Workspaces path saved"
          : "Workspaces path cleared — using the default",
      );
    } catch {
      toast.error("Couldn't save the workspaces path");
    }
  };

  const handleBrowse = async () => {
    const picked = await dialogPickFolder({
      title: "Choose a workspaces folder",
      defaultPath: draft.trim() || asString(effective.value) || undefined,
    });
    if (picked) setDraft(picked);
  };

  const inherited = isInheritedSource(effective.source) && draft.trim() === "";

  return (
    <div className="flex flex-col gap-8">
      <SettingsSection title="Identity">
        <SettingsList>
          <SettingsRow label="Name">
            <span className="text-fg2 text-sm">{project.name}</span>
          </SettingsRow>
          <SettingsRow label="Slug">
            <span className="text-fg2 text-sm">{project.repoSlug || "—"}</span>
          </SettingsRow>
          <SettingsRow label="Origin">
            <span
              className={cn(
                "text-sm",
                project.originUrl ? "text-fg2" : "text-muted-fg italic",
              )}
            >
              {project.originUrl ?? "Not set"}
            </span>
          </SettingsRow>
          <SettingsRow label="Root path">
            <Tooltip label={project.repoRoot}>
              <span className="text-fg2 max-w-[60%] truncate text-sm">
                {project.repoRoot}
              </span>
            </Tooltip>
          </SettingsRow>
        </SettingsList>
      </SettingsSection>

      <SettingsSection
        title="Workspaces"
        description="Where new worktrees are created. Personal to this Mac (.zeros/settings.local.toml, kept out of git)."
      >
        <SettingsField
          htmlFor={`workspaces-${project.id}`}
          label={
            <span className="flex items-center gap-2">
              Workspaces path
              {inherited && <SourceTag source={effective.source} />}
            </span>
          }
        >
          <div className="flex flex-row gap-2">
            <Input
              id={`workspaces-${project.id}`}
              type="text"
              spellCheck={false}
              autoComplete="off"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                asString(effective.value) ||
                `~/zeros/workspaces/${project.repoSlug || "<slug>"}`
              }
              className="flex-1 font-mono text-sm"
              aria-label="Workspaces path"
            />
            <Button
              variant="secondary"
              size="lg"
              onClick={() => void handleBrowse()}
              className="gap-1.5"
            >
              <FolderOpen className="size-3.5" aria-hidden="true" />
              Browse
            </Button>
            <Button
              variant="secondary"
              size="lg"
              onClick={() => void handleSave()}
              disabled={local.loading || draft.trim() === repoPath}
            >
              Save
            </Button>
          </div>
        </SettingsField>
      </SettingsSection>

      <RemoveRepositorySection project={project} />
    </div>
  );
}

// ── Remove repository (end of Paths) ─────────────────────
//
// Removes the repo from Zeros: deletes EVERY Zeros-created worktree (the
// ~/zeros/workspaces/<slug>/* folders) and drops the project from the sidebar
// + its per-repo UI prefs. The repo's own source checkout (repoRoot) is NEVER
// touched:
//   • workspaceList() already strips the synthetic `local-main` row (the source
//     checkout); we ALSO guard with isLocalMainWorkspace as belt-and-suspenders.
//   • deleteWorkspace runs `git worktree remove --force <worktree>` — never the
//     repoRoot — and we pass includeBranch:false, so the source repo's branches
//     and refs are left intact too. (Engine: apps/desktop/src/engine/git/worktree.ts.)
// Chats inside the removed repo are deleted too (renderer store + engine DB +
// localStorage cache, step 4 below) — a removed repo's data should be gone, not
// silently orphaned. We only bounce the active workspace away if the user is
// currently inside the repo being removed, so "Back" never lands on a dead
// "No workspace selected" pane.
function RemoveRepositorySection({ project }: { project: Project }) {
  const dispatch = useWorkspaceDispatch();
  const chats = useChats();
  const activeChatId = useActiveChatId();
  const newAgentFolder = useNewAgentFolder();
  const { projects } = useProjects();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleRemove = async () => {
    if (busy) return;
    setBusy(true);
    // Snapshot what's active BEFORE mutating, so we can tell whether the user
    // is currently inside the repo being removed.
    const activeChat = chats.find((c) => c.id === activeChatId) ?? null;
    const activeFolderAtStart = activeChat?.folder ?? newAgentFolder ?? null;
    try {
      // 1. Enumerate this repo's real worktrees. workspaceList already drops
      //    the synthetic local-main entry (the source checkout).
      // A failed bridge read must not strand preferences for workspaces we
      // already knew belonged to this repo. The exact-key cache is safe
      // fallback identity for deletion cleanup; a successful list replaces it.
      let workspaces: Workspace[] = peekWorkspacesFor(project.repoSlug) ?? [];
      try {
        workspaces = await workspaceList({
          repoSlug: project.repoSlug,
          includeDesign: true,
        });
      } catch (err) {
        // Bridge down / engine unreachable — fall through and still remove the
        // project locally; leftover worktree folders can be cleaned on re-open.
        console.warn("[Zeros] remove repo — workspace list failed:", err);
      }

      // 2. Bounce the active workspace if the user is currently inside the repo
      //    being removed — BEFORE deleting, so nothing points at a worktree
      //    mid-deletion and "Back" doesn't strand them on "No workspace
      //    selected". Land on another project, or clear (→ welcome) when none
      //    remain. Removing a different repo than the active one is a no-op here.
      const removedFolders = new Set<string>([
        project.repoRoot,
        ...workspaces.map((w) => w.path),
      ]);
      const removedFolderRoots = [...removedFolders];
      const folderBelongsToRemovedRepo = (folder: string) =>
        folderIsOwnedByProject(
          folder,
          project.id,
          projects,
          removedFolderRoots,
        );
      if (
        activeFolderAtStart &&
        folderBelongsToRemovedRepo(activeFolderAtStart)
      ) {
        const remaining = projects.filter((p) => p.id !== project.id);
        // Land on a REAL chat in the remaining project when one exists
        // (last-viewed there, else most-recent) — a null selection renders a
        // dead Conversation pane. Otherwise pin the scope and let the tab strip's
        // selection keeper auto-spawn a default chat (or fall through to the
        // welcome view when no projects remain).
        const nextRoot = remaining[0]?.repoRoot ?? null;
        const restoreId = selectChatToRestoreForFolder(
          useWorkspaceStore.getState(),
          nextRoot,
        );
        if (nextRoot) {
          dispatch({
            type: "OPEN_WORKSPACE",
            folder: nextRoot,
            repoRoot: nextRoot,
            chatId: restoreId,
          });
        } else {
          dispatch({ type: "CLEAR_WORKSPACE_TARGET" });
        }
      }

      // 3. Delete each worktree FOLDER. includeBranch:false → the source repo's
      //    branches/refs are not modified. Per-worktree failures are collected
      //    so one stuck worktree doesn't abort the rest.
      const failed: string[] = [];
      for (const ws of workspaces) {
        if (isLocalMainWorkspace(ws.id)) continue; // never the source checkout
        try {
          await workspaceDelete({ workspaceId: ws.id, includeBranch: false });
        } catch (err) {
          failed.push(ws.branch || ws.id);
          console.warn(
            "[Zeros] remove repo — workspace delete failed:",
            ws.id,
            err,
          );
        }
      }

      // 4. Delete this repo's chats — from the renderer store, the engine DB,
      //    and the localStorage cache. The user expects a removed repo's data
      //    gone, not left dormant. repoChatIds = chats whose folder is the repo
      //    root (local-main) or one of the deleted worktree paths.
      const repoChatIds = new Set(
        chats
          .filter((c) => folderBelongsToRemovedRepo(c.folder))
          .map((c) => c.id),
      );
      for (const id of repoChatIds) {
        dispatch({ type: "DELETE_CHAT", id }); // renderer store + LS primary
        void dbDeleteChat(id).catch(() => {}); // engine row + sync tombstone
      }
      // If that removed EVERY chat, suppress the localStorage backup + SQLite
      // recovery NOW (don't wait for the 5s tombstone debounce) so a reload
      // can't resurrect them. No-op when chats remain — the persist effect
      // keeps the backup correct in that case.
      if (repoChatIds.size > 0 && chats.every((c) => repoChatIds.has(c.id))) {
        setSetting(CHATS_BACKUP_KEY, []);
        setSetting(CHATS_TOMBSTONE_KEY, true);
      }

      // 5. Close the dialog before removing its target from the retained deck.
      setConfirmOpen(false);

      // 6. Drop the project from the registry + per-repo UI prefs, then tell
      //    every consumer (sidebar, settings repo list) to refresh.
      clearRepoPerformanceSnapshots(project.repoRoot);
      clearChangesFilters([
        project.repoRoot,
        ...workspaces.map((workspace) => workspace.id),
      ]);
      forgetChangesSnapshots([
        project.repoRoot,
        ...workspaces.map((workspace) => workspace.id),
      ]);
      clearTerminalFolders([...removedFolders], project.id);
      clearChatPaneFolders([...removedFolders], project.id);
      clearDashboardRepoFilter(project.repoSlug);
      dispatch({
        type: "REMOVE_REPO_UI_STATE",
        projectId: project.id,
        repoRoot: project.repoRoot,
        workspaceFolders: [...removedFolders],
      });
      forgetWorkspacesFor(project.repoSlug);
      removeProject(project.id);
      clearRepoSettings(project.id);
      notifyProjectsChanged();
      notifyWorkspacesChanged(project.repoSlug);

      // 7. If that was the LAST project, re-root the engine at the empty
      //    sentinel. The engine stays rooted at the just-removed repo otherwise,
      //    so a paired web/remote peer would keep seeing it (and the desktop is
      //    now on the welcome screen anyway). Fire-and-forget — the bridge
      //    reconnects to the sentinel engine in the background.
      const noProjectsLeft =
        projects.filter((p) => p.id !== project.id).length === 0;
      if (noProjectsLeft) {
        void resetEngineToDefault().catch((err) => {
          console.warn("[Zeros] reset engine to default failed:", err);
        });
      }

      if (failed.length > 0) {
        toast.warning(
          `Removed ${project.name}, but ${failed.length} workspace${
            failed.length === 1 ? "" : "s"
          } couldn't be fully deleted.`,
          {
            description:
              "The source folder is untouched. Re-open the repo to retry, or delete the leftover worktree folder manually.",
          },
        );
      } else {
        toast.success(`Removed ${project.name} from Zeros`);
      }
    } catch (err) {
      console.error("[Zeros] remove repo failed:", err);
      const msg = isGitErrorShape(err)
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
      toast.error(`Couldn't remove ${project.name}: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="Remove repository"
      description="Take this repo out of Zeros and delete the worktrees Zeros created for it. Your source folder is left untouched."
    >
      <div>
        <Button
          variant="destructive-secondary"
          size="md"
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          Remove repository
        </Button>
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={(o) => {
          // Don't let an outside-click / Esc close the dialog mid-removal.
          if (!busy) setConfirmOpen(o);
        }}
      >
        <DialogContent className="max-w-[480px] gap-4">
          <div className="flex flex-col gap-3">
            <DialogTitle>Remove {project.name}?</DialogTitle>
            <DialogDescription className="flex flex-col gap-3">
              <span>All your workspaces will be permanently deleted.</span>
              <span>
                The source directory{" "}
                <span className="break-all">{project.repoRoot}</span> will not
                be modified.
              </span>
            </DialogDescription>
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmOpen(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleRemove()}
              disabled={busy}
            >
              {busy && <ZerosSpinner size={16} tone="inherit" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
