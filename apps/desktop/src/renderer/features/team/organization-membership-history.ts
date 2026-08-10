import { workspaceReassignLocalOrganization } from "../../platform/git";
import { isExpectedElectron, isNativeRuntime } from "../../platform/runtime";
import { getSetting, setSetting } from "../../platform/settings";
import type { Me } from "./control-plane";

const HISTORY_KEY = "organization:membership-history-v1";
const MAX_ACCOUNTS = 8;
const MAX_ORGANIZATIONS = 200;

export type OrganizationMembershipSnapshot = {
  userId: string;
  /** Null while talking to a pre-hierarchy control plane during rollout. */
  personalId: string | null;
  organizationIds: string[];
  retiredOrganizationIds: string[];
  updatedAt: number;
};

type OrganizationMembershipHistory = {
  version: 1;
  accounts: OrganizationMembershipSnapshot[];
};

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ORGANIZATIONS &&
    value.every(validId)
  );
}

function readHistory(): OrganizationMembershipHistory {
  const raw = getSetting<unknown>(HISTORY_KEY, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { version: 1, accounts: [] };
  }
  const accounts = (raw as { accounts?: unknown }).accounts;
  if (!Array.isArray(accounts)) return { version: 1, accounts: [] };
  return {
    version: 1,
    accounts: accounts
      .filter(
        (candidate): candidate is OrganizationMembershipSnapshot =>
          !!candidate &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          validId((candidate as OrganizationMembershipSnapshot).userId) &&
          ((candidate as OrganizationMembershipSnapshot).personalId === null ||
            validId(
              (candidate as OrganizationMembershipSnapshot).personalId,
            )) &&
          validIds(
            (candidate as OrganizationMembershipSnapshot).organizationIds,
          ) &&
          validIds(
            (candidate as OrganizationMembershipSnapshot)
              .retiredOrganizationIds,
          ) &&
          Number.isFinite(
            (candidate as OrganizationMembershipSnapshot).updatedAt,
          ),
      )
      .slice(0, MAX_ACCOUNTS),
  };
}

function currentSnapshot(me: Me): OrganizationMembershipSnapshot | null {
  const organizations = me.organizations ?? me.teams ?? [];
  const personal = organizations.find(
    (organization) => organization.isPersonal,
  );
  const organizationIds = Array.from(
    new Set(organizations.map((organization) => organization.id)),
  );
  if (!validId(me.user.id) || !validIds(organizationIds)) return null;
  return {
    userId: me.user.id,
    // Preserve flat-Team ids before Personal arrives. Removals become durable
    // tombstones but are not applied until a hierarchy-aware response supplies
    // the destination Personal id. Promoted Team→Organization ids stay stable.
    personalId: personal?.id ?? null,
    organizationIds,
    retiredOrganizationIds: [],
    updatedAt: Date.now(),
  };
}

/** Retired ids remain as bounded tombstones so a create that finishes just
 * after membership removal is repaired on the next exact `/v1/me` refresh. A
 * later rejoin removes the id from the retired set. */
export function organizationMembershipTransition(
  previous: OrganizationMembershipSnapshot | null,
  current: OrganizationMembershipSnapshot,
): {
  retiredOrganizationIds: string[];
  next: OrganizationMembershipSnapshot;
} {
  const currentIds = new Set(current.organizationIds);
  const retired = new Set(previous?.retiredOrganizationIds ?? []);
  for (const id of previous?.organizationIds ?? []) {
    if (!currentIds.has(id)) retired.add(id);
  }
  for (const id of currentIds) retired.delete(id);
  const retiredOrganizationIds = Array.from(retired).slice(-MAX_ORGANIZATIONS);
  return {
    retiredOrganizationIds,
    next: { ...current, retiredOrganizationIds },
  };
}

let reconciliationChain: Promise<void> = Promise.resolve();

async function reconcile(me: Me): Promise<void> {
  const current = currentSnapshot(me);
  if (!current) return;
  const history = readHistory();
  const previous =
    history.accounts.find((account) => account.userId === current.userId) ??
    null;
  const transition = organizationMembershipTransition(previous, current);

  const persist = () => {
    const accounts = [
      transition.next,
      ...history.accounts.filter(
        (account) => account.userId !== current.userId,
      ),
    ].slice(0, MAX_ACCOUNTS);
    setSetting<OrganizationMembershipHistory>(HISTORY_KEY, {
      version: 1,
      accounts,
    });
  };

  // A pre-0009 server can prove which flat tenant ids disappeared but cannot
  // name Personal yet. Keep the tombstones and apply them after rollout.
  if (!current.personalId) {
    persist();
    return;
  }

  // Electron can briefly report no bridge while preload recovers. Do not
  // advance the durable membership snapshot until the local engine can perform
  // any required transfer; team-sync retries on bridge connection.
  if (!isNativeRuntime() && isExpectedElectron()) return;
  if (isNativeRuntime()) {
    for (const fromOrganizationId of transition.retiredOrganizationIds) {
      await workspaceReassignLocalOrganization({
        fromOrganizationId,
        toOrganizationId: current.personalId,
      });
    }
  }

  persist();
}

/** Serialize reconciliations across refresh/account switches. A failed bridge
 * call deliberately leaves the previous durable snapshot in place so a later
 * refresh retries the idempotent transfer. */
export function reconcileOrganizationWorkspaceOwnership(me: Me): Promise<void> {
  const task = reconciliationChain.then(() => reconcile(me));
  reconciliationChain = task.catch(() => undefined);
  return task;
}
