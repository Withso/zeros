// Operator-only reproduction of the published Alpha runtime. No control-plane
// database, registry, environment or runtime files are changed by this tool.
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { builderFixedCommand, BUILDER_BASE_STATUS_COMMAND, parseBuilderDiagnostic } from "../../apps/control-plane/src/cloud-workspaces/cloud-builder-commands";
import { executeBoatPinnedSsh } from "../../apps/control-plane/src/cloud-workspaces/boat-pinned-ssh";
import { RuntimeBaseStatusSchema, RuntimeInstallInputSchema } from "../../apps/control-plane/src/cloud-workspaces/runtime-contract";
import { boatClient, builderCommand, type KitDeps, type BoatRequest } from "./boat-image/boat-image";
import { pythonProbe, remote, saveJson, waitSandbox } from "./boat-image/runtime-base-v4";
import { presignGet } from "./runtime-base-v4/live-check";

export const REPRO_RUNTIME = Object.freeze({
  runtimeId: "r1-8a4dc340083cf827745300a70765bcfed5248704f6e68415b2fe76ec0324114b",
  manifestSha256: "8a4dc340083cf827745300a70765bcfed5248704f6e68415b2fe76ec0324114b",
  archiveSha256: "fb6cdcc390075ac3ade7c2becfd35053a9c951376c42432efda4964d6e8e943a",
  archiveBytes: 794594494, expandedBytes: 2105422766,
  sourceCommit: "b9834ef8f851d41b9ecb1671f10470b6ced576d1", nodeModulesAbi: 127,
  bootstrapProtocolVersion: 1, engineProtocolVersion: 20,
});
const SNAPSHOT = "zeros-v2-test-base-v4-3";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const ID = /^bx_[a-z0-9]+$/;
const OPERATION = /^bdop_[a-f0-9]{32}$/;
type R2 = Parameters<typeof presignGet>[0];
type Execute = (input: Parameters<typeof executeBoatPinnedSsh>[0]) => ReturnType<typeof executeBoatPinnedSsh>;
type Emit = (value: unknown) => void;

class ReproFailure extends Error {
  constructor(readonly check: string) { super(check); }
}
function requireRepro(value: unknown, check: string): asserts value {
  if (!value) throw new ReproFailure(check);
}

export function reproBudget(args: string[]) {
  requireRepro(args.length === 2 && args[0] === "--max-used-hours" && /^[0-9]+(?:\.[0-9]+)?$/.test(args[1]), "input_schema");
  const hours = Number(args[1]);
  requireRepro(hours > 0 && hours <= 32, "budget_limit");
  return hours;
}

export function loadReproCredentials(root: string) {
  let values: Record<string, string | undefined>;
  try { values = parseEnv(fs.readFileSync(path.join(root, ".env.agent"), "utf8")); }
  catch { throw new ReproFailure("credential_file_missing"); }
  const apiKey = values.BOAT_API_KEY, billingOrg = values.BOAT_BILLING_ORG;
  const r2 = { endpoint: values.ZEROS_R2_ALPHA_ENDPOINT?.replace(/\/$/, ""), bucket: values.ZEROS_R2_ALPHA_BUCKET,
    accessKeyId: values.ZEROS_R2_ALPHA_ACCESS_KEY_ID, secretAccessKey: values.ZEROS_R2_ALPHA_SECRET_ACCESS_KEY };
  requireRepro(apiKey && billingOrg && /^[a-z0-9-]{1,128}$/i.test(billingOrg), "boat_credentials_missing");
  requireRepro(/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(r2.endpoint ?? "") &&
    r2.bucket === "zeros-cloud-workspaces-alpha" && r2.accessKeyId && r2.secretAccessKey, "alpha_r2_credentials_missing");
  return { apiKey, billingOrg, r2: r2 as R2,
    secrets: Object.values(values).filter((value): value is string => typeof value === "string" && value.length > 0) };
}

