export interface CssLiteralSpan {
  start: number;
  end: number;
}

export interface CssUrlSpan extends CssLiteralSpan {
  url: string;
  functionStart: number;
  functionEnd: number;
}

interface QuotedSpan {
  end: number;
  closed: boolean;
  incompleteEscape: boolean;
}

interface CssImageSpan extends CssLiteralSpan {
  bodyStart: number;
  bodyEnd: number;
}

interface CssReferenceTokens {
  closedLiterals: CssLiteralSpan[];
  literals: CssLiteralSpan[];
  urls: CssUrlSpan[];
  images: CssImageSpan[];
  imports: CssUrlSpan[];
}

/** ECMAScript whitespace, matching the old URL trim/regex contract. */
export function isReferenceWhitespace(character: string | undefined): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 9 && code <= 13) ||
    code === 32 ||
    code === 160 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

export function referenceWhitespaceStart(source: string, start = 0): number {
  while (start < source.length && isReferenceWhitespace(source[start])) start++;
  return start;
}

export function referenceWhitespaceEnd(
  source: string,
  end = source.length,
): number {
  while (end > 0 && isReferenceWhitespace(source[end - 1])) end--;
  return end;
}

function identifierCharacter(character: string | undefined): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    character === "_" ||
    character === "-" ||
    character === "\\"
  );
}

/** Detect function suffixes with a bounded identifier tail. Literal removal is
 * handled by the lexer; escaped identifiers retain the existing strict policy. */
export function hasCssReferenceFunction(
  source: string,
  names: readonly string[],
  escaped = false,
): boolean {
  const width = Math.max(...names.map((name) => name.length));
  let tail = "",
    start = false,
    hasEscape = false,
    whitespace = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === "(") {
      if (names.some((name) => tail.endsWith(name)) || (escaped && hasEscape))
        return true;
    } else if (isReferenceWhitespace(character)) {
      whitespace = true;
      continue;
    } else if (identifierCharacter(character)) {
      if (whitespace) {
        tail = "";
        start = false;
        hasEscape = false;
      }
      const lower = character.toLowerCase();
      if (character === "\\" && start) hasEscape = true;
      if (
        (lower >= "a" && lower <= "z") ||
        character === "_" ||
        character === "-"
      )
        start = true;
      tail = (tail + lower).slice(-width);
      whitespace = false;
      continue;
    }
    tail = "";
    start = false;
    hasEscape = false;
    whitespace = false;
  }
  return false;
}

/** Each token walk advances its cursor. Cached delimiter lookahead preserves
 * malformed-value fallbacks without revisiting escaped-quote suffixes. */
export class CssReferenceLexer {
  private readonly quotes = new Map<number, QuotedSpan>();
  private readonly failedQuotes = new Map<string, number>();
  private readonly comments = new Map<number, number>();
  private readonly whitespace = new Map<number, number>();
  private failedComment = Infinity;
  private failedParen = Infinity;
  private tokens: CssReferenceTokens | undefined;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  private quote(start: number): QuotedSpan {
    const cached = this.quotes.get(start);
    if (cached) return cached;
    const quote = this.source[start]!;
    if (start >= (this.failedQuotes.get(quote) ?? Infinity))
      return {
        end: this.source.length,
        closed: false,
        incompleteEscape: this.source.endsWith("\\"),
      };
    const starts = [start];
    let cursor = start + 1,
      closed = false,
      incompleteEscape = false;
    while (cursor < this.source.length) {
      const character = this.source[cursor++]!;
      if (character === "\\") {
        if (cursor === this.source.length) {
          incompleteEscape = true;
          break;
        }
        if (this.source[cursor] === quote) starts.push(cursor);
        cursor++;
      } else if (character === quote) {
        closed = true;
        break;
      }
    }
    const result = { end: cursor, closed, incompleteEscape };
    for (const opener of starts) this.quotes.set(opener, result);
    if (!closed)
      this.failedQuotes.set(
        quote,
        Math.min(start, this.failedQuotes.get(quote) ?? Infinity),
      );
    return result;
  }

  private comment(start: number): number {
    const cached = this.comments.get(start);
    if (cached !== undefined) return cached;
    if (start >= this.failedComment) return -1;
    const close = this.source.indexOf("*/", start + 2);
    if (close < 0) this.failedComment = start;
    const end = close < 0 ? -1 : close + 2;
    this.comments.set(start, end);
    return end;
  }

  private skipWhitespace(start: number): number {
    const cached = this.whitespace.get(start);
    if (cached !== undefined) return cached;
    const end = referenceWhitespaceStart(this.source, start);
    this.whitespace.set(start, end);
    return end;
  }

  private closeParen(start: number): number {
    if (start >= this.failedParen) return -1;
    const end = this.source.indexOf(")", start);
    if (end < 0) this.failedParen = start;
    return end;
  }

  private literal(
    start: number,
  ): (CssLiteralSpan & { closed: boolean; includeUnclosed: boolean }) | null {
    if (this.source.startsWith("/*", start)) {
      const end = this.comment(start);
      return {
        start,
        end: end < 0 ? this.source.length : end,
        closed: end >= 0,
        includeUnclosed: true,
      };
    }
    if (this.source[start] !== '"' && this.source[start] !== "'") return null;
    const span = this.quote(start);
    return {
      start,
      end: span.end,
      closed: span.closed,
      includeUnclosed: !span.incompleteEscape,
    };
  }

