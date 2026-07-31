import React, { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { ZerosSpinner } from "@/loaders";
import { Button } from "../ui";
import { Tooltip } from "@/zeros/ui/primitives";
import { ptyKill, resolveAgentBinary } from "../../native/pty";
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
    random = `${Date.now().toString(36)}-${Math.floor(
      Math.random() * 1e9,
    ).toString(36)}`;
  }
  return `provider-login:${ownerId}:${random}`;
}

/** Shared inline login terminal used by provider and GitHub authentication. */
export function InlineLoginTerminal({
  ownerId,
  binary,
  args,
  unsetEnv,
  onClose,
}: {
  ownerId: string;
  binary: string;
  args: string[];
  unsetEnv?: readonly string[];
  onClose: () => void;
}) {
  const [binaryPath, setBinaryPath] = useState<string | null>(null);
  const sessionIdRef = useRef(makeLoginSessionId(ownerId));
  const sessionId = sessionIdRef.current;

  useEffect(() => {
    let cancelled = false;
    void resolveAgentBinary(binary).then((path) => {
      if (!cancelled) setBinaryPath(path);
    });
    return () => {
      cancelled = true;
    };
  }, [binary]);

  useEffect(
    () => () => {
      void ptyKill({ sessionId });
    },
    [sessionId],
  );

  const label = `${binary} ${args.join(" ")}`.trim();
  const command = binaryPath
    ? buildInlineLoginCommand(binaryPath, args, unsetEnv)
    : null;

  return (
    <div className="border-border1 bg-bg1 flex flex-col overflow-hidden rounded-lg border">
      <div className="border-border1 flex items-center gap-2 border-b px-3.5 py-2">
        <ZerosSpinner size={14} />
        <span className="text-fg2 min-w-0 flex-1 truncate text-sm">
          Running <span className="text-fg1">{label}</span>.
        </span>
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
      <div className="h-[300px] min-h-0 w-full">
        {command ? (
          <TerminalSessionView
            sessionId={sessionId}
            cwd=""
            visible
            ephemeral
            initialCommand={command}
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
