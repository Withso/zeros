import React, { useEffect, useRef, useState } from "react";
import { ClipboardPaste, X } from "lucide-react";

import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import { Button } from "../../shared/ui";
import { Tooltip } from "@/renderer/shared/ui/primitives";
import { ptyKill, resolveAgentBinary } from "../../platform/pty";
import { TerminalSessionView } from "../../shell/terminal/terminal-session-view";

function shellQuoteIfNeeded(path: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Replace the disposable login shell with the auth process. Its exit now
 * reaches TerminalSessionView immediately instead of returning to an idle
 * prompt, and treating args as data avoids shell metacharacter injection.
 */
export function buildInlineLoginCommand(
  binaryPath: string,
  args: readonly string[],
  unsetEnv: readonly string[] = [],
): string {
  for (const name of unsetEnv) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }
  }
  const cleanEnvironment =
    unsetEnv.length > 0
      ? ["/usr/bin/env", ...unsetEnv.flatMap((name) => ["-u", name])]
      : [];
  return [
    "exec",
    ...cleanEnvironment.map(shellQuoteIfNeeded),
    shellQuoteIfNeeded(binaryPath),
    ...args.map(shellQuoteIfNeeded),
  ].join(" ");
}

function makeLoginSessionId(ownerId: string): string {
  let random: string;
  try {
    random = crypto.randomUUID();
  } catch {
    // Fallback uses getRandomValues, not Math.random: randomUUID is the only
    // part of WebCrypto that needs a secure context, so if it throws, the CSPRNG
    // is still there. Math.random here made this a flagged weak-randomness site
    // (CodeQL js/insecure-randomness) for no reason — the strong primitive was
    // available the whole time in the one branch that claimed it wasn't.
    random = randomHex();
  }
  return `provider-login:${ownerId}:${random}`;
}

/** 16 bytes of CSPRNG as hex — the degraded path for makeLoginSessionId. */
function randomHex(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Shared inline login terminal used by provider and GitHub authentication. */
export function InlineLoginTerminal({
  ownerId,
  binary,
  args,
  unsetEnv,
  timeoutMs,
  loginProvider,
  onClose,
}: {
  ownerId: string;
  binary: string;
  args: string[];
  unsetEnv?: readonly string[];
  timeoutMs?: number;
  loginProvider?: "claude" | "codex";
  onClose: () => void;
}) {
  const terminalRef = useRef<{
    paste(text: string): void;
    focus(): void;
  } | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [binaryPath, setBinaryPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef(makeLoginSessionId(ownerId));
  const sessionId = sessionIdRef.current;

  useEffect(() => {
    if (loginProvider) return;
    let cancelled = false;
    void resolveAgentBinary(binary)
      .then((path) => {
        if (!cancelled) setBinaryPath(path);
      })
      .catch(() => {
        if (!cancelled)
          setError(
            "Could not open the sign-in terminal. Close it and try again.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [binary, loginProvider]);

  useEffect(() => {
    if (!timeoutMs) return;
    const timer = setTimeout(() => {
      setError("Sign-in timed out. Close the terminal and try again.");
      void ptyKill({ sessionId });
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [sessionId, timeoutMs]);

  useEffect(
    () => () => {
      void ptyKill({ sessionId });
    },
    [sessionId],
  );

  const label = loginProvider
    ? `${loginProvider} ${loginProvider === "claude" ? "auth login" : "login"}`
    : `${binary} ${args.join(" ")}`.trim();
  const command = binaryPath
    ? buildInlineLoginCommand(binaryPath, args, unsetEnv)
    : null;

  return (
    <div className="border-border1 bg-bg1 flex min-w-0 flex-col overflow-hidden rounded-lg border">
      <div className="border-border1 flex items-center gap-2 border-b px-3.5 py-2">
        {!error && <ZerosSpinner size={14} />}
        <span className="text-fg2 min-w-0 flex-1 truncate text-sm">
          {error ? (
            "Sign-in stopped"
          ) : (
            <>
              Running <span className="text-fg1">{label}</span>.
            </>
          )}
        </span>
        {loginProvider && (
          <Tooltip label="Paste into terminal">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Paste into terminal"
              onClick={() => {
                void navigator.clipboard
                  .readText()
                  .then((text) => {
                    terminalRef.current?.focus();
                    terminalRef.current?.paste(text);
                    setPasteError(null);
                  })
                  .catch(() =>
                    setPasteError(
                      "Click inside the terminal and use Paste from the Edit menu.",
                    ),
                  );
              }}
            >
              <ClipboardPaste className="size-3.5" aria-hidden="true" />
            </Button>
          </Tooltip>
        )}
        <Tooltip label="Close terminal">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close terminal"
            onClick={onClose}
            className="shrink-0"
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
      {pasteError && (
        <p className="text-fg2 px-3 pt-2 text-xs" role="alert">
          {pasteError}
        </p>
      )}
      <div className="h-[300px] min-h-0 w-full min-w-0 p-3">
        {error ? (
          <p className="text-fg2 p-4 text-sm" role="alert">
            {error}
          </p>
        ) : command || loginProvider ? (
          <TerminalSessionView
            sessionId={sessionId}
            cwd=""
            visible
            ephemeral
            initialCommand={command}
            loginProvider={loginProvider}
            onTerminalReady={(terminal) => {
              terminalRef.current = terminal;
            }}
            onExit={onClose}
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <ZerosSpinner size={16} />
          </div>
        )}
      </div>
    </div>
  );
}
