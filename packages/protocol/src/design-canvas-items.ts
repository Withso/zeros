// Section titles, notes and link cards a person places on a page. They live in
// canvas.json under `pages[].items` and are canvas chrome: never part of a
// frame, its source, its exports or its captures. Every check here is a
// hand-written scan over length-capped text, so authored text costs time
// linear in its length.

/** A Local engine that writes items with design.canvas.item.put/delete. */
export const DESIGN_CANVAS_ITEMS_CAPABILITY = "design.canvas-items.v1";

export const DESIGN_CANVAS_ITEM_LIMITS = {
  itemsPerPage: 256,
  textBytesPerPage: 256 * 1024,
  coordinate: 1_000_000,
  maxSize: 16_384,
  sectionText: 120,
  noteText: 2_000,
  linkTitle: 120,
  linkTarget: 512,
} as const;

/** A section title is one line of 22px/28px text. */
export const DESIGN_CANVAS_SECTION_HEIGHT = 28;
/** A link card is its title line, its path line and their padding. */
export const DESIGN_CANVAS_LINK_HEIGHT = 56;

export interface DesignCanvasSectionItem {
  id: string;
  kind: "section";
  x: number;
  y: number;
  width: number;
  text: string;
}
export interface DesignCanvasNoteItem {
  id: string;
  kind: "note";
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}
export interface DesignCanvasLinkItem {
  id: string;
  kind: "link";
  x: number;
  y: number;
  width: number;
  /** Workspace-relative file path; it opens only in Files. */
  target: string;
  title?: string;
}
export type DesignCanvasItem =
  | DesignCanvasSectionItem
  | DesignCanvasNoteItem
  | DesignCanvasLinkItem;
/** As a page summary carries it: a link whose file is absent says so. */
export type DesignCanvasItemSummary =
  | DesignCanvasSectionItem
  | DesignCanvasNoteItem
  | (DesignCanvasLinkItem & { missing?: true });

export interface DesignCanvasItemIssue {
  /** Position in the page's items list. */
  index: number;
  id?: string;
  /** invalid and unsafe-link items are skipped; unknown kinds are kept and
   * drawn as nothing; limit marks the items past a page's caps. */
  kind: "invalid" | "unsafe-link" | "unknown" | "limit";
  message: string;
}

const FIELDS = {
  section: ["id", "kind", "x", "y", "width", "text"],
  note: ["id", "kind", "x", "y", "width", "height", "text"],
  link: ["id", "kind", "x", "y", "width", "target", "title"],
} as const satisfies Record<DesignCanvasItem["kind"], readonly string[]>;
export const DESIGN_CANVAS_ITEM_KINDS = Object.keys(FIELDS) as DesignCanvasItem["kind"][];

const plainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isKnownKind = (kind: unknown): kind is DesignCanvasItem["kind"] =>
  kind === "section" || kind === "note" || kind === "link";

/** The frame and page id pattern, `[A-Za-z][A-Za-z0-9_-]{0,127}`. */
export function isDesignCanvasItemId(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (index === 0 ? !letter : !(letter || (code >= 48 && code <= 57) || code === 95 || code === 45)) return false;
  }
  return true;
}

const isControl = (code: number) => code < 0x20 || (code >= 0x7f && code <= 0x9f);

/** Code points in text no longer than `limit`, or -1 past it. */
function boundedLength(text: string, limit: number): number {
  if (text.length > limit * 2) return -1;
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
    if (++count > limit) return -1;
  }
  return count;
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/** One line of 1..limit characters with something besides spaces. */
function lineProblem(value: unknown, limit: number, name: string): string | null {
  if (typeof value !== "string") return `${name} must be text.`;
  const length = boundedLength(value, limit);
  if (length < 0) return `${name} exceeds ${limit} characters.`;
  let visible = false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (isControl(code)) return `${name} must be one line without control characters.`;
    if (code !== 32) visible = true;
  }
  return visible ? null : `${name} cannot be empty.`;
}

function noteTextProblem(value: unknown): string | null {
  if (typeof value !== "string") return "A note's text must be text.";
  if (boundedLength(value, DESIGN_CANVAS_ITEM_LIMITS.noteText) < 0)
    return `A note's text exceeds ${DESIGN_CANVAS_ITEM_LIMITS.noteText} characters.`;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    // Line breaks and tabs are the note's own; nothing else invisible.
    if (isControl(code) && code !== 10 && code !== 9) return "A note's text must not contain control characters.";
  }
  return null;
}

const coordinateProblem = (value: unknown, name: string) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= DESIGN_CANVAS_ITEM_LIMITS.coordinate
    ? null : `${name} must be a number within ±${DESIGN_CANVAS_ITEM_LIMITS.coordinate}.`;
const sizeProblem = (value: unknown, name: string) =>
  typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= DESIGN_CANVAS_ITEM_LIMITS.maxSize
    ? null : `${name} must be a number from 1 to ${DESIGN_CANVAS_ITEM_LIMITS.maxSize}.`;

