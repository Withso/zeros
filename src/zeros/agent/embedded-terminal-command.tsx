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

import { Button, cn } from "../ui";
import { Tooltip } from "@/zeros/ui/primitives";
import { ptyKill, resolveAgentBinary } from "../../native/pty";
import { TerminalSessionView } from "../../shell/terminal/terminal-session-view";
import { ZerosSpinner } from "@/loaders";

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
      <div className="flex items-center gap-2 rounded-lg border border-border1 bg-bg1 px-3.5 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm text-fg2">
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
    <div className="flex flex-col overflow-hidden rounded-lg border border-border1 bg-bg1">
      <div className="flex items-center gap-2 border-b border-border1 px-3.5 py-2">
        <ZerosSpinner size={14} />
        <span className="min-w-0 flex-1 truncate text-sm text-fg2">
          Running <span className="text-fg1">/{command}</span>.
        </span>
        <CloseButton onClick={dispose} label="Close terminal" />
      </div>
      <div className="h-[300px] min-h-0 w-full">
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
      <Button
        type="button"
        variant="ghost"
        aria-label={label}
        onClick={onClick}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-sm border-0 bg-transparent p-0 text-fg2",
          "hover:bg-bg1-hover hover:text-fg1",
        )}
      >
        <X size={16} />
      </Button>
    </Tooltip>
  );
}
