const MAX_AUTHORIZED_PREVIEW_FRAMES = 32;
const AUTHORIZATION_TTL_MS = 24 * 60 * 60_000;

interface PreviewFrameAuthorizationInput {
  readonly frameName?: unknown;
  readonly origin?: unknown;
  readonly expiresAt?: unknown;
}

/** Volatile main-process allowlist for injecting picker code into a signed
 * cloud preview. Grants are exact to one Browser frame and one HTTPS origin;
 * neither the provider hostname nor its bearer survives an app restart. */
export class PreviewFrameAuthorizations {
  private readonly grants = new Map<
    string,
    { readonly origin: string; readonly expiresAt: number }
  >();

  private purge(now: number): void {
    for (const [frameName, grant] of this.grants) {
      if (grant.expiresAt > now) continue;
      this.grants.delete(frameName);
    }
  }

  authorize(
    input: PreviewFrameAuthorizationInput,
    now = Date.now(),
  ): boolean {
    if (
      typeof input.frameName !== "string" ||
      !input.frameName.startsWith("zeros-browser-") ||
      input.frameName.length > 320 ||
      typeof input.origin !== "string" ||
      input.origin.length > 2_048 ||
      !Number.isSafeInteger(now) ||
      now <= 0 ||
      (input.expiresAt !== undefined &&
        (!Number.isSafeInteger(input.expiresAt) ||
          Number(input.expiresAt) <= now ||
          Number(input.expiresAt) > now + AUTHORIZATION_TTL_MS + 60_000))
    ) {
      return false;
    }
    try {
      const url = new URL(input.origin);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.origin !== input.origin
      ) {
        return false;
      }
      this.purge(now);
      this.grants.delete(input.frameName);
      this.grants.set(input.frameName, {
        origin: url.origin,
        expiresAt:
          input.expiresAt === undefined
            ? now + AUTHORIZATION_TTL_MS
            : Number(input.expiresAt),
      });
      while (this.grants.size > MAX_AUTHORIZED_PREVIEW_FRAMES) {
        const oldest = this.grants.keys().next().value as string | undefined;
        if (!oldest) break;
        this.grants.delete(oldest);
      }
      return true;
    } catch {
      return false;
    }
  }

  allows(frameName: string, candidateUrl: string, now = Date.now()): boolean {
    this.purge(now);
    const grant = this.grants.get(frameName);
    if (!grant) return false;
    try {
      return new URL(candidateUrl).origin === grant.origin;
    } catch {
      return false;
    }
  }

  allowsOrigin(candidateUrl: string, now = Date.now()): boolean {
    this.purge(now);
    try {
      const origin = new URL(candidateUrl).origin;
      return [...this.grants.values()].some((grant) => grant.origin === origin);
    } catch {
      return false;
    }
  }

  revoke(frameName: string): void {
    this.grants.delete(frameName);
  }

  clear(): void {
    this.grants.clear();
  }
}

export const previewFrameAuthorizations = new PreviewFrameAuthorizations();
