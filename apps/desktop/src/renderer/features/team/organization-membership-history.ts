import { workspaceReassignLocalOrganization } from "../../platform/git";
import { isExpectedElectron, isNativeRuntime } from "../../platform/runtime";
import { getSetting, setSetting } from "../../platform/settings";
import type { Me } from "./control-plane";
import { PERSONAL_ORGANIZATION_ID } from "./personal-organization";

const HISTORY_KEY = "organization:membership-history-v1";
const HIERARCHY_SEEN_KEY = "organization:hierarchy-seen-v1";
const PERSONAL_IDS_KEY = "organization:personal-ids-v1";
const MAX_ACCOUNTS = 8;
const MAX_ORGANIZATIONS = 200;
// Personal aliases outlive the small account MRU, including deletion/recreation.
// Only explicitly identified old Personal IDs are eligible for local repair.
const MAX_PERSONAL_IDS = 256;
let personalIdsFingerprint = "";
let personalIdsSnapshot: string[] = [];

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

/** Bounded local migration metadata, not an authorization or membership cache.
 * Never infer Personal ownership from an email, missing membership, ID prefix,
 * or a cloud row. The old per-account history provides the upgrade evidence. */
export function getKnownPersonalOrganizationIds(): readonly string[] {
  const raw = getSetting<{ version?: unknown; ids?: unknown } | null>(
    PERSONAL_IDS_KEY,
    null,
  );
  const stored =
    raw?.version === 1 && Array.isArray(raw.ids)
      ? raw.ids.slice(0, MAX_PERSONAL_IDS).filter(validId)
      : [];
  const historical = readHistory()
    .accounts.map((account) => account.personalId)
    .filter(validId);
  const fingerprint = JSON.stringify([stored, historical]);
  if (fingerprint !== personalIdsFingerprint) {
    personalIdsFingerprint = fingerprint;
    const ids = [...new Set([...stored, ...historical])]
      .filter((id) => id !== PERSONAL_ORGANIZATION_ID)
      .slice(-MAX_PERSONAL_IDS);
    if (!samePersonalIds(ids, personalIdsSnapshot)) personalIdsSnapshot = ids;
  }
  return personalIdsSnapshot;
}

function samePersonalIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Learn aliases before publishing the new UI snapshot. This keeps old local
 * rows visible while the asynchronous engine repair retries or is offline. */
export function rememberPersonalOrganizationOwnership(me: Me): void {
  const previous = getKnownPersonalOrganizationIds();
  const organizations = me.organizations ?? me.teams;
  const collaborativeIds = new Set(
    organizations
      .filter((organization) => !organization.isPersonal)
      .map((organization) => organization.id),
  );
  const ids = [
    ...new Set([
      ...previous,
      ...organizations
        .filter((organization) => organization.isPersonal)
        .map((organization) => organization.id),
    ]),
  ]
    .filter(
      (id) =>
        validId(id) &&
        id !== PERSONAL_ORGANIZATION_ID &&
        !collaborativeIds.has(id),
    )
    .slice(-MAX_PERSONAL_IDS);
  // Persist history-derived aliases before its account MRU can evict them.
  // Failed storage writes retain this session's known aliases; no local files
  // or source records are removed.
  if (!samePersonalIds(ids, previous)) personalIdsSnapshot = ids;
  if (setSetting(PERSONAL_IDS_KEY, { version: 1, ids })) {
    personalIdsFingerprint = JSON.stringify([
      ids,
      readHistory()
        .accounts.map((account) => account.personalId)
        .filter(validId),
    ]);
  }
}

