// Cursor-relative TUI redraws depend on the existing grid; reattach serializes that grid rather than replaying a raw byte tail.

import { Terminal } from "@xterm/headless";
import type { ITerminalAddon } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

// Bound the engine's per-session history independently of live client scrollback.
const MIRROR_SCROLLBACK_LINES = 2000;

const MIRROR_SNAPSHOT_MAX_BYTES = 256 * 1024;

// Preserve the visible screen even if discarding all scrollback cannot meet the byte budget.
const SNAPSHOT_SCROLLBACK_LADDER = [
  MIRROR_SCROLLBACK_LINES,
  1000,
  500,
  200,
  50,
  0,
];

export interface TerminalSnapshot {
  /** Write this verbatim into a fresh xterm of the same dimensions. */
  data: string;
  /** True when history was dropped to fit the payload cap; false can also mean serialization failed before producing any bytes. */
  truncated: boolean;
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
      // Match the renderer's proposed-API setting so escape handling agrees.
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    // SerializeAddon supports the headless buffer, but its addon type names the browser Terminal.
    this.term.loadAddon(this.serializer as unknown as ITerminalAddon);
  }

  /** Keep xterm's asynchronous parser off the live PTY data path. */
  write(data: string): void {
    this.term.write(data);
  }

  /** An empty xterm write is queued behind the PTY bytes already received. */
  flush(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.term.write("", resolve);
    });
  }

  resize(cols: number, rows: number): void {
    if (cols === this.term.cols && rows === this.term.rows) return;
    try {
      this.term.resize(cols, rows);
    } catch {
      /* invalid dims — leave the grid as-is */
    }
  }

  /** Drain pending writes first so reattach cannot capture a half-parsed redraw. */
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
        // Keep the last successful serialization if a shorter one fails.
        break;
      }
      data = blob;
      bytes = Buffer.byteLength(blob, "utf8");
      if (bytes <= maxBytes) {
        return { data, truncated: rung > 0, bytes };
      }
    }
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
