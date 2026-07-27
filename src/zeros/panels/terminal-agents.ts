// ──────────────────────────────────────────────────────────
// Terminal Agents — catalog, prefs, and runtime resolver
// ──────────────────────────────────────────────────────────
//
// A "terminal agent" is a coding-CLI profile the user can wire
// into the column-3 floating terminal panel. When the user opens
// a new terminal Zeros spawns a login shell at the active
// worktree, then (optionally) launches the agent's binary with
// the user's saved arg recipe — same UX as if they'd typed
// `claude` themselves, only one keystroke away.
//
// What's modelled here vs. left to ./provider-prefs.ts:
//   - provider-prefs (existing): vendor API-key auth + gateway
//     URL + binary-path override for the engine-driven adapters
//     (Claude/Codex/Cursor). That layer governs how the engine
//     subprocess spawns headlessly.
//   - terminal-agents (this file): the human-facing TUI launch.
//     Strictly cosmetic launch line + prompt transport for the
//     PTY surface — no auth, no env-var injection, no engine.
//
// Industry survey (2026-Q2) — cmux, dmux, emdash, orca, herdr,
// solo, terax all converge on the same profile shape:
//
//   { binary, launchCommand, promptTransport, promptArgs,
//     additionalArgs, autoApproveFlag, installHint, loginArgs }
//
// We adopt that shape verbatim so import/export across tools is
// trivial when Zeros publishes a `zeros agent export` later.
// Forward-looking fields (notifications / hooks / dropTargets)
// are reserved in the type but unused today — adding them now
// means future features land without a schema migration.
//
// Persistence:
//   - localStorage `terminal-agents:catalog` (the user's edits +
//     any custom agents they add via "+ Add agent"). Built-ins are
//     always shown by the settings UI and resolve from
//     BUILTIN_TERMINAL_AGENTS, so this starts empty and only ever
//     holds overrides / custom entries.
//   - localStorage `terminal-agents:default` (id of the agent
//     auto-launched on "+" in the terminal panel; null = plain
//     shell).
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";

import { getSetting, setSetting } from "../../native/settings";

// ── Type model ────────────────────────────────────────────

/** How a prompt is delivered to the CLI. Mirrors the convention
 *  surveyed across cmux/dmux/emdash/orca — every modern coding
 *  CLI exposes one of these three modes. */
export type PromptTransport = "interactive" | "prompt-arg" | "stdin";

export interface TerminalAgentInstallHint {
  command: string;
  docsUrl?: string;
}

/** Forward-looking surface for the OSC 9/99/777 stream parser the
 *  panel will grow into. cmux/herdr both detect agent state from
 *  the PTY byte stream — keeping the field reserved means we can
 *  light it up without bumping the storage schema. */
export interface TerminalAgentNotificationsSpec {
  enabled: boolean;
  /** Which OSC sequence IDs to listen for. Empty = use the
   *  default 9/99/777 set when `enabled` is true. */
  oscSequences: number[];
}

/** Forward-looking — Phase 3 of Roadmap 04 adds drag-and-drop of
 *  files into the terminal pane. Each agent declares what it
 *  accepts so the dnd overlay can show the right affordance. */
export interface TerminalAgentDropTargetsSpec {
  acceptsFiles: boolean;
  acceptsImages: boolean;
}

/** Forward-looking — cmux/dmux already have a hook contract for
 *  agent lifecycle. We model the shape so adding a runner later
 *  is purely UI work. */
export interface TerminalAgentHooksSpec {
  /** Shell line to run before the agent launches in the PTY. */
  onStart?: string;
  /** Shell line to run when the agent's process exits. */
  onFinish?: string;
}

