import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { z } from "zod";
import { parseDatabaseTarget } from "./database-target.js";
import { createMigrationPool } from "./db.js";
import { loadCapabilityKeyring, type CapabilityKeyring } from "./cloud-workspaces/capability-keyring.js";
import {
  generateCapabilityKeypair,
  sealCapabilityPrivateKey,
} from "./cloud-workspaces/capability-keys.js";
import { CAPABILITY_KEY_ID_PATTERN } from "./cloud-workspaces/capability-contract.js";
import { RolloutFlagManagementError, validateOperatorChannel } from "./manage-cloud-rollout-flag.js";

const ChannelSchema = z.string().trim().toLowerCase().pipe(z.enum(["development", "alpha", "beta", "production"]));
const ChangeSchema = z.discriminatedUnion("action", [
  z.object({
    operationId: z.string().uuid().transform(value => value.toLowerCase()),
    channel: ChannelSchema,
    actorUserId: z.string().uuid().transform(value => value.toLowerCase()),
    reason: z.string().trim().min(16).max(512),
    action: z.literal("create"),
    kid: z.string().regex(CAPABILITY_KEY_ID_PATTERN),
  }).strict(),
  z.object({
    operationId: z.string().uuid().transform(value => value.toLowerCase()),
    channel: ChannelSchema,
    actorUserId: z.string().uuid().transform(value => value.toLowerCase()),
    reason: z.string().trim().min(16).max(512),
    action: z.enum(["activate", "retire", "revoke"]),
    kid: z.string().regex(CAPABILITY_KEY_ID_PATTERN),
  }).strict(),
]);
export type CloudCapabilityKeyChange = z.input<typeof ChangeSchema>;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const OVERLAP_MS = 24 * 3_600_000;

type KeyRow = { kid: string; state: string; created_at: Date; activated_at: Date | null; retire_after: Date | null };

export const CAPABILITY_KEY_USAGE = `Usage: CLOUD_CAPABILITY_KEY_CHANGE_FILE=<change.json> DATABASE_URL=<migration owner>
  CONTROL_PLANE_CAPABILITY_KEY_CHANNEL=<channel> CLOUD_CAPABILITY_KEYS_JSON=<keyring>
  manage-cloud-capability-key [--execute]

Actions (the "action" field of the change document):
  create    adds a key in state next; it is published in the JWKS at once.
  activate  promotes next to current and demotes current to retiring. With a
            current key, next must have been published for 24 hours first.
            With no current key (first key, or after revoking the current
            one) activation is immediate and skips the 24 h JWKS publish
            window: verifiers that cached the JWKS before create reject the
            new key's tokens until they refetch (max-age 300 s). This is the
            emergency path.
  retire    retires a retiring key once its 24 h overlap has elapsed.
  revoke    removes a published key immediately (emergency).

Without --execute the command prints a plan; execute requires
CLOUD_CAPABILITY_KEY_PLAN_SHA256 set to that plan's planSha256.`;

/** Operator lifecycle for S1 signing keys: create (state next), activate
 * (next -> current, current -> retiring with a 24 h overlap), retire
 * (retiring -> retired once the overlap elapsed) and revoke (emergency,
 * immediate). Activating with no current key skips the 24 h publish window
 * (see CAPABILITY_KEY_USAGE). Dry run by default: the plan hash it returns
 * must be supplied to execute, so a key set or actor that changed in between
 * is refused. */
