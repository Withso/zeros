// ──────────────────────────────────────────────────────────
// Background CLI sign-in — hidden PTY → system browser
// ──────────────────────────────────────────────────────────
//
// Powers the chat footer's "Sign in" button (the old static
// SIGN IN REQUIRED pill). One click runs the agent's own CLI
// login (`claude /login`, `codex login`) in a HIDDEN ephemeral
// engine PTY — no visible terminal — and lands the user straight
// in their browser to authenticate:
//
//   1. spawn ephemeral PTY (extra-wide cols so the OAuth URL is
//      never soft-wrapped by the terminal — we regex it out of
//      the byte stream)
//   2. type the login line into the fresh login shell
//   3. auto-answer the CLIs' interactive gates (Claude's trust
//      prompt + login-method picker both accept Enter for their
//      default)
//   4. open the first printed OAuth URL via the OS browser as a
//      belt-and-braces redirect (the CLIs usually self-open; the
//      explicit open guarantees the redirect when they don't)
//   5. watch output for the success marker (Claude's REPL stays
//      alive after /login, so exit alone isn't a signal) or a
//      clean `codex login` exit, then reap the PTY and refresh
//      the agent registry probe so the composer flips back green.
//
// Scope: Claude + Codex only. Cursor's CLI is bundled/managed (no
// user login flow) and other agents keep the Settings → Providers
// terminal path.
// ──────────────────────────────────────────────────────────

import { useSyncExternalStore } from "react";
import { PTY_AGENT_AUTH_CWD } from "@zeros/core/messages";

import {
  onPtyData,
  onPtyExit,
  ptyCreate,
  ptyKill,
  ptyWrite,
  resolveAgentBinary,
} from "../../native/pty";
import { isElectron, nativeInvoke } from "../../native/runtime";
import { getActiveBridge } from "../bridge/active-bridge";
import type { AgentAgentsListMessage } from "../bridge/messages";
import { getAgentsSnapshot, refreshAgents } from "./agents-cache";

/** The agents whose CLI login we can drive headlessly. */
const SUPPORTED: Record<string, { loginArgs: string[] }> = {
  claude: { loginArgs: ["/login"] },
  codex: { loginArgs: ["login"] },
};

export function supportsBackgroundSignIn(
  agentId: string | null | undefined,
): agentId is "claude" | "codex" {
  return !!agentId && agentId in SUPPORTED;
}

export type SignInPhase = "idle" | "starting" | "waiting" | "success" | "error";

export interface SignInState {
  phase: SignInPhase;
  /** Human-readable failure reason (phase === "error" only). */
  error?: string;
}

export interface SignInResult {
  ok: boolean;
  error?: string;
}

// ── Tiny per-agent state store (useSyncExternalStore) ─────

const IDLE: SignInState = { phase: "idle" };
const states = new Map<string, SignInState>();
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<SignInResult>>();

function setState(agentId: string, next: SignInState): void {
  states.set(agentId, next);
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* keep notifying */
    }
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getSignInState(agentId: string | null | undefined): SignInState {
  return (agentId && states.get(agentId)) || IDLE;
}

/** Live sign-in state for one agent — drives the footer button's label. */
export function useBackgroundSignIn(
  agentId: string | null | undefined,
): SignInState {
  return useSyncExternalStore(subscribe, () => getSignInState(agentId));
}

// ── Stream matching helpers ───────────────────────────────

/** Strip CSI/OSC escape sequences so the matchers see plain text. */
// eslint-disable-next-line no-control-regex
const OSC_RX = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// eslint-disable-next-line no-control-regex
const CSI_RX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESC_RX = /\x1b[@-_]/g;
function stripAnsi(s: string): string {
  return s.replace(OSC_RX, "").replace(CSI_RX, "").replace(ESC_RX, "");
}

