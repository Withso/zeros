import { randomUUID } from "node:crypto";

export type BrowserRiskCategory =
  | "authentication"
  | "payment"
  | "publishing"
  | "destructive"
  | "external-submit"
  | "file-upload"
  | "download"
  | "browser-permission"
  | "developer-cdp"
  | "computer-control";

export type BrowserConfirmationDecision = "allow-once" | "allow-site" | "deny";
export type BrowserApprovalPolicy = "ask" | "auto-approve";

export interface BrowserConfirmationRequest {
  id: string;
  taskId: string;
  category: BrowserRiskCategory;
  /** Further isolates site grants inside a category, for example camera versus
   * notifications. It is host-generated and never trusted from page text. */
  scope?: string;
  origin: string;
  url: string;
  label: string;
  createdAt: number;
}

export type BrowserConfirmationInput = Omit<
  BrowserConfirmationRequest,
  "id" | "createdAt"
>;

interface PendingConfirmation {
  request: BrowserConfirmationRequest;
  resolve: (decision: BrowserConfirmationDecision) => void;
  timer: NodeJS.Timeout;
}

interface BrowserConfirmationBrokerOptions {
  onRequest?: (request: BrowserConfirmationRequest) => void;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4 * 60_000;
const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

/** Main-process confirmation authority for consequential browser actions.
 * Decisions are tied to an exact task, origin, and risk category. The browser
 * host—not model-supplied arguments—creates and consumes every decision. */
export class BrowserConfirmationBroker {
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly siteGrants = new Set<string>();
  private readonly onRequest?: (request: BrowserConfirmationRequest) => void;
  private readonly timeoutMs: number;
  private approvalPolicy: BrowserApprovalPolicy = "ask";

  constructor(options: BrowserConfirmationBrokerOptions = {}) {
    this.onRequest = options.onRequest;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  confirm(
    input: BrowserConfirmationInput,
  ): Promise<BrowserConfirmationDecision> {
    const normalized = normalizeInput(input);
    if (!normalized) return Promise.resolve("deny");
    if (
      this.approvalPolicy === "auto-approve" &&
      normalized.category !== "computer-control"
    ) {
      return Promise.resolve("allow-once");
    }
    if (!this.onRequest) return Promise.resolve("deny");
    if (
      this.isSiteAllowed(
        normalized.taskId,
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
      const timer = setTimeout(() => {
        this.settle(request.id, "deny");
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(request.id, { request, resolve, timer });
      this.onRequest?.(request);
    });
  }

  respond(id: string, decision: BrowserConfirmationDecision): boolean {
    if (!isDecision(decision)) return false;
    return this.settle(id, decision);
  }

  /** App-wide browser policy. Changing it settles already-visible browser
   * prompts immediately so active Codex turns do not retain stale settings.
   * Control of the visible Mac always keeps its explicit confirmation. */
  setApprovalPolicy(policy: BrowserApprovalPolicy): void {
    this.approvalPolicy = policy;
    if (policy !== "auto-approve") return;
    for (const [id, pending] of this.pending) {
      if (pending.request.category !== "computer-control") {
        this.settle(id, "allow-once");
      }
    }
  }

  isSiteAllowed(
    taskId: string,
    origin: string,
    category: BrowserRiskCategory,
    scope?: string,
  ): boolean {
    const key = grantKey(taskId, origin, category, scope);
    return key !== null && this.siteGrants.has(key);
  }

  clearSiteApprovals(taskId: string): number {
    if (!TASK_ID_PATTERN.test(taskId)) return 0;
    const prefix = `${taskId}\u0000`;
    let removed = 0;
    for (const key of this.siteGrants) {
      if (!key.startsWith(prefix)) continue;
      this.siteGrants.delete(key);
      removed += 1;
    }
    return removed;
  }

  clearTask(taskId: string): void {
    this.clearSiteApprovals(taskId);
    for (const [id, pending] of this.pending) {
      if (pending.request.taskId === taskId) this.settle(id, "deny");
    }
  }

  stop(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, "deny");
    this.siteGrants.clear();
  }

  private settle(id: string, decision: BrowserConfirmationDecision): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (decision === "allow-site") {
      const key = grantKey(
        pending.request.taskId,
        pending.request.origin,
        pending.request.category,
        pending.request.scope,
      );
      if (key) this.siteGrants.add(key);
    }
    pending.resolve(decision);
    return true;
  }
}

export function classifyBrowserClick(
  label: string,
): BrowserRiskCategory | null {
  const normalized = label.trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (!normalized) return null;
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

function normalizeInput(
  input: BrowserConfirmationInput,
): BrowserConfirmationInput | null {
  if (!TASK_ID_PATTERN.test(input.taskId)) return null;
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
  taskId: string,
  origin: string,
  category: BrowserRiskCategory,
  scope?: string,
): string | null {
  if (!TASK_ID_PATTERN.test(taskId)) return null;
  const normalizedScope = scope ? normalizeScope(scope) : "";
  if (scope && !normalizedScope) return null;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return null;
    return `${taskId}\u0000${parsed.origin}\u0000${category}\u0000${normalizedScope}`;
  } catch {
    return null;
  }
}

function normalizeScope(value: string): string {
  const scope = value.trim().toLocaleLowerCase();
  return /^[a-z0-9._:-]{1,100}$/.test(scope) ? scope : "";
}

function isDecision(value: string): value is BrowserConfirmationDecision {
  return value === "allow-once" || value === "allow-site" || value === "deny";
}