export async function manageCloudCapabilityKey(
  pool: pg.Pool,
  input: unknown,
  options: {
    databaseUrl: string; channel: string; keyring: CapabilityKeyring; execute?: boolean; approval?: string | undefined;
    railwayEnvironmentName?: string | undefined; productionConfirmed?: string | undefined;
  },
) {
  const parsed = ChangeSchema.safeParse(input);
  if (!parsed.success) throw new RolloutFlagManagementError("Capability key document is invalid");
  const request = parsed.data;
  // Both channel sources must agree and production execution is confirmed,
  // exactly like the rollout-flag command.
  const channel = validateOperatorChannel({
    ...options,
    channelVariable: "CONTROL_PLANE_CAPABILITY_KEY_CHANNEL",
    confirmationVariable: "CONTROL_PLANE_CAPABILITY_KEY_PRODUCTION_CONFIRMED",
    subject: "Capability key",
  });
  if (request.channel !== channel) throw new RolloutFlagManagementError("Capability key deployment channel mismatch");
  const target = parseDatabaseTarget(options.databaseUrl);
  const targetSha256 = hash([request.channel, target.hostname, target.port, target.pathname, decodeURIComponent(target.username)]);
  const requestSha256 = hash(request);
  const client = await pool.connect();
  try {
    await client.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'; SELECT set_config('app.system','on',true)");
    const authority = (await client.query<{ principal: string; database: string; allowed: boolean }>(`SELECT current_user AS principal,current_database() AS database,
      current_user<>'zeros_app' AND bool_and(pg_get_userbyid(relowner)=current_user) AS allowed FROM pg_class
      WHERE oid IN ('public.cloud_capability_signing_keys'::regclass,'public.cloud_capability_key_changes'::regclass)`)).rows[0];
    if (!authority?.allowed || authority.database !== decodeURIComponent(target.pathname.slice(1))) {
      throw new RolloutFlagManagementError("Capability key changes require the exact database migration owner");
    }
    // FOR SHARE fences a concurrent demotion of the actor for this
    // transaction; auth_revision in the plan hash refuses an approval taken
    // before the actor's account changed (a demotion and re-promotion).
    const actor = (await client.query<{ auth_status: string; deleted_at: Date | null; staff_role: string | null; auth_revision: string }>(
      "SELECT auth_status,deleted_at,staff_role,auth_revision::text AS auth_revision FROM users WHERE id=$1 FOR SHARE",
      [request.actorUserId])).rows[0];
    if (!actor || actor.auth_status !== "active" || actor.deleted_at || actor.staff_role !== "platform_owner") {
      throw new RolloutFlagManagementError("Capability key changes require an active platform owner");
    }
    await client.query("SELECT pg_advisory_xact_lock(830741862) /*lock_purpose='capability-key'*/");
    // A receipt means this operation id already ran: replay it verbatim, or
    // refuse an id that now names another change.
    const receipt = (await client.query<{ request_sha256: string; target_sha256: string; plan_sha256: string; transitions: Transition[] }>(
      "SELECT request_sha256,target_sha256,plan_sha256,transitions FROM cloud_capability_key_changes WHERE operation_id=$1",
      [request.operationId])).rows[0];
    if (receipt) {
      if (receipt.request_sha256 !== requestSha256 || receipt.target_sha256 !== targetSha256) {
        throw new RolloutFlagManagementError("Capability key operation already identifies another change");
      }
      await client.query("ROLLBACK");
      return { state: "replayed" as const, planSha256: receipt.plan_sha256, targetSha256: receipt.target_sha256, transitions: receipt.transitions };
    }
    const keys = (await client.query<KeyRow>(`SELECT kid,state,created_at,activated_at,retire_after
      FROM cloud_capability_signing_keys ORDER BY created_at FOR UPDATE`)).rows;
    const byState = (state: string) => keys.filter(key => key.state === state);
    const key = keys.find(candidate => candidate.kid === request.kid);
    const now = Date.now();

    type Transition = { kid: string; from: string | null; to: string };
    const plan = (): { transitions: Transition[]; generated: boolean } => {
      switch (request.action) {
        case "create": {
          if (key) {
            if (key.state === "next" || key.state === "current" || key.state === "retiring") return { transitions: [], generated: false };
            throw new Error("Capability key id was already used and must never return");
          }
          if (byState("next").length) throw new Error("A next capability key already exists; activate or revoke it first");
          return { transitions: [{ kid: request.kid, from: null, to: "next" }], generated: true };
        }
        case "activate": {
          if (!key || key.state !== "next") {
            if (key?.state === "current") return { transitions: [], generated: false };
            throw new Error("Only the next capability key can be activated");
          }
          const current = byState("current")[0];
          if (byState("retiring").length) throw new Error("A retiring capability key is still published; retire it first");
          if (current && key.created_at.getTime() + OVERLAP_MS > now) {
            throw new Error("A next capability key must be published for at least 24 hours before activation");
          }
          // Demote before promoting: the one-current index is not deferrable.
          const transitions: Transition[] = [];
          if (current) transitions.push({ kid: current.kid, from: "current", to: "retiring" });
          transitions.push({ kid: request.kid, from: "next", to: "current" });
          return { transitions, generated: false };
        }
        case "retire": {
          if (!key || key.state !== "retiring") {
            if (key?.state === "retired") return { transitions: [], generated: false };
            throw new Error("Only the retiring capability key can be retired");
          }
          if (!key.retire_after || key.retire_after.getTime() > now) {
            throw new Error("A retiring capability key stays published for at least 24 hours");
          }
          return { transitions: [{ kid: request.kid, from: "retiring", to: "retired" }], generated: false };
        }
        case "revoke": {
          if (!key || key.state === "retired" || key.state === "revoked") {
            if (key?.state === "revoked") return { transitions: [], generated: false };
            throw new Error("Only a published capability key can be revoked");
          }
          return { transitions: [{ kid: request.kid, from: key.state, to: "revoked" }], generated: false };
        }
      }
    };
    const { transitions } = plan();
    const planSha256 = hash({ targetSha256, requestSha256, transitions, keyringVersion: options.keyring.currentKeyVersion, principal: authority.principal,
      actorAuthRevision: actor.auth_revision });
    if (!transitions.length) {
      await client.query("ROLLBACK");
      return { state: "replayed" as const, planSha256, targetSha256, transitions };
    }
    if (!options.execute) {
      await client.query("ROLLBACK");
      return { state: "planned" as const, planSha256, targetSha256, transitions };
    }
    if (options.approval !== planSha256) throw new RolloutFlagManagementError("Capability key plan changed; inspect the current target before execution");
    let publicJwk: unknown;
    for (const transition of transitions) {
      if (transition.to === "next") {
        const pair = generateCapabilityKeypair(transition.kid);
        let sealed;
        try {
          sealed = sealCapabilityPrivateKey(pair.privateSeed, transition.kid, options.keyring);
        } finally {
          pair.privateSeed.fill(0);
        }
        await client.query(`INSERT INTO cloud_capability_signing_keys(kid,public_jwk,key_version,nonce,ciphertext,auth_tag,state)
          VALUES($1,$2,$3,$4,$5,$6,'next')`,
          [transition.kid, JSON.stringify(pair.publicJwk), sealed.keyVersion, sealed.nonce, sealed.ciphertext, sealed.authTag]);
        publicJwk = pair.publicJwk;
      } else if (transition.to === "current") {
        await client.query(`UPDATE cloud_capability_signing_keys SET state='current',activated_at=clock_timestamp() WHERE kid=$1`, [transition.kid]);
      } else if (transition.to === "retiring") {
        await client.query(`UPDATE cloud_capability_signing_keys SET state='retiring',retire_after=clock_timestamp()+interval '24 hours' WHERE kid=$1`, [transition.kid]);
      } else {
        await client.query(`UPDATE cloud_capability_signing_keys SET state=$2 WHERE kid=$1`, [transition.kid, transition.to]);
      }
    }
    // The audit receipt commits with the change; its operation id is the
    // idempotency fence for replays.
    await client.query(`INSERT INTO cloud_capability_key_changes
      (operation_id,actor_user_id,channel,target_sha256,request_sha256,plan_sha256,transitions,reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [request.operationId, request.actorUserId, channel, targetSha256, requestSha256, planSha256,
        JSON.stringify(transitions), request.reason]);
    await client.query("COMMIT");
    return { state: "changed" as const, planSha256, targetSha256, transitions, ...(publicJwk ? { publicJwk } : {}) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  if (process.argv.slice(2).some(arg => arg === "--help" || arg === "-h")) {
    console.log(CAPABILITY_KEY_USAGE);
    return;
  }
  const file = process.env.CLOUD_CAPABILITY_KEY_CHANGE_FILE, databaseUrl = process.env.DATABASE_URL;
  // Both channel sources must agree; neither silently wins (the rollout-flag
  // command behaves the same way).
  const channel = process.env.CONTROL_PLANE_CAPABILITY_KEY_CHANNEL;
  if (!file || !databaseUrl || !channel) throw new RolloutFlagManagementError("Capability key configuration is incomplete");
  const keyring = loadCapabilityKeyring(process.env);
  if (!keyring) throw new RolloutFlagManagementError("Capability key changes require the CLOUD_CAPABILITY_KEYS_JSON keyring");
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "--execute")) throw new RolloutFlagManagementError(`Unsupported operator arguments\n${CAPABILITY_KEY_USAGE}`);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let input: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw new RolloutFlagManagementError("Invalid operator document");
    input = JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
  const pool = createMigrationPool(databaseUrl, { maxConnections: 1 });
  try {
    const result = await manageCloudCapabilityKey(pool, input, {
      databaseUrl, channel, keyring, execute: args.includes("--execute"), approval: process.env.CLOUD_CAPABILITY_KEY_PLAN_SHA256,
      railwayEnvironmentName: process.env.RAILWAY_ENVIRONMENT_NAME,
      productionConfirmed: process.env.CONTROL_PLANE_CAPABILITY_KEY_PRODUCTION_CONFIRMED,
    });
    console.log(JSON.stringify(result));
  } finally { await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main().catch((error: unknown) => {
    // Curated messages are safe and useful; anything else stays generic so a
    // driver error cannot echo connection details into operator logs.
    console.error(error instanceof RolloutFlagManagementError
      ? `[capability-key] ${error.message}`
      : "[capability-key] request failed; inspect the target, owner, actor, key id and approval");
    process.exitCode = 1;
  });
}
