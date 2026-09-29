import { CLOUD_GITHUB_DESKTOP_REQUIRED, type CloudGithubNativeSource } from "@zeros/protocol/github-auth";
import type { TransportClient } from "../transport/types";
const eligible = (client: TransportClient) => client.kind === "cloud" && client.authorized?.() === true &&
  !!client.accountUserId && !!client.cloudActor && ["developer", "manager", "owner"].includes(client.cloudActor.role);

/** A shell survives transport disconnects. Its Git authority survives only as
 * an empty route: each operation requires a current admission of its creator.
 * Once another member types, existing processes cannot be attributed safely. */
export class NativeGithubTerminals {
  private readonly terminals = new Map<string, {
    actorUserId: string | null; clients: TransportClient[]; shared: boolean; invalidate(): void;
  }>();
  create(id: string, client: TransportClient) {
    this.terminals.get(id)?.invalidate();
    // Opening a shell does not acquire Git authority. An unidentified creator
    // gets a usable terminal whose Git requests fail closed when invoked.
    const record = { actorUserId: client.accountUserId ?? null, clients: [client], shared: false, invalidate: () => {} };
    this.terminals.set(id, record);
    return {
      source: (): CloudGithubNativeSource => {
        if (record.shared) throw new Error("Open a new terminal to authorize GitHub for your account.");
        const current = [...record.clients].reverse().find(client => client.accountUserId === record.actorUserId && eligible(client));
        if (!current) throw new Error(CLOUD_GITHUB_DESKTOP_REQUIRED);
        return { kind: "terminal", actorSessionId: current.cloudActor!.sessionId };
      },
      onAuthorityChange: (invalidate: () => void) => { record.invalidate = invalidate; },
      onRetire: () => { if (this.terminals.get(id) === record) this.terminals.delete(id); },
    };
  }
  reattach(id: string, client: TransportClient): void {
    const record = this.terminals.get(id);
    if (!record?.actorUserId || record.shared || client.accountUserId !== record.actorUserId || !eligible(client)) return;
    record.invalidate();
    record.clients = [...record.clients.filter(item => item !== client && eligible(item)), client];
  }
  input(id: string, client: TransportClient): void {
    const record = this.terminals.get(id);
    if (!record?.actorUserId || record.shared) return;
    if (client.accountUserId !== record.actorUserId) {
      record.shared = true;
      record.clients = [];
      record.invalidate();
    } else if (!record.clients.includes(client)) this.reattach(id, client);
  }
}
