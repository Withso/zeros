// ──────────────────────────────────────────────────────────
// Tolerant reader for streamed tool input JSON
// ──────────────────────────────────────────────────────────
//
// Providers stream a tool call's arguments as a growing JSON prefix. The
// Design draft preview needs the fields received so far: a string may still
// be streaming, while keys, numbers and literals count only once complete.
// `complete` names every string whose closing quote has arrived, by dotted
// path (`file_path`, `edits.1.old_string`), so a caller can require a fully
// received path or search text before acting on it. Never throws.

export interface PartialJson {
  value: unknown;
  complete: Set<string>;
}

interface Parsed {
  value: unknown;
  /** The value's final character arrived. */
  done: boolean;
  /** The value exists (an incomplete number or literal does not). */
  present: boolean;
}

const ABSENT: Parsed = { value: undefined, done: false, present: false };
const LITERALS: ReadonlyArray<[string, unknown]> = [
  ["true", true],
  ["false", false],
  ["null", null],
];
const ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

export function readPartialJson(text: string): PartialJson {
  const complete = new Set<string>();
  let index = 0;
  const skipSpace = () => {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) return;
      index += 1;
    }
  };

  const readString = (): Parsed => {
    // Caller has consumed the opening quote.
    let out = "";
    let start = index;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 34) {
        out += text.slice(start, index);
        index += 1;
        return { value: out, done: true, present: true };
      }
      if (code !== 92) {
        index += 1;
        continue;
      }
      out += text.slice(start, index);
      const escape = text[index + 1];
      if (escape === undefined) {
        index = text.length;
        return { value: out, done: false, present: true };
      }
      if (escape !== "u") {
        out += ESCAPES[escape] ?? escape;
        index += 2;
        start = index;
        continue;
      }
      const hex = text.slice(index + 2, index + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
        // An unfinished escape is withheld until its digits arrive.
        index = text.length;
        return { value: out, done: false, present: true };
      }
      const unit = Number.parseInt(hex, 16);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const low = text.slice(index + 6, index + 12);
        if (low.length < 6) {
          // Never expose half of a surrogate pair.
          index = text.length;
          return { value: out, done: false, present: true };
        }
        const pair = /^\\u([dD][c-fC-F][0-9a-fA-F]{2})$/.exec(low);
        if (pair) {
          out += String.fromCharCode(unit, Number.parseInt(pair[1]!, 16));
          index += 12;
          start = index;
          continue;
        }
      }
      out += String.fromCharCode(unit);
      index += 6;
      start = index;
    }
    out += text.slice(start, index);
    return { value: out, done: false, present: true };
  };

  const readNumber = (): Parsed => {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      text.slice(index, index + 64),
    );
    if (!match) return ABSENT;
    const end = index + match[0].length;
    // Without a following delimiter the number may still be growing.
    if (end >= text.length) {
      index = text.length;
      return ABSENT;
    }
    index = end;
    return { value: Number(match[0]), done: true, present: true };
  };

  const readLiteral = (): Parsed => {
    for (const [word, literal] of LITERALS) {
      if (text.startsWith(word, index)) {
        index += word.length;
        return { value: literal, done: true, present: true };
      }
      if (word.startsWith(text.slice(index))) {
        index = text.length;
        return ABSENT;
      }
    }
    return ABSENT;
  };

  const readValue = (path: string): Parsed => {
    skipSpace();
    if (index >= text.length) return ABSENT;
    const char = text[index];
    if (char === '"') {
      index += 1;
      const parsed = readString();
      if (parsed.done && path) complete.add(path);
      return parsed;
    }
    if (char === "{") return readObject(path);
    if (char === "[") return readArray(path);
    if (char === "-" || (char! >= "0" && char! <= "9")) return readNumber();
    return readLiteral();
  };

  const readObject = (path: string): Parsed => {
    index += 1;
    const out: Record<string, unknown> = {};
    for (;;) {
      skipSpace();
      if (index >= text.length) return { value: out, done: false, present: true };
      if (text[index] === "}") {
        index += 1;
        return { value: out, done: true, present: true };
      }
      if (text[index] !== '"') return { value: out, done: false, present: true };
      index += 1;
      const key = readString();
      if (!key.done) return { value: out, done: false, present: true };
      skipSpace();
      if (text[index] !== ":") return { value: out, done: false, present: true };
      index += 1;
      const name = String(key.value);
      const member = readValue(path ? `${path}.${name}` : name);
      if (member.present) out[name] = member.value;
      if (!member.done) return { value: out, done: false, present: true };
      skipSpace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "}") {
        index += 1;
        return { value: out, done: true, present: true };
      }
      return { value: out, done: false, present: true };
    }
  };

  const readArray = (path: string): Parsed => {
    index += 1;
    const out: unknown[] = [];
    for (;;) {
      skipSpace();
      if (index >= text.length) return { value: out, done: false, present: true };
      if (text[index] === "]") {
        index += 1;
        return { value: out, done: true, present: true };
      }
      const item = readValue(path ? `${path}.${out.length}` : String(out.length));
      if (item.present) out.push(item.value);
      if (!item.done) return { value: out, done: false, present: true };
      skipSpace();
      if (text[index] === ",") {
        index += 1;
        continue;
      }
      if (text[index] === "]") {
        index += 1;
        return { value: out, done: true, present: true };
      }
      return { value: out, done: false, present: true };
    }
  };

  const root = readValue("");
  return { value: root.present ? root.value : undefined, complete };
}
