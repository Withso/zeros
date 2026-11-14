/** A value's extent in the source. Members and items are scanned only for the
 * containers a diff descends into, so unchanged subtrees are skipped, not
 * modelled. */
interface JsonNode {
  start: number;
  end: number;
}

interface JsonMember {
  key: string;
  start: number;
  value: JsonNode;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

interface Layout {
  unit: string;
  newline: string;
}

/** Rewrite `before` into a document equal to `after`, replacing only the
 * members whose values differ. Untouched members keep their bytes, escapes
 * and order; new members follow the existing ones. Returns `after` when the
 * edit cannot reproduce it exactly. */
export function editJsonPreservingFormat(before: string, after: string): string {
  let current: unknown;
  let target: unknown;
  try {
    current = JSON.parse(before);
    target = JSON.parse(after);
  } catch {
    return after;
  }
  try {
    return editParsedJsonPreservingFormat(before, current, target) ?? after;
  } catch {
    return after;
  }
}

/** The same edit for callers that already hold both parsed values: `current`
 * must be `JSON.parse(source)`. Returns `source` itself when the values are
 * equal, and null when the edit cannot reproduce `target` exactly. */
export function editParsedJsonPreservingFormat(source: string, current: unknown, target: unknown): string | null {
  const tree = scanRoot(source);
  const edits: Edit[] = [];
  const layout = { unit: indentUnit(source, tree), newline: source.includes("\r\n") ? "\r\n" : "\n" };
  diff(source, tree, current, target, layout, edits, true);
  if (!edits.length) return source;
  edits.sort((left, right) => left.start - right.start);
  let result = "";
  let offset = 0;
  for (const edit of edits) {
    result += source.slice(offset, edit.start) + edit.text;
    offset = edit.end;
  }
  result += source.slice(offset);
  try {
    return jsonEqual(JSON.parse(result), target) ? result : null;
  } catch {
    return null;
  }
}

/** Edits turning `node` into `value`. Each level compares only its
 * children, so a large unchanged subtree is compared once; below the root the
 * caller has already found that `current` differs. */
function diff(source: string, node: JsonNode, current: unknown, value: unknown, layout: Layout, edits: Edit[], root = false): void {
  const fields = isRecord(value) && isRecord(current) ? scanMembers(source, node) : [];
  if (isRecord(value) && isRecord(current) && fields.length) {
    const first = fields.findIndex((member) => Object.hasOwn(value, member.key));
    // JSON.parse keeps one of each duplicated key, so a count mismatch means
    // the source repeats a key and members cannot be matched one to one.
    if (first >= 0 && countKeys(current) === fields.length) {
      // Removed members take the separator before them; a removed run ahead
      // of the first kept member takes the one after it instead.
      if (first > 0)
        edits.push({ start: fields[0]!.start, end: fields[first]!.start, text: "" });
      for (let index = first; index < fields.length; index++) {
        const member = fields[index]!;
        if (Object.hasOwn(value, member.key)) {
          if (!jsonEqual(current[member.key], value[member.key]))
            diff(source, member.value, current[member.key], value[member.key], layout, edits);
        } else
          edits.push({ start: fields[index - 1]!.value.end, end: member.value.end, text: "" });
      }
      // A new member goes before the existing member that follows it in the
      // new order, so restoring a removed member returns it to its place;
      // otherwise it follows the last member.
      const order = Object.keys(value);
      if (order.every((key) => Object.hasOwn(current, key))) return;
      const members = new Map(fields.map((member) => [member.key, member]));
      const last = fields.at(-1)!;
      const added: Edit[] = [];
      let anchor: JsonMember | undefined;
      for (let index = order.length - 1; index >= 0; index--) {
        const key = order[index]!;
        const kept = members.get(key);
        if (kept) {
          anchor = kept;
          continue;
        }
        const indent = lineIndent(source, (anchor ?? last).start);
        const member = indent !== null
          ? `${JSON.stringify(key)}: ${format(value[key], layout, indent)}`
          : `${JSON.stringify(key)}:${JSON.stringify(value[key])}`;
        const separator = indent !== null ? `,${layout.newline}${indent}` : ",";
        added.push(anchor
          ? { start: anchor.start, end: anchor.start, text: `${member}${separator}` }
          : { start: last.value.end, end: last.value.end, text: `${separator}${member}` });
      }
      // Collected last to first; equal offsets must apply in key order.
      edits.push(...added.reverse());
      return;
    }
  }
  const items = Array.isArray(value) && Array.isArray(current) ? scanItems(source, node) : [];
  if (Array.isArray(value) && Array.isArray(current) && items.length) {
    if (value.length === items.length) {
      items.forEach((item, index) => {
        if (!jsonEqual(current[index], value[index])) diff(source, item, current[index], value[index], layout, edits);
      });
      return;
    }
    if (spliceArray(source, items, current, value, layout, edits)) return;
  }
  if (root && jsonEqual(current, value)) return;
  const indent = lineIndent(source, node.start, true) ?? "";
  edits.push({ start: node.start, end: node.end, text: layout.unit ? format(value, layout, indent) : JSON.stringify(value) });
}

/** Items added to or removed from an array whose other items are unchanged
 * and in order; false when the change is anything else. */
function spliceArray(
  source: string,
  items: JsonNode[],
  current: unknown[],
  value: unknown[],
  layout: Layout,
  edits: Edit[],
): boolean {
  if (value.length < current.length) {
    const kept = new Set<number>();
    let next = 0;
    let first = -1;
    for (const [index, item] of current.entries())
      if (next < value.length && jsonEqual(item, value[next])) {
        if (first < 0) first = index;
        kept.add(index);
        next++;
      }
    if (next !== value.length || first < 0) return false;
    if (first > 0) edits.push({ start: items[0]!.start, end: items[first]!.start, text: "" });
    for (let index = first + 1; index < items.length; index++)
      if (!kept.has(index)) edits.push({ start: items[index - 1]!.end, end: items[index]!.end, text: "" });
    return true;
  }
  const separator =
    items.length > 1
      ? source.slice(items[0]!.end, items[1]!.start)
      : lineIndent(source, items[0]!.start) !== null
        ? `,${layout.newline}${lineIndent(source, items[0]!.start)}`
        : ", ";
  const indent = lineIndent(source, items[0]!.start, true) ?? "";
  // A new item takes the layout of the one beside it: expanded over lines,
  // or on one line, spaced as that one is.
  const neighbor = source.slice(items[0]!.start, items[0]!.end);
  const text = (item: unknown) =>
    neighbor.includes("\n")
      ? format(item, { ...layout, unit: layout.unit || "  " }, indent)
      : /^[[{] /.test(neighbor)
        ? spaced(item)
        : JSON.stringify(item);
  let next = 0;
  const added: Array<{ at: number; text: string }> = [];
  for (const item of value) {
    if (next < current.length && jsonEqual(current[next], item)) {
      next++;
      continue;
    }
    added.push(
      next === 0
        ? { at: items[0]!.start, text: `${text(item)}${separator}` }
        : { at: items[next - 1]!.end, text: `${separator}${text(item)}` },
    );
  }
  if (next !== current.length) return false;
  for (const { at, text } of added) edits.push({ start: at, end: at, text });
  return true;
}

/** One line, with a space inside braces and after each separator. */
function spaced(value: unknown): string {
  if (Array.isArray(value)) return value.length ? `[${value.map(spaced).join(", ")}]` : "[]";
  if (isRecord(value)) {
    const members = Object.entries(value).map(([key, member]) => `${JSON.stringify(key)}: ${spaced(member)}`);
    return members.length ? `{ ${members.join(", ")} }` : "{}";
  }
  return JSON.stringify(value);
}

function format(value: unknown, layout: Layout, indent: string): string {
  return JSON.stringify(value, null, layout.unit).replaceAll("\n", `${layout.newline}${indent}`);
}

/** The whitespace that starts the line holding `offset`, or null when other
 * text precedes it there (unless `anyText`, which measures the line anyway). */
function lineIndent(source: string, offset: number, anyText = false): string | null {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const indent = /^[ \t]*/.exec(source.slice(lineStart, offset))![0];
  if (lineStart === 0 && !anyText) return null;
  return anyText || lineStart + indent.length === offset ? indent : null;
}

function indentUnit(source: string, tree: JsonNode): string {
  if (source.charCodeAt(tree.start) !== OPEN_BRACE) return "  ";
  const first = skipSpace(source, tree.start + 1);
  return source.charCodeAt(first) === QUOTE ? lineIndent(source, first) ?? "" : "  ";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** isDeepStrictEqual for JSON values, without its per-call cost, which
 * dominates when a diff compares every frame of a large canvas. */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || !left || !right) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index++) if (!jsonEqual(left[index], right[index])) return false;
    return true;
  }
  if (Array.isArray(right)) return false;
  let count = 0;
  for (const key in left) {
    if (!Object.hasOwn(right, key) || !jsonEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])) return false;
    count++;
  }
  return count === countKeys(right);
}

