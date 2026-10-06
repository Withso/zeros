import { z } from "zod";
import { CHANNELS, PromotionError, ReleaseIdentity, SHA, requireCheck } from "./contracts";
import { buildReleaseLedger, previousReleaseLedger, ReleaseLedger } from "./release-ledger";

type Read = (route: string) => Promise<any>;
export function alphaForwardOnlyMode(env: NodeJS.ProcessEnv) {
  return env.ZEROS_ALPHA_FORWARD_ONLY === "admitted" || env.ZEROS_ALPHA_FORWARD_ONLY === "enabled"
    ? env.ZEROS_ALPHA_FORWARD_ONLY : "off";
}

export const AlphaAdmissionReceipt = z.object({ version: z.literal(1), channel: z.literal("alpha"),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), branch: z.literal("main"), sourceSha: z.string().regex(SHA),
  runId: z.string().regex(/^[1-9]\d*$/), runAttempt: z.string().regex(/^[1-9]\d*$/), mode: z.enum(["admitted", "enabled"]),
}).strict();
export const alphaAdmissionArtifact = (sourceSha: string) => `alpha-admission-${sourceSha}`;

/** Compare immutable Git identities, never run IDs, timestamps or tree equality.
 * Unknown responses and request failures are errors, not benign supersession. */
export async function alphaAncestor(base: string, head: string, read: Read): Promise<boolean> {
  requireCheck(SHA.test(base) && SHA.test(head), "Alpha ancestry source is invalid");
  let value: any;
  // Changed files and patches appear only on the first compare page; page 2
  // keeps the status and merge base without exceeding the JSON size bound.
  try { value = await read(`/compare/${base}...${head}?per_page=1&page=2`); }
  catch { throw new PromotionError("Alpha ancestry comparison is unavailable; no destination mutation is authorized"); }
  requireCheck(value && ["identical", "ahead", "behind", "diverged"].includes(value.status) &&
    value.base_commit?.sha === base && typeof value.merge_base_commit?.sha === "string" && SHA.test(value.merge_base_commit.sha),
  "Alpha ancestry comparison is invalid; no destination mutation is authorized");
  if (value.status === "behind" || value.status === "diverged") return false;
  requireCheck(value.merge_base_commit.sha === base && (value.status !== "identical" || base === head),
    "Alpha ancestry comparison has an inconsistent merge base");
  return true;
}

/** Deduplicate equal source pairs only within one freshness snapshot. Later
 * checkpoints must read main and every destination again. */
export function alphaAncestry(read: Read) {
  const comparisons = new Map<string, Promise<boolean>>();
  return (base: string, head: string) => {
    const key = `${base}...${head}`;
    if (!comparisons.has(key)) comparisons.set(key, alphaAncestor(base, head, read));
    return comparisons.get(key)!;
  };
}

/** Only the initial, proven unmutated barrier may skip an unsafe or unavailable
 * live destination. Ancestry errors and downstream callers remain red. */
export class AlphaAdmissionRejectedError extends PromotionError {
  constructor(reason = "An Alpha destination is newer than or divergent from this candidate; forward-only admission refused") { super(reason); }
}

function requireDestination(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new AlphaAdmissionRejectedError(reason);
}

// Admission needs the deployed source even when cloud readiness is false.
// Retain the shared identity constraints, relaxing only readiness fields.
const AlphaFrontierIdentity = ReleaseIdentity.extend({ ready: z.boolean(),
  cloud: ReleaseIdentity.shape.cloud.extend({ ready: z.boolean(),
    state: z.enum(["healthy", "disabled", "unready", "unknown"]) }),
});

async function alphaFrontierIdentity(fetcher: typeof fetch) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("identity timeout")); }, 5_000);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetcher(`${CHANNELS.alpha.api}/v1/release-identity`, { method: "GET", credentials: "omit",
        redirect: "error", cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal });
      if (response.status !== 200 && response.status !== 503) return null;
      const text = await response.text();
      if (text.length > 64 * 1024) return null;
      const parsed = (response.status === 503 ? AlphaFrontierIdentity : ReleaseIdentity).safeParse(JSON.parse(text));
      return parsed.success && parsed.data.channel === "alpha" && parsed.data.migrations.head === parsed.data.migrations.expectedHead ? parsed.data : null;
    })(), deadline]);
  } catch { return null; } finally { clearTimeout(timer); }
}

