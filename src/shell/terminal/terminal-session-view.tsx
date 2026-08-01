// ──────────────────────────────────────────────────────────
// Terminal Session View — xterm instance for one PTY session
// ──────────────────────────────────────────────────────────
//
// One instance per terminal tab. Owns:
//   - the xterm DOM grid
//   - the FitAddon (resizing on container resize)
//   - the bridge between xterm onData → pty_write
//   - the bridge between pty-data event → xterm.write
//   - PTY lifecycle: pty_create on mount, pty_kill on unmount
//
// The store records metadata only; this component is the
// canonical owner of the IPC PTY. Mounting a fresh session
// view = a fresh `pty_create`; unmounting = `pty_kill`.
//
// Sessions where `alive=false` skip the create call: the
// underlying PTY exited, so we replay the stored output buffer.
// Live PTY state is not persisted across app restarts.
//
// Stacked-prompt fix
// ──────────────────────────
// The shell used to print its prompt up to 3 times at different
// widths on first open. Root cause: PTY was spawned in the next
// rAF after xterm.open(), but the host container could still be
// in mid-layout (panel just expanded, percentage-height card
// resolving against a still-measuring parent, font shipping
// late), so `fit.fit()` returned a tiny cols/rows and the shell
// printed its login prompt at that width. Subsequent
// ResizeObserver fires grew the PTY, the shell redrew on each
// SIGWINCH, and the old narrow prompt(s) stayed in scrollback.
//
// Fix is structural:
//   1. Don't spawn the PTY until `fit.proposeDimensions()` returns
//      a real (>= 4 col, >= 2 row) measurement. A ResizeObserver
//      polls until we have stable dims, with a 1.5 s fallback to
//      80×24 so a broken layout still gives a usable shell.
//   2. After spawn, the live ResizeObserver waits for native-window bursts
//      to settle and suspends completely during known pane drags, then fits
//      once on the next frame. This collapses a gesture into one PTY resize.
//   3. All resize paths funnel through `proposeDimensions()` →
//      `fit.fit()` → `ptyResize` (matching dim equality check),
//      so the PTY and the xterm grid stay in lockstep.
// ──────────────────────────────────────────────────────────

import React, { useEffect, useLayoutEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
// 2026-05-28: dropped `@xterm/addon-canvas`. The addon's latest
// release (0.7.0) was published against xterm@^5; xterm v6 doesn't
// have a v6-compatible canvas addon yet (pnpm flagged the peer
// mismatch). The DOM renderer (xterm's built-in default) is what
// 95%+ of xterm users run on and is sufficient for our agent panel
// usage. If terminal perf becomes an issue with many simultaneous
// heavy streams, the right replacement is `@xterm/addon-webgl` —
// but Chromium caps a renderer at ~16 active WebGL contexts and
// force-loses the oldest, which in a multi-agent session would
// manifest as random pane freezes, so adopt it deliberately rather
// than reflexively. DOM-first stays the safe default.

import {
  ptyCreate,
  ptyResize,
  ptyTerminals,
  ptyWrite,
} from "../../native/pty";
import { resolveTokenValue } from "../../zeros/appearance/resolve-tokens";
import { terminalExitPolicy } from "./terminal-exit-policy";
import { WheelLineAccumulator } from "./wheel-scroll";
import { useAppearance } from "../../zeros/appearance/provider";
import { useThemeVariant } from "../../zeros/appearance/use-theme-variant";
import { resolveCodeTheme } from "../../zeros/appearance/code-themes";
import {
  ensureThemeColors,
  getThemeColorsSync,
  type ThemeColors,
} from "../../zeros/agent/renderers/syntax";
import {
  buildLaunchLine,
  resolveTerminalAgent,
} from "../../zeros/panels/terminal-agents";
import {
  bindPtyExitHandler,
  bindPtyWriter,
  useTerminalStore,
} from "./terminal-store";
import { createTerminalResizeScheduler } from "./terminal-resize-scheduler";
import { isContinuousLayoutResizeActive } from "./continuous-layout-resize";

// Mirrors `--font-mono` in `styles/zeros-tokens.css` exactly — xterm can't
// read a CSS variable, so this string has to be kept in sync by hand.
// Touch both when adding/removing a fallback.
const TERMINAL_FONT_FAMILY =
  "'Geist Mono Variable', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

// Shared default font size for every xterm surface — the col-3 floating
// panel AND the col-2 terminal-agent chats both mount this component, so
// changing this one constant changes both surfaces in lockstep.
const TERMINAL_FONT_SIZE_PX = 12;

// Fallback dims if the host container never reports a usable size
// within FIT_FALLBACK_MS (broken layout, headless test, …). 80×24 is
// the universal default; the shell will still resize correctly once
// the layout settles thanks to the post-spawn ResizeObserver.
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;
const FIT_FALLBACK_MS = 1500;

// Minimum dims we'll treat as "real" — anything smaller is almost
// certainly a mid-layout transient (panel still expanding, flex still
// resolving). `proposeDimensions` returns undefined when the host
// is 0×0, and tiny positive values when the cell metrics give it
// just one or two cells in some dimension. Below this threshold we
// keep polling.
const MIN_REAL_COLS = 4;
const MIN_REAL_ROWS = 2;

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
   *  found no live PTY (app relaunch, col-3 re-expand after the run ended)
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
   *  which both col-2 agent terminals and the col-3 panel use today; kept
   *  as a prop so a host on a different surface can still match it. */
  surfaceToken?: string;
}

