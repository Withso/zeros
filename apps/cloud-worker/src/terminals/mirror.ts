// Ported from apps/desktop/src/engine/pty/mirror.ts at 89202f45.
// Local stays unchanged; golden fixtures compare the resolved screen exactly.
// Cursor-relative TUI redraws need their original grid; serialize resolved state
// so a fresh terminal does not replay those bytes against the wrong layout.

import { Terminal } from "@xterm/headless";
import type { ITerminalAddon } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

// Bound retained history per PTY and on reattach; live clients may keep deeper scrollback.
const MIRROR_SCROLLBACK_LINES = 2000;

// Dense styling can exceed a line-based cap, so reduce scrollback to a UTF-8 byte budget.
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
    // The addon supports headless buffer/cols/rows/options at runtime; this cast
    // bridges only the packages' nominal Terminal types.
    this.term.loadAddon(this.serializer as unknown as ITerminalAddon);
  }

  /** Keep live writes asynchronous; snapshot drains them before reading the grid. */
  write(data: string): void {
    this.term.write(data);
  }

  /** Resolve once every queued write has been parsed into the grid. */
  flush(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.term.write("", resolve);
    });
  }

  /** Reconcile live and reattach dimensions: serialization expects a same-size target. */
  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    try {
      this.term.resize(cols, rows);
    } catch {
      /* invalid dims — leave the grid as-is */
    }
  }

  /** Drain writes before restoring the screen, modes and cursor into a same-size
   * xterm. Reduce scrollback to fit the byte budget while retaining the visible
   * screen even if it exceeds that budget; serializer failure keeps the last blob. */
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
