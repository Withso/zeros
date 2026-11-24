// Signing the rehearsal's accounts in: one at a time, spaced, a throttled step retried with backoff, and every failure
// named by its step and a closed code (subject_lookup http_404, sign_in http_400_invalid_credentials,
// sign_in_organization selection_required, me_read schema:organizations.0.slug). Never a body, email or password.
import { z } from "zod";
import { Gate0Failure } from "../gate0.js";
import { RehearsalFailure, type Api } from "./contract.js";

export type Account = { label: string; email: string; password: string; subject?: string; organizationId?: string };
export type Session = { accessToken(): Promise<string>; close(): Promise<void> };
export type SignedIn = { ok: true; label: string; email: string; subject: string; userId: string; session: Session; api: Api;
  organizations: { id: string; slug: string | null; personal: boolean; role: string | null }[];
  /** Which organization WorkOS's selection took: the probe's, another offered one, or none was asked. */
  selected: "probe" | "other" | "none" };
export type SignInFailure = { ok: false; label: string; step: string; code: string };

export type SignInDeps = {
  /** The WorkOS subject for an email (the Alpha WorkOS key's users read). */
  subject(email: string): Promise<string>;
  signIn(input: { email: string; password: string; subject: string; organizationId?: string; selectOrganization(offered: readonly string[]): string | undefined }): Promise<Session>;
  api(session: Session): Api;
  sleep(ms: number): Promise<void>;
  /** The probe organization's WorkOS organization id, when it has one: the one to choose when WorkOS asks. */
  probeWorkosOrganization?: string;
};

/** A transport failure's class, by closed values only, or null when it is none: `request_timeout` (one request that took
 * too long; never a wait that ran out, which is `timeout`) and `aborted` (an AbortSignal),
 * `network:<CODE>` from the error or its cause (ECONNRESET, ETIMEDOUT, ENOTFOUND, UND_ERR_SOCKET, ...), `network` for a
 * fetch failure with no code, and `json_parse` for a body that was not JSON. Never a message. */
export function transportCode(error: unknown): string | null {
  const value = error as { name?: unknown; code?: unknown; cause?: unknown } | null;
  if (!value || typeof value !== "object") return null;
  if (value.name === "TimeoutError") return "request_timeout";
  if (value.name === "AbortError") return "aborted";
  if (value.name === "SyntaxError") return "json_parse";
  const code = [value.code, (value.cause as { code?: unknown } | null)?.code].find(item => typeof item === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(item));
  if (typeof code === "string") return `network:${code}`;
  const cause = value.cause as { name?: unknown } | null;
  if (cause?.name === "TimeoutError" || cause?.name === "ConnectTimeoutError") return "request_timeout";
  return value.name === "TypeError" && cause ? "network" : null;
}

/** Seconds between two accounts' sign-ins, and the waits before each retry of a throttled step. */
export const SIGN_IN_SPACING_MS = 3_000;
export const THROTTLE_BACKOFF_MS = [5_000, 15_000, 45_000] as const;

const MeSchema = z.object({ user: z.object({ id: z.string().uuid() }).passthrough(),
  organizations: z.array(z.object({ id: z.string().uuid(), slug: z.string().nullable().optional(), isPersonal: z.boolean().optional(),
    role: z.string().nullable().optional() }).passthrough()) }).passthrough();

/** A failure as `{step, code}`: the rehearsal's and gate0's own closed classes, then a transport failure's class
 * (transportCode); anything else is "unexpected". */
export function diagnose(error: unknown, step: string): { step: string; code: string } {
  if (error instanceof RehearsalFailure) return { step: error.step, code: error.code };
  if (error instanceof Gate0Failure) return { step: error.stage, code: error.cause ?? "failed" };
  return { step, code: transportCode(error) ?? "unexpected" };
}
const throttled = (error: unknown) => {
  const code = error instanceof RehearsalFailure ? error.code : error instanceof Gate0Failure ? error.cause ?? "" : "";
  return code.startsWith("http_429");
};
/** A transport failure: one the rehearsal classified as such, or a raw one transportCode names. */
const transport = (error: unknown) => error instanceof RehearsalFailure ? /^(network|request_timeout|timeout|aborted)/.test(error.code)
  : !(error instanceof Gate0Failure) && transportCode(error) !== null && transportCode(error) !== "json_parse";

/** Retries a throttled step (429), and a read that failed in transport (a reset, a timeout), after 5, 15 and 45 s. */
async function retrying<T>(deps: SignInDeps, work: () => Promise<T>, read = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); } catch (error) {
      const wait = THROTTLE_BACKOFF_MS[attempt];
      if (!(throttled(error) || read && transport(error)) || wait === undefined) throw error;
      await deps.sleep(wait);
    }
  }
}

export async function signInAccount(account: Account, deps: SignInDeps): Promise<SignedIn | SignInFailure> {
  let step = "subject_lookup";
  let session: Session | undefined;
  try {
    const subject = account.subject ?? await retrying(deps, () => deps.subject(account.email), true);
    step = "sign_in";
    const choice: { selected: SignedIn["selected"] } = { selected: "none" };
    session = await retrying(deps, () => deps.signIn({ email: account.email, password: account.password, subject,
      ...(account.organizationId ? { organizationId: account.organizationId } : {}),
      selectOrganization: offered => {
        const probe = deps.probeWorkosOrganization && offered.includes(deps.probeWorkosOrganization) ? deps.probeWorkosOrganization : undefined;
        choice.selected = probe ? "probe" : offered.length ? "other" : "none";
        return probe ?? offered[0];
      } }));
    step = "me_read";
    const api = deps.api(session);
    const me = await retrying(deps, async () => {
      const reply = await api.json("GET", "/v1/me");
      if (reply.status !== 200) throw new RehearsalFailure("me_read", `http_${reply.status}`);
      const parsed = MeSchema.safeParse(reply.body);
      if (!parsed.success) throw new RehearsalFailure("me_read", `schema:${parsed.error.issues[0]?.path.map(String).join(".") ?? ""}`.slice(0, 80));
      return parsed.data;
    }, true);
    return { ok: true, label: account.label, email: account.email, subject, userId: me.user.id, session, api, selected: choice.selected,
      organizations: me.organizations.map(org => ({ id: org.id, slug: org.slug ?? null, personal: org.isPersonal === true, role: org.role ?? null })) };
  } catch (error) {
    await session?.close().catch(() => undefined);
    return { ok: false, label: account.label, ...diagnose(error, step) };
  }
}

/** Signs every account in, in order, spaced; each result is kept (a failure does not stop the next). */
export async function signInAll(accounts: readonly Account[], deps: SignInDeps): Promise<(SignedIn | SignInFailure)[]> {
  const results: (SignedIn | SignInFailure)[] = [];
  for (const [index, account] of accounts.entries()) {
    if (index > 0) await deps.sleep(SIGN_IN_SPACING_MS);
    results.push(await signInAccount(account, deps));
  }
  return results;
}