/** Own keys of a JSON.parse object, which has no inherited enumerable ones. */
function countKeys(value: object): number {
  let count = 0;
  for (const _key in value) count++;
  return count;
}

const QUOTE = 34;
const BACKSLASH = 92;
const COMMA = 44;
const COLON = 58;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const OPEN_BRACKET = 91;
const CLOSE_BRACKET = 93;
const isSpace = (code: number) => code === 32 || code === 10 || code === 13 || code === 9;

const skipSpace = (source: string, index: number) => {
  while (index < source.length && isSpace(source.charCodeAt(index))) index++;
  return index;
};

/** The offset after the string that opens at `index`. */
function skipString(source: string, index: number): number {
  for (;;) {
    const quote = source.indexOf('"', index + 1);
    if (quote < 0) throw new Error("Unterminated JSON string.");
    let slashes = 0;
    while (source.charCodeAt(quote - 1 - slashes) === BACKSLASH) slashes++;
    index = quote;
    if (slashes % 2 === 0) return quote + 1;
  }
}

/** The offset after the value that starts at `index`. Callers have already
 * parsed the source, so this only measures it. */
function skipValue(source: string, index: number): number {
  const code = source.charCodeAt(index);
  if (code === QUOTE) return skipString(source, index);
  if (code !== OPEN_BRACE && code !== OPEN_BRACKET) {
    const start = index;
    while (index < source.length) {
      const next = source.charCodeAt(index);
      if (isSpace(next) || next === COMMA || next === CLOSE_BRACKET || next === CLOSE_BRACE) break;
      index++;
    }
    if (index === start) throw new Error("Expected a JSON value.");
    return index;
  }
  let depth = 0;
  for (;;) {
    if (index >= source.length) throw new Error("Unterminated JSON container.");
    const next = source.charCodeAt(index);
    if (next === QUOTE) {
      index = skipString(source, index);
      continue;
    }
    if (next === OPEN_BRACE || next === OPEN_BRACKET) depth++;
    else if ((next === CLOSE_BRACE || next === CLOSE_BRACKET) && --depth === 0) return index + 1;
    index++;
  }
}