const PRIVATE_SEGMENTS = new Set([".git", ".context", ".conductor", ".zeros", "zeros-dev-env.json", ".env", ".npmrc", ".yarnrc.yml"]);
const PRIVATE_EXTENSIONS = [".crt", ".pem", ".key", ".p12", ".pfx", ".cer", ".der", ".db", ".sqlite", ".db-wal", ".db-shm"];

/** The same private paths the development servers deny (scripts/
 * dev-server-policy.mjs isPrivateDevPath): VCS, Zeros and agent state,
 * environment files, package credentials, keys and databases. */
export function isDesignCanvasPrivatePath(target: string): boolean {
  for (const part of target.split("/")) {
    const lower = part.toLowerCase();
    if (PRIVATE_SEGMENTS.has(lower) || lower.startsWith(".env.") || PRIVATE_EXTENSIONS.some((extension) => lower.endsWith(extension)))
      return true;
  }
  return false;
}

/** Why a target cannot be a link card's file, or null. A workspace-relative
 * path only: never absolute, a home path, a URL or a scheme, never through
 * `.` or `..`, and never a private file. */
export function designCanvasLinkTargetProblem(target: unknown): string | null {
  if (typeof target !== "string" || target.length === 0) return "A link card needs a file path.";
  if (target.length > DESIGN_CANVAS_ITEM_LIMITS.linkTarget)
    return `A link card's path exceeds ${DESIGN_CANVAS_ITEM_LIMITS.linkTarget} characters.`;
  const first = target.charCodeAt(0);
  if (first === 47) return "A link card's path is relative to the workspace, so it cannot start with /.";
  if (first === 126) return "A link card's path cannot start with ~.";
  let segmentStart = 0;
  let firstSlash = -1;
  for (let index = 0; index <= target.length; index++) {
    const code = index < target.length ? target.charCodeAt(index) : 47;
    if (index < target.length) {
      if (isControl(code)) return "A link card's path must not contain control characters.";
      if (code === 92) return "A link card's path uses / between folders, not \\.";
      // A colon before the first folder is a scheme or a drive: never a URL.
      if (code === 58 && firstSlash < 0) return "A link card points to a file, never a URL or another scheme.";
    }
    if (code !== 47) continue;
    if (firstSlash < 0) firstSlash = index;
    const length = index - segmentStart;
    if (length === 0) return "A link card's path has an empty folder name.";
    if (length <= 2 && target.charCodeAt(segmentStart) === 46 && (length === 1 || target.charCodeAt(segmentStart + 1) === 46))
      return "A link card's path cannot use . or .. folders.";
    segmentStart = index + 1;
  }
  return isDesignCanvasPrivatePath(target) ? "A link card cannot point to a private file." : null;
}

type Parsed =
  | { item: DesignCanvasItem }
  | { problem: string; unsafe?: true }
  | { unknown: string };

/** Validate one item's known fields. Other keys are allowed here (they are
 * kept in the file); the canvas's own writes are checked more strictly. */
function parseItem(value: unknown): Parsed {
  if (!plainObject(value)) return { problem: "An item must be an object." };
  if (!isDesignCanvasItemId(value.id)) return { problem: "An item needs an id like a frame's: a letter, then letters, digits, - or _." };
  if (!isKnownKind(value.kind))
    return typeof value.kind === "string" ? { unknown: value.kind.slice(0, 64) } : { problem: "An item needs a kind." };
  const problem = coordinateProblem(value.x, "x") ?? coordinateProblem(value.y, "y") ?? sizeProblem(value.width, "width");
  if (problem) return { problem };
  const { id, x, y, width } = value as { id: string; x: number; y: number; width: number };
  if (value.kind === "section") {
    const text = lineProblem(value.text, DESIGN_CANVAS_ITEM_LIMITS.sectionText, "A section's title");
    return text ? { problem: text } : { item: { id, kind: "section", x, y, width, text: value.text as string } };
  }
  if (value.kind === "note") {
    const issue = sizeProblem(value.height, "height") ?? noteTextProblem(value.text);
    return issue ? { problem: issue } : { item: { id, kind: "note", x, y, width, height: value.height as number, text: value.text as string } };
  }
  const target = designCanvasLinkTargetProblem(value.target);
  // A missing path is malformed; a path that leaves the workspace or names a
  // private file is unsafe.
  if (target) return typeof value.target === "string" && value.target ? { problem: target, unsafe: true } : { problem: target };
  if (value.title !== undefined) {
    const title = lineProblem(value.title, DESIGN_CANVAS_ITEM_LIMITS.linkTitle, "A link card's title");
    if (title) return { problem: title };
  }
  return { item: { id, kind: "link", x, y, width, target: value.target as string,
    ...(value.title !== undefined ? { title: value.title as string } : {}) } };
}

function itemTextBytes(item: DesignCanvasItem): number {
  return item.kind === "link" ? utf8Bytes(item.target) + utf8Bytes(item.title ?? "") : utf8Bytes(item.text);
}

