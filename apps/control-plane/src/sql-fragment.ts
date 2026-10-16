/** Statement text for one-round-trip simple-protocol batches, which cannot
 * bind parameters. A fragment is built only from source-code template text
 * and these literal helpers, each of which accepts a closed character set
 * without quotes, backslashes, semicolons or NUL. Plain strings are rejected
 * at compile time and at run time. */
const token = Symbol("sql-fragment");
const UNSAFE = /['"\\;\0]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class SqlFragment {
  readonly text: string;
  private constructor(text: string, key: symbol) {
    if (key !== token) throw new Error("sql_fragment_forged");
    this.text = text;
  }

  /** @internal Only this module constructs fragments. */
  static create(text: string, key: symbol): SqlFragment { return new SqlFragment(text, key); }

  static integer(value: number, min: number, max: number): SqlFragment {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("sql_integer_invalid");
    // Parenthesized so that `x -${n}` can never become a `--` comment.
    return new SqlFragment(value < 0 ? `(${value})` : String(value), token);
  }

  /** A quoted text literal whose value must match `pattern` and contain no
   * quoting or statement characters. */
  static text(value: string, pattern: RegExp): SqlFragment {
    if (typeof value !== "string" || !pattern.test(value) || UNSAFE.test(value)) throw new Error("sql_literal_invalid");
    return new SqlFragment(`'${value}'`, token);
  }

  static uuid(value: string): SqlFragment {
    if (typeof value !== "string" || !UUID.test(value)) throw new Error("sql_literal_invalid");
    return new SqlFragment(`'${value}'::uuid`, token);
  }

  static boolean(value: boolean): SqlFragment {
    if (typeof value !== "boolean") throw new Error("sql_literal_invalid");
    return new SqlFragment(value ? "true" : "false", token);
  }

  static list(parts: readonly SqlFragment[]): SqlFragment {
    if (!parts.length || !parts.every(part => part instanceof SqlFragment)) throw new Error("sql_fragment_invalid");
    return new SqlFragment(parts.map(part => part.text).join(", "), token);
  }
}

/** Tagged template for fragments: every interpolation must be another
 * fragment. The tag cannot tell a hand-built frozen array from a template
 * literal, so this guards against mistakes, not against hostile code. */
export function sql(strings: TemplateStringsArray, ...values: readonly SqlFragment[]): SqlFragment {
  if (!Array.isArray(strings) || !Object.isFrozen(strings) || !Array.isArray(strings.raw) || strings.length !== values.length + 1) {
    throw new Error("sql_fragment_invalid");
  }
  let text = strings[0]!;
  values.forEach((value, index) => {
    if (!(value instanceof SqlFragment)) throw new Error("sql_fragment_invalid");
    text += value.text + strings[index + 1]!;
  });
  return SqlFragment.create(text, token);
}
