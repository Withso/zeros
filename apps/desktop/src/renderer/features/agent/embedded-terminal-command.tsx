// ──────────────────────────────────────────────────────────
// EmbeddedTerminalCommand — inline ephemeral terminal for Claude
// slash commands that need an interactive TUI (`/mcp`, `/login`, …)
// ──────────────────────────────────────────────────────────
//
// These commands aren't "text to send" — they drive Claude Code's
// interactive terminal UIs (manage MCP servers, sign in, edit memory).
// Zeros runs them in a one-shot login-shell PTY mounted right above the
// composer, then disposes it. Two states (matching the 2026-06-08 mockups):
//
//   1. BANNER  — "Run /mcp in the embedded terminal" + an Open-terminal
//                button. Nothing spawns until the user opts in (a PTY is a
//                real resource).
//   2. RUNNING — an ephemeral PTY in the chat's cwd runs `<claude> /mcp`; the
//                live xterm is mounted inline under a "Complete /mcp below,
//                then click done" header. Closing (×) or the shell exiting
//                disposes it.
//
// The `claude` binary is resolved host-side (resolveAgentBinary) so the line
// is the SAME CLI the agent uses, sharing ~/.claude config + auth. The PTY is
// a LOGIN shell, so even the bare-name fallback resolves.
// ──────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, X } from "lucide-react";

import { Button, cn } from "../../shared/ui";
import { IconButton, Tooltip } from "@/renderer/shared/ui/primitives";
import { DOCK_CARD_CLS } from "./composer-shell";
import { ptyKill, resolveAgentBinary } from "../../platform/pty";
import { TerminalSessionView } from "../../shell/terminal/terminal-session-view";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";

export interface EmbeddedTerminalCommandProps {
  /** The slash-command name without the leading slash (e.g. "mcp"). */
  command: string;
  /** The chat's working directory — where the ephemeral shell spawns. */
  cwd: string;
  /** The agent whose CLI to run (only "claude" is wired today). */
  agentId: string;
  /** Tear down: the parent clears its terminal-command state. */
  onClose: () => void;
}

/** POSIX single-quote a path that isn't a bare, safe token (so a binary path
 *  with spaces — e.g. macOS "Application Support" — runs as one argument). */
function shellQuoteIfNeeded(p: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(p)) return p;
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/** A collision-resistant ephemeral PTY session id. crypto.randomUUID is
 *  available in the renderer's secure context; degrade if it ever isn't.
 *  The degraded path uses getRandomValues rather than Math.random: randomUUID
 *  is the only WebCrypto member gated on a secure context, so the CSPRNG is
 *  still present in the exact branch that assumed it wasn't. */
function makeSessionId(command: string): string {
  let rand: string;
  try {
    rand = crypto.randomUUID();
  } catch {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    rand = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `ephemeral-term:${command}:${rand}`;
}

export function EmbeddedTerminalCommand({
  command,
  cwd,
  agentId,
  onClose,
}: EmbeddedTerminalCommandProps) {
  // null → banner; set → running (a spawned ephemeral session).
  const [running, setRunning] = useState<{
    sessionId: string;
    binPath: string;
  } | null>(null);
  const [opening, setOpening] = useState(false);

  // Reap the ephemeral PTY if this unmounts while a shell is still live (the
  // chat was switched/closed without an explicit dispose). It's not in the
  // shared registry, so nothing else would reap it before engine shutdown.
  // TerminalSessionView deliberately never kills on unmount (it survives
  // refresh), so this owner must.
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    return () => {
      const r = runningRef.current;
      if (r) void ptyKill({ sessionId: r.sessionId });
    };
  }, []);

  const open = useCallback(async () => {
    if (opening || running) return;
    setOpening(true);
    try {
      const binPath = await resolveAgentBinary(agentId);
      setRunning({ sessionId: makeSessionId(command), binPath });
    } finally {
      setOpening(false);
    }
  }, [opening, running, agentId, command]);

  const dispose = useCallback(() => {
    // Ephemeral PTYs are explicitly killed (TerminalSessionView never kills on
    // unmount — it's built to survive refresh). A no-op if the shell already
    // exited (natural-exit auto-dispose path).
    if (running) void ptyKill({ sessionId: running.sessionId });
    onClose();
  }, [running, onClose]);

  // ── Banner ──────────────────────────────────────────────
  if (!running) {
    return (
      // A dock bar like the goal card: the composer's surface, 44px tall.
      <div className={cn(DOCK_CARD_CLS, "flex min-h-11 items-center gap-2 py-1.5 pr-2 pl-3.5")}>
        <span className="text-fg2 min-w-0 flex-1 truncate text-xs leading-4.5">
          Run <span className="text-fg1">/{command}</span> in the embedded
          terminal
        </span>
        <Button
          type="button"
          // The banner's primary action: our standard secondary button
          // (bg1 fill + border3, hover bg2) — was a bespoke ghost/transparent
          // treatment. Only `shrink-0` is added so it doesn't collapse in the
          // flex row; the variant + base supply padding / text / icon sizing.
          variant="secondary"
          onClick={() => void open()}
          disabled={opening}
          className="shrink-0"
        >
          {opening ? (
            <ZerosSpinner size={16} />
          ) : (
            <Terminal size={16} className="text-fg2" />
          )}
          {opening ? "Opening…" : "Open terminal"}
        </Button>
        <CloseButton onClick={dispose} label="Dismiss" />
      </div>
    );
  }

  // ── Running ─────────────────────────────────────────────
  const line = `${shellQuoteIfNeeded(running.binPath)} /${command}`;
  return (
    // Terminal panel — header + the live xterm. No separate outer "done"
    // header: the panel header already carries the close (×) control, so a
    // second finish button above it was redundant (removed 2026-07-02).
    // The composer's surface with a 40px head; the live terminal sits inset
    // on its own bg1 with a border1 edge, the fill xterm paints.
    <div className={cn(DOCK_CARD_CLS, "flex flex-col overflow-hidden")}>
      <div className="flex min-h-10 items-center gap-2 py-1.5 pr-2 pl-3.5">
        <ZerosSpinner size={14} />
        <span className="text-fg2 min-w-0 flex-1 truncate text-xs leading-4.5">
          Running <span className="text-fg1">/{command}</span>.
        </span>
        <CloseButton onClick={dispose} label="Close terminal" />
      </div>
      <div className="border-border1 bg-bg1 mx-1.5 mb-1.5 h-[300px] min-h-0 overflow-hidden rounded-lg border px-2.5 py-2">
        <TerminalSessionView
          sessionId={running.sessionId}
          cwd={cwd}
          visible
          ephemeral
          initialCommand={line}
          onExit={dispose}
        />
      </div>
    </div>
  );
}

function CloseButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <Tooltip label={label}>
      <IconButton size="compact" label={label} onClick={onClick}>
        <X />
      </IconButton>
    </Tooltip>
  );
}
