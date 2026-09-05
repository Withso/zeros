const MAX_AUTHORIZED_PREVIEW_FRAMES = 32;
const AUTHORIZATION_TTL_MS = 24 * 60 * 60_000;

interface PreviewFrameAuthorizationInput {
  readonly frameName?: unknown;
  readonly origin?: unknown;
  readonly expiresAt?: unknown;
}

interface CloudPreviewFrameAuthorizationInput extends PreviewFrameAuthorizationInput {
  readonly capability?: unknown;
}

interface PreviewFrameAuthorization {
  readonly origin: string;
  readonly expiresAt: number;
  readonly frameTreeNodeId: number | null;
  readonly capability: string | null;
}

const CLOUD_PREVIEW_CAPABILITY_PATTERN = /^zwp_[A-Za-z0-9_-]{43}$/;

/** Volatile main-process allowlist for injecting picker code into a signed
 * cloud preview. Grants are exact to one Browser frame and one HTTPS origin;
 * neither the provider hostname nor its bearer survives an app restart. */
export class PreviewFrameAuthorizations {
  private readonly grants = new Map<string, PreviewFrameAuthorization>();

  private purge(now: number): void {
    for (const [frameName, grant] of this.grants) {
      if (grant.expiresAt > now) continue;
      this.grants.delete(frameName);
    }
  }

  authorize(
    input: PreviewFrameAuthorizationInput,
    now = Date.now(),
    frameTreeNodeId: number | null = null,
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
          Number(input.expiresAt) > now + AUTHORIZATION_TTL_MS + 60_000)) ||
      (frameTreeNodeId !== null &&
        (!Number.isSafeInteger(frameTreeNodeId) || frameTreeNodeId < 1))
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
      if (
        !this.grants.has(input.frameName) &&
        this.grants.size >= MAX_AUTHORIZED_PREVIEW_FRAMES
      ) {
        return false;
      }
      this.grants.delete(input.frameName);
      this.grants.set(input.frameName, {
        origin: url.origin,
        expiresAt:
          input.expiresAt === undefined
            ? now + AUTHORIZATION_TTL_MS
            : Number(input.expiresAt),
        frameTreeNodeId,
        capability: null,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Install a control-plane preview bearer without ever sending it back to
   * renderer code. The capability is usable only by requests whose frame ancestry
   * contains the exact Browser iframe that requested this grant. */
  authorizeCloudPreview(
    input: CloudPreviewFrameAuthorizationInput,
    frameTreeNodeId: number,
    now = Date.now(),
  ): boolean {
    if (
      typeof input.capability !== "string" ||
      !CLOUD_PREVIEW_CAPABILITY_PATTERN.test(input.capability) ||
      !this.authorize(input, now, frameTreeNodeId)
    ) {
      return false;
    }
    const grant =
      typeof input.frameName === "string"
        ? this.grants.get(input.frameName)
        : null;
    if (!grant) return false;
    this.grants.set(input.frameName as string, {
      ...grant,
      capability: input.capability,
    });
    return true;
  }

  /** Bind a pre-navigation, capability-free authorization to the exact
   * top-level Browser iframe that starts using it. Ordinary Daytona preview
   * authorization is requested before React mounts the iframe, so the frame
   * tree id does not exist at IPC time. The trusted WebContents navigation
   * observer supplies that id before request headers are released. */
  bindPendingFrame(
    frameName: string,
    candidateUrl: string,
    frameTreeNodeId: number,
    now = Date.now(),
  ): boolean {
    if (
      !frameName.startsWith("zeros-browser-") ||
      frameName.length > 320 ||
      !Number.isSafeInteger(frameTreeNodeId) ||
      frameTreeNodeId < 1
    ) {
      return false;
    }
    this.purge(now);
    const grant = this.grants.get(frameName);
    if (!grant || grant.capability !== null) return false;
    let origin: string;
    try {
      origin = new URL(candidateUrl).origin;
    } catch {
      return false;
    }
    if (origin !== grant.origin) return false;
    if (grant.frameTreeNodeId !== null) {
      return grant.frameTreeNodeId === frameTreeNodeId;
    }
    this.grants.set(frameName, { ...grant, frameTreeNodeId });
    return true;
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

  /** Headers for an exact preview request. `frameTreeNodeIds` starts with the
   * requesting frame and includes its ancestors; an ordinary renderer fetch has
   * no authorized Browser frame in that chain and therefore receives nothing. */
  requestHeaders(
    candidateUrl: string,
    frameTreeNodeIds: readonly number[],
    now = Date.now(),
  ): Record<string, string> | null {
    this.purge(now);
    let origin: string;
    try {
      origin = new URL(candidateUrl).origin;
    } catch {
      return null;
    }
    const grant = [...this.grants.values()].find(
      (candidate) =>
        candidate.origin === origin &&
        candidate.frameTreeNodeId !== null &&
        frameTreeNodeIds.includes(candidate.frameTreeNodeId),
    );
    if (!grant) return null;
    return {
      "X-Daytona-Skip-Preview-Warning": "true",
      ...(grant.capability
        ? { "x-zeros-preview-capability": grant.capability }
        : {}),
    };
  }

  revoke(frameName: string, capability?: string): void {
    if (
      capability !== undefined &&
      this.grants.get(frameName)?.capability !== capability
    ) {
      return;
    }
    this.grants.delete(frameName);
  }

  clear(): void {
    this.grants.clear();
  }
}

export const previewFrameAuthorizations = new PreviewFrameAuthorizations();
