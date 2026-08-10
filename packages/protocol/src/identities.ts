// ──────────────────────────────────────────────────────────
// Zeros-owned identity model
// ──────────────────────────────────────────────────────────
//
// These names intentionally describe ownership and lifetime instead of using
// the overloaded word "session":
//   workspaceId    — durable Zeros workspace identity
//   conversationId — durable Zeros chat identity
//   executionId    — ephemeral Zeros runtime/routing identity
//   providerBinding — opaque durable provider resume identity
//
// Provider bindings are data, never route keys. A provider may replace or
// refine one while the Zeros conversation stays the same. Likewise an engine
// may mint a new execution for the same provider binding after restart.

export type WorkspaceId = string;
export type ConversationId = string;
export type ExecutionId = string;
export type ProviderId = string;

export type ProviderBindingKind = "native" | "legacy";

/** Versioned, provider-owned durable resume identity.
 *
 * `resumeId` is the handle the provider's resume API accepts (Codex thread id,
 * Claude SDK session id, Cursor agent id). `scopeId` is an optional wider
 * provider lineage identity; Codex uses its thread.sessionId, shared by forks.
 * `legacySessionId` is a downgrade/migration locator only. It is never a live
 * execution route, even when an older build originally minted it as one. */
export interface ProviderBinding {
  version: 1;
  providerId: ProviderId;
  kind: ProviderBindingKind;
  resumeId: string;
  scopeId?: string;
  legacySessionId?: string;
}

export interface ProviderGitMetadata {
  sha: string | null;
  branch: string | null;
  originUrl: string | null;
}

/** Descriptive provider state is deliberately separate from identity. It may
 * inform labels/reconciliation, but must never switch a checkout or route an
 * execution. */
export interface ProviderMetadata {
  version: 1;
  git?: ProviderGitMetadata;
}

export interface ConversationExecutionIdentity {
  workspaceId: WorkspaceId | null;
  conversationId: ConversationId;
  executionId: ExecutionId;
  providerBinding: ProviderBinding | null;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function coerceProviderBinding(value: unknown): ProviderBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    !nonEmpty(candidate.providerId) ||
    (candidate.kind !== "native" && candidate.kind !== "legacy") ||
    !nonEmpty(candidate.resumeId)
  ) {
    return null;
  }
  if (candidate.scopeId !== undefined && !nonEmpty(candidate.scopeId)) {
    return null;
  }
  if (
    candidate.legacySessionId !== undefined &&
    !nonEmpty(candidate.legacySessionId)
  ) {
    return null;
  }
  return {
    version: 1,
    providerId: candidate.providerId,
    kind: candidate.kind,
    resumeId: candidate.resumeId,
    ...(candidate.scopeId ? { scopeId: candidate.scopeId } : {}),
    ...(candidate.legacySessionId
      ? { legacySessionId: candidate.legacySessionId }
      : {}),
  };
}

export function parseProviderBinding(value: unknown): ProviderBinding | null {
  if (typeof value !== "string") return coerceProviderBinding(value);
  try {
    return coerceProviderBinding(JSON.parse(value));
  } catch {
    return null;
  }
}

export function coerceProviderMetadata(
  value: unknown,
): ProviderMetadata | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const record = candidate as Record<string, unknown>;
  if (record.version !== 1) return null;
  if (record.git === undefined) return { version: 1 };
  if (
    !record.git ||
    typeof record.git !== "object" ||
    Array.isArray(record.git)
  ) {
    return null;
  }
  const git = record.git as Record<string, unknown>;
  const nullable = (entry: unknown): string | null =>
    typeof entry === "string" ? entry : null;
  return {
    version: 1,
    git: {
      sha: nullable(git.sha),
      branch: nullable(git.branch),
      originUrl: nullable(git.originUrl),
    },
  };
}

export function providerBindingForResume(
  providerId: ProviderId,
  resumeId: string,
  options: { scopeId?: string; legacySessionId?: string } = {},
): ProviderBinding {
  return {
    version: 1,
    providerId,
    kind: "native",
    resumeId,
    ...(options.scopeId ? { scopeId: options.scopeId } : {}),
    ...(options.legacySessionId
      ? { legacySessionId: options.legacySessionId }
      : {}),
  };
}

/** Convert the pre-identity-model `chats.session_id` into an explicit binding.
 * Cursor's historical value was already its SDK agent id. Claude/Codex used a
 * Zeros runtime/session-directory locator, so those stay tagged `legacy` until
 * their adapter resolves a real native id. */
export function legacyProviderBinding(
  providerId: ProviderId,
  legacySessionId: string,
): ProviderBinding {
  if (providerId === "cursor") {
    return providerBindingForResume(providerId, legacySessionId);
  }
  return {
    version: 1,
    providerId,
    kind: "legacy",
    resumeId: legacySessionId,
    legacySessionId,
  };
}

export function sameProviderBinding(
  left: ProviderBinding | null | undefined,
  right: ProviderBinding | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  return (
    left.version === right.version &&
    left.providerId === right.providerId &&
    left.kind === right.kind &&
    left.resumeId === right.resumeId &&
    left.scopeId === right.scopeId &&
    left.legacySessionId === right.legacySessionId
  );
}

export function sameProviderMetadata(
  left: ProviderMetadata | null | undefined,
  right: ProviderMetadata | null | undefined,
): boolean {
  if (!left || !right) return !left && !right;
  if (!left.git || !right.git) return !left.git && !right.git;
  return (
    left.git.sha === right.git.sha &&
    left.git.branch === right.git.branch &&
    left.git.originUrl === right.git.originUrl
  );
}

/** Pure lifecycle invariant used at identity-owning boundaries and in tests.
 * Execution/provider identities may rotate; a mounted conversation cannot
 * silently become a different Zeros workspace or conversation. */
export function validateIdentityTransition(
  previous: ConversationExecutionIdentity,
  next: ConversationExecutionIdentity,
): string[] {
  const violations: string[] = [];
  if (previous.workspaceId !== next.workspaceId) {
    violations.push(
      "workspace identity changed inside one conversation lifecycle",
    );
  }
  if (previous.conversationId !== next.conversationId) {
    violations.push(
      "conversation identity changed inside one conversation lifecycle",
    );
  }
  return violations;
}
