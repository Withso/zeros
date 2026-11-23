import type { CodeReviewThreadItem } from "./review-thread-model";

/** A pull request or diff comment staged in the composer as a pill. It is
 *  saved with the draft, so it stays small and plain: the full text rides in
 *  the pill's attachment file, and `body` here only feeds the preview. */
export interface ReviewCommentReference {
  kind: "pr-comment";
  /** `<source>:<id>`, unique within one pull request. */
  key: string;
  prNumber: number;
  author: { name: string; avatarUrl: string | null; bot: boolean };
  createdAt: number;
  url: string | null;
  title: string;
  /** Line comments only. Paths are repository-relative. */
  path?: string;
  side?: "old" | "new";
  startLine?: number;
  line?: number;
  body: string;
  resolved?: boolean;
}

/** What the Overview's Comments list draws. */
export interface ReviewCommentItem {
  reference: ReviewCommentReference;
  source: "conversation" | "review" | "github" | "workspace" | "check";
  /** An agent's workspace comment names its provider's mark. */
  provider?: string;
  replies: readonly { author: string; body: string }[];
  /** The whole first comment; the reference keeps a bounded copy. */
  fullBody: string;
}

const PREVIEW_BODY_LIMIT = 20_000;
const TITLE_LIMIT = 160;

/** How much of a comment the title reads. Review apps put their summary
 *  after a few HTML markers; the rest of a long body never becomes a title. */
const TITLE_SCAN_LIMIT = 8_000;
const BLOCK_TAGS = new Set(["details", "summary", "p", "div", "br", "hr", "table", "tr", "td", "th", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** Comments and tags out, in one forward pass: block tags break lines and an
 *  image keeps its alt text. Unclosed markup stays as text. */
function readableText(body: string): string {
  const text = body.slice(0, TITLE_SCAN_LIMIT);
  let out = "";
  let at = 0;
  let unclosed = false;
  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open === -1 || unclosed) {
      out += text.slice(at);
      break;
    }
    out += text.slice(at, open);
    if (text.startsWith("<!--", open)) {
      const close = text.indexOf("-->", open + 4);
      out += "\n";
      if (close === -1) break;
      at = close + 3;
      continue;
    }
    const close = text.indexOf(">", open + 1);
    const tag = close === -1 ? "" : text.slice(open + 1, close);
    if (close === -1) unclosed = true;
    if (!/^\/?[A-Za-z]/.test(tag)) {
      out += "<";
      at = open + 1;
      continue;
    }
    const name = /^\/?([A-Za-z][A-Za-z0-9]*)/.exec(tag)![1]!.toLowerCase();
    if (BLOCK_TAGS.has(name)) out += "\n";
    else if (name === "img") out += /\balt="([^"]*)"/.exec(tag.slice(0, 1_000))?.[1] ?? "";
    at = close + 1;
  }
  return out;
}

/** `[label](url)` and `![alt](src)` become their label, in one pass: each
 *  bracket is visited once and each URL is skipped by one forward search, so
 *  unclosed brackets can't make it rescan. Nested badges (`[![a](b)](c)`)
 *  keep their inner label. */
function linkLabels(line: string): string {
  const out: string[] = [];
  const open: number[][] = [];
  let noParen = false;
  for (let at = 0; at < line.length; at++) {
    const char = line[at]!;
    if (char === "!" && line[at + 1] === "[") {
      open.push([out.length, out.length + 1]);
      out.push("!", "[");
      at++;
    } else if (char === "[") {
      open.push([out.length]);
      out.push("[");
    } else if (char === "]" && line[at + 1] === "(" && open.length && !noParen) {
      const close = line.indexOf(")", at + 2);
      if (close === -1) {
        noParen = true;
        out.push(char);
        continue;
      }
      for (const index of open.pop()!) out[index] = "";
      at = close;
    } else out.push(char);
  }
  return out.join("");
}

/** One readable line from a Markdown/HTML comment: review apps open with HTML
 *  comments, badges and headings that say nothing on their own. */
