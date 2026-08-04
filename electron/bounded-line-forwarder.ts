export const MAX_FORWARDED_LINE_CHARS = 1_000_000;

export interface BoundedLineForwarder {
  push(chunk: string | Buffer): void;
  end(): void;
}

/**
 * Split a child stream into bounded logical lines.
 *
 * Once a line crosses the ceiling, emit one fixed-size diagnostic and discard
 * the rest of that SAME logical line through its newline. Flushing arbitrary
 * one-megabyte fragments would bound RAM but still let a newline-free child
 * amplify directly into main.log and the structured log store.
 */
export function createBoundedLineForwarder(
  write: (line: string) => void,
  maxChars: number = MAX_FORWARDED_LINE_CHARS,
): BoundedLineForwarder {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error("maxChars must be a positive safe integer");
  }

  let buffer = "";
  let droppingOversizedLine = false;
  const oversizedMarker = `[dropped oversized child log line (> ${maxChars} characters)]`;

  const push = (chunk: string | Buffer) => {
    let remaining =
      typeof chunk === "string" ? chunk : chunk.toString("utf-8");

    while (remaining.length > 0) {
      if (droppingOversizedLine) {
        const newline = remaining.indexOf("\n");
        if (newline === -1) return;
        droppingOversizedLine = false;
        remaining = remaining.slice(newline + 1);
        continue;
      }

      const newline = remaining.indexOf("\n");
      if (newline === -1) {
        if (buffer.length + remaining.length > maxChars) {
          buffer = "";
          droppingOversizedLine = true;
          write(oversizedMarker);
        } else {
          buffer += remaining;
        }
        return;
      }

      const fragment = remaining.slice(0, newline);
      remaining = remaining.slice(newline + 1);
      if (buffer.length + fragment.length > maxChars) {
        write(oversizedMarker);
      } else {
        const line = `${buffer}${fragment}`.replace(/\r$/, "");
        if (line.length > 0) write(line);
      }
      buffer = "";
    }
  };

  return {
    push,
    end: () => {
      if (!droppingOversizedLine && buffer.length > 0) write(buffer);
      buffer = "";
      droppingOversizedLine = false;
    },
  };
}
