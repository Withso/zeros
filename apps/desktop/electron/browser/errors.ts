// ──────────────────────────────────────────────────────────
// browser/errors — which browser failures may cross the wire
// ──────────────────────────────────────────────────────────
//
// A browser failure message travels further than it looks. The loopback service
// answers the engine, the engine hands the failure to the agent as a tool
// result, and the agent may quote it into a transcript bound for a model
// provider. So these strings are product copy with off-machine reach, not
// developer aids: "Browser work was stopped by the user." tells the agent how to
// adapt, and every message thrown as a BrowserRequestError was written knowing
// it could be read that way.
//
// Anything else reaching a response is unreviewed text. An `ENOENT ... open
// '/Users/<name>/src/...'` from a bad path, a TypeError naming an internal
// field, or a thrown non-Error stringified by String() all leak host detail that
// RULES.md §5 requires scrubbing before errors leave the machine — and none of
// them help the agent. The boundary replaces those with a fixed string.

/**
 * A failure whose message is deliberate, caller-facing product copy.
 *
 * Throw this for a condition the caller can act on: invalid input, a denied
 * confirmation, a stale ref, a stopped turn. Use a plain Error for a condition
 * that means Zeros itself is broken — the caller only learns that the request
 * failed, which is all it can do anything about.
 */
export class BrowserRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserRequestError";
  }
}

/**
 * Build a {@link BrowserRequestError}.
 *
 * Prefer this to `new BrowserRequestError(...)` at throw sites: it keeps the
 * line close to the width of the `new Error(...)` it replaced, so marking an
 * error as caller-facing does not re-wrap the code around it.
 */
export function browserError(message: string): BrowserRequestError {
  return new BrowserRequestError(message);
}

/** Sent in place of a message that was never written to be read off-machine. */
export const OPAQUE_BROWSER_ERROR_MESSAGE = "The Zeros browser request failed.";

/**
 * The caller-facing message for `error`.
 *
 * Deliberate messages pass through verbatim; everything else collapses to
 * `OPAQUE_BROWSER_ERROR_MESSAGE`. Call this at every boundary that puts failure
 * text into a response, a tool result, or a JSON-RPC error.
 */
export function browserErrorMessage(error: unknown): string {
  return error instanceof BrowserRequestError
    ? error.message
    : OPAQUE_BROWSER_ERROR_MESSAGE;
}
