import { stripVTControlCharacters } from "node:util";

const REDACTED = "[redacted]";
const LINE_LIMIT = 8_192;
const LINE_TRUNCATED = "[build log line truncated]";

/** Defense in depth after the VM's filter. Only recipe logs use this path;
 * infrastructure exceptions and helper stderr are never public build output. */
export function sanitizeComputerTemplateLog(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/https?:\/\/[^\s<>"']+/gi, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']*/gi, REDACTED)
    .replace(
      /\b(?:gh[spou]_|github_pat_|condw_|sk[_-])[A-Za-z0-9._+/=-]*/g,
      REDACTED,
    )
    .replace(
      /(["']?(?:[A-Za-z0-9_]*(?:token|secret|password|credential|api_key|authorization))["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b[A-Za-z0-9_+/=-]{32,}(?:\.[A-Za-z0-9_+/=-]+)*\b/g, REDACTED);
}

type Stream = { literal: string; line: string; dropping: boolean };

/** Uses the same complete-literal-before-prefix rule as the engine's streaming
 * customization filter. Complete lines then pass through the token-shape filter,
 * so a shape split over any number of SSH chunks cannot escape. Each stream
 * retains at most one bounded line and one credential prefix. */
export class ComputerTemplateLogRedactor {
  private readonly secrets: string[];
  private readonly streams = new Map<string, Stream>();
  constructor(values: readonly string[]) {
    this.secrets = [
      ...new Set(
        values
          .filter(Boolean)
          .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]),
      ),
    ].sort((a, b) => b.length - a.length);
    if (
      this.secrets.length > 64 ||
      this.secrets.some((value) => value.length > 16_384)
    )
      throw new Error("Invalid build redaction input");
  }
  private stream(key: string): Stream {
    if (key !== "stdout" && key !== "stderr")
      throw new Error("Invalid build log stream");
    let stream = this.streams.get(key);
    if (!stream) {
      stream = { literal: "", line: "", dropping: false };
      this.streams.set(key, stream);
    }
    return stream;
  }
  private clean(value: string): string {
    let output = sanitizeComputerTemplateLog(value);
    for (const secret of this.secrets)
      for (const part of secret.split("\n").filter(Boolean))
        output = output.split(part).join(REDACTED);
    for (const secret of this.secrets)
      for (
        let size = Math.min(secret.length - 1, output.length);
        size > 0;
        size--
      )
        if (output.endsWith(secret.slice(0, size))) {
          output = output.slice(0, -size) + REDACTED;
          break;
        }
    return output;
  }
  private lines(stream: Stream, value: string): string {
    let result = "",
      offset = 0;
    while (offset < value.length) {
      const newline = value.indexOf("\n", offset);
      const end = newline < 0 ? value.length : newline;
      const part = value.slice(offset, end);
      if (!stream.dropping) {
        if (
          Buffer.byteLength(stream.line) + Buffer.byteLength(part) >
          LINE_LIMIT
        ) {
          stream.line = "";
          stream.dropping = true;
          result += LINE_TRUNCATED;
        } else stream.line += part;
      }
      if (newline >= 0) {
        result += (stream.dropping ? "" : this.clean(stream.line)) + "\n";
        stream.line = "";
        stream.dropping = false;
      }
      offset = end + 1;
    }
    return result;
  }
  push(key: string, chunk: string): string {
    const stream = this.stream(key);
    let value = stream.literal + chunk;
    for (const secret of this.secrets)
      value = value.split(secret).join(REDACTED);
    let keep = 0;
    for (const secret of this.secrets)
      for (
        let size = Math.min(secret.length - 1, value.length);
        size > keep;
        size--
      )
        if (value.endsWith(secret.slice(0, size))) {
          keep = size;
          break;
        }
    stream.literal = keep ? value.slice(-keep) : "";
    return this.lines(stream, keep ? value.slice(0, -keep) : value);
  }
  finish(key: string): string {
    const stream = this.stream(key);
    let value = stream.literal ? this.lines(stream, REDACTED) : "";
    value += this.clean(stream.line);
    this.streams.delete(key);
    return value;
  }
}
