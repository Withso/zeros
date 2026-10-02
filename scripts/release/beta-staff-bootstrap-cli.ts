import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMigrationPool } from "../../apps/control-plane/src/db.js";
import { planetScaleClient } from "../../apps/control-plane/src/manage-release-migration.js";
import { BetaStaffBootstrapError, betaStaffBootstrapConfig, prepareBetaStaffBootstrap, readBetaStaffBootstrapTarget, runBetaStaffBootstrap,
  type BetaStaffBootstrapDeps, type BetaStaffBootstrapJournal } from "./beta-staff-bootstrap";
import { githubClient } from "./github";
import { command, jsonClient, type Command } from "./io";

async function readJson(file: string, code: "configuration" | "intent"): Promise<unknown> {
  try {
    const handle = await open(file, "r");
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error();
      const bytes = Buffer.alloc(64 * 1024 + 1);
      let size = 0;
      while (size < bytes.length) {
        const result = await handle.read(bytes, size, bytes.length - size, null);
        if (result.bytesRead === 0) break;
        size += result.bytesRead;
      }
      if (size > 64 * 1024) throw new Error();
      return JSON.parse(bytes.subarray(0, size).toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch { throw new BetaStaffBootstrapError(code); }
}

async function exists(file: string): Promise<boolean> {
  try { await stat(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new BetaStaffBootstrapError("journal");
  }
}

async function saveJournal(file: string, journal: BetaStaffBootstrapJournal, initial = false) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(initial ? file : temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (!initial) await rename(temporary, file);
  } catch { throw new BetaStaffBootstrapError("journal"); }
  finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

export async function betaStaffBootstrapMain(args: string[], env: NodeJS.ProcessEnv, options: {
  cwd?: string; fetch?: typeof fetch; command?: Command; createPool?: BetaStaffBootstrapDeps["createPool"]; signal?: AbortSignal;
} = {}): Promise<BetaStaffBootstrapJournal> {
  if (args.length !== 1 || !["--prepare", "--run"].includes(args[0]) || !env.GITHUB_EVENT_PATH || !env.GH_TOKEN?.trim()) {
    throw new BetaStaffBootstrapError("configuration");
  }
  const config = betaStaffBootstrapConfig(env, await readJson(env.GITHUB_EVENT_PATH, "configuration"));
  const cwd = options.cwd ?? process.cwd(), directory = path.join(cwd, ".context/release");
  const intentPath = path.join(directory, "beta-staff-bootstrap-intent.json"), resultPath = path.join(directory, "beta-staff-bootstrap-result.json");
  const runCommand = options.command ?? command, github = githubClient(config, env, { fetch: options.fetch, command: runCommand });
  const planetScale = planetScaleClient({ organization: config.organization, tokenId: env.PLANETSCALE_SERVICE_TOKEN_ID!,
    token: env.PLANETSCALE_SERVICE_TOKEN!, fetch: options.fetch });
  const verifySource = async () => {
    try {
      if ((await runCommand("git", ["rev-parse", "HEAD"], { cwd })).trim() !== config.sourceSha) throw new Error();
      await github.assertRequiredChecks(); await github.assertCurrent();
    } catch { throw new BetaStaffBootstrapError("source"); }
  };
  if (args[0] === "--prepare") {
    await verifySource();
    if (await exists(intentPath) || await exists(resultPath)) throw new BetaStaffBootstrapError("intent");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const journal = prepareBetaStaffBootstrap(config);
    Object.assign(journal.target, await readBetaStaffBootstrapTarget(config, planetScale));
    await saveJournal(intentPath, journal, true);
    return journal;
  }
  const artifactId = env.STAFF_BOOTSTRAP_INTENT_ARTIFACT_ID ?? "";
  if (!/^[1-9]\d*$/.test(artifactId) || !Number.isSafeInteger(Number(artifactId))) throw new BetaStaffBootstrapError("intent");
  try {
    const artifact = await jsonClient(options.fetch)(`https://api.github.com/repos/${config.repository}/actions/artifacts/${artifactId}`, {
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (artifact.id !== Number(artifactId) || artifact.name !== `beta-staff-owner-intent-${config.runId}-${config.runAttempt}` ||
      artifact.expired !== false || String(artifact.workflow_run?.id) !== config.runId || artifact.workflow_run?.head_sha !== config.sourceSha ||
      artifact.workflow_run?.head_branch !== config.branch) throw new Error();
  } catch { throw new BetaStaffBootstrapError("intent"); }
  const retained = await readJson(await exists(resultPath) ? resultPath : intentPath, "intent");
  return runBetaStaffBootstrap(config, retained, {
    planetScale,
    createPool: options.createPool ?? (url => createMigrationPool(url, { role: "postgres", maxConnections: 1, applicationName: "zeros-beta-staff-bootstrap" })),
    verifySource, saveJournal: journal => saveJournal(resultPath, journal), signal: options.signal,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  void betaStaffBootstrapMain(process.argv.slice(2), process.env, { signal: cancellation.signal }).then(journal => {
    console.log(journal.staff ? `Beta staff ${journal.staff.state}; temporary owner role absence verified.` : "Beta staff role-create intent prepared; no provider mutation.");
  }).catch(error => {
    console.error(error instanceof BetaStaffBootstrapError ? error.message : "Beta staff bootstrap failed; details withheld.");
    process.exitCode = 1;
  }).finally(() => { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); });
}
