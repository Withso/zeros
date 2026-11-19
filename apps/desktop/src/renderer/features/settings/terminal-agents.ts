import { subscribePreferenceCache } from "../../platform/personal-preferences";

import { useCallback, useEffect, useState } from "react";

import { getSetting, setSetting } from "../../platform/settings";

export type PromptTransport = "interactive" | "prompt-arg" | "stdin";

export interface TerminalAgentInstallHint {
  command: string;
  docsUrl?: string;
}

export interface TerminalAgentNotificationsSpec {
  enabled: boolean;
  /** Reserved default OSC IDs for an empty list: 9/99/777. */
  oscSequences: number[];
}

export interface TerminalAgentDropTargetsSpec {
  acceptsFiles: boolean;
  acceptsImages: boolean;
}

export interface TerminalAgentHooksSpec {
  onStart?: string;
  onFinish?: string;
}

export interface TerminalAgent {
  id: string;
  name: string;
  description: string;
  icon?: string;
  binary: string;
  /** A shell command can include arguments, unlike the executable name. */
  launchCommand: string;
  /** Interactive launches do not carry the prompt. */
  promptTransport: PromptTransport;
  /** CLI arguments that must precede the prompt body. */
  promptArgs: string[];
  additionalArgs: string[];
  /** Preserve the user's exact CLI syntax rather than mapping flags to an enum. */
  autoApproveFlag: string;
  installHint?: TerminalAgentInstallHint;
  loginArgs: string[];
  imported: boolean;
  // Reserved fields are retained in stored profiles for compatibility.
  notifications?: TerminalAgentNotificationsSpec;
  dropTargets?: TerminalAgentDropTargetsSpec;
  hooks?: TerminalAgentHooksSpec;
}

// Unknown approval flags stay blank rather than guessing a CLI's behavior.
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
    icon: "https://unpkg.com/@lobehub/icons-static-svg@latest/icons/codex.svg",
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

// Keep tab order independent of import order.
export const TERMINAL_AGENT_ORDER: ReadonlyArray<string> =
  BUILTIN_TERMINAL_AGENTS.map((a) => a.id);

export const CORE_TERMINAL_AGENT_IDS: ReadonlyArray<string> = [
  "claude",
  "codex",
  "cursor",
  "opencode",
];

// Store overrides and custom profiles; unedited built-ins resolve from code.
const CATALOG_KEY = "terminal-agents:catalog";
const DEFAULT_ID_KEY = "terminal-agents:default";
// Built-ins need persisted hide markers because deleting an override reveals the stock entry.
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

// Tolerate optional fields from persisted profiles; only require the launch identity.
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

export interface BuildLaunchLineOptions {
  agent: TerminalAgent;
  prompt?: string;
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
  // Stdin transport needs a separate PTY write, not a command argument.
  return parts.join(" ");
}

function shellQuote(value: string): string {
  // Escape POSIX double-quote metacharacters in prompt text.
  const escaped = value.replace(/(["\\$`])/g, "\\$1");
  return `"${escaped}"`;
}

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
  removedIds: string[];
  setDefault(id: string | null): void;
  upsert(agent: TerminalAgent): void;
  /** Pass the command to purge duplicate entries from older catalogs. */
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
    if (CORE_TERMINAL_AGENT_IDS.includes(id)) return;
    const cmd = (launchCommand ?? "").trim();
    const next = loadTerminalAgents().filter(
      (a) => a.id !== id && !(cmd && a.launchCommand.trim() === cmd),
    );
    saveTerminalAgents(next);
    if (TERMINAL_AGENT_ORDER.includes(id)) {
      const removed = loadRemovedTerminalAgentIds();
      if (!removed.includes(id)) saveRemovedTerminalAgentIds([...removed, id]);
    }
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

// A saved default ID can point at a built-in with no saved profile.
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

// Terminal agents do not use the chat provider registry to select a fallback.
export const FALLBACK_TERMINAL_AGENT_ID = "codex";

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

for (const key of [CATALOG_KEY, DEFAULT_ID_KEY, REMOVED_KEY])
  subscribePreferenceCache(`zeros-${key}`, notify);