/** The root value: the source is already known to be JSON, so it spans the
 * text between leading and trailing whitespace. */
function scanRoot(source: string): JsonNode {
  let end = source.length;
  while (end > 0 && isSpace(source.charCodeAt(end - 1))) end--;
  return { start: skipSpace(source, 0), end };
}

/** The members of the object at `node`; only keys with an escape are decoded
 * by JSON.parse. Empty for anything that is not a non-empty object. */
function scanMembers(source: string, node: JsonNode): JsonMember[] {
  if (source.charCodeAt(node.start) !== OPEN_BRACE) return [];
  const members: JsonMember[] = [];
  let index = skipSpace(source, node.start + 1);
  while (source.charCodeAt(index) !== CLOSE_BRACE) {
    if (source.charCodeAt(index) !== QUOTE) throw new Error("Expected a JSON key.");
    const keyStart = index;
    index = skipString(source, index);
    const raw = source.slice(keyStart + 1, index - 1);
    const key = raw.includes("\\") ? (JSON.parse(source.slice(keyStart, index)) as string) : raw;
    index = skipSpace(source, index);
    if (source.charCodeAt(index) !== COLON) throw new Error("Expected a JSON colon.");
    const valueStart = skipSpace(source, index + 1);
    index = skipValue(source, valueStart);
    members.push({ key, start: keyStart, value: { start: valueStart, end: index } });
    index = skipSpace(source, index);
    if (source.charCodeAt(index) === COMMA) index = skipSpace(source, index + 1);
    else if (source.charCodeAt(index) !== CLOSE_BRACE) throw new Error("Expected a JSON comma.");
  }
  return members;
}

/** The items of the array at `node`; empty for anything else. */
function scanItems(source: string, node: JsonNode): JsonNode[] {
  if (source.charCodeAt(node.start) !== OPEN_BRACKET) return [];
  const items: JsonNode[] = [];
  let index = skipSpace(source, node.start + 1);
  while (source.charCodeAt(index) !== CLOSE_BRACKET) {
    const start = index;
    index = skipValue(source, index);
    items.push({ start, end: index });
    index = skipSpace(source, index);
    if (source.charCodeAt(index) === COMMA) index = skipSpace(source, index + 1);
    else if (source.charCodeAt(index) !== CLOSE_BRACKET) throw new Error("Expected a JSON comma.");
  }
  return items;
}
