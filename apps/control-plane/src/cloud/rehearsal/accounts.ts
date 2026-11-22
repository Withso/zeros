// Signing the rehearsal's accounts in: one at a time, spaced, a throttled step retried with backoff, and every failure
// named by its step and a closed code (subject_lookup http_404, sign_in http_400_invalid_credentials,
// sign_in_organization selection_required, me_read schema:organizations.0.slug). Never a body, email or password.
import { z } from "zod";
import { Gate0Failure } from "../gate0.js";
import { RehearsalFailure, type Api } from "./contract.js";

export type Account = { label: string; email: string; password: string; subject?: string; organizationId?: string };
export type Session = { accessToken(): Promise<string>; close(): Promise<void> };
export type SignedIn = { ok: true; label: string; subject: string; session: Session; api: Api; organizations: { id: string; slug: string | null }[];
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

/** Seconds between two accounts' sign-ins, and the waits before each retry of a throttled step. */
export const SIGN_IN_SPACING_MS = 3_000;
export const THROTTLE_BACKOFF_MS = [5_000, 15_000, 45_000] as const;

const MeSchema = z.object({ organizations: z.array(z.object({ id: z.string().uuid(), slug: z.string().nullable().optional() }).passthrough()) }).passthrough();

/** A failure as `{step, code}`: the rehearsal's and gate0's own closed classes; anything else is "unexpected". */
export function diagnose(error: unknown, step: string): { step: string; code: string } {
  if (error instanceof RehearsalFailure) return { step: error.step, code: error.code };
  if (error instanceof Gate0Failure) return { step: error.stage, code: error.cause ?? "failed" };
  return { step, code: "unexpected" };
}
const throttled = (error: unknown) => {
  const code = error instanceof RehearsalFailure ? error.code : error instanceof Gate0Failure ? error.cause ?? "" : "";
  return code.startsWith("http_429");
};

async function retrying<T>(deps: SignInDeps, work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await work(); } catch (error) {
      const wait = THROTTLE_BACKOFF_MS[attempt];
      if (!throttled(error) || wait === undefined) throw error;
      await deps.sleep(wait);
    }
  }
}

export async function signInAccount(account: Account, deps: SignInDeps): Promise<SignedIn | SignInFailure> {
  let step = "subject_lookup";
  let session: Session | undefined;
  try {
    const subject = account.subject ?? await retrying(deps, () => deps.subject(account.email));
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
    });
    return { ok: true, label: account.label, subject, session, api, selected: choice.selected,
      organizations: me.organizations.map(org => ({ id: org.id, slug: org.slug ?? null })) };
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
