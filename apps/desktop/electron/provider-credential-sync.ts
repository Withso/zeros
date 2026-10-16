import { randomUUID } from "node:crypto";

/** A host→engine update is complete only after the current engine has
 * installed it. The acknowledgment carries an opaque request ID, never the
 * update itself. */
export class EngineAppliedSync {
  private pending = new Map<
    string,
    { owner: object; finish: (error?: Error) => void }
  >();

  constructor(
    private readonly acknowledgmentType: string,
    private readonly timeoutMessage: string,
  ) {}

  send(owner: object, write: (requestId: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(
        () => finish(new Error(this.timeoutMessage)),
        10_000,
      );
      timer.unref?.();
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve();
      };
      this.pending.set(id, { owner, finish });
      try {
        write(id);
      } catch {
        finish(new Error("The engine connection changed. Try again."));
      }
    });
  }

  acknowledge(owner: object, value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const msg = value as Record<string, unknown>;
    if (
      msg.type !== this.acknowledgmentType ||
      typeof msg.requestId !== "string"
    )
      return false;
    const pending = this.pending.get(msg.requestId);
    if (pending?.owner === owner) pending.finish();
    return true;
  }
}

/** A connection switch is complete only after the current engine has
 * installed the new credentials. */
export class ProviderCredentialSync extends EngineAppliedSync {
  constructor() {
    super(
      "engine.providerCredentialsApplied",
      "The engine did not confirm the connection change. Refresh and try again.",
    );
  }
}