// Wrapped in React.memo so the deck parent (which subscribes to the
// whole Context-backed workspace store and therefore re-renders on
// every reducer dispatch) doesn't cascade through to xterm
// reconciliation. Props are all primitives / nullable strings, so the
// default shallow comparator is correct.
export const TerminalSessionView = React.memo(function TerminalSessionView({
  sessionId,
  cwd,
  visible,
  agentId,
  ephemeral,
  initialCommand,
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
  // Resolved "dark"|"light" — flips on an OS appearance change in system mode
  // (where prefs.mode stays "system"). Drives the theme re-resolve below so the
  // xterm's concrete bg/fg values never go stale on a live flip.
  const variant = useThemeVariant();

  // Mount xterm once; defer PTY spawn until the host container reports
  // a real size. See the file header for why this is structural —
  // spawning at 80×24 (or worse) leaves stale prompt lines in scrollback
  // every time the panel finishes its expand animation.
  useLayoutEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    const term = new XTerm({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE_PX,
      cursorBlink: true,
      cursorStyle: "bar",
      scrollback: 10_000,
      allowProposedApi: true,
      // Background comes from `surfaceToken` so this one shared component matches
      // whatever it sits on (--bg1 everywhere today — col-2 agent terminals and
      // the col-3 panel). An explicit color (not transparency) so the DOM
      // renderer paints it reliably — a transparent theme bg renders as the
      // renderer's opaque default here, not the surface behind it.
      theme: resolveTerminalTheme(surfaceToken),
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    xtermRef.current = term;
    fitRef.current = fit;
    // Renderer choice — DOM (xterm's built-in default). See the
    // import-section comment above for why we dropped the Canvas
    // addon path. The DOM renderer handles our typical workload
    // (per-agent worktree pane, scrollback up to 10k lines) without
    // visible perf issues; if that changes for heavy multi-agent
    // sessions, evaluate `@xterm/addon-webgl` with the 16-context
    // ceiling in mind before adopting.

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
      // App-level global chords use Cmd/Ctrl+Option (⌥⌘B toggles
      // Column 3, ⌥⌘T cycles theme). Return false so xterm neither
      // forwards them to the PTY nor calls preventDefault — the event
      // then bubbles to the window keydown handlers in app-shell.
      // macOS terminals never deliver Cmd+Option combos to the shell,
      // so nothing useful is lost. The matching half of this fix is
      // the xterm-helper-textarea exemption in editable-target.ts;
      // without it those window handlers would still bail on the
      // terminal's hidden <textarea>.
      if (mod && evt.altKey) return false;
      if (!mod || evt.altKey) return true;
      const key = evt.key.toLowerCase();
      if (key === "v") {
        // Do NOT call term.paste() here. The PLATFORM paste path already
        // pastes: the Electron app menu's { role: "paste" }
        // (electron/menu.ts) and the right-click context menu both drive
        // webContents.paste(), which fires xterm's native `paste`
        // DOM-event handler; on the web target the browser's own
        // Cmd/Ctrl+V fires that same handler directly. xterm's native
        // handler ALREADY wraps the clipboard in bracketed-paste markers
        // (CSI ?2004h → \x1b[200~…\x1b[201~) via the very routine
        // term.paste() calls, so multi-line pastes stay intact. Calling
        // term.paste() in addition pasted a SECOND copy on top of it —
        // the "git remote -vgit remote -v" duplication.
        //
        // We still return false so xterm doesn't ALSO emit Ctrl+V (0x16,
        // "quoted-insert") to the PTY on Linux/Windows. Returning false
        // does NOT preventDefault, so the native paste event still fires —
        // leaving exactly one bracketed paste.
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

    // Capture-phase wheel handler. TUIs that enable mouse tracking
    // (vim, tmux, claude-code in input mode, codex) eat wheel events
    // before xterm gets to scroll its viewport — so the user can't
    // scrollback while an agent is running. Intercepting at capture
    // ensures we scroll the buffer regardless of mouse-tracking state.
    // We DON'T preventDefault at the scrollback boundaries, so an
    // outer scroller can take over there.
    //
    // Everywhere else we take the WHOLE gesture — including the events that are
    // still sub-line. Releasing those would hand them straight back to the
    // listener this handler exists to pre-empt: xterm's viewport, which under
    // mouse tracking forwards them to the TUI as scroll escapes, and otherwise
    // runs its OWN accumulator on top of ours for a jittery ~2× scroll. One
    // accumulator owns the gesture, and it carries the remainder between events
    // instead of rounding it away — which is what made slow trackpad scrolling
    // do nothing at all (see wheel-scroll.ts).
    const wheelLines = new WheelLineAccumulator();
    const onWheelCapture = (evt: WheelEvent) => {
      if (!term.element) return;
      // NOT a scrollback gesture — release it untouched (no preventDefault), or
      // we'd both eat the gesture and scroll on its incidental vertical noise.
      // Both cases became reachable when the accumulator started banking
      // sub-line deltas that the old `Math.round(deltaY / 20)` discarded:
      //   • ctrl/⌘+wheel is zoom (Chromium synthesizes trackpad pinch as
      //     ctrlKey wheel with a few px of deltaY, so a pinch used to be
      //     rounded to nothing and now scrolls a row per pinch), and
      //   • a mostly-HORIZONTAL two-finger swipe carries a couple of px of
      //     vertical jitter, which accumulated into real rows of drift. xterm's
      //     own viewport zeroes the non-dominant axis for the same reason
      //     (scrollPredominantAxis).
      if (evt.ctrlKey || evt.metaKey) return;
      if (Math.abs(evt.deltaY) < Math.abs(evt.deltaX)) return;
      const buffer = term.buffer.active;
      // The ALTERNATE screen has no scrollback (its line buffer is capped at
      // `rows`), so scrollLines is a no-op there and the wheel belongs to the
      // full-screen TUI — xterm turns it into an SGR mouse escape or ESC[A/B.
      // The boundary check below already lets it through, because both atTop and
      // atBottom hold; this says so once, explicitly, so a transient ydisp of 1
      // during a resize can't consume a wheel-up that would go nowhere.
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
    host.addEventListener("wheel", onWheelCapture, { capture: true, passive: false });

    // Forward xterm keystrokes to the PTY. Bound ONCE here — NOT
    // inside `spawn` — so a restart-after-exit respawn doesn't stack a
    // second onData listener (two listeners would write every
    // keystroke to the PTY twice). While the shell is dead
    // (exitedRef), the first keystroke is consumed to restart the
    // session instead of vanishing into a closed PTY.
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
    let spawned = false;
    let spawnRaf = 0;
    let cancelled = false;
    let roSpawn: ResizeObserver | null = null;

    const stopSpawnObserver = () => {
      roSpawn?.disconnect();
      roSpawn = null;
    };

    const tryMeasureAndSpawn = () => {
      if (spawned || cancelled) return;
      // proposeDimensions() returns undefined when the host has zero
      // box, and a positive `{cols, rows}` once it has real layout.
      const dims = fit.proposeDimensions();
      if (
        !dims ||
        !Number.isFinite(dims.cols) ||
        !Number.isFinite(dims.rows) ||
        dims.cols < MIN_REAL_COLS ||
        dims.rows < MIN_REAL_ROWS
      ) {
        return; // keep polling
      }
      spawned = true;
      stopSpawnObserver();
      try {
        fit.fit();
      } catch {
        /* fall through using proposed dims via lastDimsRef */
      }
      lastDimsRef.current = {
        cols: term.cols || dims.cols,
        rows: term.rows || dims.rows,
      };
      void spawn(term);
    };

    // First try after one paint frame — the common case (panel already
    // expanded at full size on mount) clears here.
    spawnRaf = requestAnimationFrame(tryMeasureAndSpawn);

    // Keep trying as the container reaches its real size.
    roSpawn = new ResizeObserver(() => {
      tryMeasureAndSpawn();
    });
    roSpawn.observe(host);

    // Font-load remeasure. Geist Mono Variable is a webfont
    // (@fontsource-variable/geist-mono); if xterm measures cell
    // metrics while only the SFMono fallback is loaded, cell width
    // ends up off by a few pixels and the column count we just
    // resolved is wrong. When the variable font finally swaps in,
    // we re-fit so the live grid matches reality.
    //   - Pre-spawn: triggers another measurement attempt (font may
    //     have been the reason the host was reporting weird dims).
    //   - Post-spawn: runs `applyFit`, which is a no-op if cols/rows
    //     didn't actually change; if they did, it pushes a single
    //     dimension-checked ptyResize — the shell sees one clean SIGWINCH
    //     instead of the previous "draw at wrong width → SIGWINCH →
    //     redraw → ghost" cascade.
    if (typeof document !== "undefined" && document.fonts && document.fonts.load) {
      void document.fonts
        .load(`${TERMINAL_FONT_SIZE_PX}px "Geist Mono Variable"`)
        .catch(() => [])
        .then(() => {
          if (cancelled) return;
          if (!spawned) {
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

    // Last-resort: spawn with 80×24 if the host never reports real
    // dims (badly-broken layout, jsdom, …). Keeps the terminal usable
    // and the post-spawn ResizeObserver will correct dims as soon as
    // the layout heals.
    const fallbackTimer = window.setTimeout(() => {
      if (!spawned && !cancelled) {
        spawned = true;
        stopSpawnObserver();
        lastDimsRef.current = { cols: FALLBACK_COLS, rows: FALLBACK_ROWS };
        void spawn(term);
      }
    }, FIT_FALLBACK_MS);

    return () => {
      cancelled = true;
      cancelAnimationFrame(spawnRaf);
      window.clearTimeout(fallbackTimer);
      stopSpawnObserver();
      host.removeEventListener("wheel", onWheelCapture, { capture: true });
      term.dispose();
      xtermRef.current = null;
      fitRef.current = null;
      // 2026-05-28: do NOT ptyKill on unmount. The PTY lives in the
      // main process and we want it to survive a page refresh + col-3
      // collapse so `npm run dev` doesn't die every cmd+R. The PTY is
      // explicitly killed only by the close paths:
      //   - terminal-store.closeSession (× on tab)
      //   - Column2 chat archive (× on terminal-agent tab)
      //   - killAllPtySessions on before-quit
      // ptyCreate is now reattach-aware and returns the existing
      // session + scrollback when called again with the same
      // sessionId — so this cleanup just disposes the xterm widget.
      createdRef.current = false;
    };
    // sessionId + cwd are component identity, never change for a
    // single tab — fresh mount per tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Spawn the PTY on the main process, wire stdin/stdout. */
  const spawn = async (term: XTerm) => {
    const { cols, rows } = lastDimsRef.current;
    if (attachOnly) {
      // Reattach-or-nothing: consult the engine's shared registry first. A
      // PTY_CREATE for a missing session would SPAWN a fresh login shell
      // under this id — exactly what attach-only exists to prevent.
      const terms = await ptyTerminals();
      const live =
        terms?.some((t) => t.sessionId === sessionId && t.exited !== true) ??
        false;
      if (!live) {
        // The PTY exited before we could attach — its live mirror is gone, but
        // the engine may still hold the run's output buffer. Replay it so a
        // fast run (an instant build/lint failure, a dev server that died on
        // boot) shows WHY it ended instead of a blank pane. Never spawns.
        try {
          const replay = await replayOnMiss?.(sessionId);
          if (replay) term.write(replay);
        } catch {
          /* buffer unavailable — fall through to the exited state */
        }
        markExited(sessionId);
        exitedRef.current = true;
        return;
      }
    }
    const info = await ptyCreate({ sessionId, cwd, cols, rows, ephemeral });
    if (!info) {
      // No-bridge fallback only. A connected web client gets a real host
      // shell over the relay; ptyCreate returns null solely when there is
      // no bridge to the host (e.g. browser dev mode with no paired engine).
      term.writeln(
        "\x1b[33m(No host connection — terminal needs the Mac app or a paired relay session.)\x1b[0m",
      );
      return;
    }
    createdRef.current = true;
    // A fresh/reattached PTY is live again — clear the exited latch so
    // keystrokes flow to the shell instead of triggering another
    // restart (matters on the restart path; harmless on first spawn).
    exitedRef.current = false;
    restartBlockedRef.current = false;
    // Repaint from the main-side mirror's serialized snapshot (a clean
    // escape blob of the resolved grid, NOT raw byte history) captured
    // while this renderer was disconnected (page refresh, col-3
    // collapse). Because main resizes the mirror to our measured dims
    // before serializing, this xterm is already the matching size, so
    // the snapshot reproduces the exact pre-refresh screen — including
    // a live TUI's last frame, with no double-render. Written *before*
    // the live data binding so the snapshot and live stream stay
    // ordered.
    if (info.reattached && info.replay) {
      term.write(info.replay);
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
    // Auto-launch input once the shell prompt is ready: an explicit
    // `initialCommand` (the embedded-terminal `claude /mcp` runner) takes
    // priority, else the bound terminal-agent's launch line. We give the login
    // shell ~200 ms to draw its prompt so the line doesn't race shell init (zsh
    // -l can take ~50–150 ms on a cold cache). The latch keeps re-mounts from
    // firing a second launch on top of the live session. A re-attach
    // (info.reattached) short-circuits it — the input already ran on the
    // original spawn.
    if (info.reattached) {
      agentLaunchedRef.current = true;
    }
    if (!agentLaunchedRef.current) {
      const explicit = initialCommand?.trim();
      const agent = !explicit && agentId ? resolveTerminalAgent(agentId) : null;
      const line = explicit || (agent ? buildLaunchLine({ agent }) : "");
      if (line) {
        agentLaunchedRef.current = true;
        // Leading-space prefix: with HIST_IGNORE_SPACE (set by Zeros'
        // ZDOTDIR wrapper in shell-setup.ts), zsh DROPS commands that
        // start with a space from history. These auto-injected lines
        // (`claude`, `codex`, `claude /mcp`, …) are Zeros-driven, not
        // user-typed — keeping them out of recall stops the user's
        // ~/.zsh_history from filling with them. User-typed commands
        // still flow through `term.onData` above and DO land in history.
        window.setTimeout(() => {
          void ptyWrite({ sessionId, data: ` ${line}\r` }).catch(() => {
            /* pty already exited — drop */
          });
        }, 200);
      }
    }
  };

  /** Respawn a fresh shell in place after the PTY exited. Triggered by
   *  the first keystroke on an exited terminal (see the once-bound
   *  `term.onData` in the mount effect). The main-side session was
   *  deleted on exit, so `ptyCreate` with the same id spawns a
   *  brand-new shell rather than reattaching. We re-arm the agent
   *  auto-launch so a terminal-agent tab brings its agent back; a
   *  plain shell (col-3 panel, null agentId) just gets a fresh prompt.
   *  markAlive clears the tab's "(exited)" badge. */
  const restart = async (term: XTerm) => {
    agentLaunchedRef.current = false;
    markAlive(sessionId);
    term.writeln("\x1b[2m[restarting…]\x1b[0m");
    await spawn(term);
    try {
      term.focus();
    } catch {
      /* not laid out yet */
    }
  };

  // Register pty-data + pty-exit handlers via the store's central
  // router (one nativeListen per event, dispatched by sessionId).
  // Replaces the previous per-mount listener pair that was O(n) per
  // PTY byte in the open-tab count.
  useEffect(() => {
    return bindPtyWriter(sessionId, (data) => {
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
      // Arm the restart latch: the shell is gone, so the next
      // keystroke (handled in the mount effect's onData) respawns it
      // instead of being lost. Without this an exited terminal was a
      // dead, un-typeable rectangle.
      exitedRef.current = true;
      const exitPolicy = terminalExitPolicy(evt.reason);
      restartBlockedRef.current = exitPolicy.restartBlocked;
      const term = xtermRef.current;
      if (term) {
        const code = evt.exitCode ?? evt.signal;
        if (exitPolicy.restartBlocked) {
          term.writeln(
            `\r\n\x1b[31m[terminal failed to start — ${exitPolicy.detail}]\x1b[0m`,
          );
          term.writeln(
            `\x1b[2m[${exitPolicy.recovery}]\x1b[0m`,
          );
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

  // Re-apply theme when the app VARIANT flips (a mode change OR an OS appearance
  // flip in "system" mode) or the code theme / surface token changes, so a live
  // theme swap (and an HMR prop change) repaints the grid. The background +
  // foreground are app tokens (--bg1/--fg1) and the ANSI palette comes from the
  // code theme, so both have to be re-resolved on a flip.
  //
  // Keyed on `variant` (the store's RESOLVED "dark"|"light"), NOT `prefs.mode`:
  // an OS flip in system mode leaves mode === "system" but flips the variant, so
  // keying on mode alone would strand the terminal on the old colors. (`codeTheme`
  // also usually flips with the variant, but only when the two variants resolve
  // to DIFFERENT theme ids — `variant` is the robust trigger for the bg/fg re-read.)
  //
  // useLayoutEffect (not useEffect): applyTheme() sets data-theme on <html>
  // synchronously inside the store's refresh(), re-theming the whole app in one
  // commit. A post-paint useEffect re-resolves the xterm a frame LATER, flashing
  // the old background against the already-flipped app. Running pre-paint (the
  // token values are live by now) lands the terminal in the same frame; refresh()
  // forces xterm to repaint the recolored grid immediately.
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
  }, [variant, prefs.codeTheme, surfaceToken]);

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

  // When this tab becomes visible: re-measure, redraw, focus. Double
  // rAF is intentional — visibility flip → layout settle → measure.
  // Without it xterm reads the previous (zero-width) bounds and the
  // grid clamps to 1×1 until the next external resize. `refresh()`
  // forces the renderer to paint immediately because the DOM
  // renderer skips paints while the ancestor is `visibility:hidden`.
  useEffect(() => {
    if (!visible) return;
    // Dragging a collapsed panel open flips visibility mid-gesture. Mark the
    // scheduler dirty explicitly so release always performs one exact fit,
    // even if ResizeObserver coalesces away that intermediate geometry.
    if (isContinuousLayoutResizeActive()) {
      resizeSchedulerRef.current?.flush();
      return;
    }
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        applyFit();
        const term = xtermRef.current;
        if (term) {
          try {
            term.refresh(0, Math.max(0, term.rows - 1));
            term.focus();
          } catch {
            /* not laid out yet */
          }
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
    // applyFit is a stable closure over refs (see post-spawn observer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Shared "fit + propose + ptyResize" path. Reads the proposed dims
  // first so we can no-op when nothing changed (avoids IPC churn on
  // mouse-resize that doesn't cross a cell boundary). All three
  // resize paths (post-spawn ResizeObserver, visibility flip,
  // term.onResize callback) funnel through here so behaviour stays
  // consistent.
  function applyFit(): void {
    const fit = fitRef.current;
    const term = xtermRef.current;
    if (!fit || !term) return;
    const proposed = fit.proposeDimensions();
    if (
      !proposed ||
      !Number.isFinite(proposed.cols) ||
      !Number.isFinite(proposed.rows) ||
      proposed.cols < MIN_REAL_COLS ||
      proposed.rows < MIN_REAL_ROWS
    ) {
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
      // No bg here — the xterm paints `surfaceToken` (--bg1 in both col-2 and
      // the col-3 panel); this host only shows through before xterm opens,
      // where the parent surface already matches.
      className="size-full min-h-0 min-w-0 overflow-hidden"
    />
  );
});

// ──────────────────────────────────────────────────────────
// Theme — pull current CSS tokens, hand xterm RGB strings.
// xterm doesn't read CSS variables on its own; the appearance
// store applies tokens to <html> before React mounts, so by the
// time this resolver runs the values are always present. If a
// token ever fails to resolve, we leave the key undefined and
// xterm uses its built-in default for that field.
// ──────────────────────────────────────────────────────────

/** Compose a translucent `#RRGGBBAA` from a resolved token color. The
 *  SELECTION must be translucent: an opaque swatch can't sit behind every
 *  possible foreground (fg1 on opaque --highlighted-bright read ≈2.2:1 in
 *  dark — selected text was near-unreadable). With alpha, the glyphs keep
 *  most of their own contrast against the grid, which is how mainstream
 *  terminals handle selection. Canvas fillStyle normalizes whatever the
 *  token holds (hsl/rgb/hex) to #rrggbb — same trick as derive.ts's
 *  window-background sync. Returns undefined (→ xterm default) if the
 *  color can't be normalized. */
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
  // `surfaceToken` is the terminal's background surface (--bg1 for both col-2
  // agent terminals and the col-3 panel). Resolve it to a concrete color
  // (xterm can't read CSS vars) so the grid matches the card behind it.
  //
  // The terminal background + default foreground are ALWAYS the app tokens —
  // uniform across every code theme, just like the code blocks / diffs / editor.
  // ONLY the 16-color ANSI palette comes from the active code theme, so colored
  // shell output (CJS/WARN badges, ✓/✗, ls colors) follows the theme while the
  // grid stays readable for every theme (a light theme's dark fg would vanish on
  // the dark grid). ANSI falls back to xterm's built-in defaults until the
  // highlighter has loaded the theme (cold first paint).
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
    // xterm 6 ships its OWN VS Code-derived scrollbar — real DOM nodes
    // (`.xterm-scrollable-element > .scrollbar > .slider`), NOT a
    // `::-webkit-scrollbar` pseudo — so the app's global scrollbar CSS can't
    // reach it. Its default slider is a light translucent fill that renders as
    // a heavy, always-on, full-height bar at the terminal's right edge (and
    // bleeds over the chat when a terminal layer sits behind the conversation).
    // Drive it through xterm's own theme so it AUTO-HIDES like everything else:
    // invisible at rest, a subtle token thumb only while the terminal is
    // hovered. `rgba(0,0,0,0)` (not "transparent") for xterm's color parser.
    scrollbarSliderBackground: "rgba(0,0,0,0)",
    scrollbarSliderHoverBackground: resolveTokenValue("--border3") ?? undefined,
    scrollbarSliderActiveBackground: resolveTokenValue("--border4") ?? undefined,
  };
}

// ──────────────────────────────────────────────────────────
// Clipboard helper (copy) — async navigator.clipboard with a
// graceful fallback to the deprecated execCommand path for
// browsers / older Electron contexts that gate the async API
// behind user activation. Silently no-ops on failure so a denied
// clipboard never throws into render. (Paste is handled entirely
// by xterm's native `paste` handler — see the Cmd/Ctrl+V branch
// in attachCustomKeyEventHandler above.)
// ──────────────────────────────────────────────────────────

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
