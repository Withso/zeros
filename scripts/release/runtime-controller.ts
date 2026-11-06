import { join } from "node:path";
import { createMigrationPool } from "../../apps/control-plane/src/db";
import { planetScaleClient } from "../../apps/control-plane/src/manage-release-migration";
import { PromotionError, requireCheck } from "./contracts";
import { readRuntimeJson, writeRuntimeJson } from "./runtime-artifacts";
import { verifyRuntimeBuild } from "./runtime-build";
import { runtimeReleaseConfig } from "./runtime-contracts";
import { prepareRuntimeDatabase, withRuntimeDatabase } from "./runtime-database";
import { runtimeDrain } from "./runtime-drain";
import { runtimeGithub } from "./runtime-github";
import { writeRuntimeHandoff } from "./runtime-handoff";
import { runtimeJournal } from "./runtime-journal";
import { runtimeJson, verifyRuntimeQualification, prepareRuntimePublication, completeRuntimePublication } from "./runtime-proof";
import { runtimeProvider } from "./runtime-provider";
import { releaseRuntime, type RuntimeReleaseReceipt } from "./runtime-release";
import { runtimeReleaseStore, runtimeStoreConfig } from "./runtime-storage";

export async function runRuntimeController(env: NodeJS.ProcessEnv, options: {
  root?: string; signal?: AbortSignal; fetch?: typeof fetch;
  services?: {
    store?: typeof runtimeReleaseStore; github?: typeof runtimeGithub; provider?: typeof runtimeProvider;
    database?: typeof withRuntimeDatabase; drain?: typeof runtimeDrain;
    read?: typeof readRuntimeJson; write?: typeof writeRuntimeJson; pool?: typeof createMigrationPool; planetScale?: typeof planetScaleClient;
    handoff?: typeof writeRuntimeHandoff;
  };
} = {}): Promise<RuntimeReleaseReceipt> {
  const config = runtimeReleaseConfig(env), services = options.services ?? {}, root = options.root ?? process.cwd();
  requireCheck(env.RUNNER_ENVIRONMENT === "github-hosted", "Runtime releases require an ephemeral GitHub-hosted runner");
  const storeConfig = runtimeStoreConfig(env), storeFactory = services.store ?? runtimeReleaseStore;
  const alphaConfig = config.action === "promote" ? runtimeStoreConfig(env, "CLOUD_RUNTIME_ALPHA_STORE_") : undefined;
  const store = storeFactory(storeConfig, config.repository);
  const fromAlpha = alphaConfig ? storeFactory(alphaConfig, config.repository) : undefined;
  const read = services.read ?? readRuntimeJson, write = services.write ?? writeRuntimeJson;
  const directory = join(root, ".context/runtime-release"), checkActive = () => requireCheck(!options.signal?.aborted, "Runtime release was cancelled; no further mutation is authorized");
  const fetcher = options.fetch ?? fetch;
  const activeFetch: typeof fetch = (url, init) => fetcher(url, { ...init,
    ...(options.signal ? { signal: AbortSignal.any([options.signal, ...(init?.signal ? [init.signal] : [])]) } : {}) });
  const github = (services.github ?? runtimeGithub)(config, env, { fetch: activeFetch });
  const source = async () => {
    checkActive(); await github.source();
    if (config.action === "promote") await github.alphaCurrent(config.runtimeSha256!);
    checkActive();
  };
  const record = runtimeJournal(config, async event => {
    await store.saveEvent(event);
    await write(join(directory, "events", `${String(event.sequence).padStart(4, "0")}.json`), event);
  });
  let drain: ReturnType<typeof runtimeDrain> | undefined;
  const provider = (services.provider ?? runtimeProvider)(config, env, storeConfig, { fetch: activeFetch, cleanupFetch: fetcher,
    ...(options.signal ? { signal: options.signal } : {}),
    inspectDrain: lease => { requireCheck(drain, "The runtime build drain is not available"); return drain.inspectDrain(lease); },
    record: async intent => { if (intent.kind !== "restore") checkActive(); await record(intent); if (intent.kind !== "restore") checkActive(); },
  });
  let receipt: RuntimeReleaseReceipt | undefined;
  let publication: ReturnType<typeof prepareRuntimePublication> | undefined;
  try {
    await source(); await provider.current();
    const artifact = config.action === "publish" ? await verifyRuntimeBuild(config,
      await read(join(root, ".context/runtime-build/runtime-build.json")), github.read) : undefined;
    const journal = prepareRuntimeDatabase(config, env);
    await (services.database ?? withRuntimeDatabase)(config, env, journal, {
      planetScale: (services.planetScale ?? planetScaleClient)({ organization: env.PLANETSCALE_ORG!,
        tokenId: env.PLANETSCALE_SERVICE_TOKEN_ID!, token: env.PLANETSCALE_SERVICE_TOKEN!, fetch: fetcher }),
      createPool: services.pool ?? createMigrationPool, verifyDatabaseRoute: provider.verifyDatabaseRoute,
      retain: (login, expiresAt) => (services.handoff ?? writeRuntimeHandoff)(config, env, login, expiresAt), deferCleanupOnFailure: true,
      save: value => record({ kind: "database", journal: value }), ...(options.signal ? { signal: options.signal } : {}),
    }, async pool => {
      drain = (services.drain ?? runtimeDrain)(config, pool);
      await releaseRuntime(config, { ...provider, ...drain, source,
        beginDrain: async () => {
          checkActive(); await record({ kind: "drain", phase: "requested", lease: null }); checkActive();
          const result = await drain!.beginDrain(); await record({ kind: "drain", phase: "acquired", lease: result.lease }); return result;
        },
        endDrain: async lease => {
          const result = await drain!.endDrain(lease); await record({ kind: "drain", phase: "ended", lease }); return result;
        },
        prepare: async digest => {
          checkActive();
          if (config.action !== "publish") { requireCheck(digest, "Runtime copy requires a digest"); return store.copy(digest, fromAlpha); }
          requireCheck(artifact, "Runtime publication requires its exact build proof");
          const manifest = await store.publish(join(root, ".context/runtime-build/runtime.tar.gz"), artifact.manifest.sourceSha, artifact.manifest.sourceSha256);
          requireCheck(runtimeJson(manifest) === runtimeJson(artifact.manifest), "Runtime archive differs from its exact-attempt build artifact");
          return manifest;
        },
        qualify: async manifest => {
          checkActive();
          publication = prepareRuntimePublication(config, manifest);
          await write(join(directory, "runtime-publication-intent.json"), publication.intent);
          checkActive(); return publication.release;
        },
        qualification: async (manifest, origin, pinnedPrevious) => {
          checkActive();
          const proof = await verifyRuntimeQualification(config, manifest,
            await (fromAlpha ?? store).qualification(manifest.sha256, origin.runId, origin.runAttempt), github, pinnedPrevious);
          await store.saveQualification(proof); await write(join(directory, "runtime-qualification.json"), proof);
          return proof.release;
        },
        retain: pin => { checkActive(); return store.retain(pin); },
        record: async value => { checkActive(); receipt = value; },
      });
    });
    checkActive(); requireCheck(receipt, "Runtime release did not confirm a final receipt");
    await store.saveReceipt(receipt); await write(join(directory, "runtime-receipt.json"), receipt);
    if (config.channel === "alpha") {
      checkActive();
      requireCheck(publication, "Alpha release did not retain its publication intent");
      const proof = completeRuntimePublication(publication, receipt);
      await store.saveQualification(proof); await write(join(directory, "runtime-qualification.json"), proof);
    }
    return receipt;
  } catch (error) {
    throw new PromotionError(error instanceof PromotionError ? error.message : "Runtime release failed; private diagnostics withheld. Reconcile its durable intent before retrying.");
  } finally { store.close(); fromAlpha?.close(); }
}
