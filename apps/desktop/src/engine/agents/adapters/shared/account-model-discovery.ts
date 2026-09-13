import type { AdvertisedModel } from "@zeros/protocol/agent-events";

export interface AccountModelState {
  readonly identity: string;
  models?: AdvertisedModel[];
  pending?: Promise<void>;
}

/** Sessions capture their account before boot. Only the currently selected
 * account may publish models, even when an older query finishes after a switch. */
export class AccountModelDiscovery {
  private state: AccountModelState | undefined;

  constructor(private readonly identity: () => string) {}

  current(): AccountModelState {
    const identity = this.identity();
    if (this.state?.identity !== identity) this.state = { identity };
    return this.state;
  }

  capture(identity?: string): AccountModelState {
    const current = this.current();
    return identity === undefined || current.identity === identity
      ? current
      : { identity };
  }

  discover(
    state: AccountModelState,
    read: () => Promise<AdvertisedModel[]>,
  ): Promise<void> {
    if (this.current() !== state || state.models) return Promise.resolve();
    if (state.pending) return state.pending;
    const work = Promise.resolve()
      .then(read)
      .then((models) => {
        if (models.length && this.current() === state) state.models = models;
      })
      .catch(() => {
        /* Missing discovery retains the bundled fallback. */
      })
      .finally(() => {
        state.pending = undefined;
      });
    state.pending = work;
    return work;
  }
}
