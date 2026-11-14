import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { HttpError } from "../../authz.js";
import { CloudTeamPresence, TEAM_PRESENCE_RENEW_MS } from "./presence.js";
import type { CloudTeamSharing } from "./store.js";
import { CloudTeamSignals, type TeamHint } from "./signals.js";
import { teamUnavailable } from "./contract.js";
import type { TeamAdmission } from "./authority.js";

const AUTHORITY_INTERVAL_MS = 60_000, TOKEN_END_MARGIN_MS = 2_000, TOKEN_END_SKEW_MS = 10_000, HEARTBEAT_MS = 60_000;

/** A reader receives only invalidations and presence. HTTP mirror reads own
 * content authorization; this channel never opens the executable bridge. */
export class CloudTeamEvents {
  readonly presence: CloudTeamPresence;
  constructor(readonly sharing: CloudTeamSharing, readonly signals: CloudTeamSignals, private readonly now = () => Date.now()) {
    this.presence = new CloudTeamPresence(sharing.authority);
  }

  async open(c: Context, workspaceId: string): Promise<Response> {
    const user = c.get("user"), pending = new Set<TeamHint>();
    let wake: (() => void) | undefined;
    const unsubscribe = this.signals.subscribe(workspaceId,hint => { pending.add(hint); wake?.(); });
    let connection: string | undefined, proof: TeamAdmission;
    try {
      await this.signals.start();
      proof = await this.sharing.authority.admit(workspaceId,user,true);
      connection = await this.presence.open(proof);
      if (!this.signals.healthy() || pending.has("gap")) throw teamUnavailable();
    } catch (error) {
      unsubscribe();
      if (connection) await this.presence.close(connection).catch(() => {});
      throw error;
    }
    const connectionId = connection;
    return streamSSE(c,async stream => {
      const controller = new AbortController(); stream.onAbort(() => controller.abort());
      const signal = AbortSignal.any([controller.signal,c.req.raw.signal]);
      const tokenEnd = user.authentication.tokenExpiresAt ? user.authentication.tokenExpiresAt*1000 : Infinity;
      let first = true, previousPresence = "", nextAuthority = this.now(), nextRenew = this.now()+TEAM_PRESENCE_RENEW_MS,
        nextHeartbeat = this.now()+HEARTBEAT_MS;
      try {
        while (!stream.aborted && !signal.aborted && this.now()<tokenEnd-TOKEN_END_MARGIN_MS) {
          if (!this.signals.healthy() || pending.has("gap")) break;
          if (pending.delete("authority")) nextAuthority = this.now();
          if (this.now()>=nextAuthority) {
            await this.sharing.authority.assert(proof);
            nextAuthority = this.now()+AUTHORITY_INTERVAL_MS;
          }
          if (this.now()>=nextRenew) { await this.presence.renew(connectionId,proof); nextRenew = this.now()+TEAM_PRESENCE_RENEW_MS; }
          if (this.now()>=tokenEnd-TOKEN_END_MARGIN_MS) break;
          if (first || pending.delete("presence") || this.now()>=nextHeartbeat) {
            const presence = await this.presence.snapshot(proof), encoded = JSON.stringify(presence);
            if (this.now()>=tokenEnd-TOKEN_END_MARGIN_MS) break;
            if (first) {
              // Ready requests a new snapshot. A hint received after sending
              // it may be newer than that snapshot, including under backpressure.
              pending.delete("changed");
              await stream.writeSSE({ event: "ready",data: JSON.stringify({ teamSharing: 1 }) });
            }
            if (encoded !== previousPresence) await stream.writeSSE({ event: "presence",data: encoded });
            previousPresence = encoded;
          }
          if (pending.delete("changed")) {
            // Idle sockets carry no data. A content hint needs a current check
            // even when a separate revocation notification was lost.
            await this.sharing.authority.assert(proof);
            if (this.now()>=tokenEnd-TOKEN_END_MARGIN_MS) break;
            await stream.writeSSE({ event: "changed",data: JSON.stringify({ workspaceId }) });
          }
          if (this.now()>=nextHeartbeat) { await stream.writeSSE({ event: "heartbeat",data: "{}" }); nextHeartbeat = this.now()+HEARTBEAT_MS; }
          first = false;
          if (pending.size) continue;
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); signal.removeEventListener("abort",done); wake = undefined; resolve(); };
            const timer = setTimeout(done,Math.max(0,Math.min(nextAuthority,nextRenew,nextHeartbeat,tokenEnd-TOKEN_END_MARGIN_MS)-this.now())); timer.unref();
            wake = done;
            if (signal.aborted || pending.size) done(); else signal.addEventListener("abort",done,{ once: true });
          });
        }
      } catch (error) {
        const tokenEnded = error instanceof HttpError && error.status === 401 && this.now()>=tokenEnd-TOKEN_END_SKEW_MS;
        if (!tokenEnded && !stream.aborted && !signal.aborted && error instanceof HttpError && [401,404,409].includes(error.status)) {
          try { await stream.writeSSE({ event: "revoked",data: JSON.stringify({ code: error.status === 401 ? "session_revoked" : "workspace_access_changed" }) }); }
          catch { /* A closed client needs no revocation frame. */ }
        }
      } finally {
        unsubscribe(); controller.abort();
        // TTL remains the fallback after a crash or failed cleanup. This
        // best-effort metadata delete cannot make sign-out fail.
        await this.presence.close(connectionId).catch(() => {});
      }
    });
  }
}