export interface TerminalAgent {
  id: string;
  /** Short display name (used in tabs, dropdowns). */
  name: string;
  /** One-line description shown under the tab. */
  description: string;
  /** Lobehub-style icon URL (optional — falls back to neutral
   *  foreground initial when absent). Per-agent brand color lives
   *  in `src/zeros/agent/agent-brands.ts` so terminal-only catalog
   *  entries don't fork the token policy. */
  icon?: string;
  /** Binary on PATH (e.g. "claude", "codex", "cursor-agent"). */
  binary: string;
  /** The exact command Zeros types into the freshly-spawned
   *  shell. Defaults to `binary` but the user can override (e.g.
   *  `claude --resume` or a wrapper script). */
  launchCommand: string;
  /** How a prompt — when the user later supplies one via the
   *  composer — is delivered to the CLI. `interactive` skips
   *  the prompt entirely (TUI-only). */
  promptTransport: PromptTransport;
  /** Tokens the CLI expects BEFORE the prompt body. E.g. Claude
   *  uses `["-p"]`; Codex uses `["exec"]`. Stored as an array
   *  so the user doesn't have to think about shell quoting. */
  promptArgs: string[];
  /** Extra tokens appended to every launch (model flag, debug
   *  mode, etc.). Free-form so the user can paste anything
   *  their CLI version supports. */
  additionalArgs: string[];
  /** Flag the user can toggle via a one-click checkbox in the
   *  composer (Phase 04b). Stored as a string so each CLI's
   *  convention (--yolo / --dangerously-skip-permissions /
   *  --force) survives a round-trip. */
  autoApproveFlag: string;
  /** Pre-baked install command + docs URL, surfaced when the
   *  binary isn't on PATH. */
  installHint?: TerminalAgentInstallHint;
  /** Args for the CLI's own login flow (e.g. ["login"], ["auth",
   *  "login"], ["/login"]). The terminal panel uses this when the
   *  user clicks "Sign in" from a not-authenticated tab. */
  loginArgs: string[];
  /** True when this entry has been Imported from the BUILTIN
   *  catalog (vs. user-authored from scratch). Lets the UI
   *  visually distinguish stock vs. custom rows. */
  imported: boolean;
  /** Forward-looking — kept so future features don't migrate
   *  storage. See comments on each sub-type. */
  notifications?: TerminalAgentNotificationsSpec;
  /** Forward-looking — file/image drag targets. */
  dropTargets?: TerminalAgentDropTargetsSpec;
  /** Forward-looking — lifecycle hooks. */
  hooks?: TerminalAgentHooksSpec;
}

// ── Built-in catalog ──────────────────────────────────────
//
// Every entry's `launchCommand` defaults to the bare binary
// (Cursor runs an interactive TUI by default; Claude / Codex
// also have rich TUIs by default and grow a `-p`/`exec` mode
// for scripted prompt-arg delivery).
//
// `autoApproveFlag` reflects each CLI's documented "skip the
// confirmation gate" toggle as of 2026-Q2. These are intentionally
// per-vendor strings, not a normalised enum — when the CLI ships
// a new flag name (which they do every quarter) the user can edit
// the field without an app update.

