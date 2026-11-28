/** Chat-owned follow-ups. Stop pauses dispatch without changing payloads or
 * order. An explicit send resumes it; editing and delivery callbacks do not. */
export class SendQueue<T extends { bubbleId: string }> extends Map<
  string,
  T[]
> {
  private readonly paused = new Set<string>();
  private readonly sending = new Map<string, Set<string>>();
  /** Called after a chat's entries or in-flight claims change, so a durable
   * copy can follow the queue without every caller remembering to save. */
  onChange?: (chatId: string) => void;

  override set(chatId: string, entries: T[]): this {
    super.set(chatId, entries);
    this.onChange?.(chatId);
    return this;
  }

  pause(chatId: string): void {
    this.paused.add(chatId);
  }
  resume(chatId: string): boolean {
    return this.paused.delete(chatId);
  }
  isPaused(chatId: string): boolean {
    return this.paused.has(chatId);
  }
  isSending(chatId: string, messageId?: string): boolean {
    const ids = this.sending.get(chatId);
    return messageId ? ids?.has(messageId) === true : !!ids?.size;
  }
  canDrain(chatId: string): boolean {
    return !this.isPaused(chatId) && !this.isSending(chatId);
  }
  claim(chatId: string, messageId: string): boolean {
    if (this.isSending(chatId, messageId)) return false;
    const ids = this.sending.get(chatId) ?? new Set<string>();
    ids.add(messageId);
    this.sending.set(chatId, ids);
    this.onChange?.(chatId);
    return true;
  }
  release(chatId: string, messageId: string): void {
    const ids = this.sending.get(chatId);
    ids?.delete(messageId);
    if (!ids?.size) this.sending.delete(chatId);
    this.onChange?.(chatId);
  }
  prioritize(chatId: string, messageId: string): void {
    const entries = this.get(chatId);
    const entry = entries?.find((item) => item.bubbleId === messageId);
    if (entries && entry)
      this.set(chatId, [entry, ...entries.filter((item) => item !== entry)]);
  }
  override delete(chatId: string): boolean {
    this.paused.delete(chatId);
    this.sending.delete(chatId);
    const deleted = super.delete(chatId);
    if (deleted) this.onChange?.(chatId);
    return deleted;
  }
  override clear(): void {
    const chats = [...this.keys()];
    this.paused.clear();
    this.sending.clear();
    super.clear();
    for (const chatId of chats) this.onChange?.(chatId);
  }
}
