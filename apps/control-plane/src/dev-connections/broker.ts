import { parseCodexNativeCache } from "../cloud-workspaces/codex-auth-cache.js";
import {
  renewCodexNativeAuth,
  type CodexAuthRenewer,
  type CredentialRenewer,
} from "../cloud-workspaces/codex-auth-keeper.js";
import { publishKnownCredentialRenewal } from "../cloud-workspaces/codex-auth-renewal.js";
import { DevConnectionStore, type RenewalReservation } from "./store.js";
import {
  GrantScopeSchema,
  parse,
  parseMaterial,
  reconnect,
  type Context,
  type DevMaterial,
  type GithubMaterial,
  type GrantScope,
} from "./types.js";

export type BrokerPorts = {
  codex: CodexAuthRenewer;
  github: CredentialRenewer<GithubMaterial>;
  /** Must intersect current user, installation, app and repository access. */
  githubAccess(
    material: GithubMaterial,
    scope: Exclude<GrantScope, { action: "agent" }>,
  ): Promise<void>;
};
export class DevConnectionBroker {
  constructor(
    private readonly store: DevConnectionStore,
    private readonly ports: BrokerPorts,
  ) {}
  async grant(ctx: Context, bindingId: string, value: unknown, expectedVersion?: number) {
    const scope = parse(GrantScopeSchema, value),
      reservation = await this.store.reserve(ctx, bindingId, scope, expectedVersion);
    if (reservation) {
      if (reservation.material)
        await this.renew(ctx, bindingId, scope, reservation);
      else await this.wait(reservation);
    }
    const snapshot = await this.store.snapshot(ctx, bindingId, scope);
    if (snapshot.material.kind === "github-app" && scope.action !== "agent")
      await this.ports.githubAccess(snapshot.material, scope);
    // Recheck all revision/generation fences AFTER network I/O, immediately before issuance.
    return this.store.issue(
      ctx,
      bindingId,
      scope,
      snapshot.connection.current_version,
    );
  }
  private async renew(
    ctx: Context,
    bindingId: string,
    scope: GrantScope,
    reservation: RenewalReservation,
  ) {
    const original = reservation.material!;
    let dispatched = false;
    const dispatch = async () => {
      if (dispatched) reconnect();
      await this.store.dispatch(ctx, bindingId, scope, reservation);
      dispatched = true;
    };
    try {
      let updated: DevMaterial;
      if (original.kind === "codex-chatgpt") {
        const cache = await this.ports.codex(original.nativeCache, dispatch);
        const next = parseCodexNativeCache(cache),
          old = parseCodexNativeCache(original.nativeCache);
        if (
          !next.bindingSha256.equals(old.bindingSha256) ||
          JSON.stringify(next.cache) === JSON.stringify(old.cache)
        )
          reconnect();
        updated = { kind: "codex-chatgpt", nativeCache: next.cache };
      } else if (original.kind === "github-app") {
        updated = parseMaterial(await this.ports.github(original, dispatch));
        if (
          updated.kind !== "github-app" ||
          updated.accountId !== original.accountId ||
          updated.appId !== original.appId ||
          updated.clientId !== original.clientId ||
          updated.refreshToken === original.refreshToken ||
          updated.expiresAt * 1000 <= Date.now() + 60000
        )
          reconnect();
      } else reconnect();
      if (!dispatched) reconnect();
      await publishKnownCredentialRenewal(() =>
        this.store.publish(reservation, updated),
      );
    } catch {
      // A lost COMMIT acknowledgement is read back; a lost provider response is
      // uncertain forever. Even a database outage cannot dispatch this seed again.
      let committed = false;
      try {
        committed = await this.store.settle(reservation);
      } catch {
        /* durable dispatched fence remains */
      }
      if (!committed) reconnect();
    }
  }
  private async wait(reservation: RenewalReservation) {
    const deadline = performance.now() + 6500;
    while (performance.now() < deadline) {
      const state = await this.store.renewalState(reservation);
      if (state === "published") return;
      if (!state || state === "uncertain" || state === "abandoned") reconnect();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    reconnect();
  }
}
export const nativeCodexRenewer: CodexAuthRenewer = renewCodexNativeAuth;
