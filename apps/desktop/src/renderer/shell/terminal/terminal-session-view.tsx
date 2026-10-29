// One xterm instance per terminal tab. It owns the PTY: create or reattach on
// mount, input and output bridging, and resizes; the store records metadata
// only. The PTY spawns only once the view is visible and FitAddon proposes a
// real measurement (a 1.5 s 80×24 fallback covers missing font metrics), and
// later resizes funnel through proposeDimensions → fit → ptyResize after
// layout settles. Spawning earlier printed the login prompt at a tiny width
// and left stacked prompts in scrollback.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { captureDeferredFocus } from "@/renderer/shared/ui/deferred-focus";
import { useWorkbenchStatusSource } from "../workbench/tab-status";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
// DOM renderer by design: xterm v6 has no canvas addon, and `@xterm/addon-webgl`
// would hit Chromium's ~16 active WebGL contexts per renderer, which
// force-loses the oldest and would freeze panes in multi-agent sessions.

import {
  ptyCreate,
  ptyResize,
  ptyTerminals,
  ptyWrite,
} from "../../platform/pty";
import { resolveTokenValue } from "../../shared/theme/resolve-tokens";
import { terminalExitPolicy } from "./terminal-exit-policy";
import { WheelLineAccumulator } from "./wheel-scroll";
import { useAppearance } from "../../shared/theme/provider";
import { useThemeId } from "../../shared/theme/use-theme-variant";
import { resolveCodeTheme } from "../../shared/theme/code-themes";
import {
  ensureThemeColors,
  getThemeColorsSync,
  type ThemeColors,
} from "../../features/agent/renderers/syntax";
import {
  buildLaunchLine,
  resolveTerminalAgent,
} from "../../features/settings/terminal-agents";
import {
  bindPtyExitHandler,
  bindPtyWriter,
  useTerminalStore,
} from "./terminal-store";
import {
  createTerminalRevealScheduler,
  createTerminalResizeScheduler,
} from "./terminal-resize-scheduler";
import { isContinuousLayoutResizeActive } from "./continuous-layout-resize";
import { isUsableTerminalDimensions } from "./terminal-dimensions";
import { recordWorkspaceActivity } from "../../state/workspace-store";
import { isCloudWorkspace, parseCloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { getActiveBridge, onActiveBridgeConnected } from "../../platform/bridge/active-bridge";
import { WorkspaceRuntimeClient } from "../../platform/bridge/workspace-runtime-client";
import { cloudWorkspaceDocument, subscribeCloudWorkspaces } from "../../state/cloud-workspace-catalog";

function cloudTerminalEngineId(cwd: string): string | undefined {
  if (!isCloudWorkspace(cwd)) return undefined;
  const bridge = getActiveBridge();
  return bridge instanceof WorkspaceRuntimeClient ? bridge.cloudEngineInstanceId(cwd) : undefined;
}

// Mirrors `--font-mono` in `styles/zeros-tokens.css` exactly — xterm can't
// read a CSS variable, so this string has to be kept in sync by hand.
// Touch both when adding/removing a fallback.
const TERMINAL_FONT_FAMILY =
  "'Geist Mono Variable', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

// Shared default font size for every xterm surface — the workbench floating
// panel AND the conversation pane terminal-agent chats both mount this component, so
// changing this one constant changes both surfaces in lockstep.
const TERMINAL_FONT_SIZE_PX = 12;

// Fallback dims if the host container never reports a usable size
// within FIT_FALLBACK_MS (broken layout, headless test, …). 80×24 is
// the universal default; the shell will still resize correctly once
// the layout settles thanks to the post-spawn ResizeObserver.
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;
const FIT_FALLBACK_MS = 1500;

interface TerminalSessionViewProps {
  sessionId: string;
  cwd: string;
  visible: boolean;
  /** Terminal-agent profile to auto-launch once the PTY shell is
   *  ready. Null = leave the shell idle so the user can type
   *  their own command. */
  agentId?: string | null;
  /** Ephemeral one-shot PTY (the composer's inline `claude /mcp` runner):
   *  spawned outside the shared multiplayer registry. Pairs with `onExit`
   *  (the parent disposes on shell exit) — no "press any key to restart". */
  ephemeral?: boolean;
  /** A literal command line to type into the shell once its prompt is ready
   *  (e.g. `'/abs/claude' /mcp`). Takes priority over `agentId`. Written with a
   *  leading space so HIST_IGNORE_SPACE keeps it out of the user's history. */
  initialCommand?: string | null;
  /** Cloud registry reset: retain this tab and resume a plain shell on reveal. */
  resumePending?: boolean;
  loginProvider?: "claude" | "codex";
  onTerminalReady?: (terminal: Pick<XTerm, "paste" | "focus"> | null) => void;
  /** Called when the PTY exits. When provided (ephemeral mode) the view does
   *  NOT show the "press any key to restart" hint — the parent unmounts. */
  onExit?: () => void;
  /** When false, an exited session shows no "press any key to restart" hint
   *  and keystrokes don't respawn a shell. Run-action terminals set this —
   *  their restart affordance is the Rerun button (which respawns the
   *  COMMAND via the engine, not a plain shell under the same id). */
  restartOnKey?: boolean;
  /** Attach-only mount: bind to the engine's EXISTING live PTY, but never
   *  spawn one. Run-action terminals set this — their PTYs are born only
   *  through the engine's RunManager (workspace.startRun), so a mount that
   *  found no live PTY (app relaunch, workbench re-expand after the run ended)
   *  must NOT plant a plain interactive shell under the deterministic run id
   *  (the RunManager would then "adopt" it and Run would stop running the
   *  command). On a miss the view replays `replayOnMiss` (if any), then marks
   *  the session exited. */
  attachOnly?: boolean;
  /** Attach-only replay source (run-action terminals). When an attach-only
   *  mount finds no live PTY — the run exited before the renderer could attach
   *  (an instant build/lint failure, a dev server that died on boot) — this
   *  supplies the engine's buffered output (workspace.runLog) so the terminal
   *  shows WHY it ended instead of a blank pane. Passed this view's sessionId
   *  (so callers can share one stable callback); returns null = nothing to
   *  replay. Ignored unless `attachOnly`. */
  replayOnMiss?: (sessionId: string) => Promise<string | null>;
  /** CSS token name for the terminal's background surface, fed to the xterm
   *  theme so the grid matches whatever it sits on. Defaults to `--bg1`,
   *  which both conversation pane agent terminals and the workbench panel use today; kept
   *  as a prop so a host on a different surface can still match it. */
  surfaceToken?: string;
}

// Memoized so the deck parent's re-renders never reach xterm; every prop is a
// primitive, so the shallow comparator is correct.
export const TerminalSessionView = React.memo(function TerminalSessionView({
  sessionId,
  cwd,
  visible,
  agentId,
  ephemeral,
  initialCommand,
  resumePending = false,
  loginProvider,
  onTerminalReady,
  onExit,
  restartOnKey = true,
  attachOnly = false,
  replayOnMiss,
  surfaceToken = "--bg1",
}: TerminalSessionViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // Latest onExit, read from the exit handler without re-binding it when the
  // parent passes a fresh closure each render.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  // Latest restartOnKey, read from the once-bound key handler + exit writer.
  const restartOnKeyRef = useRef(restartOnKey);
  restartOnKeyRef.current = restartOnKey;
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const trySpawnRef = useRef<((allowFallback?: boolean) => void) | null>(null);
  const spawnStartedRef = useRef(false);
  const resizeSchedulerRef = useRef<ReturnType<
    typeof createTerminalResizeScheduler
  > | null>(null);
  const lastDimsRef = useRef<{ cols: number; rows: number }>({
    cols: FALLBACK_COLS,
    rows: FALLBACK_ROWS,
  });
  /** True once `pty_create` has returned successfully. Gates
   *  `ptyResize` calls so a ResizeObserver firing during the spawn
   *  window doesn't IPC into a non-existent session. */
  const createdRef = useRef(false);
  const engineInstanceRef = useRef<string | undefined>(undefined);
  const [readFailure, setReadFailure] = useState<unknown>(null);
  const [readPending, setReadPending] = useState(false);
  const [hasScrollback, setHasScrollback] = useState(false);
  const managed = useWorkbenchStatusSource(
    {
      error: readFailure,
      pending: readPending,
      primary: true,
      hasContent: hasScrollback,
      retry: async () => {
        const term = xtermRef.current;
        if (visible && term) await spawn(term, true);
      },
    },
    sessionId,
  );
  const attachInFlightRef = useRef(false);
  const reconnectPendingRef = useRef(false);
  const launchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Once-only latch — we only auto-launch the bound agent on the
   *  initial PTY spawn, never on a re-mount (which would re-run
   *  `claude` etc. on top of an existing session). Reset by `restart`
   *  so a respawn after exit brings the agent back. */
  const agentLaunchedRef = useRef(false);
  /** True once the PTY has exited and the terminal is showing the
   *  "press any key to restart" hint. The next keystroke (caught by
   *  the once-bound `term.onData` in the mount effect) consumes itself
   *  to respawn a fresh shell under the same sessionId instead of
   *  disappearing into the dead PTY — this is what makes an exited
   *  terminal typeable again. */
  const exitedRef = useRef(false);
  /** Infrastructure spawn failures are deterministic until the app/package is
   *  repaired. Block key-restart for those so typing cannot create an endless
   *  `[restarting…] → [process exited]` transcript. Natural shell exits remain
   *  restartable exactly as before. */
  const restartBlockedRef = useRef(false);

  const markExited = useTerminalStore((s) => s.markExited);
  const markAlive = useTerminalStore((s) => s.markAlive);
  const { prefs } = useAppearance();
  // Concrete visual theme — flips on OS appearance changes in System and on
  // an explicit Dark ↔ Light switch. Drives the token re-resolve below so the
  // xterm's concrete bg/fg values never go stale.
  const themeId = useThemeId();

  // Mount xterm once and defer the PTY spawn until the host reports a real size
  // (see the header).
  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    const term = new XTerm({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE_PX,
      cursorBlink: true,
      cursorStyle: "bar",
      // xterm's buffer costs ~12 bytes/cell, so scrollback × cols is resident
      // memory PER terminal — and terminals stay mounted across the retained
      // folder deck. 10k lines × ~200 cols was ~25 MB apiece; 2k keeps deep
      // history for real use while capping the fleet's floor. The engine-side
      // reattach mirror replays ~256 KB anyway, so deeper renderer scrollback
      // only ever outlives a live attach, never a reattach.
      scrollback: 2_000,
      allowProposedApi: true,
      // Background comes from `surfaceToken` so this one shared component matches
      // whatever it sits on (--bg1 everywhere today — conversation pane agent terminals and
      // the workbench panel). An explicit color (not transparency) so the DOM
      // renderer paints it reliably — a transparent theme bg renders as the
      // renderer's opaque default here, not the surface behind it.
      theme: resolveTerminalTheme(surfaceToken),
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    onTerminalReady?.(term);
    if (loginProvider)
      term.textarea?.setAttribute("aria-label", "Sign-in terminal");
    xtermRef.current = term;
    fitRef.current = fit;

    // Cmd/Ctrl shortcuts: bracketed-paste-safe Ctrl/Cmd+V and copy-
    // when-selection on Ctrl/Cmd+C. Returning `false` from the
    // handler stops xterm from processing the key further so our
    // clipboard path wins.
    term.attachCustomKeyEventHandler((evt) => {
      // Only act on keydown so we don't double-fire on the matching
      // keyup. Letting keyup through means xterm still gets it (we
      // return true), which is fine — it's a no-op for these chords.
      if (evt.type !== "keydown") return true;
      const mod = evt.metaKey || evt.ctrlKey;
      // App chords use Cmd/Ctrl+Option (⌥⌘B, ⌥⌘T). Returning false keeps xterm from
      // forwarding them or calling preventDefault, so they bubble to app-shell's
      // window handlers; macOS terminals never deliver Cmd+Option to the shell.
      // editable-target.ts exempts xterm's hidden textarea for the same reason.
      if (mod && evt.altKey) return false;
      if (!mod || evt.altKey) return true;
      const key = evt.key.toLowerCase();
      if (key === "v") {
        // Do not call term.paste(): the platform paste path (Electron's paste role, the
        // context menu, or a relay client's Cmd/Ctrl+V) already fires xterm's native
        // paste handler, which adds bracketed-paste markers, so calling it pasted a
        // second copy. Returning false only stops xterm from also sending Ctrl+V (0x16)
        // to the PTY; it does not preventDefault, so exactly one paste happens.
        return false;
      }
      if (key === "c" && term.hasSelection()) {
        // Copy the selection instead of sending SIGINT. If there's no
        // selection we fall through so Ctrl/Cmd+C still interrupts.
        try {
          const sel = term.getSelection();
          if (sel) void writeClipboard(sel);
        } catch {
          /* clipboard denied — drop silently */
        }
        return false;
      }
      return true;
    });

    // Capture-phase wheel handler: mouse-tracking TUIs (vim, tmux, agent CLIs)
    // otherwise eat wheel events, leaving scrollback unreachable while an agent
    // runs. Take the whole gesture, sub-line deltas included, so xterm's viewport
    // never forwards them as scroll escapes or runs a second accumulator; ours
    // carries the remainder so slow trackpad scrolls still move (wheel-scroll.ts).
    // At the scrollback boundaries the event passes to an outer scroller.
    const wheelLines = new WheelLineAccumulator();
    const onWheelCapture = (evt: WheelEvent) => {
      if (!term.element) return;
      // Not a scrollback gesture: release it untouched. Ctrl/⌘+wheel is zoom
      // (Chromium sends trackpad pinch as ctrlKey wheel), and a mostly horizontal
      // swipe's vertical jitter would accumulate into drift; xterm's viewport ignores
      // the non-dominant axis too.
      if (evt.ctrlKey || evt.metaKey) return;
      if (Math.abs(evt.deltaY) < Math.abs(evt.deltaX)) return;
      const buffer = term.buffer.active;
      // The alternate screen has no scrollback, so the wheel belongs to the
      // full-screen TUI. Saying so explicitly keeps a transient ydisp of 1 during a
      // resize from consuming a wheel-up.
      if (buffer.type === "alternate") {
        wheelLines.reset();
        return;
      }
      const atTop = buffer.viewportY === 0;
      const atBottom = buffer.viewportY >= buffer.baseY;
      // Only consume when we can actually scroll in this direction.
      const goingUp = evt.deltaY < 0;
      const goingDown = evt.deltaY > 0;
      if ((goingUp && atTop) || (goingDown && atBottom)) {
        // Let it bubble — outer scrollback (panel chrome) or no-op.
        wheelLines.reset();
        return;
      }
      const lines = wheelLines.lines(evt, term.rows);
      if (lines !== 0) term.scrollLines(lines);
      evt.preventDefault();
      evt.stopPropagation();
    };
    host.addEventListener("wheel", onWheelCapture, {
      capture: true,
      passive: false,
    });

    // Bound once, not inside `spawn`, so a respawn never stacks a second listener
    // that writes every keystroke twice. While the shell is dead, the first
    // keystroke restarts it.
    term.onData((data) => {
      if (exitedRef.current) {
        // Run-action terminals don't key-restart — respawning here would give
        // a plain shell under the run id; their Rerun button re-runs the
        // command through the engine instead.
        if (!restartOnKeyRef.current || restartBlockedRef.current) return;
        exitedRef.current = false;
        void restart(term);
        return;
      }
      // Count a submitted terminal line, not each keystroke. This gives Active
      // a meaningful command-level signal without making the lane churn while
      // someone types or navigates inside a terminal UI.
      if (data.includes("\r") || data.includes("\n")) {
        recordWorkspaceActivity(cwd);
      }
      void ptyWrite({ sessionId, data }).catch(() => {
        /* drop — pty likely exited */
      });
    });
    // Mirror xterm grid resizes to the PTY. Also bound once; the
    // dim-equality check + createdRef latch keep a resize fired during
    // the spawn window (or after an exit) from IPC-ing a dead session.
    term.onResize(({ cols: c, rows: r }) => {
      if (lastDimsRef.current.cols === c && lastDimsRef.current.rows === r) {
        return;
      }
      lastDimsRef.current = { cols: c, rows: r };
      if (!createdRef.current) return;
      void ptyResize({ sessionId, cols: c, rows: r }).catch(() => {
        /* drop */
      });
    });

    // Gated spawn: wait for a real proposed measurement before calling
    // `pty_create`. This observer disconnects as soon as spawning succeeds;
    // the settled live-resize scheduler below owns later geometry changes.
    let spawnRaf = 0;
    let cancelled = false;
    let roSpawn: ResizeObserver | null = null;

    const stopSpawnObserver = () => {
      roSpawn?.disconnect();
      roSpawn = null;
    };

    const tryMeasureAndSpawn = (allowFallback = false) => {
      if (spawnStartedRef.current || cancelled || !hasVisibleHost()) return;
      // FitAddon can propose a small positive grid under display:none. A
      // parked view must never resize the live PTY merely by attaching.
      const dims = fit.proposeDimensions();
      const measured = isUsableTerminalDimensions(dims);
      if (!measured && !allowFallback) {
        return; // keep polling
      }
      spawnStartedRef.current = true;
      stopSpawnObserver();
      if (measured) {
        try {
          fit.fit();
        } catch {
          /* fall through using proposed dims via lastDimsRef */
        }
        lastDimsRef.current = {
          cols: term.cols || dims.cols,
          rows: term.rows || dims.rows,
        };
      } else {
        lastDimsRef.current = { cols: FALLBACK_COLS, rows: FALLBACK_ROWS };
      }
      void spawn(term);
    };
    trySpawnRef.current = tryMeasureAndSpawn;

    // First try after one paint frame — the common case (panel already
    // expanded at full size on mount) clears here.
    spawnRaf = requestAnimationFrame(() => tryMeasureAndSpawn());

    // Keep trying as the container reaches its real size.
    roSpawn = new ResizeObserver(() => {
      tryMeasureAndSpawn();
    });
    roSpawn.observe(host);

    // Re-fit when the Geist Mono webfont swaps in, because metrics measured against
    // the fallback are a few pixels off. Before spawn this retries the measurement;
    // after spawn applyFit sends at most one ptyResize, so the shell sees one clean
    // SIGWINCH.
    if (
      typeof document !== "undefined" &&
      document.fonts &&
      document.fonts.load
    ) {
      void document.fonts
        .load(`${TERMINAL_FONT_SIZE_PX}px "Geist Mono Variable"`)
        .catch(() => [])
        .then(() => {
          if (cancelled) return;
          if (!spawnStartedRef.current) {
            tryMeasureAndSpawn();
            return;
          }
          // Allow one frame for xterm to redraw with the new font
          // glyphs before we re-measure.
          requestAnimationFrame(() => {
            if (cancelled) return;
            const scheduler = resizeSchedulerRef.current;
            if (scheduler) scheduler.flush();
            else if (!isContinuousLayoutResizeActive()) applyFit();
          });
        });
    }

    return () => {
      cancelled = true;
      if (launchTimerRef.current !== null) clearTimeout(launchTimerRef.current);
      cancelAnimationFrame(spawnRaf);
      trySpawnRef.current = null;
      spawnStartedRef.current = false;
      stopSpawnObserver();
      host.removeEventListener("wheel", onWheelCapture, { capture: true });
      onTerminalReady?.(null);
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      // Never ptyKill on unmount: the PTY lives in main so `npm run dev` survives a
      // reload or workbench collapse. Only the close paths kill it
      // (terminal-store.closeSession, terminal-agent chat archive, killAllPtySessions
      // on quit); ptyCreate reattaches by sessionId, so this only disposes the widget.
      createdRef.current = false;
    };
    // sessionId + cwd are component identity, never change for a
    // single tab — fresh mount per tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canResumeCloudTerminal = () => {
    const target = parseCloudWorkspaceKey(cwd);
    if (!target || attachOnly || ephemeral || loginProvider) return false;
    const doc = cloudWorkspaceDocument(target), engine = cloudTerminalEngineId(cwd);
    return !!doc?.capabilities.canWrite && !doc.deletedAt && !doc.error && ["ready", "busy"].includes(doc.status) && !!engine &&
      (!!engineInstanceRef.current && engineInstanceRef.current !== engine ||
        useTerminalStore.getState().sessions.some(s => s.id === sessionId && s.resumePending));
  };

  /** Spawn the PTY on the main process, wire stdin/stdout. */
  const spawn = async (term: XTerm, reconnect = false) => {
    if (attachInFlightRef.current || xtermRef.current !== term) return;
    const mayFocus = captureDeferredFocus(hostRef.current);
    const target = parseCloudWorkspaceKey(cwd);
    if (target && !attachOnly && !ephemeral && !loginProvider &&
        !["ready", "busy"].includes(cloudWorkspaceDocument(target)?.status ?? "")) {
      // A shown shell waits calmly for the existing wake path. Merely showing
      // a retained terminal never starts compute or retries an agent command.
      reconnectPendingRef.current = true;
      return;
    }
    let resuming = canResumeCloudTerminal();
    attachInFlightRef.current = true;
    setReadPending(true);
    try {
      const { cols, rows } = lastDimsRef.current;
      if (attachOnly || (reconnect && (createdRef.current || resuming))) {
        // Reattach-or-nothing: consult the engine's shared registry first. A
        // PTY_CREATE for a missing session would SPAWN a fresh login shell
        // under this id — exactly what attach-only exists to prevent.
        const terms = await ptyTerminals(
          isCloudWorkspace(cwd) ? cwd : undefined,
        );
        if (xtermRef.current !== term) return;
        resuming ||= canResumeCloudTerminal();
        if (terms === null) throw new Error("Terminal connection unavailable");
        const live = terms.some(
          (t) => t.sessionId === sessionId && t.exited !== true,
        );
        if (!live && !resuming) {
          // The PTY exited before we could attach — its live mirror is gone, but
          // the engine may still hold the run's output buffer. Replay it so a
          // fast run (an instant build/lint failure, a dev server that died on
          // boot) shows WHY it ended instead of a blank pane. Never spawns.
          try {
            const replay = await replayOnMiss?.(sessionId);
            if (xtermRef.current !== term) return;
            if (replay) term.write(replay);
          } catch {
            /* buffer unavailable — fall through to the exited state */
          }
          if (xtermRef.current !== term) return;
          markExited(sessionId);
          createdRef.current = false;
          exitedRef.current = true;
          if (reconnect && !attachOnly && restartOnKeyRef.current)
            term.writeln(
              "\r\n\x1b[2m[terminal session ended — press any key to restart]\x1b[0m",
            );
          return;
        }
      }
      if (resuming && (!visibleRef.current || !canResumeCloudTerminal())) {
        // Registry discovery may finish after navigation, Stop or withdrawal.
        // Preserve the tab; only a shown, authorized ready owner may create.
        reconnectPendingRef.current = true;
        return;
      }
      const info = await ptyCreate({
        sessionId,
        cwd,
        cols,
        rows,
        ephemeral,
        loginProvider,
      });
      if (xtermRef.current !== term) return;
      if (!info) {
        setReadFailure(new Error("Terminal connection unavailable"));
        // No-bridge fallback only. An optional connected relay client gets a real
        // host shell; ptyCreate returns null when there is no engine connection.
        if (!managed)
          term.writeln(
            isCloudWorkspace(cwd)
            ? "\x1b[33m(Cloud terminal unavailable — reconnect to this workspace to retry.)\x1b[0m"
            : "\x1b[33m(No host connection — terminal needs the Mac app or a paired relay session.)\x1b[0m",
          );
        return;
      }
      resuming ||= canResumeCloudTerminal();
      createdRef.current = true;
      engineInstanceRef.current = cloudTerminalEngineId(cwd);
      setReadFailure(null);
      setHasScrollback(true);
      if (loginProvider && visibleRef.current && mayFocus()) term.focus();
      // A fresh/reattached PTY is live again — clear the exited latch so
      // keystrokes flow to the shell instead of triggering another
      // restart (matters on the restart path; harmless on first spawn).
      exitedRef.current = false;
      restartBlockedRef.current = false;
      // Repaint from main's serialized mirror snapshot (the resolved grid, not raw
      // history), taken at our measured size, so it reproduces the pre-refresh screen
      // including a live TUI's last frame. The reset and replay are queued together
      // to keep their order with live writes.
      if (info.reattached && typeof info.replay === "string") {
        // Queue the reset with the snapshot, after any already queued live bytes.
        // Reconnect replaces the old grid instead of appending duplicate history.
        term.write(`\x1bc${info.replay}`);
      }
      if (resuming) {
        markAlive(sessionId);
        agentLaunchedRef.current = true; // Resume a shell; never replay a launch command.
        if (!info.reattached) term.writeln("\r\n\x1b[2mWorkspace resumed — new shell\x1b[0m");
      }
      // If the main-side PTY's dims drifted from what we just measured
      // (re-attach into a session that was resized in another renderer),
      // push our measurement now so subsequent output is laid out
      // against the live terminal grid.
      if (info.cols !== cols || info.rows !== rows) {
        void ptyResize({ sessionId, cols, rows }).catch(() => {
          /* drop */
        });
      }
      // Auto-launch once the prompt is ready: `initialCommand` wins over the agent's
      // launch line. ~200 ms lets a login shell draw its prompt (zsh -l takes ~50–150
      // ms cold). The latch stops re-mounts from launching twice; a reattach already
      // ran it.
      if (info.reattached) {
        agentLaunchedRef.current = true;
      }
      if (!agentLaunchedRef.current && !loginProvider) {
        const explicit = initialCommand?.trim();
        const agent =
          !explicit && agentId ? resolveTerminalAgent(agentId) : null;
        const line = explicit || (agent ? buildLaunchLine({ agent }) : "");
        if (line) {
          agentLaunchedRef.current = true;
          // Leading space: with HIST_IGNORE_SPACE (the ZDOTDIR wrapper in shell-setup.ts)
          // zsh keeps these Zeros-driven lines out of ~/.zsh_history; user-typed commands
          // still land there.
          launchTimerRef.current = setTimeout(() => {
            if (
              xtermRef.current !== term ||
              !createdRef.current ||
              exitedRef.current
            )
              return;
            void ptyWrite({ sessionId, data: ` ${line}\r` }).catch(() => {
              /* pty already exited — drop */
            });
          }, 200);
        }
      }
    } catch (error) {
      if (xtermRef.current === term) setReadFailure(error);
    } finally {
      if (xtermRef.current === term) setReadPending(false);
      attachInFlightRef.current = false;
      // A newer connection may have arrived while the previous request was
      // failing. Coalesce those boundaries into one fresh attachment.
      if (xtermRef.current === term) resumeAfterReconnect();
    }
  };

  const resumeAfterReconnect = () => {
    const term = xtermRef.current;
    if (
      !reconnectPendingRef.current ||
      !visibleRef.current ||
      !term ||
      !spawnStartedRef.current ||
      attachInFlightRef.current ||
      exitedRef.current && !canResumeCloudTerminal()
    )
      return;
    reconnectPendingRef.current = false;
    void spawn(term, true);
  };

  // Track connection boundaries while retained, like the existing output
  // subscription, but perform no attachment reads until this view is visible.
  // A healthy A → B → A switch preserves the current grid and selection.
  useEffect(() => {
    if (!isCloudWorkspace(cwd)) return;
    return onActiveBridgeConnected((_client, { initial }) => {
      if (initial || !spawnStartedRef.current) return;
      reconnectPendingRef.current = true;
      resumeAfterReconnect();
    }, cwd);
    // Identity is fixed for a mounted terminal; mutable liveness lives in refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, sessionId]);

  useEffect(() => {
    if (resumePending && !attachInFlightRef.current && engineInstanceRef.current !== cloudTerminalEngineId(cwd))
      reconnectPendingRef.current = true;
    if (visible) resumeAfterReconnect();
    // The pending connection and current terminal are read from refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, resumePending]);

  useEffect(() => {
    if (!visible || !isCloudWorkspace(cwd)) return;
    return subscribeCloudWorkspaces(() => resumeAfterReconnect());
    // No presence, wake, reads or shell creation from a hidden retained view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, sessionId, visible]);

  /** Respawn a fresh shell after the PTY exited, on the first keystroke. Main
   *  deleted the session on exit, so ptyCreate with the same id spawns a new
   *  shell; the agent auto-launch re-arms and markAlive clears "(exited)". */
  const restart = async (term: XTerm) => {
    const mayFocus = captureDeferredFocus(hostRef.current);
    agentLaunchedRef.current = false;
    markAlive(sessionId);
    term.writeln("\x1b[2m[restarting…]\x1b[0m");
    await spawn(term);
    try {
      if (visibleRef.current && xtermRef.current === term && mayFocus()) term.focus();
    } catch {
      /* not laid out yet */
    }
  };

  // One nativeListen per event in the store's router, dispatched by sessionId;
  // per-mount listeners cost O(tabs) per PTY byte.
  useEffect(() => {
    return bindPtyWriter(sessionId, (data) => {
      // A parked view waiting for its first attach will receive the engine's
      // replay. Appending live bytes now would duplicate that history. Once
      // attachment starts, continue buffering output through later hides.
      if (!spawnStartedRef.current) return;
      xtermRef.current?.write(data);
    });
  }, [sessionId]);

  useEffect(() => {
    return bindPtyExitHandler(sessionId, (evt) => {
      markExited(sessionId);
      createdRef.current = false;
      // Ephemeral one-shot: the parent disposes on exit (the inline
      // command terminal is a transient runner, not a restartable tab),
      // so hand off and skip the "press any key to restart" affordance.
      if (onExitRef.current) {
        onExitRef.current();
        return;
      }
      // Arm the restart latch so the next keystroke respawns the shell.
      exitedRef.current = true;
      const exitPolicy = terminalExitPolicy(evt.reason);
      restartBlockedRef.current = exitPolicy.restartBlocked;
      const term = spawnStartedRef.current ? xtermRef.current : null;
      if (term) {
        const code = evt.exitCode ?? evt.signal;
        if (exitPolicy.restartBlocked) {
          term.writeln(
            `\r\n\x1b[31m[terminal failed to start — ${exitPolicy.detail}]\x1b[0m`,
          );
          term.writeln(`\x1b[2m[${exitPolicy.recovery}]\x1b[0m`);
          return;
        }
        const hint = restartOnKeyRef.current
          ? " — press any key to restart"
          : "";
        term.writeln(
          `\r\n\x1b[2m[process exited${code !== null ? ` with code ${code}` : ""}]${hint}\x1b[0m`,
        );
      }
    });
  }, [sessionId, markExited]);

  // Re-resolve when the concrete theme flips or the code theme or surface
  // changes: bg/fg are app tokens and ANSI comes from the code theme. Keyed on
  // `themeId`, not `prefs.mode`, which an OS flip in System leaves unchanged. A
  // layout effect, because applyTheme re-themes <html> synchronously and a
  // passive effect would show the old background for a frame.
  useLayoutEffect(() => {
    const term = xtermRef.current;
    if (!term) return;
    const shiki = resolveCodeTheme(prefs.codeTheme).shiki;
    // Apply immediately with whatever colors are already loaded (warm → full
    // ANSI on this frame; cold → token-based fallback), then upgrade once the
    // theme's colors resolve off the highlighter warm-up.
    term.options.theme = resolveTerminalTheme(
      surfaceToken,
      getThemeColorsSync(shiki),
    );
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      /* not laid out yet — a later fit/visibility pass repaints */
    }
    let cancelled = false;
    void ensureThemeColors(shiki).then((colors) => {
      const t = xtermRef.current;
      if (cancelled || !t) return;
      t.options.theme = resolveTerminalTheme(surfaceToken, colors);
    });
    return () => {
      cancelled = true;
    };
  }, [themeId, prefs.codeTheme, surfaceToken]);

  // Live resize observer (post-spawn). xterm's own API recommends debouncing
  // resize calls: each fit can reflow the complete scrollback buffer and then
  // send SIGWINCH through the PTY. Native-window bursts settle briefly; known
  // pane drags are suspended until release by the shared layout coordinator.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scheduler = createTerminalResizeScheduler(applyFit);
    resizeSchedulerRef.current = scheduler;
    const ro = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      scheduler.request();
    });
    ro.observe(host);
    return () => {
      ro.disconnect();
      scheduler.dispose();
      if (resizeSchedulerRef.current === scheduler) {
        resizeSchedulerRef.current = null;
      }
    };
    // applyFit is a stable closure over refs; pinning it as a dep
    // would re-attach the observer on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On reveal, re-measure, redraw and focus after a double rAF (flip → layout →
  // measure); otherwise xterm reads zero-width bounds and clamps to 1×1. refresh()
  // is needed because the DOM renderer skips paints under visibility:hidden.
  useEffect(() => {
    if (!visible) return;
    const mayFocus = captureDeferredFocus(hostRef.current);
    // A collapsed panel can become visible while its seam gesture is still
    // active. Keep the complete reveal follow-up pending until release; a fit
    // alone cannot repaint DOM-renderer rows skipped under visibility:hidden
    // and cannot restore keyboard focus.
    const revealScheduler = createTerminalRevealScheduler(() => {
      trySpawnRef.current?.();
      applyFit();
      const term = xtermRef.current;
      if (term) {
        try {
          term.refresh(0, Math.max(0, term.rows - 1));
          if (visibleRef.current && mayFocus()) term.focus();
        } catch {
          /* not laid out yet */
        }
      }
    });
    revealScheduler.request();
    // Hidden mounts do not arm the fallback. Each reveal gets a fresh chance
    // to measure before using default font dimensions in a visible host.
    const fallbackTimer = window.setTimeout(() => {
      trySpawnRef.current?.(true);
    }, FIT_FALLBACK_MS);
    return () => {
      revealScheduler.dispose();
      window.clearTimeout(fallbackTimer);
    };
    // applyFit is a stable closure over refs (see post-spawn observer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  function hasVisibleHost(): boolean {
    const host = hostRef.current;
    return !!(
      visibleRef.current &&
      host?.isConnected &&
      host.clientWidth > 0 &&
      host.clientHeight > 0
    );
  }

  // The one fit path for every resize trigger. Proposed dims come first, so a
  // resize that crosses no cell boundary sends no IPC.
  function applyFit(): void {
    if (!hasVisibleHost()) return;
    const fit = fitRef.current;
    const term = xtermRef.current;
    if (!fit || !term) return;
    const proposed = fit.proposeDimensions();
    if (!isUsableTerminalDimensions(proposed)) {
      return;
    }
    // term.onResize will fire and push to ptyResize if the dims
    // actually changed — but it only fires when xterm's internal
    // dims change. Calling proposeDimensions + comparing first means
    // we skip the heavy fit() in the no-op case.
    if (
      proposed.cols === lastDimsRef.current.cols &&
      proposed.rows === lastDimsRef.current.rows
    ) {
      return;
    }
    try {
      fit.fit();
    } catch {
      /* host not laid out yet */
    }
    // term.onResize handles the ptyResize IPC + lastDimsRef update.
    // If for any reason it didn't fire (xterm internal dims didn't
    // move), sync from `term.cols`/`term.rows` defensively here.
    if (
      term.cols !== lastDimsRef.current.cols ||
      term.rows !== lastDimsRef.current.rows
    ) {
      lastDimsRef.current = { cols: term.cols, rows: term.rows };
      if (createdRef.current) {
        void ptyResize({
          sessionId,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {
          /* drop */
        });
      }
    }
  }

  return (
    <div
      ref={hostRef}
      // No bg here — the xterm paints `surfaceToken` (--bg1 in both conversation pane and
      // the workbench panel); this host only shows through before xterm opens,
      // where the parent surface already matches.
      className="size-full min-h-0 min-w-0 overflow-hidden"
    />
  );
});

// xterm cannot read CSS variables, so resolve tokens to concrete colors. Tokens
// are applied before React mounts; an unresolved token leaves that key to
// xterm's default.

/** A translucent `#RRGGBBAA` from a token color. Selection must be translucent:
 *  an opaque swatch can't sit behind every foreground (fg1 on opaque
 *  --highlighted-bright read ≈2.2:1 in dark). Canvas fillStyle normalizes the
 *  token to #rrggbb; undefined (→ xterm default) when it can't. */
function withAlpha(
  color: string | null,
  alphaHex: string,
): string | undefined {
  if (!color) return undefined;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return undefined;
  ctx.fillStyle = color;
  const hex = ctx.fillStyle;
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alphaHex}` : undefined;
}

function resolveTerminalTheme(
  surfaceToken = "--bg1",
  themeColors?: ThemeColors | null,
) {
  // Background and default foreground are always app tokens, uniform across code
  // themes; only the 16-color ANSI palette follows the code theme, so colored
  // output follows the theme while the grid stays readable. ANSI uses xterm's
  // defaults until the highlighter loads the theme.
  const bg = resolveTokenValue(surfaceToken) ?? undefined;
  const fg = resolveTokenValue("--fg1") ?? undefined;
  // 40% alpha ("66") — see withAlpha: translucent so selected glyphs stay
  // readable in both themes instead of fighting an opaque swatch.
  const sel = withAlpha(resolveTokenValue("--highlighted-bright"), "66");
  const ansi = themeColors?.ansi ?? null;
  return {
    background: bg,
    foreground: fg,
    cursor: fg,
    cursorAccent: bg,
    selectionBackground: sel,
    ...(ansi
      ? {
          black: ansi.black,
          red: ansi.red,
          green: ansi.green,
          yellow: ansi.yellow,
          blue: ansi.blue,
          magenta: ansi.magenta,
          cyan: ansi.cyan,
          white: ansi.white,
          brightBlack: ansi.brightBlack,
          brightRed: ansi.brightRed,
          brightGreen: ansi.brightGreen,
          brightYellow: ansi.brightYellow,
          brightBlue: ansi.brightBlue,
          brightMagenta: ansi.brightMagenta,
          brightCyan: ansi.brightCyan,
          brightWhite: ansi.brightWhite,
        }
      : {}),
    // xterm 6 ships its own DOM scrollbar, which the global scrollbar CSS can't
    // reach, and its default is a heavy always-on bar. Drive it through the theme
    // so it auto-hides: invisible at rest, a subtle thumb on hover. `rgba(0,0,0,0)`,
    // not "transparent", for xterm's color parser.
    scrollbarSliderBackground: "rgba(0,0,0,0)",
    scrollbarSliderHoverBackground: resolveTokenValue("--border3") ?? undefined,
    scrollbarSliderActiveBackground: resolveTokenValue("--border4") ?? undefined,
  };
}

// navigator.clipboard, falling back to execCommand where the async API needs
// user activation. Failures are silent so a denied clipboard never throws into
// render. Paste is xterm's native handler (see the Cmd/Ctrl+V branch).

async function writeClipboard(text: string): Promise<void> {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fall through to execCommand */
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    document.execCommand("copy");
    document.body.removeChild(el);
  } catch {
    /* drop */
  }
}
