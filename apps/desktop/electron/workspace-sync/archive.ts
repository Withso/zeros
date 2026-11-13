import { z } from "zod";
import { archiveContext } from "../../src/engine/files/archived-contexts";
import type { SyncManager } from "./manager";

export const ArchiveWorkspaceReplySchema = z.object({ workspace: z.object({
  id: z.string().uuid(), organizationId: z.string().uuid(), repository: z.string().regex(/^[^/]+\/[^/]+$/),
  number: z.number().int().positive().nullable().optional(), name: z.string().min(1).max(200),
  archivedAt: z.string().datetime({ offset: true }).nullable().optional(),
}) });

const NOT_VISIBLE_MS = 5 * 60_000, MAX_NOT_VISIBLE = 10_000;

export class CloudContextArchiver {
  private backoffOwner: string | null = null;
  private readonly notVisibleUntil = new Map<string, number>();
  constructor(private readonly deps: {
    ownerKey(): string | null;
    now?(): number;
    read(workspaceId: string): Promise<z.infer<typeof ArchiveWorkspaceReplySchema>>;
    manager: Pick<SyncManager, "archive">;
    channel: string;
  }) {}

  async inspect(workspaceId: string, isCurrent = () => true): Promise<boolean> {
    const owner = this.deps.ownerKey();
    if (owner !== this.backoffOwner) { this.notVisibleUntil.clear(); this.backoffOwner = owner; }
    if (!owner) throw new Error("Context archive owner is unavailable.");
    const current = () => this.deps.ownerKey() === owner && isCurrent();
    if (!current()) throw new Error("Context archive owner changed.");
    const now = () => this.deps.now?.() ?? Date.now();
    if ((this.notVisibleUntil.get(workspaceId) ?? Number.NEGATIVE_INFINITY) > now()) return false;
    this.notVisibleUntil.delete(workspaceId);
    let reply: z.infer<typeof ArchiveWorkspaceReplySchema>;
    try { reply = await this.deps.read(workspaceId); }
    catch (error) {
      if (current() && (error as { status?: unknown }).status === 404) {
        // Invisibility is not archive intent, and device hints must not retry it at their own cadence.
        if (this.notVisibleUntil.size >= MAX_NOT_VISIBLE) this.notVisibleUntil.delete(this.notVisibleUntil.keys().next().value!);
        this.notVisibleUntil.set(workspaceId, now() + NOT_VISIBLE_MS);
        return false;
      }
      throw error;
    }
    if (!current()) throw new Error("Context archive owner changed.");
    const workspace = reply.workspace;
    if (workspace.id !== workspaceId) throw new Error("Context archive workspace changed.");
    // Sleep and connection expiry are not archive intent.
    if (!workspace.archivedAt) return false;
    await this.deps.manager.archive(workspaceId, (sourceRoot, identity, stillCurrent) => archiveContext({
      sourceRoot, channelRoot: this.deps.channel, repository: workspace.repository.split("/")[1]!,
      workspace: workspace.number ? `w-${workspace.number}` : workspace.name,
      identity: JSON.stringify(["cloud", identity.accountId, workspace.organizationId, workspaceId]),
      archivedAt: Date.parse(workspace.archivedAt!), isCurrent: () => current() && stillCurrent(),
    }));
    if (!current()) throw new Error("Context archive owner changed.");
    return true;
  }
}