export function reviewCommentTitle(body: string): string {
  const line =
    readableText(body)
      .split("\n")
      .slice(0, 200)
      .map((value) =>
        linkLabels(value.slice(0, 2_000))
          .replace(/\*\*|__|~~/g, "")
          .replace(/^\s*(?:#+|[-*>]|\d+\.)\s+/, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find((value) => value && !/^[-=_*|: ]+$/.test(value)) ?? "";
  if (line.length <= TITLE_LIMIT) return line;
  const cut = line.slice(0, TITLE_LIMIT - 1);
  // Never leave a lone high surrogate before the ellipsis.
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

/** Whether anything is left once HTML comments are taken out, over the
 *  whole body: a long marker must not hide the text after it. */
function hasContentOutsideComments(body: string): boolean {
  let at = 0;
  while (at < body.length) {
    const open = body.indexOf("<!--", at);
    const visible = body.slice(at, open === -1 ? body.length : open);
    if (visible.trim()) return true;
    if (open === -1) return false;
    const close = body.indexOf("-->", open + 4);
    if (close === -1) return false;
    at = close + 3;
  }
  return false;
}

/** A title for a comment with content but no words: a screenshot, a table
 *  of badges, or a summary past the title's scan. A body of only HTML
 *  comments has nothing to show. */
function fallbackTitle(body: string): string | null {
  if (!hasContentOutsideComments(body)) return null;
  const head = body.slice(0, TITLE_SCAN_LIMIT).toLowerCase();
  return head.includes("<img") || head.includes("![") ? "Image" : "Comment";
}

export function reviewCommentLocation(
  reference: Pick<ReviewCommentReference, "path" | "startLine" | "line">,
  full = false,
): string | null {
  if (!reference.path || !reference.line) return null;
  const name = full ? reference.path : (reference.path.split("/").pop() ?? reference.path);
  const start = reference.startLine ?? reference.line;
  return start < reference.line
    ? `${name}:${start}–${reference.line}`
    : `${name}:${reference.line}`;
}

function bounded(body: string): string {
  return body.length > PREVIEW_BODY_LIMIT
    ? `${body.slice(0, PREVIEW_BODY_LIMIT)}\n\n…`
    : body;
}

function isBot(name: string, kind?: string): boolean {
  return kind === "bot" || kind === "integration" || /\[bot\]$/i.test(name);
}

/** Conversation comments and review bodies from the PR timeline. */
export function timelineCommentItems(
  items: readonly {
    kind: "review" | "comment";
    id: number;
    author: string;
    authorAvatarUrl: string | null;
    state: string;
    body: string;
    url: string | null;
    createdAt: number;
    optimistic?: boolean;
  }[],
  prNumber: number,
): ReviewCommentItem[] {
  return items.flatMap((item) => {
    if (item.optimistic || !item.body.trim()) return [];
    const title = reviewCommentTitle(item.body) || fallbackTitle(item.body);
    if (!title) return [];
    return [
      {
        source: item.kind === "review" ? ("review" as const) : ("conversation" as const),
        replies: [],
        fullBody: item.body,
        reference: {
          kind: "pr-comment" as const,
          key: `${item.kind}:${item.id}`,
          prNumber,
          author: {
            name: item.author.replace(/\[bot\]$/i, ""),
            avatarUrl: item.authorAvatarUrl,
            bot: isBot(item.author),
          },
          createdAt: item.createdAt,
          url: item.url,
          title,
          body: bounded(item.body),
        },
      },
    ];
  });
}

/** Line comments: GitHub threads, workspace discussions and check findings. */
export function threadCommentItems(
  threads: readonly CodeReviewThreadItem[],
  prNumber: number,
): ReviewCommentItem[] {
  return threads.flatMap((thread) => {
    const [first, ...rest] = thread.comments;
    if (!first) return [];
    const anchor = thread.anchor;
    const located = anchor.side !== "file";
    return [
      {
        source: thread.source,
        ...(first.author.provider ? { provider: first.author.provider } : {}),
        replies: rest.map((reply) => ({ author: reply.author.name, body: reply.body })),
        fullBody: first.body,
        reference: {
          kind: "pr-comment" as const,
          key: `${thread.source}:${thread.id}`,
          prNumber,
          author: {
            name: first.author.name,
            avatarUrl: first.author.avatarUrl ?? null,
            bot: thread.source !== "workspace" && isBot(first.author.name, first.author.kind),
          },
          createdAt: first.createdAt,
          url: thread.url ?? null,
          title: reviewCommentTitle(first.body) || fallbackTitle(first.body) || "Comment",
          path: anchor.path,
          ...(located
            ? {
                side: anchor.side as "old" | "new",
                startLine: anchor.startLine,
                line: anchor.endLine,
              }
            : {}),
          body: bounded(first.body),
          resolved: thread.resolved,
        },
      },
    ];
  });
}

/** Unresolved first; each group oldest first, as the conversation reads. */
export function sortReviewComments(
  items: readonly ReviewCommentItem[],
): ReviewCommentItem[] {
  return items
    .map((item, index) => [item, index] as const)
    .sort(
      ([a, ai], [b, bi]) =>
        Number(!!a.reference.resolved) - Number(!!b.reference.resolved) ||
        a.reference.createdAt - b.reference.createdAt ||
        ai - bi,
    )
    .map(([item]) => item);
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

/** The attachment file the agent reads: who, where, the comment and replies. */
export function reviewCommentDocument(item: ReviewCommentItem): string {
  const ref = item.reference;
  const where = reviewCommentLocation(ref, true);
  const lines = [
    `# PR #${ref.prNumber} comment by ${ref.author.name}${ref.author.bot ? " (bot)" : ""}`,
    "",
    ...(where
      ? [`File: \`${where}\`${ref.side === "old" ? " (removed side)" : ""}`]
      : ref.path
        ? [`File: \`${ref.path}\``]
        : []),
    ...(ref.resolved !== undefined ? [`Status: ${ref.resolved ? "resolved" : "unresolved"}`] : []),
    ...(ref.url ? [`Link: ${ref.url}`] : []),
    "",
    item.fullBody.trim(),
  ];
  if (item.replies.length) {
    lines.push("", "## Replies");
    for (const reply of item.replies)
      lines.push("", `**${reply.author}**:`, quote(reply.body.trim()));
  }
  return `${lines.join("\n")}\n`;
}

/** A short, safe attachment name: `pr42-login.ts-L18.md`, `pr42-comment-coderabbitai.md`. */
export function reviewCommentFileName(ref: ReviewCommentReference): string {
  const clean = (value: string) =>
    value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  const base = ref.path
    ? `${clean(ref.path.split("/").pop() ?? ref.path)}${ref.line ? `-L${ref.line}` : ""}`
    : `comment-${clean(ref.author.name) || "github"}`;
  return `pr${ref.prNumber}-${base || "comment"}.md`;
}

/** One composer pill per comment; staging the same comment again replaces it. */
export function reviewCommentSourceKey(
  workspaceId: string,
  ref: Pick<ReviewCommentReference, "prNumber" | "key">,
): string {
  return `pr-comment:${JSON.stringify([workspaceId, ref.prNumber, ref.key])}`;
}

/** Validate a reference read back from a saved draft before acting on it. */
export function parseReviewCommentReference(
  value: unknown,
): ReviewCommentReference | null {
  if (!value || typeof value !== "object") return null;
  const ref = value as Partial<ReviewCommentReference>;
  if (
    ref.kind !== "pr-comment" ||
    typeof ref.key !== "string" ||
    typeof ref.prNumber !== "number" ||
    typeof ref.title !== "string" ||
    typeof ref.body !== "string" ||
    !ref.author ||
    typeof ref.author.name !== "string"
  )
    return null;
  if (
    ref.path !== undefined &&
    (typeof ref.path !== "string" ||
      ref.path.startsWith("/") ||
      ref.path.split("/").some((part) => part === ".." || part === ""))
  )
    return null;
  if (
    ref.line !== undefined &&
    (!Number.isSafeInteger(ref.line) || ref.line < 1)
  )
    return null;
  if (
    ref.url != null &&
    (typeof ref.url !== "string" || !/^https:\/\//.test(ref.url))
  )
    return null;
  return ref as ReviewCommentReference;
}
