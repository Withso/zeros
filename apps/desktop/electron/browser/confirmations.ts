import { randomUUID } from "node:crypto";
import {
  isBrowserProductId,
  isBrowserConfirmationDecision,
  type BrowserConfirmationDecision,
  type BrowserConfirmationRequest,
  type BrowserRiskCategory,
} from "@zeros/protocol/browser-tools";

export type {
  BrowserConfirmationDecision,
  BrowserConfirmationRequest,
  BrowserRiskCategory,
} from "@zeros/protocol/browser-tools";

export type BrowserConfirmationInput = Omit<
  BrowserConfirmationRequest,
  "id" | "createdAt"
>;

export interface BrowserClickRiskInput {
  label: string;
  tagName?: string;
  inputType?: string;
  submitsForm?: boolean;
}

interface PendingConfirmation {
  request: BrowserConfirmationRequest;
  resolve: (decision: BrowserConfirmationDecision) => void;
  timer: NodeJS.Timeout;
}

interface BrowserConfirmationBrokerOptions {
  onRequest?: (request: BrowserConfirmationRequest) => void;
  onSettled?: (confirmationId: string) => void;
  timeoutMs?: number;
  maxPending?: number;
}

const DEFAULT_TIMEOUT_MS = 4 * 60_000;
const DEFAULT_MAX_PENDING = 16;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** Main-process authority for consequential browser effects. There is no
 * global auto-approve mode. Site-persistent grants are restricted to a
 * host-generated browser permission scope; payments, auth, publishing,
 * destructive actions, form submissions, files, and downloads always require
 * a fresh user decision. */
export class BrowserConfirmationBroker {
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly siteGrants = new Set<string>();
  private readonly onRequest?: (request: BrowserConfirmationRequest) => void;
  private readonly onSettled?: (confirmationId: string) => void;
  private readonly timeoutMs: number;
  private readonly maxPending: number;

  constructor(options: BrowserConfirmationBrokerOptions = {}) {
    this.onRequest = options.onRequest;
    this.onSettled = options.onSettled;
    this.timeoutMs = boundedPositiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "confirmation timeout",
    );
    this.maxPending = boundedPositiveInteger(
      options.maxPending ?? DEFAULT_MAX_PENDING,
      "pending confirmation limit",
    );
  }

  confirm(
    input: BrowserConfirmationInput,
  ): Promise<BrowserConfirmationDecision> {
    const normalized = normalizeInput(input);
    if (
      !normalized ||
      !this.onRequest ||
      this.pending.size >= this.maxPending
    ) {
      return Promise.resolve("deny");
    }
    if (
      this.isSiteAllowed(
        normalized.browserSessionId,
        normalized.origin,
        normalized.category,
        normalized.scope,
      )
    ) {
      return Promise.resolve("allow-site");
    }

    const request: BrowserConfirmationRequest = {
      ...normalized,
      id: randomUUID(),
      createdAt: Date.now(),
    };
    return new Promise<BrowserConfirmationDecision>((resolve) => {
      const timer = setTimeout(
        () => this.settle(request.id, "deny"),
        this.timeoutMs,
      );
      timer.unref?.();
      this.pending.set(request.id, { request, resolve, timer });
      try {
        this.onRequest?.(request);
      } catch {
        // Delivery is advisory; authorization remains main-owned. If the
        // trusted event channel breaks synchronously, deny and remove the
        // request instead of leaving its host action parked until timeout.
        this.settle(request.id, "deny");
      }
    });
  }

  respond(id: string, decision: BrowserConfirmationDecision): boolean {
    if (!isBrowserConfirmationDecision(decision)) return false;
    return this.settle(id, decision);
  }

  /** Read-only recovery snapshot for a trusted renderer that subscribed after
   * a request was emitted. Requests remain main-owned and can only be settled
   * through `respond`; returning a fresh array prevents renderer-side mutation
   * from changing authorization state. */
  pendingRequests(): BrowserConfirmationRequest[] {
    return [...this.pending.values()].map((pending) => pending.request);
  }

  isSiteAllowed(
    browserSessionId: string,
    origin: string,
    category: BrowserRiskCategory,
    scope?: string,
  ): boolean {
    const key = grantKey(browserSessionId, origin, category, scope);
    return key !== null && this.siteGrants.has(key);
  }

  clearSiteApprovals(browserSessionId: string): number {
    if (!SESSION_ID_PATTERN.test(browserSessionId)) return 0;
    const prefix = `${browserSessionId}\u0000`;
    let removed = 0;
    for (const key of this.siteGrants) {
      if (!key.startsWith(prefix)) continue;
      this.siteGrants.delete(key);
      removed += 1;
    }
    return removed;
  }

  clearAllSiteApprovals(): number {
    const count = this.siteGrants.size;
    this.siteGrants.clear();
    return count;
  }

  clearSession(browserSessionId: string): void {
    this.clearSiteApprovals(browserSessionId);
    for (const [id, pending] of this.pending) {
      if (pending.request.browserSessionId === browserSessionId) {
        this.settle(id, "deny");
      }
    }
  }

  denyPending(): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.settle(id, "deny");
    return ids.length;
  }

  revokeConfirmationSurface(): number {
    const denied = this.denyPending();
    this.clearAllSiteApprovals();
    return denied;
  }

  stop(): void {
    this.revokeConfirmationSurface();
  }

  private settle(id: string, decision: BrowserConfirmationDecision): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (decision === "allow-site" && canPersistSiteGrant(pending.request)) {
      const key = grantKey(
        pending.request.browserSessionId,
        pending.request.origin,
        pending.request.category,
        pending.request.scope,
      );
      if (key) this.siteGrants.add(key);
    }
    try {
      this.onSettled?.(id);
    } catch {
      // The authorization has already settled. A renderer tombstone is only
      // cache invalidation and must never roll back or reject that decision.
    }
    // A disallowed persistent decision still authorizes this exact action once.
    pending.resolve(decision === "allow-site" ? "allow-once" : decision);
    return true;
  }
}

