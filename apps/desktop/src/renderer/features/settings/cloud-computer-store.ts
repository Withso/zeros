// Shared Cloud Computer state for Settings: the organization's overview cache,
// its owner check, and the recipe draft both the Cloud Computer page and each
// repository's page edit through.
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyedAsyncCache } from "../../shared/lib/keyed-async-cache";
import { useRecoveringRead } from "../../state/use-recovering-read";
import { getOrganizationStoreGeneration, getTeamStoreState } from "../team/team-store";
import { CONTROL_PLANE_URL, ControlPlaneError } from "../team/control-plane";
import { getCloudV2Computer, saveCloudV2ComputerRecipe, type CloudV2Computer, type CloudV2RepositoryDraft } from "../../platform/cloud-v2";
import { editableRepositories, newerRecipe, RecipeSaveQueue } from "./cloud-computer-model";

export const computers = new KeyedAsyncCache<CloudV2Computer>({ maxEntries: 16 });
export const MAX_REPOSITORIES = 10;
/** Typing in a branch or setup field saves after a pause; list edits at once. */
export const TYPING_SAVE_MS = 600;

export const computerKey = (userId: string, organizationId: string) => JSON.stringify([CONTROL_PLANE_URL, getOrganizationStoreGeneration(), userId, organizationId]);
export function assertComputerOwner(key: string, organizationId: string): void {
  const me = getTeamStoreState().me, organization = (me?.organizations ?? me?.teams)?.find(row => row.id === organizationId);
  if (!me || key !== computerKey(me.user.id, organizationId) || !organization || organization.isPersonal ||
      (organization.role !== "owner" && organization.role !== "admin")) throw new Error("The Cloud Computer account changed. Reopen its settings.");
}
/** Intent warming for the Settings entry; only owners and admins can read it. */
export function prefetchCloudComputer(userId: string, organization: { id: string; isPersonal: boolean; role?: string }): void {
  if (organization.isPersonal || (organization.role !== "owner" && organization.role !== "admin")) return;
  void computers.load(computerKey(userId, organization.id), () => getCloudV2Computer(organization.id), { maxAgeMs: 30_000 })
    .catch(() => undefined);
}

export function message(error: unknown): string {
  if (error instanceof ControlPlaneError) return error.message;
  return "The Cloud Computer request failed. Try again.";
}

/** One repository's recipe row with a patch applied; empty fields drop out. */
export function patchRepository(rows: readonly CloudV2RepositoryDraft[], repository: string,
  patch: { ref?: string; setup?: string; setupScript?: string }): CloudV2RepositoryDraft[] {
  return rows.map(row => {
    if (row.repository !== repository) return row;
    const next = { ...row, ...patch };
    return { repository: next.repository, ...(next.ref?.trim() ? { ref: next.ref.trim() } : {}), ...(next.setup?.trim() ? { setup: next.setup } : {}),
      ...(next.setupScript ? { setupScript: next.setupScript } : {}) };
  });
}

/** Merges a recipe reply into the freshest cached overview. A late reply
 * never replaces a newer revision a refresh has already shown. */
export function publishRecipe(key: string, latest: { current: { data: CloudV2Computer | undefined; revision: number | undefined } },
  saved: { recipe: NonNullable<CloudV2Computer["recipe"]>; recipeRevision: number }): void {
  const next = newerRecipe(computers.getSnapshot(key).data ?? latest.current.data, saved);
  if (!next) return;
  latest.current = { data: next, revision: saved.recipeRevision };
  computers.setData(key, next);
}

/** Local edits over the configured repositories, saved in order at the
 * revision they started from. A newer revision from elsewhere wins. */
export function useRecipeDraft(organizationId: string, key: string, data: CloudV2Computer | undefined,
  refresh: () => void, onError: (text: string) => void) {
  const [local, setLocal] = useState<CloudV2RepositoryDraft[] | null>(null);
  const legacy = data !== undefined && data.recipeRevision === undefined;
  const latest = useRef({ data, revision: data?.recipeRevision });
  latest.current = { data, revision: data?.recipeRevision };
  const callbacks = useRef({ refresh, onError });
  callbacks.current = { refresh, onError };
  const [queue] = useState(() => new RecipeSaveQueue<CloudV2RepositoryDraft[]>({
    save: async (repositories, revision) => {
      assertComputerOwner(key, organizationId);
      const saved = await saveCloudV2ComputerRecipe(organizationId, repositories, revision);
      assertComputerOwner(key, organizationId);
      publishRecipe(key, latest, saved);
      return saved.recipeRevision;
    },
    serverRevision: () => latest.current.revision,
    onSaved: () => setLocal(null),
    onError: error => {
      setLocal(null); callbacks.current.refresh();
      callbacks.current.onError(error instanceof ControlPlaneError && error.code === "computer_recipe_changed"
        ? "The Cloud Computer changed elsewhere. The latest repositories are shown." : message(error));
    },
  }));
  // Owner navigation can finish an authored save, but a retired account must
  // not send its queued selection under the replacement account's authority.
  useEffect(() => () => {
    if (!queue.waiting) return;
    try { assertComputerOwner(key, organizationId); void queue.flush(); }
    catch { queue.cancel(); }
  }, [queue, key, organizationId]);

  const edit = useCallback((next: CloudV2RepositoryDraft[], delayMs: number) => {
    setLocal(next);
    if (!legacy) queue.push(next, delayMs);
  }, [legacy, queue]);
  const reset = useCallback(() => { queue.cancel(); setLocal(null); }, [queue]);
  return { local, legacy, edit, settle: () => queue.settle(), revision: () => queue.revision(), reset, latest };
}


/** The configured repositories, for Settings' sidebar; empty for non-managers. */
export function useCloudComputerRepositories(userId: string | null, organization: { id: string; isPersonal: boolean; role?: string } | null,
  enabled: boolean): string[] {
  const manages = !!userId && !!organization && !organization.isPersonal && (organization.role === "owner" || organization.role === "admin");
  const read = useRecoveringRead(computers, manages ? computerKey(userId!, organization!.id) : null,
    (key) => getCloudV2Computer((JSON.parse(key) as string[])[3]!), { enabled, maxAgeMs: 30_000 });
  const data = read.data;
  if (!manages || !data) return [];
  return (data.recipe?.repositories ?? editableRepositories(data.builds.find(build => build.id === data.activeBuildId))).map(row => row.repository);
}
