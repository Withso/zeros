// ──────────────────────────────────────────────────────────
// TerminalMirror — engine-side virtual terminal per PTY session
// ──────────────────────────────────────────────────────────
//
// A headless xterm (@xterm/headless) that consumes the EXACT same byte stream
// the engine forwards to clients, maintaining the *resolved* screen + scrollback
// grid inside the engine process. Its job is to produce a clean reattach
// snapshot via @xterm/addon-serialize instead of replaying raw PTY history — so
// a page refresh, panel reopen, OR a second device attaching repaints the exact
// pre-existing screen with no double-rendered TUI frames.
//
// This is the sole engine-side terminal mirror (the desktop terminal now runs
// through the engine PtyService, so there is no parallel electron-main copy).
// It is deliberately dependency-light (only @xterm/headless +
// @xterm/addon-serialize — no node-pty, no electron, no Zeros IPC) so it stays
// testable without the native binding and runs unchanged inside the daemon.
//
// WHY THIS EXISTS — the "rendered twice" fix
// ──────────────────────────────────────────
// Redraw-based TUIs (Ink apps like `cursor-agent`, full-screen `claude`/`codex`)
// paint a frame then repaint via cursor-relative sequences ("cursor up N, erase,
// redraw"). Those only mean anything against the exact grid they were emitted
// against. Concatenating raw bytes and `term.write()`-replaying them into a
// FRESH xterm leaves a ghost of the earlier frame (the "cursor up N" no longer
// matches). Feeding the same bytes into a real headless grid resolves the cursor
// math against an actual terminal; serialize() then emits only the final
// resolved state. No ghost.
//
// OSC 133 SEAM
// ────────────
// The headless grid is also the natural home for shell-integration parsing
// (OSC 133 prompt/command-exit markers → agent idle/working status). The parser
// hook would register in the constructor below; the matching half emits the
// markers around the zsh prompt in the ZDOTDIR wrapper (shell-setup.ts). Not
// wired yet; documented seam only.
// ──────────────────────────────────────────────────────────

import { Terminal } from "@xterm/headless";
import type { ITerminalAddon } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

// Lines of scrollback the mirror keeps AND the cap we serialize on reattach.
// Bounds both engine memory per session and the replay payload pushed over the
// bridge. ~2000 lines covers the "started a dev server, refreshed, don't lose
// the log" case without shipping multi-MB snapshots. (Clients keep a deeper
// scrollback for live scrolling; this only governs what survives a reattach.)
const MIRROR_SCROLLBACK_LINES = 2000;

// Hard ceiling on the serialized reattach payload. Even within the line cap, a
// pathological full-screen TUI (dense SGR styling on a very wide grid) can
// serialize to hundreds of KB; this bounds the message + JSON parse on every
// refresh / reattach. snapshot() walks down the ladder below until the UTF-8
// payload fits, flagging `truncated` when it had to drop history. 256 KB
// comfortably holds a full 2000-line log of ordinary output.
const MIRROR_SNAPSHOT_MAX_BYTES = 256 * 1024;

// Scrollback rungs snapshot() tries (most → least) to fit the byte budget. The
// final rung (0) is the visible screen only — inherently bounded — so it's the
// floor we ship even if still over budget.
const SNAPSHOT_SCROLLBACK_LADDER = [
  MIRROR_SCROLLBACK_LINES,
  1000,
  500,
  200,
  50,
  0,
];

export interface TerminalSnapshot {
  /** Serialized escape-sequence blob to write verbatim into a fresh, same-size
   *  xterm to reproduce the resolved screen + scrollback. */
  data: string;
  /** True when scrollback was reduced below the full cap to fit
   *  MIRROR_SNAPSHOT_MAX_BYTES. The visible screen is always intact. */
  truncated: boolean;
  /** UTF-8 byte length of `data` — what actually rides the wire. */
  bytes: number;
}

export class TerminalMirror {
  private readonly term: Terminal;
  private readonly serializer: SerializeAddon;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: MIRROR_SCROLLBACK_LINES,
      // Match the renderer's xterm so any proposed-API-gated escape handling
      // resolves identically here.
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    // The headless `ITerminalAddon` and the SerializeAddon's `@xterm/xterm`-typed
    // `ITerminalAddon` are structurally identical (activate/dispose); only the
    // nominal Terminal type on `activate` differs across packages. At runtime
    // SerializeAddon only reads buffer/cols/rows/options — all present on the
    // headless Terminal — a documented, supported combination. The cast bridges
    // the cross-package type seam.
    this.term.loadAddon(this.serializer as unknown as ITerminalAddon);
  }

  /** Feed one chunk of PTY stdout — the same bytes clients receive, so the grid
   *  stays in lockstep with what the user saw. Parsing is async (xterm buffers
   *  writes); we don't block the live data path on it. `snapshot()` awaits a
   *  drain before serializing so a reattach can't capture a half-parsed burst. */
  write(data: string): void {
    this.term.write(data);
  }

  /** Resolve once every queued write has been parsed into the grid. */
  private flush(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.term.write("", resolve);
    });
  }

  /** Keep the grid sized to the live PTY. Call on every resize and on the
   *  reattach dim-reconcile so the snapshot is produced at the width the
   *  client's xterm will receive it at (serialize expects a same-size target). */
  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    try {
      this.term.resize(cols, rows);
    } catch {
      /* invalid dims — leave the grid as-is */
    }
  }

  /** Clean reattach payload: the resolved screen + bounded scrollback as a
   *  single escape-sequence blob that reproduces the exact visible state —
   *  including terminal modes (mouse tracking, bracketed paste, alt buffer) and
   *  cursor position — when written into a same-size xterm.
   *
   *  Awaits a write drain first so the snapshot reflects every byte clients have
   *  seen, then walks SNAPSHOT_SCROLLBACK_LADDER until the UTF-8 payload fits
   *  `maxBytes`. Never throws: a serialize hiccup yields whatever smaller blob
   *  already succeeded and the client starts clean. */
  async snapshot(
    maxBytes: number = MIRROR_SNAPSHOT_MAX_BYTES,
  ): Promise<TerminalSnapshot> {
    await this.flush();
    let data = "";
    let bytes = 0;
    for (let rung = 0; rung < SNAPSHOT_SCROLLBACK_LADDER.length; rung++) {
      let blob: string;
      try {
        blob = this.serializer.serialize({
          scrollback: SNAPSHOT_SCROLLBACK_LADDER[rung],
        });
      } catch {
        // Keep any smaller blob already produced; otherwise empty replay.
        break;
      }
      data = blob;
      bytes = Buffer.byteLength(blob, "utf8");
      if (bytes <= maxBytes) {
        // rung 0 is the full scrollback cap — anything past it dropped history.
        return { data, truncated: rung > 0, bytes };
      }
    }
    // Ladder exhausted (even the visible screen exceeded the budget) or a
    // serialize threw mid-walk. Ship what we have, flag the trim.
    return { data, truncated: data.length > 0, bytes };
  }

  dispose(): void {
    try {
      this.serializer.dispose();
    } catch {
      /* already gone */
    }
    try {
      this.term.dispose();
    } catch {
      /* already gone */
    }
  }
}
