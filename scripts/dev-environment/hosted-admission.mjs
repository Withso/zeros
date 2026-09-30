import { sha256 } from "./state.mjs";

const defaults = { maxActiveGenerations: 4, maxGenerationsPerOwner: 1, maxBuilders: 1, maxBuildersPerOwner: 1, maxNamedSnapshots: 10, snapshotHeadroom: 1 };
export function admissionPolicy(profile) {
  const policy = { ...defaults, ...profile.admission };
  for (const [key, value] of Object.entries(policy)) if (!Number.isSafeInteger(value) || value < (key === "snapshotHeadroom" ? 0 : 1)) throw new Error("Invalid Dev admission cap");
  if (policy.maxNamedSnapshots > 10 || policy.snapshotHeadroom >= policy.maxNamedSnapshots) throw new Error("Dev snapshot cap exceeds qualified capacity");
  return policy;
}
const account = profile => sha256(JSON.stringify([profile.boat.accountScope, profile.boat.billingOrg,
  profile.railway.projectId, profile.planetscale.organization, profile.planetscale.database, profile.cloudflare.accountId]));

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const computeIdentity = row => row.computeId ?? (row.snapshotName ? `snapshot:${row.snapshotName}` : undefined);
function validateLedger(ledger, { legacy = false } = {}) {
  const seen = new Set();
  if (ledger?.version !== 1 || ledger.owner !== "account-admission" || !Array.isArray(ledger.reservations) || ledger.reservations.length > 5000) throw new Error("Invalid Dev admission ledger");
  for (const row of ledger.reservations) {
    const computeId = row && computeIdentity(row);
    const validCompute = typeof row?.snapshotName === "string"
      ? uuid.test(row.generation ?? "") && (row.snapshotName.startsWith(`dev-${row.owner}-${row.generation.slice(0, 8)}-`) ||
        row.capacityClass === "custom" && row.snapshotName === `zeros-org-${row.generation.replaceAll("-", "")}`) && /^[a-z0-9-]+$/.test(row.snapshotName) && computeId === `snapshot:${row.snapshotName}`
      : row?.snapshotName === undefined && typeof computeId === "string" && computeId.startsWith("canary:") && uuid.test(computeId.slice(7));
    const key = `${row?.owner}/${row?.generation}/${row?.kind}/${computeId ?? ""}`;
    if (!row || !["generation", "builder"].includes(row.kind) || !/^[a-f0-9]{24}$/.test(row.owner ?? "") || !uuid.test(row.generation ?? "") ||
        !Number.isFinite(Date.parse(row.createdAt)) || row.releasedAt && !Number.isFinite(Date.parse(row.releasedAt)) ||
        row.snapshotReleasedAt && !Number.isFinite(Date.parse(row.snapshotReleasedAt)) ||
        row.kind === "builder" && !validCompute && !(legacy && row.legacy === true && row.snapshotName === undefined && row.computeId === undefined) ||
        row.kind === "generation" && (row.snapshotName !== undefined || row.computeId !== undefined) || seen.has(key)) throw new Error("Invalid Dev admission ledger reservation");
    seen.add(key);
  }
}

// Legacy receipts can hold retired qualification canaries recorded before
// agentQualificationId existed. They never hold capacity (see imageReservation),
// so lookups skip them instead of failing the whole admission change.
function knownImageIdentity(image) {
  try { return imageIdentity(image); } catch { return undefined; }
}

function imageIdentity(image) {
  if (image.purpose === "native-agent-qualification" && uuid.test(image.agentQualificationId ?? "") && image.snapshotId === undefined) return `canary:${image.agentQualificationId}`;
  if (typeof image.snapshotId === "string") return `snapshot:${image.snapshotId}`;
  throw new Error("Invalid Dev admission resource identity; reconcile its receipt");
}

function imageReservation(state, image, now) {
  const computing = image.builder ? !image.builder.deleted && !image.builder.retiredAt
    : image.builderIntent && !["planned", "rejected"].includes(image.builderCreate?.phase);
  const saving = image.snapshotId && !image.snapshotDeleted && (computing || image.snapshotRequested && !["planned", "rejected"].includes(image.snapshotCreate?.phase));
  if (!computing && !saving) return undefined;
  return { kind: "builder", owner: state.owner, generation: state.generation, computeId: imageIdentity(image),
    ...(image.snapshotId ? { snapshotName: image.snapshotId } : {}), createdAt: state.createdAt, legacy: true,
    ...(!computing ? { releasedAt: new Date(now).toISOString() } : {}) };
}