  private url(start: number): CssUrlSpan | null {
    const close = this.closeParen(start + 4);
    if (close < 0) return null;
    const content = this.skipWhitespace(start + 4);
    const quoted = this.source[content] === '"' || this.source[content] === "'";
    let rawStart = content,
      rawEnd = referenceWhitespaceEnd(this.source, close),
      functionEnd = close + 1;
    if (quoted) {
      const span = this.quote(content);
      const end = span.closed ? this.skipWhitespace(span.end) : -1;
      if (end >= 0 && this.source[end] === ")") {
        rawStart = content + 1;
        rawEnd = span.end - 1;
        functionEnd = end + 1;
      }
    }
    const raw = this.source.slice(rawStart, rawEnd),
      url = raw.trim();
    // Keep the established fallback offsets even when a quoted URL is malformed.
    const first = content + Number(quoted) + referenceWhitespaceStart(raw);
    return {
      start: first,
      end: first + url.length,
      url,
      functionStart: start,
      functionEnd,
    };
  }

  private import(start: number): { next: number; span?: CssUrlSpan } {
    let cursor = start + 7;
    while (cursor < this.source.length) {
      cursor = this.skipWhitespace(cursor);
      if (!this.source.startsWith("/*", cursor)) break;
      const end = this.comment(cursor);
      if (end < 0) break;
      cursor = end;
    }
    const quote = this.source[cursor];
    if (quote !== '"' && quote !== "'") return { next: cursor };
    const quoted = this.quote(cursor);
    if (!quoted.closed) return { next: cursor };
    const url = this.source.slice(cursor + 1, quoted.end - 1);
    const first = this.source.indexOf(quote, start + 7) + 1;
    return {
      next: quoted.end,
      span: {
        start: first,
        end: first + url.length,
        url,
        functionStart: start,
        functionEnd: quoted.end,
      },
    };
  }

  private scan(): CssReferenceTokens {
    if (this.tokens) return this.tokens;
    const tokens: CssReferenceTokens = {
      closedLiterals: [],
      literals: [],
      urls: [],
      images: [],
      imports: [],
    };
    // Separate token heads retain the old closed-only URL fallback and EOF
    // migration literals while sharing one monotonic walk and delimiter cache.
    let closedHead = 0,
      literalHead = 0,
      urlHead = 0,
      imageHead = 0,
      importHead = 0;
    for (let cursor = 0; cursor < this.source.length; cursor++) {
      const character = this.source[cursor]!;
      const literal =
        cursor >= closedHead ||
        cursor >= literalHead ||
        cursor >= urlHead ||
        cursor >= importHead
          ? this.literal(cursor)
          : null;
      if (cursor >= closedHead) {
        closedHead = literal?.closed ? literal.end : cursor + 1;
        if (literal?.closed)
          tokens.closedLiterals.push({ start: cursor, end: literal.end });
      }
      if (cursor >= literalHead) {
        literalHead = literal?.includeUnclosed ? literal.end : cursor + 1;
        if (literal?.includeUnclosed)
          tokens.literals.push({ start: cursor, end: literal.end });
      }
      if (cursor >= urlHead) {
        urlHead = literal?.closed ? literal.end : cursor + 1;
        if (
          !literal &&
          (character === "u" || character === "U") &&
          this.source.slice(cursor, cursor + 4).toLowerCase() === "url(" &&
          !identifierCharacter(this.source[cursor - 1])
        ) {
          const span = this.url(cursor);
          if (span) {
            tokens.urls.push(span);
            urlHead = span.functionEnd;
          }
        }
      }
      if (cursor >= imageHead && (character === "i" || character === "I")) {
        const name = this.source.slice(cursor, cursor + 9).toLowerCase();
        const width =
          name === "image-set" ? 9 : name.startsWith("image") ? 5 : 0;
        const open = width ? this.skipWhitespace(cursor + width) : -1;
        if (open >= 0 && this.source[open] === "(") {
          const close = this.closeParen(open + 1);
          imageHead = close < 0 ? this.source.length : close + 1;
          if (close >= 0)
            tokens.images.push({
              start: cursor,
              end: close + 1,
              bodyStart: open + 1,
              bodyEnd: close,
            });
        }
      }
      if (cursor >= importHead) {
        importHead =
          literal && (literal.closed || character === "/")
            ? literal.end
            : cursor + 1;
        if (
          !literal &&
          character === "@" &&
          this.source.slice(cursor, cursor + 7).toLowerCase() === "@import"
        ) {
          const imported = this.import(cursor);
          importHead = imported.next;
          if (imported.span) tokens.imports.push(imported.span);
        }
      }
    }
    this.tokens = tokens;
    return tokens;
  }

  syntax(): string {
    const chunks: string[] = [];
    let cursor = 0;
    for (const literal of this.scan().closedLiterals) {
      chunks.push(this.source.slice(cursor, literal.start));
      cursor = literal.end;
    }
    chunks.push(this.source.slice(cursor));
    return chunks.join("");
  }

  literals(includeUnclosed: boolean): CssLiteralSpan[] {
    const tokens = this.scan();
    return includeUnclosed ? tokens.literals : tokens.closedLiterals;
  }

  urls(): CssUrlSpan[] {
    return this.scan().urls;
  }

  images(): CssImageSpan[] {
    return this.scan().images;
  }

  imports(): CssUrlSpan[] {
    return this.scan().imports;
  }
}