// Display order + identity. The user-facing NAME is the launch command
// (lowercase) — "the launch command is the name of the agent". Logos are
// shown ONLY for claude / codex / cursor-agent / opencode (bundled SVGs);
// every other agent renders name-only (no `icon` → no robot fallback).
// `autoApproveFlag` is a best-effort pre-fill the user can edit (the field is
// a starting point, not a guarantee — see settings UI). Where a CLI's
// skip-approval flag isn't well-established it's left blank.
export const BUILTIN_TERMINAL_AGENTS: TerminalAgent[] = [
  {
    id: "claude",
    name: "claude",
    description: "Anthropic's Claude Code CLI.",
    icon: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/claude.svg",
    binary: "claude",
    launchCommand: "claude",
    promptTransport: "prompt-arg",
    promptArgs: ["-p"],
    additionalArgs: [],
    autoApproveFlag: "--dangerously-skip-permissions",
    installHint: {
      command: "npm install -g @anthropic-ai/claude-code",
      docsUrl: "https://code.claude.com/docs",
    },
    loginArgs: ["/login"],
    imported: false,
  },
  {
    id: "codex",
    name: "codex",
    description: "OpenAI Codex CLI.",
    icon: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/openai.svg",
    binary: "codex",
    launchCommand: "codex",
    promptTransport: "prompt-arg",
    promptArgs: ["exec"],
    additionalArgs: [],
    autoApproveFlag: "--dangerously-bypass-approvals-and-sandbox",
    installHint: {
      command: "npm install -g @openai/codex",
      docsUrl: "https://developers.openai.com/codex",
    },
    loginArgs: ["login"],
    imported: false,
  },
  {
    id: "cursor",
    name: "cursor-agent",
    description: "Cursor's coding agent CLI.",
    icon: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/cursor.svg",
    binary: "cursor-agent",
    launchCommand: "cursor-agent",
    promptTransport: "interactive",
    promptArgs: [],
    additionalArgs: [],
    autoApproveFlag: "--force",
    installHint: {
      command: "curl https://cursor.com/install -sSf | bash",
      docsUrl: "https://cursor.com/docs/cli",
    },
    loginArgs: ["login"],
    imported: false,
  },
  {
    id: "opencode",
    name: "opencode",
    description: "SST's open-source terminal coding agent.",
    icon: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/opencode.svg",
    binary: "opencode",
    launchCommand: "opencode",
    promptTransport: "prompt-arg",
    promptArgs: ["run"],
    additionalArgs: [],
    autoApproveFlag: "",
    installHint: {
      command: "curl -fsSL https://opencode.ai/install | bash",
      docsUrl: "https://opencode.ai/docs/cli",
    },
    loginArgs: ["auth", "login"],
    imported: false,
  },
  {
    id: "amp",
    name: "amp",
    description: "Sourcegraph Amp coding agent.",
    binary: "amp",
    launchCommand: "amp",
    promptTransport: "prompt-arg",
    promptArgs: ["-x"],
    additionalArgs: [],
    autoApproveFlag: "",
    installHint: {
      command: "npm install -g @ampcode/cli",
      docsUrl: "https://ampcode.com/manual",
    },
    loginArgs: ["login"],
    imported: false,
  },
  {
    id: "antigravity",
    name: "antigravity",
    description: "Google Antigravity CLI.",
    binary: "antigravity",
    launchCommand: "antigravity",
    promptTransport: "interactive",
    promptArgs: [],
    additionalArgs: [],
    autoApproveFlag: "",
    loginArgs: ["login"],
    imported: false,
  },
  {
    id: "droid",
    name: "droid",
    description: "Factory's Droid CLI.",
    binary: "droid",
    launchCommand: "droid",
    promptTransport: "prompt-arg",
    promptArgs: ["exec"],
    additionalArgs: [],
    autoApproveFlag: "--auto high",
    installHint: {
      command: "curl -fsSL https://app.factory.ai/cli | sh",
      docsUrl: "https://docs.factory.ai/cli",
    },
    loginArgs: ["login"],
    imported: false,
  },
];

/** Order in which Imported agents appear in the tab strip. Mirrors
 *  BUILTIN_TERMINAL_AGENTS — keeps the UI deterministic across
 *  reloads and across machines that imported in different orders. */
export const TERMINAL_AGENT_ORDER: ReadonlyArray<string> =
  BUILTIN_TERMINAL_AGENTS.map((a) => a.id);

/** The agents that are ALWAYS shown and can't be removed or have their launch
 *  command edited. Every other agent (amp / antigravity / droid + any custom)
 *  is user-removable and fully editable. */
export const CORE_TERMINAL_AGENT_IDS: ReadonlyArray<string> = [
  "claude",
  "codex",
  "cursor",
  "opencode",
];

// ── Storage ──────────────────────────────────────────────

const CATALOG_KEY = "terminal-agents:catalog";
const DEFAULT_ID_KEY = "terminal-agents:default";
// Ids of BUILT-IN agents the user removed from the list. Built-ins live in
// code (not the catalog), so "removing" one means hiding it via this set; a
// custom agent is removed by deleting it from the catalog outright.
const REMOVED_KEY = "terminal-agents:removed";

export function loadTerminalAgents(): TerminalAgent[] {
  const stored = getSetting<TerminalAgent[] | null>(CATALOG_KEY, null);
  if (!Array.isArray(stored)) return [];
  return stored.filter((a) => isWellFormed(a));
}

export function saveTerminalAgents(agents: TerminalAgent[]): void {
  setSetting(CATALOG_KEY, agents);
  notify();
}

export function getDefaultTerminalAgentId(): string | null {
  return getSetting<string | null>(DEFAULT_ID_KEY, null);
}

export function setDefaultTerminalAgentId(id: string | null): void {
  setSetting(DEFAULT_ID_KEY, id);
  notify();
}

