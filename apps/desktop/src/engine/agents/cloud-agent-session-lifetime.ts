import { isDeepStrictEqual } from "node:util";
import { isCloudAgentAdmissionCode } from "@zeros/protocol/cloud-agent-execution";
import { CloudCommandFailureError, decodeCloudCommandFailure, type CloudCommandFailureCause } from "@zeros/protocol/cloud-commands";
import { isCloudAuthorizedActor, type CloudAuthorizedActor } from "./cloud-actor-authority";
import { isCloudAgentCredentialCapture, type CloudAgentCredentialCapture } from "./cloud-agent-credential-cache";
import type { CloudAgentLeaseSupervisor } from "./cloud-agent-lease";

type Domain = { stopAndProve(): Promise<void> };
const failure = (category: CloudCommandFailureCause["category"], stage: CloudCommandFailureCause["stage"] = "validation") =>
  new CloudCommandFailureError({ stage, category });
function safeCause(error: unknown, category: CloudCommandFailureCause["category"], stage: CloudCommandFailureCause["stage"] = "validation"): Error {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (typeof code === "string" && (decodeCloudCommandFailure(code) || isCloudAgentAdmissionCode(code)))
    return Object.assign(new Error("Cloud execution authority ended"), { code });
  return failure(category, stage);
}

/** Exact conversation ownership. This is a local lifetime, never a lease:
 * it neither admits, validates, renews nor releases a CP execution lease.
 * The verified actor and captured provider source have independent deadlines.
 * Socket release alone does not revoke either positive recorded authority. */
export class CloudAgentSessionLifetime {
  private readonly controller = new AbortController();
  private readonly domains = new Set<Domain>();
  private readonly stopping = new Map<Domain, Promise<void>>();
  private readonly launches = new Set<Promise<Domain>>();
  private closing: Promise<void> | null = null;
  private cause: Error | null = null;
  private retired = false;
  private released = false;
  private failures = 0;
  private escalated = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly options: {
    actor: CloudAuthorizedActor; credential: CloudAgentCredentialCapture;
    engineLive(): boolean; supervisor: CloudAgentLeaseSupervisor;
  }) {
    if (!isCloudAuthorizedActor(options.actor) || !isCloudAgentCredentialCapture(options.credential) ||
      !isDeepStrictEqual(options.actor.provenance.scope, options.credential.scope)) throw failure("access_denied");
    this.assertLive();
    options.actor.signal.addEventListener("abort", this.authorityEnded, { once: true });
    options.credential.signal.addEventListener("abort", this.authorityEnded, { once: true });
  }
  get signal(): AbortSignal { return this.controller.signal; }
  private readonly authorityEnded = (): void => {
    const error = this.options.actor.signal.aborted ? this.options.actor.signal.reason : this.options.credential.signal.reason;
    this.cause ??= safeCause(error, "access_denied");
    void this.close().catch(() => {});
  };
  assertLive(): void {
    if (this.cause) throw this.cause;
    try {
      if (this.retired || !this.options.engineLive()) throw failure("lifecycle_superseded");
      this.options.actor.assertLive("run"); this.options.credential.assertLive();
    } catch (error) {
      this.cause ??= safeCause(error, "authority_unavailable");
      void this.close().catch(() => {}); throw this.cause;
    }
  }
  /** Reserve cleanup before invoking a possibly asynchronous native launch. */
  async launch<T extends Domain>(spawn: () => Promise<T>): Promise<T> {
    this.assertLive();
    if (this.launches.size + this.domains.size >= 64) throw failure("execution_limit");
    const pending = Promise.resolve().then(() => { this.assertLive(); return spawn(); });
    this.launches.add(pending);
    try { const domain = await pending; this.attach(domain); return domain; }
    finally { this.launches.delete(pending); }
  }
  attach(domain: Domain): void {
    this.domains.add(domain);
    if (this.retired) {
      // close owns the retained domain and counts this proof failure once.
      // Start stopping immediately without counting the shared promise again.
      void this.stopDomain(domain).catch(() => {});
      void this.close().catch(() => {});
      throw this.cause ?? failure("lifecycle_superseded");
    }
    this.assertLive();
  }
  async retire(domain: Domain): Promise<void> {
    if (!this.domains.has(domain)) return;
    try { await this.stopDomain(domain); }
    catch (error) { this.cause ??= safeCause(error, "attestation_failed", "containment"); void this.close().catch(() => {}); throw this.cause; }
  }
  private async bounded(operation: Promise<unknown>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure("timeout", "containment")), 5000); timer.unref?.();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private stopDomain(domain: Domain): Promise<void> {
    const current = this.stopping.get(domain); if (current) return current;
    const stopping = this.bounded(Promise.resolve().then(() => domain.stopAndProve())).then(() => { this.domains.delete(domain); });
    this.stopping.set(domain, stopping);
    void stopping.finally(() => { if (this.stopping.get(domain) === stopping) this.stopping.delete(domain); }).catch(() => {});
    return stopping;
  }
  private queueRetirement(error: unknown): void {
    if (++this.failures >= 3) {
      if (this.retry) { clearTimeout(this.retry); this.retry = null; }
      if (!this.escalated) { this.escalated = true; this.options.supervisor.onRetirementFailure(safeCause(error, "attestation_failed", "containment")); }
      return;
    }
    if (!this.retry) {
      this.retry = setTimeout(() => { this.retry = null; void this.close().catch(() => {}); }, 1000); this.retry.unref?.();
    }
  }
  private async drain(): Promise<void> {
    while (this.launches.size || this.domains.size) {
      if (this.launches.size) await this.bounded(Promise.allSettled([...this.launches]));
      const results = await Promise.allSettled([...this.domains].map(domain => this.stopDomain(domain)));
      const rejected = results.find(result => result.status === "rejected");
      if (rejected?.status === "rejected") throw safeCause(rejected.reason, "attestation_failed", "containment");
    }
  }
  close(): Promise<void> {
    this.cause ??= failure("lifecycle_superseded"); this.retired = true;
    if (!this.controller.signal.aborted) this.controller.abort(this.cause);
    this.options.actor.signal.removeEventListener("abort", this.authorityEnded);
    this.options.credential.signal.removeEventListener("abort", this.authorityEnded);
    if (this.closing) return this.closing;
    const closing = (async () => {
      try {
        // An initially empty drain still crosses an await. A rejected late
        // attachment can register ownership before this continuation resumes;
        // recheck it before releasing material or reporting retirement.
        do { await this.drain(); } while (this.launches.size || this.domains.size);
        // Keep private material and its ownership on failed retirement.
        // Never dispose the boot cache or a sibling conversation here.
        if (!this.released) { this.options.credential.release(); this.released = true; }
        do { await this.drain(); } while (this.launches.size || this.domains.size);
        if (this.retry) { clearTimeout(this.retry); this.retry = null; }
      } catch (error) { this.queueRetirement(error); throw error; }
    })();
    this.closing = closing;
    void closing.finally(() => { if (this.closing === closing) this.closing = null; }).catch(() => {});
    return closing;
  }
  /** A selected foreground capture may govern a reused native host. Carry
   * its real closed cause into that host's abort, before draining descendants.
   * This grants no authority and never replaces an earlier retirement cause. */
  invalidate(error: unknown): Promise<void> {
    this.cause ??= safeCause(error, "access_denied");
    return this.close();
  }
}
