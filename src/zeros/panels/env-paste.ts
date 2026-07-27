// ──────────────────────────────────────────────────────────
// KEY=VALUE paste detection — the Add-variable dialog's bulk-import brain
// ──────────────────────────────────────────────────────────
//
// Users paste whole .env files (comments, blank lines, prose in between) into
// the dialog; only the KEY=VALUE assignments should become variables. The
// grammar mirrors dotenv so a file that works with dotenv imports the same
// way here:
//
//   • optional `export ` prefix, spaces allowed around `=`;
//   • single-, double- or backtick-quoted values may span lines (PEM keys);
//     surrounding quotes are stripped, and `\n` / `\r` escapes inside DOUBLE
//     quotes become real newlines (dotenv semantics);
//   • an unquoted value ends at `#` (inline comment) and is trimmed;
//   • a repeated NAME keeps its first position, the last value wins.
//
// KEYs are restricted to the vault's name shape ([A-Za-z_][A-Za-z0-9_]*), and
// names the vault refuses (code-injection — NODE_OPTIONS, PATH, …) are split
// out as `unsafe` so the dialog can say why they were skipped instead of
// silently dropping them.
//
// envPasteAction() is the per-field policy. The paste BOX is lenient (any
// assignment found counts); the NAME and VALUE inputs only get hijacked when
// the text is unambiguously an assignment block — a base64 value with `=`
// padding ("Zm9v=", "dGVzdA==") parses as a bare NAME with an empty/`=` value,
// so the VALUE field ignores exactly that shape and pastes it as plain text.
// ──────────────────────────────────────────────────────────

import { envVaultNameError } from "../agent/env-vault";

export interface EnvPastePair {
  key: string;
  value: string;
}

export interface EnvBlockParse {
  /** Storable assignments, in first-seen order (last value wins on repeats). */
  pairs: EnvPastePair[];
  /** NAMEs that parsed as assignments but the vault refuses to store. */
  unsafe: string[];
}

/** One assignment, anchored to a line start. Quoted alternatives come first;
 *  the unquoted fallback `[^#\n]*` lets an unbalanced quote fall through as a
 *  literal value (dotenv behavior, via backtracking). The trailing `[ \t]*`
 *  matters: without it, a quoted value followed by a plain trailing space (a
 *  routine copy artifact) would reject the quoted branch and fall back to a
 *  corrupting single-line parse. */
const ASSIGNMENT_RE =
  /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*("(?:\\"|[^"])*"|'(?:\\'|[^'])*'|`(?:\\`|[^`])*`|[^#\n]*)[ \t]*(?:#[^\n]*)?$/gm;

/** Uniform newlines + no BOM (a copied .env can carry U+FEFF, which would
 *  otherwise silently unmatch the first line's assignment). */
const normalize = (text: string): string =>
  text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");

function unquote(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if (v.length >= 2 && (q === '"' || q === "'" || q === "`") && v.endsWith(q)) {
    const inner = v.slice(1, -1);
    // dotenv expands \n / \r escapes inside double quotes only.
    return q === '"' ? inner.replace(/\\n/g, "\n").replace(/\\r/g, "\r") : inner;
  }
  return v;
}

/** Extract every KEY=VALUE assignment from arbitrary pasted text. Non-matching
 *  lines (comments, prose "in between") are simply ignored. */
export function parseEnvBlock(text: string): EnvBlockParse {
  const src = normalize(text);
  const vars = new Map<string, string>();
  const unsafe = new Set<string>();
  for (const m of src.matchAll(ASSIGNMENT_RE)) {
    const key = m[1]!;
    const value = unquote(m[2] ?? "");
    // The regex guarantees the name SHAPE, so an error here means dangerous.
    if (envVaultNameError(key)) unsafe.add(key);
    else vars.set(key, value);
  }
  return {
    pairs: [...vars.entries()].map(([key, value]) => ({ key, value })),
    unsafe: [...unsafe],
  };
}

/** True when the text is NOTHING BUT an env block: every character outside a
 *  matched assignment sits on a blank or `#`-comment line. Distinguishes "a
 *  pasted .env" from "a config value that happens to contain one x=y line". */
export function isPureEnvBlock(text: string): boolean {
  const src = normalize(text);
  let matched = false;
  let last = 0;
  const residue: string[] = [];
  for (const m of src.matchAll(ASSIGNMENT_RE)) {
    matched = true;
    residue.push(src.slice(last, m.index));
    last = m.index + m[0].length;
  }
  residue.push(src.slice(last));
  return (
    matched &&
    residue
      .join("\n")
      .split("\n")
      .every((line) => {
        const t = line.trim();
        return t === "" || t.startsWith("#");
      })
  );
}

export type EnvPasteField = "name" | "value" | "block";

export type EnvPasteAction =
  /** Not an assignment block — let the paste land as ordinary text. `unsafe`
   *  still reports refused names (e.g. the text was ONLY `NODE_OPTIONS=…`). */
  | { kind: "none"; unsafe: string[] }
  /** Exactly one assignment — populate the Name + Value fields with it. */
  | { kind: "fill"; key: string; value: string }
  /** An assignment block — switch the dialog to the parsed-variables list. */
  | { kind: "bulk"; pairs: EnvPastePair[]; unsafe: string[] };

/** What a paste into `field` should do. The block box is lenient; the name /
 *  value inputs require the text to be unambiguously an assignment (see the
 *  header comment for the base64 rationale). */
export function envPasteAction(
  text: string,
  field: EnvPasteField,
): EnvPasteAction {
  const { pairs, unsafe } = parseEnvBlock(text);
  if (pairs.length === 0) return { kind: "none", unsafe };

  const multiline = normalize(text).trim().includes("\n");
  if (pairs.length === 1 && unsafe.length === 0 && !multiline) {
    const [p] = pairs;
    // A base64 token pastes as `NAME=` / `NAME==…` — that's a value, not an
    // assignment. Only the VALUE field is exposed to this ambiguity.
    if (field === "value" && (p!.value === "" || p!.value.startsWith("=")))
      return { kind: "none", unsafe };
    return { kind: "fill", key: p!.key, value: p!.value };
  }

  // Name/Value inputs: a lone assignment buried in non-env text (YAML, INI
  // sections, prose) is NOT a block — pasting it must not hijack the fields.
  if (field !== "block" && pairs.length < 2 && !isPureEnvBlock(text))
    return { kind: "none", unsafe };
  return { kind: "bulk", pairs, unsafe };
}
