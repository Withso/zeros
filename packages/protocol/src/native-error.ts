// Machine-readable errors across Electron's renderer↔main IPC boundary.
//
// Electron rejects `ipcRenderer.invoke` with a *new* Error whose message is
// `Error invoking remote method '<channel>': <name>: <message>`. Only `name`,
// `message`, and `stack` survive the main→renderer hop — a custom `code`
// property is dropped — and the renderer then sees the whole thing as one
// string. Two consequences, both of which shipped as bugs: user-facing toasts
// rendered the transport wrapper verbatim ("Error invoking remote method
// 'zeros:invoke': …"), and every `error.code` branch on the renderer side was
// permanently unreachable for main-process failures.
//
// `name` is the one field that survives and that we control, so a command
// error carries its code there. Main throws `NativeCommandError`; the renderer
// façade (apps/desktop/src/renderer/platform/runtime.ts) parses the wrapper back into a plain Error
// with `code` restored.

const NAME_PREFIX = "NativeCommandError";

/** Snake-case identifiers only — both vocabularies already in use qualify
 *  (`not_configured` from the App flow, `NOT_AUTHENTICATED` from GitError) and
 *  the shape keeps the parser from mistaking an ordinary class name for a code. */
const CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const WRAPPER_RE = /^Error invoking remote method '[^']*':\s*/;
const CODED_NAME_RE = /^NativeCommandError\(([A-Za-z][A-Za-z0-9_]{0,63})\):\s*/;
/** Any `FooError: ` / `Error: ` prefix `${error}` adds for an un-coded throw. */
const PLAIN_NAME_RE = /^(?:[A-Z][A-Za-z0-9_$]*)?Error:\s*/;

/** Thrown by Electron main command handlers whose failure the renderer needs to
 *  branch on. `message` must already be a sentence we are willing to show. */
export class NativeCommandError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    if (!CODE_RE.test(code)) {
      throw new Error(`Invalid NativeCommandError code: ${code}`);
    }
    this.code = code;
    this.name = `${NAME_PREFIX}(${code})`;
  }
}

export interface ParsedNativeError {
  message: string;
  code?: string;
}

/** Strip Electron's transport wrapper from a rejection message and recover the
 *  handler's own sentence plus, when the handler supplied one, its code. Safe
 *  on strings that were never wrapped — they come back unchanged. */
export function parseNativeErrorMessage(raw: string): ParsedNativeError {
  const unwrapped = raw.replace(WRAPPER_RE, "");
  const coded = CODED_NAME_RE.exec(unwrapped);
  if (coded) {
    return {
      code: coded[1],
      message: unwrapped.slice(coded[0].length).trim() || raw,
    };
  }
  const stripped = unwrapped.replace(PLAIN_NAME_RE, "").trim();
  return { message: stripped || unwrapped.trim() || raw };
}