async function repairLegacyReservations(ledger, receipts) {
  // Earlier ledgers keyed compute by snapshotName, which qualification canaries
  // do not have. Recover every matching canary from authenticated receipts;
  // never infer noncreation or discard a nameless, uncertain allocation.
  const nameless = ledger.reservations.filter(row => row.kind === "builder" && !computeIdentity(row));
  const scan = nameless.length ? await receipts() : undefined;
  for (const row of nameless) {
    const state = scan.records.find(record => record.state.owner === row.owner && record.state.generation === row.generation)?.state;
    const images = state?.resources.images?.filter(image => image.purpose === "native-agent-qualification" && uuid.test(image.agentQualificationId ?? "") && image.snapshotId === undefined);
    if (!images?.length) throw new Error("Dev admission ledger needs reconciliation of a legacy compute reservation");
    ledger.reservations = ledger.reservations.filter(value => value !== row);
    for (const image of images) {
      const computeId = imageIdentity(image);
      const previous = ledger.reservations.find(value => value.owner === row.owner && value.generation === row.generation && value.kind === "builder" && computeIdentity(value) === computeId);
      if (previous) { delete previous.releasedAt; delete previous.snapshotReleasedAt; }
      else ledger.reservations.push({ kind: "builder", owner: row.owner, generation: row.generation, computeId, createdAt: row.createdAt, legacy: true });
    }
  }
  for (const row of ledger.reservations) if (row.kind === "builder") row.computeId = computeIdentity(row);
}

async function changeAdmission(store, profile, update, receipts = () => store.list({ history: true })) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const current = await store.readAdmission();
    const ledger = current?.state ?? { version: 1, owner: "account-admission", account: account(profile), reservations: [] };
    validateLedger(ledger, { legacy: true });
    if (ledger.account !== account(profile)) throw new Error("Dev admission ledger belongs to another provider account");
    await repairLegacyReservations(ledger, receipts);
    validateLedger(ledger);
    const result = update(ledger);
    // Validate enrollment and repair before persisting a shared account object.
    validateLedger(ledger);
    try { await store.writeAdmission(ledger, current?.etag); return result; }
    catch (error) { if (error?.code !== "DEV_REGISTRY_CONFLICT") throw error; }
  }
  throw new Error("Dev account admission is busy; retry before allocating resources");
}

/** Reservations have no time-only release. Unknown dispatches keep capacity
 * until authenticated deletion/noncreation is confirmed by the owning lease. */
