import { CloudActionClientRequestSchema, CloudActionReceiptSchema, type CloudAction,
  type CloudActionReceipt, type CloudActionEngineRequest } from "@zeros/protocol/cloud-actions";
import { CloudCommandRuntimeError } from "./cloud-command-client";

type Result = { outcome: "delivered" | "queued" | "interrupted"; turnId: string | null };
type Settlement = Extract<CloudActionEngineRequest, { kind: "settle" }>;
function canonical(value: unknown, budget = { nodes: 0 }, depth = 0): string {
  if (++budget.nodes > 20000 || depth > 24) throw new CloudCommandRuntimeError("invalid_command");
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, budget, depth + 1)).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new CloudCommandRuntimeError("invalid_command");
    return `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], budget, depth + 1)}`;
  }).join(",")}}`;
  return JSON.stringify(value);
}

/** Claims are durable before invoking native callbacks. Ambiguous claims are
 * never dispatched again; only known terminal receipts are retried in the background. */
export class CloudActionRuntime {
  private readonly flights = new Map<string, { key: string; promise: Promise<CloudActionReceipt> }>();
  private readonly unsettled = new Map<string, Settlement>();
  private readonly retries = new Map<string, { timer: ReturnType<typeof setTimeout>; delay: number }>();
  private closed = false;
  constructor(private readonly dependencies: {
    request(input: CloudActionEngineRequest,actorSessionId?:string): Promise<unknown>;
    validate(action: CloudAction): boolean;
    authorize(action:CloudAction,actorSessionId?:string):Promise<void>;
    dispatch(action: CloudAction): Promise<Result>;
    changed(conversationId: string): void;
  }) {}

  async handle(input: unknown,actorSessionId?:string): Promise<CloudActionReceipt> {
    if (this.closed) throw new CloudCommandRuntimeError("engine_authority_rejected");
    const parsed = CloudActionClientRequestSchema.safeParse(input);
    if (!parsed.success) throw new CloudCommandRuntimeError("invalid_command");
    const request = parsed.data;
    if (Buffer.byteLength(JSON.stringify(request)) > 192 * 1024) throw new CloudCommandRuntimeError("command_limit");
    if (request.kind === "read") {
      const pending = this.unsettled.get(request.operationId);
      if (pending) await this.settle(pending).catch(() => undefined);
      const receipt = CloudActionReceiptSchema.parse(await (actorSessionId?this.dependencies.request(request,actorSessionId):this.dependencies.request(request)));
      if (receipt.operationId !== request.operationId) throw new CloudCommandRuntimeError("command_response_invalid");
      return receipt;
    }
    const action = request.action, key = canonical({action,actorSessionId:actorSessionId??null});
    const existing = this.flights.get(action.operationId);
    if (existing) {
      if (existing.key !== key) throw new CloudCommandRuntimeError("command_conflict");
      return existing.promise;
    }
    if (this.flights.size + this.unsettled.size >= 64) throw new CloudCommandRuntimeError("command_limit");
    const promise = this.run(action,actorSessionId).finally(() => this.flights.delete(action.operationId));
    this.flights.set(action.operationId, { key, promise });
    return promise;
  }
  private async run(action: CloudAction,actorSessionId?:string): Promise<CloudActionReceipt> {
    const request={kind:"begin" as const,action,admissible:this.dependencies.validate(action)};
    const receipt = CloudActionReceiptSchema.parse(await (actorSessionId?this.dependencies.request(request,actorSessionId):this.dependencies.request(request)));
    if (receipt.operationId !== action.operationId || receipt.conversationId !== action.conversationId ||
      receipt.executionId !== action.executionId || receipt.kind !== action.kind || receipt.requestId !== action.requestId)
      throw new CloudCommandRuntimeError("command_response_invalid");
    if (receipt.state !== "dispatching") return receipt;
    const pending = this.unsettled.get(action.operationId);
    if (pending) return this.settle(pending);
    let result: Result = { outcome: "interrupted", turnId: null };
    // A begin acknowledgement may have been lost. A replay has no permission to
    // execute, even in the same process. Read the receipt instead of guessing.
    if (!receipt.replayed && !this.closed && this.dependencies.validate(action)) {
      try {
        await this.dependencies.authorize(action,actorSessionId);
        if(!this.closed&&this.dependencies.validate(action))result = await this.dependencies.dispatch(action);
      } catch { /* delivery is uncertain */ }
    }
    const settlement: Settlement = { kind: "settle", operationId: action.operationId, claimId: receipt.claimId, ...result };
    this.unsettled.set(action.operationId, settlement);
    try { return await this.settle(settlement); }
    finally { this.dependencies.changed(action.conversationId); }
  }
  private async settle(result: Settlement): Promise<CloudActionReceipt> {
    if (this.closed) throw new CloudCommandRuntimeError("engine_authority_rejected");
    try {
      const receipt = CloudActionReceiptSchema.parse(await this.dependencies.request(result));
      if (receipt.operationId !== result.operationId || receipt.claimId !== result.claimId ||
        receipt.state !== "settled" || receipt.outcome !== result.outcome || receipt.turnId !== result.turnId)
        throw new CloudCommandRuntimeError("command_response_invalid");
      this.unsettled.delete(result.operationId);
      const retry = this.retries.get(result.operationId); if (retry) clearTimeout(retry.timer);
      this.retries.delete(result.operationId);
      this.dependencies.changed(receipt.conversationId);
      return receipt;
    } catch (error) { this.retry(result); throw error; }
  }
  private retry(result: Settlement, delay = 1000): void {
    if (this.closed || this.retries.has(result.operationId)) return;
    const timer = setTimeout(() => {
      this.retries.delete(result.operationId);
      void this.settle(result).catch(() => {
        const scheduled = this.retries.get(result.operationId);
        if (scheduled) { clearTimeout(scheduled.timer); this.retries.delete(result.operationId); }
        this.retry(result, Math.min(delay * 2, 30000));
      });
    }, delay);
    timer.unref?.(); this.retries.set(result.operationId, { timer, delay });
  }
  close(): void {
    this.closed = true; for (const { timer } of this.retries.values()) clearTimeout(timer);
    this.retries.clear(); this.unsettled.clear();
  }
}
