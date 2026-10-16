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

const ChangeSchema = z.discriminatedUnion("action", [
  z.object({
    operationId: z.string().uuid(),
    channel: z.enum(["development", "alpha", "beta", "production"]),
    actorUserId: z.string().uuid(),
    reason: z.string().trim().min(16).max(512),
    action: z.literal("create"),
    kid: z.string().regex(CAPABILITY_KEY_ID_PATTERN),
  }).strict(),
  z.object({
    operationId: z.string().uuid(),
    channel: z.enum(["development", "alpha", "beta", "production"]),
    actorUserId: z.string().uuid(),
    reason: z.string().trim().min(16).max(512),
    action: z.enum(["activate", "retire", "revoke"]),
    kid: z.string().regex(CAPABILITY_KEY_ID_PATTERN),
  }).strict(),
]);
export type CloudCapabilityKeyChange = z.input<typeof ChangeSchema>;

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const OVERLAP_MS = 24 * 3_600_000;

type KeyRow = { kid: string; state: string; created_at: Date; activated_at: Date | null; retire_after: Date | null };

/** Operator lifecycle for S1 signing keys: create (state next), activate
 * (next -> current, current -> retiring with a 24 h overlap), retire
 * (retiring -> retired once the overlap elapsed) and revoke (emergency,
 * immediate). Dry run by default: the plan hash it returns must be supplied
 * to execute, so a key set that changed in between is refused. */
export async function manageCloudCapabilityKey(
  pool: pg.Pool,
  input: unknown,
  options: { databaseUrl: string; channel: string; keyring: CapabilityKeyring; execute?: boolean; approval?: string | undefined },
) {
  const parsed = ChangeSchema.safeParse(input);
  if (!parsed.success) throw new Error("Capability key document is invalid");
  const request = parsed.data;
  if (request.channel !== options.channel) throw new Error("Capability key deployment channel mismatch");
  const target = parseDatabaseTarget(options.databaseUrl);
  const targetSha256 = hash([request.channel, target.hostname, target.port, target.pathname, decodeURIComponent(target.username)]);
  const requestSha256 = hash(request);
  const client = await pool.connect();
  try {
    await client.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='15s'; SELECT set_config('app.system','on',true)");
    const authority = (await client.query<{ principal: string; database: string; allowed: boolean }>(`SELECT current_user AS principal,current_database() AS database,
      current_user<>'zeros_app' AND pg_get_userbyid(relowner)=current_user AS allowed FROM pg_class
      WHERE oid='public.cloud_capability_signing_keys'::regclass`)).rows[0];
    if (!authority?.allowed || authority.database !== decodeURIComponent(target.pathname.slice(1))) {
      throw new Error("Capability key changes require the exact database migration owner");
    }
    const actor = (await client.query<{ auth_status: string; deleted_at: Date | null; staff_role: string | null }>(
      "SELECT auth_status,deleted_at,staff_role FROM users WHERE id=$1", [request.actorUserId])).rows[0];
    if (!actor || actor.auth_status !== "active" || actor.deleted_at || actor.staff_role !== "platform_owner") {
      throw new Error("Capability key changes require an active platform owner");
    }
    await client.query("SELECT pg_advisory_xact_lock(830741862)");
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
    const planSha256 = hash({ targetSha256, requestSha256, transitions, keyringVersion: options.keyring.currentKeyVersion, principal: authority.principal });
    if (!transitions.length) {
      await client.query("ROLLBACK");
      return { state: "replayed" as const, planSha256, targetSha256, transitions };
    }
    if (!options.execute) {
      await client.query("ROLLBACK");
      return { state: "planned" as const, planSha256, targetSha256, transitions };
    }
    if (options.approval !== planSha256) throw new Error("Capability key plan changed; inspect the current target before execution");
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
  const file = process.env.CLOUD_CAPABILITY_KEY_CHANGE_FILE, databaseUrl = process.env.DATABASE_URL;
  const channel = process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.CONTROL_PLANE_CAPABILITY_KEY_CHANNEL;
  if (!file || !databaseUrl || !channel) throw new Error("Capability key configuration is incomplete");
  const keyring = loadCapabilityKeyring(process.env);
  if (!keyring) throw new Error("Capability key changes require the CLOUD_CAPABILITY_KEYS_JSON keyring");
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "--execute")) throw new Error("Unsupported operator arguments");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let input: unknown;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw new Error("Invalid operator document");
    input = JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
  const pool = createMigrationPool(databaseUrl, { maxConnections: 1 });
  try {
    const result = await manageCloudCapabilityKey(pool, input, {
      databaseUrl, channel, keyring, execute: args.includes("--execute"), approval: process.env.CLOUD_CAPABILITY_KEY_PLAN_SHA256,
    });
    console.log(JSON.stringify(result));
  } finally { await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void main().catch(() => {
    console.error("[capability-key] request failed; inspect the target, owner, actor, key id and approval");
    process.exitCode = 1;
  });
}
