// The rehearsal's fences: its one name prefix, the only repositories it may touch, and the only lines it may print.
import { RehearsalFailure } from "./contract.js";

/** Every resource the rehearsal names starts with this: projects, workspaces, chats, files, branches, PR titles. */
export const runPrefix = (runId: string): string => {
  if (!/^[0-9a-f]{8}/.test(runId)) throw new RehearsalFailure("run_id", "invalid");
  return `zr-${runId.slice(0, 8)}-`;
};
export const prefixed = (prefix: string, value: string): boolean => /^zr-[0-9a-f]{8}-$/.test(prefix) && value.startsWith(prefix);

/** The fixture repositories the rehearsal may use: Withso/zeros-dev-fixture and Withso/zeros-dev-fixture-*. The
 * product repository and anything else is refused by name, whatever an argument says. */
const ALLOWED = /^withso\/zeros-dev-fixture(-[a-z0-9-]{1,40})?$/;
export function assertRepository(repository: string): string {
  const name = repository.trim();
  if (!ALLOWED.test(name.toLowerCase())) throw new RehearsalFailure("repository_refused", "not_a_fixture");
  return name;
}

/** A line the rehearsal may print: words, ids, counts and closed codes. Never a URL, token, key, email or body. */
const UNSAFE = [/[a-z][a-z0-9+.-]*:\/\//i, /bearer/i, /\beyJ[A-Za-z0-9_-]{8,}/, /\bgh[pousr]_[A-Za-z0-9]{8,}/, /\bzw2[a-z]_/, /[A-Za-z0-9+/=_-]{48,}/,
  /@[a-z0-9-]+\./i, /password|secret|token=|apikey|api_key/i, /[{}"]/];
export function safeLine(line: string): string {
  if (line.length > 400 || /[\r\n]/.test(line) || UNSAFE.some(pattern => pattern.test(line))) return "line withheld (unsafe)";
  return line;
}
export const stageLine = (stage: string, result: { ok: boolean; step?: string; code?: string; skipped?: string }): string =>
  safeLine(result.skipped ? `stage ${stage}: skipped ${result.skipped}`
    : result.ok ? `stage ${stage}: ok` : `stage ${stage}: failed ${result.step ?? "step"} ${result.code ?? "failed"}`);
