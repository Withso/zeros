import { gitLog, type Commit } from "@/renderer/platform/git";
import { turnsList, type TurnInfo } from "@/renderer/platform/turns";
import type { TurnHistoryCursor } from "@zeros/protocol/changes-history";

const PAGE_SIZE = 500;

/** Publish a complete history snapshot, never a truncated page that could
 * invalidate a remembered range. Subsequent pages stay pinned to the first. */
export async function loadChangesCommits(
  workspaceId: string,
  base: string,
): Promise<Commit[]> {
  const commits: Commit[] = [];
  let ref: string | undefined;
  for (let skip = 0; ; skip += PAGE_SIZE) {
    const page = await gitLog({
      workspaceId,
      base,
      limit: PAGE_SIZE,
      skip,
      ...(ref ? { ref } : {}),
    });
    commits.push(...page);
    ref ??= page[0]?.sha;
    if (page.length < PAGE_SIZE) return commits;
  }
}

export async function loadChangesTurns(
  workspaceId: string,
): Promise<TurnInfo[]> {
  const turns = new Map<string, TurnInfo>();
  let before: number | undefined;
  let after: TurnHistoryCursor | undefined;
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await turnsList(workspaceId, {
      limit: PAGE_SIZE,
      offset,
      ...(before !== undefined ? { before } : {}),
      ...(after ? { after } : {}),
    });
    for (const turn of page)
      turns.set(JSON.stringify([turn.chatId, turn.turnId]), turn);
    before ??= page[0]?.startedAt;
    if (page.length < PAGE_SIZE) return [...turns.values()];
    const last = page[page.length - 1];
    after = {
      chatId: last.chatId,
      turnId: last.turnId,
      startedAt: last.startedAt,
    };
  }
}
