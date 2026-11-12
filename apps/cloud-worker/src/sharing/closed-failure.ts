/** A closed diagnostic class for a failure (terminal spawn, client operation, activated turn), with a closed code
 * (errno name, relay refusal, validation code) when one exists. Never a path, id or value. */
export class ClosedFailure<T extends string = string> extends Error {
  constructor(readonly failure: T, readonly code?: string) { super(failure); }
}

export function closedCode(error: unknown): string | undefined {
  const value = (error as { contextCode?: unknown } | undefined)?.contextCode ?? (error as { code?: unknown } | undefined)?.code;
  return typeof value === "string" && /^(?:E[A-Z0-9]{1,15}|[a-z][a-z0-9_]{0,63})$/.test(value) ? value : undefined;
}

/** error as this class, unless it already names its own. */
export const closedFailure = <T extends string>(failure: T, error?: unknown): ClosedFailure<T> =>
  error instanceof ClosedFailure ? error as ClosedFailure<T> : new ClosedFailure(failure, closedCode(error));

export async function failingAs<T extends string, R>(failure: T, work: () => R | Promise<R>): Promise<R> {
  try { return await work(); } catch (error) { throw closedFailure(failure, error); }
}

/** One worker journal line: `<what> failed class=<class>[ code=<code>]`. */
export const failureLine = (what: string, failure: ClosedFailure): string => `${what} failed class=${failure.failure}${failure.code ? ` code=${failure.code}` : ""}`;

const CLASS = Symbol("closed-failure-class");
/** Marks an error that keeps its own user-facing message (WorkspaceError, …) with a closed class; the first mark wins. */
export function tagged<E>(error: E, failure: string): E {
  if (error && typeof error === "object" && !(CLASS in error) && !(error instanceof ClosedFailure)) Object.defineProperty(error, CLASS, { value: failure });
  return error;
}
/** The closed class an error carries (a ClosedFailure or a tagged error), with its code; undefined when none. */
export function classOf(error: unknown): ClosedFailure | undefined {
  if (error instanceof ClosedFailure) return error;
  const failure = error && typeof error === "object" ? (error as { [CLASS]?: string })[CLASS] : undefined;
  return failure ? new ClosedFailure(failure, errorCode(error)) : undefined;
}
/** A closed code, or a WorkspaceError-style program constant (VALIDATION_FAILED, session-expired); never free text. */
export function errorCode(error: unknown): string | undefined {
  const value = (error as { code?: unknown } | undefined)?.code;
  return closedCode(error) ?? (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) ? value : undefined);
}