function readHierarchySeenUserIds(): string[] {
  const raw = getSetting<unknown>(HIERARCHY_SEEN_KEY, null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const userIds = (raw as { userIds?: unknown }).userIds;
  return Array.isArray(userIds)
    ? userIds.filter(validId).slice(0, MAX_ACCOUNTS)
    : [];
}

/** Whether this account has already observed a hierarchy-aware ownership
 * snapshot. Absence is the one-time upgrade signal: the durable active id may
 * still be a promoted flat-Team selection while all existing rows are legacy
 * Personal data. */
export function hasOrganizationOwnershipHistory(userId: string): boolean {
  return (
    readHierarchySeenUserIds().includes(userId) ||
    readHistory().accounts.some(
      (account) => account.userId === userId && account.personalId !== null,
    )
  );
}

/** Record the one-time hierarchy normalization independently from engine
 * ownership repair. A missing preload bridge may defer the latter indefinitely,
 * but must not keep snapping the user's active selection back to Personal. */
export function recordOrganizationHierarchySeen(userId: string): void {
  if (!validId(userId)) return;
  const current = readHierarchySeenUserIds();
  if (current.includes(userId)) return;
  setSetting(HIERARCHY_SEEN_KEY, {
    version: 1,
    userIds: [userId, ...current].slice(0, MAX_ACCOUNTS),
  });
}

/** Recover the last confirmed owner while `/v1/me` is cold or unavailable.
 * This never trusts the active-id key by itself: the first hierarchy upgrade
 * has no history yet, so a legacy Team selection cannot claim new rows. */
export function hasRecordedOrganizationOwnership(
  organizationId: string | null,
): organizationId is string {
  return Boolean(
    organizationId &&
    readHistory().accounts.some((account) =>
      account.organizationIds.includes(organizationId),
    ),
  );
}

function currentSnapshot(me: Me): OrganizationMembershipSnapshot | null {
  const organizations = me.organizations ?? me.teams ?? [];
  // Every hierarchy-aware account has Personal. An empty response is therefore
  // a rollout/provisioning gap, not an authoritative membership deletion; keep
  // the last confirmed ownership snapshot until a non-empty response arrives.
  if (organizations.length === 0) return null;
  const personal = organizations.find(
    (organization) => organization.isPersonal,
  );
  const organizationIds = Array.from(
    new Set(organizations.map((organization) => organization.id)),
  );
  if (!validId(me.user.id) || !validIds(organizationIds)) return null;
  return {
    userId: me.user.id,
    // Preserve the server Personal ID only as legacy migration evidence.
    // Device Personal itself has no account or server organization ID.
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

async function detachKnownPersonalWorkspaceOwners(): Promise<void> {
  if (!isNativeRuntime()) return;
  for (const fromOrganizationId of getKnownPersonalOrganizationIds()) {
    await workspaceReassignLocalOrganization({
      fromOrganizationId,
      toOrganizationId: null,
    });
  }
}

/** Can run on local bridge connection without any login or network access. */
export function reconcilePersonalWorkspaceOwnership(): Promise<void> {
  const task = reconciliationChain.then(detachKnownPersonalWorkspaceOwners);
  reconciliationChain = task.catch(() => undefined);
  return task;
}

async function reconcile(me: Me, isCurrent: () => boolean): Promise<void> {
  if (!isCurrent()) return;
  rememberPersonalOrganizationOwnership(me);
  await detachKnownPersonalWorkspaceOwners();
  if (!isCurrent()) return;
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

  // Electron can briefly report no bridge while preload recovers. Do not
  // advance the durable membership snapshot until the local engine can perform
  // any required transfer; team-sync retries on bridge connection.
  if (!isNativeRuntime() && isExpectedElectron()) return;
  if (isNativeRuntime()) {
    for (const fromOrganizationId of transition.retiredOrganizationIds) {
      if (!isCurrent()) return;
      await workspaceReassignLocalOrganization({
        fromOrganizationId,
        toOrganizationId: null,
      });
    }
  }

  if (isCurrent()) persist();
}

/** Serialize reconciliations across refresh/account switches. A failed bridge
 * call deliberately leaves the previous durable snapshot in place so a later
 * refresh retries the idempotent transfer. */
export function reconcileOrganizationWorkspaceOwnership(
  me: Me,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const task = reconciliationChain.then(() => reconcile(me, isCurrent));
  reconciliationChain = task.catch(() => undefined);
  return task;
}