/** Built-in agent ids the user has hidden (removed). Core agents are never
 *  removable, so they never appear here. */
export function loadRemovedTerminalAgentIds(): string[] {
  const s = getSetting<string[] | null>(REMOVED_KEY, null);
  return Array.isArray(s)
    ? s.filter((x): x is string => typeof x === "string")
    : [];
}

function saveRemovedTerminalAgentIds(ids: string[]): void {
  setSetting(REMOVED_KEY, ids);
  notify();
}

/** Validate the persisted shape. We don't full-schema-check —
 *  loose fields stay as-is — but the four critical strings must
 *  be present or the entry is dropped. */
function isWellFormed(a: unknown): a is TerminalAgent {
  if (!a || typeof a !== "object") return false;
  const r = a as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.binary === "string" &&
    typeof r.launchCommand === "string"
  );
}

// ── Resolver — shell line for a single launch ────────────
//
// Given an agent and an optional prompt body, build the actual
// shell line Zeros types into the PTY. The same helper is used
// by:
//   - terminal-session-view.tsx (auto-launch on "+")
//   - future Phase 04b composer "Send to terminal" action
//
// Quoting policy: prompts and additional args are double-quoted
// with embedded `"` and `\` escaped. The CLI binary itself is
// never quoted — it has to remain on PATH-resolveable form, and
// users who need an absolute path can paste it into
// `launchCommand` directly.

export interface BuildLaunchLineOptions {
  agent: TerminalAgent;
  /** Optional prompt body. When omitted (or the agent's transport
   *  is "interactive") the launch line is just the binary and
   *  static args. */
  prompt?: string;
  /** Whether to append the autoApproveFlag to the launch. */
  autoApprove?: boolean;
}

export function buildLaunchLine(opts: BuildLaunchLineOptions): string {
  const { agent, prompt, autoApprove } = opts;
  const parts: string[] = [agent.launchCommand.trim()];
  for (const a of agent.additionalArgs) {
    if (a.trim()) parts.push(a.trim());
  }
  if (autoApprove && agent.autoApproveFlag.trim()) {
    parts.push(agent.autoApproveFlag.trim());
  }
  if (prompt && agent.promptTransport === "prompt-arg") {
    for (const a of agent.promptArgs) {
      if (a.trim()) parts.push(a.trim());
    }
    parts.push(shellQuote(prompt));
  }
  // "stdin" transport delivers the prompt out-of-band via a
  // separate ptyWrite() with a newline terminator — the launch
  // line itself stays prompt-free here.
  return parts.join(" ");
}

function shellQuote(value: string): string {
  // POSIX double-quote: backslash-escape `"`, `\`, `$`, and the
  // backtick. Anything else is safe inside double quotes. zsh +
  // bash + sh all agree on this subset.
  const escaped = value.replace(/(["\\$`])/g, "\\$1");
  return `"${escaped}"`;
}

// ── React hook ───────────────────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* listeners shouldn't throw — keep going */
    }
  }
}

export interface UseTerminalAgentsApi {
  agents: TerminalAgent[];
  defaultId: string | null;
  /** Built-in agent ids the user has hidden (removed). */
  removedIds: string[];
  setDefault(id: string | null): void;
  upsert(agent: TerminalAgent): void;
  /** Remove an agent. `launchCommand` (when supplied) also purges any other
   *  catalog entry sharing that command — clears leftover duplicates. */
  remove(id: string, launchCommand?: string): void;
}

