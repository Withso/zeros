import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { KNOWN_KEYS, parseAgentEnv } from "../../agent-env-check.mjs";
import { cleanupAcceptance, journalSchema, runAcceptance } from "./runner";
import type { AlphaLiveUpdateAdapter, Journal, Operation, Report } from "./contract";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** fsync before acknowledging the journal: create may succeed without a reply.
 * Journal contains only fixed phases, test operation/name and workspace UUIDs. */
export async function writeJournal(directory: string, record: Journal): Promise<void> {
  const safe = journalSchema.parse(record);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== path.resolve(directory)) throw new Error("Journal directory rejected");
  const destination = path.join(directory, `${safe.name}.json`);
  const temporary = path.join(directory, `${safe.name}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(safe) + "\n"); await handle.sync(); await handle.close();
    if (safe.phase === "allocated") {
      // Reserve the final path exclusively. Never replace another run's journal.
      const reserved = await open(destination, "wx", 0o600); await reserved.close();
    }
    await rename(temporary, destination);
    const parent = await open(directory, "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await handle.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
}

export async function main(args: string[]): Promise<number> {
  let report: Report = { version: 1, operationId: randomUUID(), outcome: "blocked", code: "adapter_not_configured", cleaned: true };
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const flags = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      if (!["--adapter", "--cleanup"].includes(args[i]) || !args[i + 1] || flags.has(args[i])) throw new Error();
      flags.set(args[i], args[i + 1]);
    }
    if (flags.has("--cleanup")) { report.outcome = "cleanup_required"; report.cleaned = false; }
    if (!flags.has("--adapter")) return 2;
    report.code = "adapter_configuration_rejected";
    const adapterPath = await realpath(path.resolve(ROOT, flags.get("--adapter")!));
    const allowed = await realpath(path.join(ROOT, "scripts/cloud-workspace-validation"));
    if (!adapterPath.startsWith(allowed + path.sep) || !/\.(?:mjs|ts)$/.test(adapterPath)) throw new Error();
    const credentials = parseAgentEnv(await readFile(path.join(ROOT, ".env.agent"), "utf8"));
    if (credentials.malformedLines.length || credentials.duplicateKeys.length) throw new Error();
    const values = new Map<string, string>();
    for (const key of KNOWN_KEYS) { const value = credentials.values.get(key); if (value) values.set(key, value); }
    // The reviewed local adapter is trusted code. Factory/import/preflight are
    // read-only and silent; no arbitrary provider URL is accepted by this CLI.
    const module = await import(pathToFileURL(adapterPath).href) as {
      createAlphaLiveUpdateAdapter(input: { credentials: ReadonlyMap<string, string>; signal: AbortSignal }): Promise<AlphaLiveUpdateAdapter>;
    };
    if (typeof module.createAlphaLiveUpdateAdapter !== "function") throw new Error();
    const adapter = await module.createAlphaLiveUpdateAdapter({ credentials: values, signal: controller.signal });
    const journal = (record: Journal) => writeJournal(path.join(ROOT, ".context"), record);
    if (flags.has("--cleanup")) {
      const file = await realpath(path.resolve(ROOT, flags.get("--cleanup")!));
      const context = await realpath(path.join(ROOT, ".context"));
      if (path.dirname(file) !== context) throw new Error();
      const saved = journalSchema.parse(JSON.parse(await readFile(file, "utf8")));
      if (path.basename(file) !== `${saved.name}.json`) throw new Error();
      report = { version: 1, operationId: saved.operationId, workspaceId: saved.workspace?.workspaceId,
        outcome: "cleanup_required", code: "cleanup_unconfirmed", cleaned: false };
      // Cleanup stays available after a qualification is revoked. Verify Alpha
      // and org authority, but do not require an eligible target pair to delete.
      const preflight = z.object({ version: z.literal(1), channel: z.literal("alpha"), staff: z.literal(true), organizationId: z.uuid() })
        .parse(await adapter.preflight(AbortSignal.timeout(10_000)));
      if (saved.workspace && saved.workspace.organizationId !== preflight.organizationId) throw new Error();
      const operation: Operation = { version: 1, operationId: saved.operationId, name: saved.name };
      const cleaned = await cleanupAcceptance(adapter, operation, { journal }, saved.workspace);
      report = { version: 1, operationId: saved.operationId, workspaceId: saved.workspace?.workspaceId,
        outcome: cleaned ? "passed" : "cleanup_required", code: cleaned ? "cleanup_verified" : "cleanup_unconfirmed", cleaned };
    } else report = await runAcceptance(adapter, { journal, signal: controller.signal });
    return report.outcome === "passed" ? 0 : report.outcome === "blocked" ? 2 : 1;
  } catch { return 2; }
  finally {
    process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
    process.stdout.write(JSON.stringify(report) + "\n");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    process.stdout.write('{"version":1,"outcome":"blocked","code":"runner_failed","cleaned":false}\n'); process.exitCode = 2;
  });
}