/** Apply before truncating or writing any provider/probe text, including private
 * evidence. Actual credential values are additionally scrubbed in the CLI. */
export function redactReproText(input: string, secrets: string[] = [], maximum = 2000): string {
  let text = input;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join("[redacted]");
  return text.replace(/https?:\/\/[^\s<>"']+/gi, "[url]")
    .replace(/\bBearer\s+[^\s"']+/gi, "[authorization]")
    .replace(/\b(?:ghs_|gho_|ghp_|ghu_|github_pat_|condw_|sk_|sk-)[A-Za-z0-9_-]+/g, "[token]")
    .replace(/\b[A-Z_][A-Z0-9_]*\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/g, "[assignment]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[jwt]")
    .replace(/\b[a-fA-F0-9]{32,}\b/g, "[hex]")
    .replace(/[A-Za-z0-9+/_-]{48,}={0,2}/g, "[opaque]")
    .replace(/\b(?:curl|wget)\b/g, "download-tool")
    .slice(-maximum);
}

function scrub(value: unknown, secrets: string[] = [], depth = 0): unknown {
  if (depth > 12) return "[depth-limit]";
  if (typeof value === "string") return redactReproText(value, secrets);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.slice(0, 128).map(item => scrub(item, secrets, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 128)
    .map(([key, item]) => [redactReproText(key, secrets, 100), scrub(item, secrets, depth + 1)]));
  return null;
}

export async function containmentRepro({ deps: initial, maxUsedHours, r2, emit: output, execute, wait = delay, secrets = [] }: {
  deps: KitDeps; maxUsedHours: number; r2: R2; emit: Emit; execute?: Execute; wait?: (ms: number) => Promise<unknown>; secrets?: string[];
}) {
  requireRepro(maxUsedHours > 0 && maxUsedHours <= 32, "budget_limit");
  const emit: Emit = value => output(scrub(value, secrets));
  const name = `zeros-v2-test-containment-${initial.randomHex().slice(0, 12)}`;
  const owned = new Set<string>();
  let phase = "create";
  let createAttempted = false;
  let createResolved = false;
  // Reuse kit budgets/idempotency/wallet checks. Only the requested builder
  // body differs from the legacy image kit; never alter its global behavior.
  const boat: BoatRequest = async (method, endpoint, options = {}) => {
    const create = method === "POST" && endpoint === "/sandboxes";
    if (create) createAttempted = true;
    const reply = await initial.boat(method, endpoint, { ...options,
      ...(create ? { body: { ...(options.body as object), name, snapshots: true } } : {}),
      headers: { ...options.headers, "x-boat-org": initial.billingOrg } });
    if (create) {
      const id = reply.body?.sandbox?.id ?? reply.body?.sandboxId;
      if (typeof id === "string" && ID.test(id)) {
        owned.add(id); createResolved = true;
        saveJson(path.join(initial.stateDir, "owned.json"), { name, ids: [...owned] });
      } else if ([400, 401, 403, 422].includes(reply.status)) createResolved = true;
    }
    return reply;
  };
  const deps = { ...initial, boat };
  const fixed: Execute = execute ?? (input => executeBoatPinnedSsh(input, { maxOutputBytes: 64 * 1024,
    client: { request: async (endpoint, options = {}) => {
      const result = await boat(options.method ?? "GET", endpoint, { body: options.body, timeoutMs: options.timeoutMs });
      requireRepro(result.status >= 200 && result.status < 300, "ssh_provider_response");
      return result.body;
    } } }, AbortSignal.timeout((input.timeoutSeconds + 60) * 1000)));
  const probeSource = fs.readFileSync(path.join(HERE, "runtime-base-v4/containment_repro.py"), "utf8");
  const probe = async (id: string, mode: "host" | "qualify" | "launch_detail") => {
    const reply = await remote(deps, id, pythonProbe(`${probeSource}\nmain(${JSON.stringify(mode)}, ${JSON.stringify(REPRO_RUNTIME.runtimeId)})`, "verify"), mode === "host" ? 60 : 390);
    requireRepro(reply.status === 200 && reply.body?.exitCode === 0 && !reply.body?.timedOut && !reply.body?.stdoutTruncated &&
      typeof reply.body.stdout === "string" && Buffer.byteLength(reply.body.stdout) <= 128 * 1024, "probe_response");
    let result;
    try { result = JSON.parse(reply.body.stdout); } catch { throw new ReproFailure("probe_json"); }
    requireRepro(result && typeof result === "object" && !Array.isArray(result) && result.mode === mode, "probe_shape");
    emit({ ...result, event: mode });
    return result;
  };
  const status = async (id: string, installed = false) => {
    const deadline = deps.now() + 12 * 60_000;
    while (deps.now() < deadline) {
      const reply = await remote(deps, id, BUILDER_BASE_STATUS_COMMAND, 30);
      let value;
      try { value = RuntimeBaseStatusSchema.safeParse(JSON.parse(reply.body?.stdout ?? "")); } catch { /* Still booting. */ }
      if (reply.status === 200 && reply.body?.exitCode === 0 && !reply.body?.stdoutTruncated && value?.success &&
          ["idle", "waiting_for_runtime"].includes(value.data.hostState)) {
        requireRepro(!installed || (value.data.hostState === "idle" && value.data.currentRuntimeId === REPRO_RUNTIME.runtimeId), "runtime_identity");
        emit({ event: "base_status", installed, hostState: value.data.hostState, runtimeMatches: value.data.currentRuntimeId === REPRO_RUNTIME.runtimeId });
        return;
      }
      await wait(3000);
    }
    throw new ReproFailure("base_timeout");
  };
  const create = () => builderCommand("create", new Map([["--from", SNAPSHOT], ["--max-used-hours", String(maxUsedHours)]]), [], deps);
  try {
    let created;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { created = await create() as { id: string }; break; }
      catch (error) {
        if (owned.size || createResolved || !fs.existsSync(path.join(deps.stateDir, "builder-intent.json")) || attempt === 2) throw error;
        await wait(3000); // Replay the kit's persisted request, never a new key.
      }
    }
    requireRepro(created && ID.test(created.id), "create_response");
    const id = created.id;
    emit({ event: "created", name, sandboxId: id });
    await waitSandbox(deps, id);
    phase = "base_status";
    await status(id);
    await probe(id, "host");
    phase = "install_runtime";
    const objectKey = `runtime/v1/${REPRO_RUNTIME.runtimeId}/${REPRO_RUNTIME.archiveSha256}.tar.gz`;
    const payload = RuntimeInstallInputSchema.parse({ schema: "zeros.runtime-install/v1", purpose: "qualification",
      runtime: REPRO_RUNTIME, artifact: presignGet(r2, objectKey) });
    // The signed URL lives only in this process and the pinned SSH stdin.
    const install = await fixed({ resourceId: id, command: builderFixedCommand("install-runtime", null)!,
      stdin: Buffer.from(JSON.stringify(payload)).toString("base64url"), timeoutSeconds: 600 });
    const installed = !install.outputTruncated && parseBuilderDiagnostic(install.output, "install-runtime", install.exitCode);
    if (installed) emit(installed);
    requireRepro(installed && installed.ok, "install_runtime");
    await status(id, true);
    phase = "self_test";
    const tested = await fixed({ resourceId: id, command: builderFixedCommand("runtime-self-test", REPRO_RUNTIME.runtimeId)!, stdin: "", timeoutSeconds: 600 });
    const result = !tested.outputTruncated && parseBuilderDiagnostic(tested.output, "runtime-self-test", tested.exitCode);
    if (result) emit(result);
    else emit({ event: "self_test", check: "diagnostic_missing", exitCode: tested.exitCode });
    // A failed smoke is the evidence sought. Continue to the expanded report.
    phase = "qualify";
    const qualified = await probe(id, "qualify");
    if (!qualified.report) {
      phase = "launch_detail";
      await probe(id, "launch_detail");
    }
    await probe(id, "host");
  } catch (error) {
    emit({ event: "failure", phase, check: error instanceof ReproFailure ? error.check : "operation_failed",
      errorClass: error instanceof TypeError ? "TypeError" : error instanceof SyntaxError ? "SyntaxError" : "Error" });
    throw new ReproFailure("reproduction_failed");
  } finally {
    // Resolve a lost create reply using the SAME durable intent before cleanup.
    if (createAttempted && !createResolved && !owned.size) {
      try { await create(); } catch { /* Report an unresolved create below. */ }
    }
    let cleaned = !createAttempted || createResolved;
    for (const id of owned) {
      let absent = false, operationId: string | null = null, operationStatus = "unconfirmed";
      let deleteAccepted = false;
      const deadline = deps.now() + 180_000;
      while (deps.now() < deadline) {
        try {
          if (!deleteAccepted) {
            const reply = await boat("DELETE", `/sandboxes/${id}`, { headers: { "x-ascii-confirm-delete": id } });
            requireRepro(reply.status === 404 || (reply.status >= 200 && reply.status < 300), "delete_response");
            const operation = reply.body?.operation;
            if (operation?.targetId === id && operation.kind === "sandbox" && OPERATION.test(operation.id)) operationId = operation.id;
            saveJson(path.join(deps.stateDir, `delete-${id}.json`), { sandboxId: id, operationId, absent: false });
            deleteAccepted = true;
          }
          if (operationId) {
            const poll = await boat("GET", `/deletion-operations/${operationId}`);
            const value = poll.body?.operation;
            requireRepro(poll.status === 200 && value?.id === operationId && value?.targetId === id &&
              ["pending", "processing", "blocked", "completed"].includes(value?.status), "delete_operation");
            operationStatus = value.status;
          }
          const observed = await boat("GET", `/sandboxes/${id}`);
          absent = observed.status === 404;
          if (absent && (!operationId || operationStatus === "completed")) break;
        } catch { /* Retry lost DELETE/observation replies with the same ID. */ }
        await wait(2000);
      }
      cleaned &&= absent && (!operationId || operationStatus === "completed");
      if (absent && !operationId) operationStatus = "absent";
      const deletion = { event: "cleanup", sandboxId: id, operationId, status: operationStatus, absent };
      saveJson(path.join(deps.stateDir, `delete-${id}.json`), deletion);
      emit(deletion);
    }
    if (!cleaned) {
      emit({ event: "cleanup", check: "cleanup_unconfirmed", absent: false });
      throw new ReproFailure("cleanup_unconfirmed");
    }
  }
}

async function main() {
  const maxUsedHours = reproBudget(process.argv.slice(2));
  const { apiKey, billingOrg, r2, secrets } = loadReproCredentials(REPO);
  const parent = path.join(REPO, ".context");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stateDir = fs.mkdtempSync(path.join(parent, "containment-repro-"));
  fs.chmodSync(stateDir, 0o700);
  const emit = (value: unknown) => {
    const line = JSON.stringify(scrub(value, secrets)) + "\n";
    fs.appendFileSync(path.join(stateDir, "report.jsonl"), line, { mode: 0o600 });
    process.stdout.write(line);
  };
  emit({ event: "evidence", directory: path.relative(REPO, stateDir) });
  await containmentRepro({ deps: { boat: boatClient(apiKey), billingOrg, stateDir, repoRoot: REPO,
    now: Date.now, randomHex: () => randomBytes(16).toString("hex"), randomUUID, imageContract: () => "unused" }, maxUsedHours, r2, emit, secrets });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ event: "reproduction_failed", check: error instanceof ReproFailure ? error.check : "operation_failed" }) + "\n");
    process.exitCode = 1;
  });
}