async function alphaTagSource(read: Read) {
  const ref = await read("/git/ref/tags/alpha");
  requireDestination(ref?.ref === "refs/tags/alpha", "Alpha rolling tag identity is unavailable");
  let object = ref.object;
  const seen = new Set<string>();
  for (let depth = 0; depth <= 5; depth++) {
    requireDestination(object && typeof object.sha === "string" && SHA.test(object.sha), "Alpha rolling tag source is invalid");
    if (object.type === "commit") return object.sha as string;
    requireDestination(object.type === "tag" && depth < 5 && !seen.has(object.sha), "Alpha rolling tag does not resolve to a bounded commit identity");
    seen.add(object.sha);
    object = (await read(`/git/tags/${object.sha}`))?.object;
  }
  throw new AlphaAdmissionRejectedError("Alpha rolling tag source is unavailable");
}

export async function assertAlphaDestinations(candidate: { repository: string; sourceSha: string }, env: NodeJS.ProcessEnv,
  read: Read, ancestor: ReturnType<typeof alphaAncestry>, fetcher: typeof fetch = fetch) {
  // Load the existing bounded, schema-aware Pages reader at use time. Its
  // guard also uses githubClient; this avoids a module initialization cycle.
  const { publicPagesSource } = await import("./guard");
  const [identity, app, ops, tag, previous] = await Promise.all([
    alphaFrontierIdentity(fetcher),
    publicPagesSource(CHANNELS.alpha.app, "app", fetcher),
    publicPagesSource(CHANNELS.alpha.ops, "ops", fetcher),
    alphaTagSource(read),
    previousReleaseLedger(candidate.repository, "alpha", env.GH_TOKEN, fetcher),
  ]).catch(error => {
    if (error instanceof AlphaAdmissionRejectedError) throw error;
    throw new AlphaAdmissionRejectedError("Alpha live destination identity is unavailable; forward-only admission refused");
  });
  requireDestination(identity, "Alpha live API/schema identity is unavailable; forward-only admission refused");
  requireDestination(!identity.cloud.enabled || identity.worker,
    "Alpha active worker identity is unavailable; forward-only admission refused");
  requireDestination(app && ops, "Alpha live Pages identity is unavailable; forward-only admission refused");
  const parsed = ReleaseLedger.safeParse(previous);
  requireDestination(parsed.success && parsed.data.channel === "alpha" && parsed.data.releases.length > 0,
    "Alpha live release ledger is unavailable; forward-only admission refused");
  const entry = parsed.data.releases.at(-1)!;
  // Reuse the feed's version, duplicate and idempotency checks. Missing feeds
  // or malformed ledgers are unknown, never fabricated genesis frontiers.
  try { buildReleaseLedger("alpha", parsed.data, entry); }
  catch { throw new AlphaAdmissionRejectedError("Alpha live release ledger is invalid; forward-only admission refused"); }
  const sources = [identity.sourceSha, app, ops, tag, entry.sourceSha, ...(identity.worker ? [identity.worker.sourceSha] : [])];
  const accepted = await Promise.all(sources.map(source => ancestor(source, candidate.sourceSha)));
  if (accepted.some(value => !value)) throw new AlphaAdmissionRejectedError();
  // Feed assets precede the tag update. The same admitted parent's parallel
  // runtime publisher can observe that intermediate write; both identities
  // must still be <= X and at least one must identify this admitted X.
  requireDestination(tag === entry.sourceSha || env.GITHUB_JOB !== "ci" && (tag === candidate.sourceSha || entry.sourceSha === candidate.sourceSha),
    "Alpha rolling tag and release ledger disagree; reconcile publication before admission");
}