export function classifyBrowserClick(
  input: BrowserClickRiskInput | string,
): BrowserRiskCategory | null {
  const detail = typeof input === "string" ? { label: input } : input;
  const normalized = detail.label
    .trim()
    .toLocaleLowerCase()
    .replace(/\s+/g, " ");
  if (
    /\b(sign[ -]?in|log[ -]?in|sign[ -]?up|create account|continue with|authorize|authenticate|connect account)\b/.test(
      normalized,
    )
  ) {
    return "authentication";
  }
  if (
    /\b(pay|purchase|buy|checkout|place order|confirm order|transfer|subscribe)\b/.test(
      normalized,
    )
  ) {
    return "payment";
  }
  if (/\b(publish|deploy|post publicly|make public)\b/.test(normalized)) {
    return "publishing";
  }
  if (/\b(delete|remove|erase|destroy|revoke|disconnect)\b/.test(normalized)) {
    return "destructive";
  }
  if (/\b(submit|send message|send email|send form)\b/.test(normalized)) {
    return "external-submit";
  }
  // Visible text is evidence, not the security boundary. Any structural form
  // submit pauses even when its label is an icon, "Continue", or localized.
  if (
    detail.submitsForm ||
    detail.inputType?.toLocaleLowerCase() === "submit"
  ) {
    return "external-submit";
  }
  return null;
}

export function classifyBrowserInput(
  inputType: string,
): BrowserRiskCategory | null {
  const normalized = inputType.trim().toLocaleLowerCase();
  if (normalized === "password") return "authentication";
  if (normalized === "file") return "file-upload";
  return null;
}

function canPersistSiteGrant(request: BrowserConfirmationRequest): boolean {
  return (
    (request.category === "browser-permission" ||
      request.category === "navigation") &&
    Boolean(request.scope)
  );
}

function normalizeInput(
  input: BrowserConfirmationInput,
): BrowserConfirmationInput | null {
  if (
    !SESSION_ID_PATTERN.test(input.browserSessionId) ||
    !isBrowserProductId(input.workspaceId) ||
    !isBrowserProductId(input.conversationId)
  )
    return null;
  const scope = input.scope ? normalizeScope(input.scope) : undefined;
  if (input.scope && !scope) return null;
  let origin: string;
  let url: string;
  try {
    const parsedOrigin = new URL(input.origin);
    const parsedUrl = new URL(input.url);
    if (
      (parsedOrigin.protocol !== "http:" &&
        parsedOrigin.protocol !== "https:") ||
      (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
      parsedOrigin.username ||
      parsedOrigin.password ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedOrigin.origin !== parsedUrl.origin
    ) {
      return null;
    }
    origin = parsedOrigin.origin;
    url = parsedUrl.href;
  } catch {
    return null;
  }
  return {
    ...input,
    origin,
    url,
    label: input.label.trim().replace(/\s+/g, " ").slice(0, 300),
    ...(scope ? { scope } : {}),
  };
}

function grantKey(
  browserSessionId: string,
  origin: string,
  category: BrowserRiskCategory,
  scope?: string,
): string | null {
  if (!SESSION_ID_PATTERN.test(browserSessionId)) return null;
  if (category !== "browser-permission" && category !== "navigation")
    return null;
  const normalizedScope = scope ? normalizeScope(scope) : "";
  if (!normalizedScope) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return `${browserSessionId}\u0000${parsed.origin}\u0000${category}\u0000${normalizedScope}`;
  } catch {
    return null;
  }
}

function normalizeScope(value: string): string {
  const scope = value.trim().toLocaleLowerCase();
  return /^[a-z0-9._:-]{1,100}$/.test(scope) ? scope : "";
}

function boundedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Browser ${label} is invalid.`);
  }
  return value;
}
