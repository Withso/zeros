import { z } from "zod";
import { archiveContext } from "../../src/engine/files/archived-contexts";
import type { SyncManager } from "./manager";

export const ArchiveWorkspaceReplySchema = z.object({ workspace: z.object({
  id: z.string().uuid(), organizationId: z.string().uuid(), repository: z.string().regex(/^[^/]+\/[^/]+$/),
  number: z.number().int().positive().nullable().optional(), name: z.string().min(1).max(200),
  archivedAt: z.string().datetime({ offset: true }).nullable().optional(),
}) });

export class CloudContextArchiver {
  constructor(private readonly deps: {
    ownerKey(): string | null;
    read(workspaceId: string): Promise<z.infer<typeof ArchiveWorkspaceReplySchema>>;
    manager: Pick<SyncManager, "archive">;
    channel: string;
  }) {}

  async inspect(workspaceId: string, isCurrent = () => true): Promise<boolean> {
    const owner = this.deps.ownerKey();
    if (!owner) throw new Error("Context archive owner is unavailable.");
    const current = () => this.deps.ownerKey() === owner && isCurrent();
    let reply: z.infer<typeof ArchiveWorkspaceReplySchema>;
    try { reply = await this.deps.read(workspaceId); }
    catch (error) { if (current() && (error as { status?: unknown }).status === 404) return false; throw error; }
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