/** The drawable items of one page, in order, and what was skipped. `reserved`
 * holds every frame id and the ids earlier pages took; this page's are added.
 * Never throws: an unreadable list reads as no items. */
export function readDesignCanvasPageItems(
  raw: unknown,
  reserved: Set<string>,
): { items: DesignCanvasItem[]; issues: DesignCanvasItemIssue[] } {
  if (raw === undefined) return { items: [], issues: [] };
  if (!Array.isArray(raw))
    return { items: [], issues: [{ index: 0, kind: "invalid", message: "A page's items must be a list." }] };
  const items: DesignCanvasItem[] = [];
  const issues: DesignCanvasItemIssue[] = [];
  let bytes = 0;
  let pastCap = 0;
  let firstPast = -1;
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index] as unknown;
    const id = plainObject(entry) && isDesignCanvasItemId(entry.id) ? entry.id : undefined;
    if (id !== undefined && reserved.has(id)) {
      issues.push({ index, id, kind: "invalid", message: `The id ${id} is already a frame's or another item's.` });
      continue;
    }
    // A kept entry keeps its id from later items, drawn or not.
    if (id !== undefined) reserved.add(id);
    const parsed = parseItem(entry);
    if ("unknown" in parsed) {
      issues.push({ index, ...(id ? { id } : {}), kind: "unknown", message: `Kind ${JSON.stringify(parsed.unknown)} is kept and not drawn.` });
      continue;
    }
    if ("problem" in parsed) {
      issues.push({ index, ...(id ? { id } : {}), kind: parsed.unsafe ? "unsafe-link" : "invalid", message: parsed.problem });
      continue;
    }
    const weight = itemTextBytes(parsed.item);
    if (items.length >= DESIGN_CANVAS_ITEM_LIMITS.itemsPerPage || bytes + weight > DESIGN_CANVAS_ITEM_LIMITS.textBytesPerPage) {
      if (firstPast < 0) firstPast = index;
      pastCap++;
      continue;
    }
    bytes += weight;
    items.push(parsed.item);
  }
  if (pastCap)
    issues.push({ index: firstPast, kind: "limit", message:
      `${pastCap} ${pastCap === 1 ? "item is" : "items are"} past a page's ${DESIGN_CANVAS_ITEM_LIMITS.itemsPerPage} items or ${DESIGN_CANVAS_ITEM_LIMITS.textBytesPerPage / 1024} KiB of item text, and not drawn.` });
  return { items, issues };
}

/** Why an item the canvas sends cannot be written, or null. Exactly its kind's
 * fields; the id is optional when the engine names a new item. */
export function designCanvasItemInputProblem(value: unknown): string | null {
  if (!plainObject(value)) return "An item must be an object.";
  if (!isKnownKind(value.kind)) return "An item's kind must be section, note or link.";
  const fields: readonly string[] = FIELDS[value.kind];
  for (const key of Object.keys(value)) if (!fields.includes(key)) return `A ${value.kind} has no ${JSON.stringify(key.slice(0, 64))} field.`;
  const parsed = parseItem(value.id === undefined ? { ...value, id: "pending" } : value);
  if ("item" in parsed) return null;
  return "problem" in parsed ? parsed.problem : "Unknown item kind.";
}

/** Valid as a page summary carries it, with no field beyond its kind's own
 * and, on a link card, the engine's `missing` mark. */
export function isDesignCanvasItemSummary(value: unknown): value is DesignCanvasItemSummary {
  if (!plainObject(value) || !isKnownKind(value.kind)) return false;
  const { missing, ...rest } = value;
  if (missing !== undefined && (missing !== true || value.kind !== "link")) return false;
  return isDesignCanvasItemId(rest.id) && designCanvasItemInputProblem(rest) === null;
}

/** Whether a page's summary items fit a page's caps; ids are checked by the
 * catalog, against frames and every page's items. */
export function designCanvasItemsWithinLimits(items: readonly DesignCanvasItem[]): boolean {
  if (items.length > DESIGN_CANVAS_ITEM_LIMITS.itemsPerPage) return false;
  let bytes = 0;
  for (const item of items) bytes += itemTextBytes(item);
  return bytes <= DESIGN_CANVAS_ITEM_LIMITS.textBytesPerPage;
}

/** Text the card shows as its name. */
export function designCanvasItemTitle(item: DesignCanvasItem): string {
  if (item.kind !== "link") return item.text;
  if (item.title) return item.title;
  const slash = item.target.lastIndexOf("/");
  return slash < 0 ? item.target : item.target.slice(slash + 1);
}

/** The box an item covers, for culling and hit testing. */
export function designCanvasItemBounds(item: DesignCanvasItem): { x: number; y: number; width: number; height: number } {
  const height = item.kind === "note" ? item.height : item.kind === "section" ? DESIGN_CANVAS_SECTION_HEIGHT : DESIGN_CANVAS_LINK_HEIGHT;
  return { x: item.x, y: item.y, width: item.width, height };
}