export function useTerminalAgents(): UseTerminalAgentsApi {
  const [agents, setAgents] = useState<TerminalAgent[]>(() =>
    loadTerminalAgents(),
  );
  const [defaultId, setDefaultIdState] = useState<string | null>(() =>
    getDefaultTerminalAgentId(),
  );
  const [removedIds, setRemovedIds] = useState<string[]>(() =>
    loadRemovedTerminalAgentIds(),
  );

  useEffect(() => {
    const sync = () => {
      setAgents(loadTerminalAgents());
      setDefaultIdState(getDefaultTerminalAgentId());
      setRemovedIds(loadRemovedTerminalAgentIds());
    };
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const setDefault = useCallback((id: string | null) => {
    setDefaultTerminalAgentId(id);
  }, []);

  const upsert = useCallback((agent: TerminalAgent) => {
    const current = loadTerminalAgents();
    const idx = current.findIndex((a) => a.id === agent.id);
    const next =
      idx >= 0
        ? current.map((a, i) => (i === idx ? agent : a))
        : [...current, agent];
    saveTerminalAgents(next);
  }, []);

  const remove = useCallback((id: string, launchCommand?: string) => {
    // Core agents are permanent — guard even though the UI hides the control.
    if (CORE_TERMINAL_AGENT_IDS.includes(id)) return;
    const cmd = (launchCommand ?? "").trim();
    // Drop the entry by id AND any catalog entry sharing the launch command
    // (kills leftover duplicates from older catalogs).
    const next = loadTerminalAgents().filter(
      (a) => a.id !== id && !(cmd && a.launchCommand.trim() === cmd),
    );
    saveTerminalAgents(next);
    // A built-in lives in code, not the catalog, so hide it via the removed set.
    if (TERMINAL_AGENT_ORDER.includes(id)) {
      const removed = loadRemovedTerminalAgentIds();
      if (!removed.includes(id)) saveRemovedTerminalAgentIds([...removed, id]);
    }
    // If the removed agent was the default, fall back to null so new terminals
    // open as plain shells until the user picks another default.
    if (getDefaultTerminalAgentId() === id) {
      setDefaultTerminalAgentId(null);
    }
  }, []);

  return {
    agents,
    defaultId,
    removedIds,
    setDefault,
    upsert,
    remove,
  };
}

/** Non-React accessor used by `terminal-session-view.tsx` when
 *  the panel auto-launches the default agent. Falls back to the
 *  built-in catalog when the id isn't in the user's saved catalog —
 *  the settings UI shows (and lets you default to) every built-in
 *  without an explicit import/save, so a default that was never
 *  edited must still resolve to its stock launch profile. */
export function resolveTerminalAgent(
  id: string | null | undefined,
): TerminalAgent | null {
  if (!id) return null;
  const all = loadTerminalAgents();
  return (
    all.find((a) => a.id === id) ??
    BUILTIN_TERMINAL_AGENTS.find((a) => a.id === id) ??
    null
  );
}

/** Hardcoded terminal-agent fallback when the user hasn't picked a
 *  default yet. Mirrors the chat-side FALLBACK_AGENT_ID in
 *  zeros/panels/default-agent.ts so the rule "every chat lands with
 *  an agent" applies to both `kind: "chat"` and `kind: "terminal"`. */
export const FALLBACK_TERMINAL_AGENT_ID = "codex";

/** Idempotently ensure the fallback terminal agent ("codex") is in
 *  the user's saved catalog AND is the default. Called by the "+ →
 *  Terminal" menu path when no default is configured so a brand-new
 *  Zeros install never opens a terminal-agent tab without an agent.
 *
 *  Behavior:
 *   - If codex is already in the catalog, leave it alone.
 *   - If codex is NOT in the catalog, copy it in from
 *     BUILTIN_TERMINAL_AGENTS with `imported: true`.
 *   - If the user has no default terminal agent, set codex as the
 *     default. Existing defaults are never overwritten.
 *
 *  Returns the resolved TerminalAgent entry. Null only if the
 *  BUILTIN_TERMINAL_AGENTS catalog doesn't ship "codex" (which would
 *  be a code bug, not a runtime condition).
 */
export function ensureFallbackTerminalAgent(): TerminalAgent | null {
  const seed = BUILTIN_TERMINAL_AGENTS.find(
    (a) => a.id === FALLBACK_TERMINAL_AGENT_ID,
  );
  if (!seed) return null;
  const current = loadTerminalAgents();
  const existing = current.find((a) => a.id === FALLBACK_TERMINAL_AGENT_ID);
  if (!existing) {
    saveTerminalAgents([...current, { ...seed, imported: true }]);
  }
  if (getDefaultTerminalAgentId() === null) {
    setDefaultTerminalAgentId(FALLBACK_TERMINAL_AGENT_ID);
  }
  return resolveTerminalAgent(FALLBACK_TERMINAL_AGENT_ID);
}