export async function reserveHostedAdmission(store, state, profile, { kind = "generation", snapshotName, computeId = snapshotName ? `snapshot:${snapshotName}` : undefined, inventory = [], now = Date.now() } = {}) {
  if (!/^[a-f0-9]{24}$/.test(state.owner) || !uuid.test(state.generation) || !["generation", "builder"].includes(kind) || state.status === "archiving" || state.status === "archived") throw new Error("Invalid Dev admission owner");
  const policy = admissionPolicy(profile);
  const scan = await store.list({ history: true });
  if (scan.quarantine?.length) throw new Error("Dev ownership inventory needs reconciliation before admission");
  const reservation = { kind, owner: state.owner, generation: state.generation, ...(computeId ? { computeId } : {}),
    ...(snapshotName ? { snapshotName } : {}), createdAt: new Date(now).toISOString() };
  validateLedger({ version: 1, owner: "account-admission", reservations: [reservation] });
  // The owning lease is fresher than the inventory snapshot, including its own
  // legacy builders. Empty contenders still compete only through the CAS.
  const records = [...scan.records.filter(record => record.state.owner !== state.owner || record.state.generation !== state.generation), { state }];
  return changeAdmission(store, profile, ledger => {
    // Enroll legacy active receipts conservatively before computing capacity.
    for (const { state: existing } of records) {
      if (existing.status === "archived") continue;
      // A lease creates an empty provisioning receipt before admission. Those
      // concurrent contenders must compete in CAS, not reserve each other.
      if (existing.status === "provisioning" && !existing.backendEverDeployed && !Object.keys(existing.resources ?? {}).length) continue;
      if (!ledger.reservations.some(row => row.kind === "generation" && row.owner === existing.owner && row.generation === existing.generation)) {
        ledger.reservations.push({ kind: "generation", owner: existing.owner, generation: existing.generation, createdAt: existing.createdAt, legacy: true });
      }
      for (const image of existing.resources.images ?? []) {
        const resource = imageReservation(existing, image, now);
        if (resource && !ledger.reservations.some(row => row.kind === "builder" && row.owner === existing.owner && row.generation === existing.generation && row.computeId === resource.computeId)) ledger.reservations.push(resource);
      }
    }
    validateLedger(ledger);
    const previous = ledger.reservations.find(row => row.kind === kind && row.owner === state.owner && row.generation === state.generation && row.computeId === computeId);
    if (previous && !previous.releasedAt) return previous;
    const active = ledger.reservations.filter(row => row.kind === kind && !row.releasedAt);
    const globalCap = kind === "generation" ? policy.maxActiveGenerations : policy.maxBuilders;
    const ownerCap = kind === "generation" ? policy.maxGenerationsPerOwner : policy.maxBuildersPerOwner;
    if (active.length >= globalCap || active.filter(row => row.owner === state.owner).length >= ownerCap) throw new Error("Dev account/owner admission cap reached; archive or reconcile existing reservations");
    if (kind === "builder" && snapshotName) {
      const names = new Set(inventory.filter(row => row.provider === "boat").map(row => row.id));
      if (!names.has(profile.boat.baseSnapshot)) throw new Error("Dev snapshot inventory must confirm the protected base before admission");
      for (const row of ledger.reservations) if (row.kind === "builder" && row.snapshotName && !row.snapshotReleasedAt) names.add(row.snapshotName);
      names.add(snapshotName);
      const channels = ["alpha", "beta", "production"];
      const release = name => channels.find(channel => name.startsWith(`dev-${sha256(`zeros-release-worker:${channel}`).slice(0, 24)}-`) || name.startsWith(`zeros-${channel}-`));
      if ([...names].filter(name => name !== profile.boat.baseSnapshot && !release(name)).length > 2 ||
        channels.some(channel => [...names].filter(name => release(name) === channel).length > 2))
        throw new Error("Dev named snapshot capacity is reserved for release and rollback images; image capacity reached");
      if (names.size + policy.snapshotHeadroom > policy.maxNamedSnapshots) throw new Error("Dev named snapshot capacity is reserved; no builder was allocated");
    }
    if (previous) Object.assign(previous, reservation, { releasedAt: undefined, snapshotReleasedAt: undefined }); else ledger.reservations.push(reservation);
    ledger.policy = policy; return reservation;
  }, async () => ({ ...scan, records }));
}

export async function releaseHostedAdmission(store, lease, profile) {
  await lease.fence();
  const state = lease.state;
  return changeAdmission(store, profile, ledger => {
    for (const row of ledger.reservations.filter(row => row.owner === state.owner && row.generation === state.generation)) {
      const image = row.kind === "builder" && state.resources.images?.find(image => knownImageIdentity(image) === row.computeId);
      // Builder intents and snapshot requests are saved before any provider
      // dispatch, so a reservation with no record or no intent never allocated.
      const neverStarted = row.kind === "builder" && (!image || !image.builder && (!image.builderIntent || ["planned", "rejected"].includes(image.builderCreate?.phase)));
      const stopped = neverStarted || image && (image.builder ? image.builder.deleted || image.builder.retiredAt : ["planned", "rejected"].includes(image.builderCreate?.phase));
      if (state.status === "archived" || row.kind === "builder" && stopped) row.releasedAt ??= new Date().toISOString();
      if (row.kind === "builder" && (state.status === "archived" || !row.snapshotName || image?.snapshotDeleted || stopped && (!image?.snapshotRequested || ["planned", "rejected"].includes(image?.snapshotCreate?.phase)))) row.snapshotReleasedAt ??= new Date().toISOString();
    }
    // Keep terminal evidence in generation receipts, bound the account object.
    ledger.reservations = ledger.reservations.filter(row => !row.releasedAt || row.kind === "builder" && !row.snapshotReleasedAt);
  });
}
