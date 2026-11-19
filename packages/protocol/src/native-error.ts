// Electron invoke preserves the error name in the wrapped message but drops custom properties, so carry the code in the name.

const NAME_PREFIX = "NativeCommandError";

/** Restrict codes to identifiers accepted by the transport parser. */
const CODE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const WRAPPER_RE = /^Error invoking remote method '[^']*':\s*/;
const CODED_NAME_RE = /^NativeCommandError\(([A-Za-z][A-Za-z0-9_]{0,63})\):\s*/;
const PLAIN_NAME_RE = /^(?:[A-Z][A-Za-z0-9_$]*)?Error:\s*/;

/** Use a display-safe message; the renderer may show it verbatim. */
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
