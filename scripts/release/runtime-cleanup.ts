import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createMigrationPool } from "../../apps/control-plane/src/db";
import { planetScaleClient } from "../../apps/control-plane/src/manage-release-migration";
import { PromotionError, requireCheck } from "./contracts";
import { readRuntimeJson, writeRuntimeJson } from "./runtime-artifacts";
import { runtimeReleaseConfig, type RuntimeReleaseConfig } from "./runtime-contracts";
import { cleanupRuntimeDatabase, withRetainedRuntimeDatabase } from "./runtime-database";
import { existingRuntimeDrain, runtimeDrain } from "./runtime-drain";
import { withRuntimeHandoff } from "./runtime-handoff";
import { RuntimeEventSchema, runtimeJournal, type RuntimeEvent, type RuntimeProviderRecovery } from "./runtime-journal";
import { runtimeJson } from "./runtime-proof";
import { runtimeProvider } from "./runtime-provider";
import { retireRuntimeCanary } from "./runtime-qualification";
import { runtimeReleaseStore, runtimeStoreConfig } from "./runtime-storage";

export async function readRuntimeEvents(config: RuntimeReleaseConfig, directory: string, cleanup = false): Promise<RuntimeEvent[]> {
  let names: string[];
  try { names = await readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return []; throw new PromotionError("Runtime cleanup events are unavailable"); }
  requireCheck(names.length <= 1000 && names.every(name => /^\d{4}\.json$/.test(name)), "Runtime cleanup event inventory is invalid");
  const events: RuntimeEvent[] = [];
  for (const name of names.sort()) {
    const event = RuntimeEventSchema.parse(await readRuntimeJson(join(directory, name)));
    requireCheck(event.sequence === events.length + 1 && name === `${String(event.sequence).padStart(4, "0")}.json` &&
      !!event.cleanup === cleanup && runtimeJson(event.source) === runtimeJson(config), "Runtime cleanup events belong to another source or attempt");
    events.push(event);
  }
  return events;
}

export type RuntimeCleanupReceipt = { version: 1; source: RuntimeReleaseConfig; status: "success" | "refused";
  databaseDeleted: boolean; canaryDeleted: boolean | null; drain: "absent" | "released" | "unresolved" };

