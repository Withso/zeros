/** Retrying a timed-out bridge request must retrieve the original result,
 * never inject the same user message a second time. Receipts belong to one
 * execution and remain valid after its foreground turn finishes. */
export class SteeringReceiptCapacityError extends Error {
  constructor() {
    super("Steering receipt capacity reached");
  }
}

export class SteeringReceipts<T> {
  private readonly executions = new Map<string, Map<string, Promise<T>>>();

  has(executionId: string, messageId: string): boolean {
    return this.executions.get(executionId)?.has(messageId) ?? false;
  }

  run(
    executionId: string,
    messageId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const entries =
      this.executions.get(executionId) ?? new Map<string, Promise<T>>();
    const existing = entries.get(messageId);
    if (existing) return existing;
    // Keep every accepted identity until execution disposal. Evicting even a
    // settled receipt could turn a delayed retry into a second instruction.
    // At capacity the caller can safely keep NEW input in the normal queue.
    if (entries.size >= 256)
      return Promise.reject(new SteeringReceiptCapacityError());
    const result = Promise.resolve().then(operation);
    entries.set(messageId, result);
    this.executions.set(executionId, entries);
    return result;
  }

  delete(executionId: string): void {
    this.executions.delete(executionId);
  }
}
