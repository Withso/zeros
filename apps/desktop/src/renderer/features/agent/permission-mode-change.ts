/** In-flight permission choices belong to one chat and one execution. A late
 * rejection cannot undo a newer choice or patch a replacement provider. */
export class PermissionModeChanges {
  private readonly pending = new Map<string, symbol>();

  begin(chatId: string, executionId: string) {
    const token = Symbol();
    this.pending.set(chatId, token);
    return {
      owns: (currentExecutionId: string | null | undefined) =>
        this.pending.get(chatId) === token && currentExecutionId === executionId,
      finish: () => {
        if (this.pending.get(chatId) === token) this.pending.delete(chatId);
      },
    };
  }
}