export async function runRuntimeCleanup(env: NodeJS.ProcessEnv, options: {
  root?: string; fetch?: typeof fetch;
  services?: { store?: typeof runtimeReleaseStore; provider?: typeof runtimeProvider; pool?: typeof createMigrationPool;
    planetScale?: typeof planetScaleClient; readEvents?: typeof readRuntimeEvents; write?: typeof writeRuntimeJson;
    database?: typeof withRetainedRuntimeDatabase; cleanupDatabase?: typeof cleanupRuntimeDatabase;
    handoff?: typeof withRuntimeHandoff; retireCanary?: typeof retireRuntimeCanary;
    existingDrain?: typeof existingRuntimeDrain; drain?: typeof runtimeDrain };
} = {}): Promise<RuntimeCleanupReceipt> {
  const config = runtimeReleaseConfig(env), services = options.services ?? {}, root = options.root ?? process.cwd();
  const directory = join(root, ".context/runtime-release"), write = services.write ?? writeRuntimeJson;
  const receipt: RuntimeCleanupReceipt = { version: 1, source: config, status: "refused", databaseDeleted: false, canaryDeleted: null, drain: "absent" };
  let store: ReturnType<typeof runtimeReleaseStore> | undefined, failed = false;
  try {
    await (services.handoff ?? withRuntimeHandoff)(config, env, async handoff => {
      const main = await (services.readEvents ?? readRuntimeEvents)(config, join(directory, "events"));
      const priorCleanup = await (services.readEvents ?? readRuntimeEvents)(config, join(directory, "cleanup-events"), true);
      const details = [...main, ...priorCleanup].map(event => event.detail), latest = details.filter(detail => detail.kind === "database").at(-1);
      if (!latest) { requireCheck(!handoff && details.length === 0, "Runtime cleanup has no database ownership record"); receipt.databaseDeleted = true; return; }
      const journal = structuredClone(latest.journal);
      const canaries = main.map(event => event.detail).filter(detail => detail.kind === "canary");
      requireCheck(canaries.length <= 1, "Runtime cleanup has conflicting canary intents");
      const canary = canaries[0];
      receipt.canaryDeleted = canary ? details.some(detail => detail.kind === "canary-cleanup" && detail.grantId === canary.claims.jti) : null;
      const stage = main.map(event => event.detail).filter(detail => detail.kind === "stage").at(-1);
      const deploy = main.map(event => event.detail).filter(detail => detail.kind === "deploy").at(-1);
      requireCheck(!deploy || stage, "Runtime cleanup deployment has no staging record");
      const drainAttempted = details.some(detail => detail.kind === "drain") || !!stage;
      receipt.drain = drainAttempted ? "unresolved" : "absent";
      const storage = runtimeStoreConfig(env);
      store = (services.store ?? runtimeReleaseStore)(storage, config.repository);
      const record = runtimeJournal(config, async event => {
        await store!.saveEvent(event);
        await write(join(directory, "cleanup-events", `${String(event.sequence).padStart(4, "0")}.json`), event);
      }, { cleanup: true, sequence: priorCleanup.length });
      let drain: ReturnType<typeof runtimeDrain> | undefined;
      const recovery: RuntimeProviderRecovery | undefined = stage ? { stage, ...(deploy ? { deploy } : {}) } : undefined;
      const provider = (services.provider ?? runtimeProvider)(config, env, storage, {
        fetch: options.fetch, cleanupFetch: options.fetch, record, ...(recovery ? { recovery } : {}),
        inspectDrain: lease => { requireCheck(drain, "Runtime cleanup has no database drain access"); return drain.inspectDrain(lease); },
      });
      const database = { planetScale: (services.planetScale ?? planetScaleClient)({ organization: env.PLANETSCALE_ORG!,
        tokenId: env.PLANETSCALE_SERVICE_TOKEN_ID!, token: env.PLANETSCALE_SERVICE_TOKEN!, fetch: options.fetch }),
        createPool: services.pool ?? createMigrationPool, verifyDatabaseRoute: provider.verifyDatabaseRoute,
        save: (value: typeof journal) => record({ kind: "database", journal: value }) };
      try {
        if (handoff && journal.role.phase === "owned") {
          await (services.database ?? withRetainedRuntimeDatabase)(config, env, journal, handoff, database, async pool => {
            if (canary && !receipt.canaryDeleted) {
              const closed = await (services.retireCanary ?? retireRuntimeCanary)(config, canary, env, pool, { fetch: options.fetch });
              receipt.canaryDeleted = true;
              await record({ kind: "canary-cleanup", grantId: canary.claims.jti, ...closed });
            }
            if (drainAttempted) {
              drain = (services.drain ?? runtimeDrain)(config, pool);
              const existing = await (services.existingDrain ?? existingRuntimeDrain)(config, pool);
              if (existing) {
                requireCheck(!stage || (await provider.recover(existing.lease)).releaseDrain, "Runtime cleanup cannot release an unresolved deployment");
                await drain.endDrain(existing.lease);
                receipt.drain = "released";
                await record({ kind: "drain", phase: "ended", lease: existing.lease });
              } else { requireCheck(!stage, "Runtime staged intent has no persisted drain"); receipt.drain = "absent"; }
            }
          });
        } else {
          await (services.cleanupDatabase ?? cleanupRuntimeDatabase)(config, env, journal, database);
          requireCheck(receipt.canaryDeleted !== false, "Runtime canary cleanup cannot be confirmed without its retained login");
          if (drainAttempted) {
            requireCheck(details.some(detail => detail.kind === "drain" && detail.phase === "ended"), "Runtime drain cleanup cannot be confirmed without its retained login");
            receipt.drain = "released";
          }
        }
      } finally { receipt.databaseDeleted = journal.role.deleted || journal.role.phase === "planned"; }
    });
    receipt.status = "success";
  } catch { failed = true; }
  finally {
    try { await write(join(directory, "runtime-cleanup.json"), receipt); } catch { failed = true; }
    store?.close();
  }
  if (failed) throw new PromotionError("Runtime cleanup is unconfirmed; retained recovery records and the login TTL remain the backstop");
  return receipt;
}