// Both CLIs print the OAuth URL. Restricting to the known auth hosts keeps
// us from "opening" incidental docs links the TUIs also print.
const AUTH_URL_RX =
  /https:\/\/(?:[\w.-]*\.)?(?:claude\.ai|anthropic\.com|console\.anthropic\.com|openai\.com|chatgpt\.com|auth0\.openai\.com)\/[^\s"'<>\])]+|http:\/\/localhost:\d+\/[^\s"'<>\])]+/g;

// Claude: "Login successful. Press Enter to continue…" / "Logged in as …".
// Codex: "Successfully logged in".
const SUCCESS_RX =
  /login successful|logged in as|successfully logged in|authentication successful/i;

// Claude's REPL gates that accept Enter for their default option: the
// folder-trust prompt (fresh HOME) and the login-method picker (first
// option = "Claude account"). Matched on the stripped stream, answered once
// each with a bare CR after a beat so the TUI's key handler is mounted.
const TRUST_RX = /do you trust the files in this folder/i;
const PICKER_RX = /select login method|claude account/i;

/** POSIX single-quote a path unless it's already a bare safe token. Mirrors
 *  the helper in providers-panel / embedded-terminal-command. */
function shellQuoteIfNeeded(p: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(p)) return p;
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/** Open a URL in the user's real browser (desktop) / a new tab (web). */
function openExternal(url: string): void {
  if (isElectron()) void nativeInvoke("shell_open_url", { url });
  else globalThis.open?.(url, "_blank", "noopener,noreferrer");
}

/** Force-refresh loader for the agents cache — same AGENT_LIST_AGENTS request
 *  the providers panel uses, reachable from this non-React module via the
 *  active bridge. Empty list when the bridge is down (cache keeps its data). */
async function listAgentsViaBridge(force?: boolean) {
  const bridge = getActiveBridge();
  if (!bridge) return [];
  const resp = await bridge.request<AgentAgentsListMessage>(
    { type: "AGENT_LIST_AGENTS", force: force ?? true },
    30_000,
  );
  return resp.agents;
}

function makeSessionId(agentId: string): string {
  return `chat-signin:${agentId}:${crypto.randomUUID()}`;
}

/** Overall cap on the browser round-trip before we give up and reap the PTY. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
// Matcher window — plenty for the wrapped-free URL + prompts, bounded so a
// chatty TUI can't grow the buffer unboundedly.
const TAIL_CHARS = 16_384;

/**
 * Run the agent's CLI login in a hidden PTY and resolve when it succeeds or
 * fails. Concurrent calls for the same agent share one run. The returned
 * promise never rejects.
 */
export function startBackgroundSignIn(agentId: string): Promise<SignInResult> {
  if (!isElectron()) {
    return Promise.resolve({
      ok: false,
      error: "Background sign-in is available only in the Zeros Mac app.",
    });
  }
  const existing = inflight.get(agentId);
  if (existing) return existing;
  const run = runSignIn(agentId).finally(() => {
    inflight.delete(agentId);
  });
  inflight.set(agentId, run);
  return run;
}

async function runSignIn(agentId: string): Promise<SignInResult> {
  const spec = SUPPORTED[agentId];
  if (!spec) return { ok: false, error: "Sign-in isn't supported for this agent." };
  setState(agentId, { phase: "starting" });

  // Registry may carry user overrides (authBinary / loginArgs); fall back to
  // the built-in spec when the snapshot isn't loaded.
  const reg = getAgentsSnapshot()?.find((a) => a.id === agentId);
  const loginArgs = reg?.loginArgs ?? spec.loginArgs;
  const binPath = await resolveAgentBinary(reg?.authBinary ?? agentId);

  const sessionId = makeSessionId(agentId);
  let offData: (() => void) | null = null;
  let offExit: (() => void) | null = null;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let settled = false;

  const finish = (result: SignInResult): SignInResult => {
    if (settled) return result;
    settled = true;
    offData?.();
    offExit?.();
    for (const t of timers) clearTimeout(t);
    void ptyKill({ sessionId });
    if (result.ok) {
      setState(agentId, { phase: "success" });
      // Re-probe so the providers panel + composer flip to connected without
      // waiting for the next window-focus refresh.
      void refreshAgents(listAgentsViaBridge).catch(() => {});
      // Let the "Signed in" state read for a moment, then reset to idle so a
      // later auth failure starts the button fresh.
      setTimeout(() => {
        if (getSignInState(agentId).phase === "success")
          setState(agentId, IDLE);
      }, 4000);
    } else {
      setState(agentId, { phase: "error", error: result.error });
    }
    return result;
  };

  return new Promise<SignInResult>((resolve) => {
    let tail = "";
    let openedUrl = false;
    let answeredTrust = false;
    let answeredPicker = false;
    let sawSuccess = false;

    const handleChunk = (chunk: string) => {
      tail = (tail + stripAnsi(chunk)).slice(-TAIL_CHARS);

      if (!answeredTrust && TRUST_RX.test(tail)) {
        answeredTrust = true;
        timers.push(setTimeout(() => void ptyWrite({ sessionId, data: "\r" }), 350));
      }
      if (!answeredPicker && PICKER_RX.test(tail)) {
        answeredPicker = true;
        timers.push(setTimeout(() => void ptyWrite({ sessionId, data: "\r" }), 350));
      }
      if (!openedUrl) {
        const m = tail.match(AUTH_URL_RX);
        if (m && m.length > 0) {
          openedUrl = true;
          openExternal(m[0]);
          setState(agentId, { phase: "waiting" });
        }
      }
      if (!sawSuccess && SUCCESS_RX.test(tail)) {
        sawSuccess = true;
        resolve(finish({ ok: true }));
      }
    };

    void (async () => {
      offData = await onPtyData((evt) => {
        if (evt.sessionId === sessionId) handleChunk(evt.data);
      });
      offExit = await onPtyExit((evt) => {
        if (evt.sessionId !== sessionId || settled) return;
        // `codex login` exits 0 after the browser handshake; treat that as
        // success even if the marker line raced the exit. Claude's REPL only
        // exits here if the user's shell died — an error unless we already
        // saw the marker.
        if (evt.exitCode === 0 && openedUrl) resolve(finish({ ok: true }));
        else
          resolve(
            finish({
              ok: false,
              error: "The sign-in process ended before completing.",
            }),
          );
      });

      const info = await ptyCreate({
        sessionId,
        // Claude's first-run trust prompt is safe to accept only from this
        // engine-resolved app directory, never from the active repository.
        cwd: PTY_AGENT_AUTH_CWD,
        // Extra-wide grid so the terminal never soft-wraps the OAuth URL —
        // the URL matcher reads the raw stream, and a mid-URL line break
        // would truncate what we open (Claude's authorize URL runs ~500
        // chars of PKCE/state params).
        cols: 800,
        rows: 50,
        ephemeral: true,
      });
      if (!info) {
        resolve(
          finish({
            ok: false,
            error: "The Zeros engine isn't reachable right now.",
          }),
        );
        return;
      }

      // Same grace TerminalSessionView gives a fresh login shell before
      // typing (zsh -l can take ~50–150 ms to draw its prompt).
      timers.push(
        setTimeout(() => {
          const line = `${shellQuoteIfNeeded(binPath)} ${loginArgs.join(" ")}`.trim();
          void ptyWrite({ sessionId, data: `${line}\r` });
        }, 250),
      );

      timers.push(
        setTimeout(() => {
          resolve(
            finish({ ok: false, error: "Timed out waiting for the browser sign-in." }),
          );
        }, SIGN_IN_TIMEOUT_MS),
      );
    })();
  });
}
