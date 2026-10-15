import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGitHubApi } from "../ci/recovery-api.mjs";
import { downloadArtifact, jsonFromZip } from "../agent-runtime/artifacts.mjs";
import { collectSoak } from "./soak";
import { PublicHourlyTrustSchema } from "./hourly-artifact";
import { REPO } from "./hourly-actions.mjs";
import { ZerosDevError, closedError } from "./errors";

const HELP = "Usage: pnpm exec tsx scripts/zeros-dev/soak-cli.ts --end <UTC-hour> --device-id <uuid> --public-key <Ed25519-base64url> --output <new-file> [--profile hourly|infrastructure]\nReads Actions only using GITHUB_TOKEN or GH_TOKEN. The verifier is public; no .env.agent or provider keys are read. Infrastructure reports exclude the owner's §7 agent/UI test.\n";
type Options = { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; write?: (value: unknown) => void; now?: () => number };

export async function soakMain(argv: string[], options: Options = {}): Promise<number> {
  const write = options.write ?? ((value: unknown) => { process.stdout.write(JSON.stringify(value) + "\n"); });
  let file: Awaited<ReturnType<typeof open>> | undefined, parent: Awaited<ReturnType<typeof open>> | undefined;
  let stage: "input" | "file" | "collection" = "input";
  let profile: "hourly" | "infrastructure" = "hourly";
  try {
    // A valid base64url key can begin with '-'. Bind only this exact value
    // shape to its known flag before the strict option parser sees it.
    const args = [...argv], index = args.indexOf("--public-key");
    if (index >= 0 && /^[A-Za-z0-9_-]{43}$/.test(args[index + 1] ?? "")) args.splice(index, 2, `--public-key=${args[index + 1]}`);
    const { values } = parseArgs({ args, strict: true, allowPositionals: false,
      options: { end: { type: "string" }, "device-id": { type: "string" }, "public-key": { type: "string" }, output: { type: "string" },
        profile: { type: "string" }, help: { type: "boolean" } } });
    if (values.help) { process.stdout.write(HELP); return 0; }
    if (!values.end || !values.output || !path.isAbsolute(values.output)) throw new ZerosDevError("invalid_request");
    if (values.profile !== undefined && values.profile !== "hourly" && values.profile !== "infrastructure") throw new ZerosDevError("invalid_request");
    profile = values.profile ?? "hourly";
    const trust = PublicHourlyTrustSchema.parse({ deviceId: values["device-id"], publicKey: values["public-key"] });
    const destination = path.resolve(values.output);
    const directory = path.dirname(destination), same = (a: { ino: number; dev: number }, b: { ino: number; dev: number }) => a.ino === b.ino && a.dev === b.dev;
    stage = "file";
    parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parentInfo = await parent.stat();
    if (!parentInfo.isDirectory() || parentInfo.uid !== process.getuid?.() || parentInfo.mode & 0o022 || await realpath(directory) !== directory)
      throw new ZerosDevError("artifact_invalid");
    // Refuse replacement and aliases; validate and write the same descriptor.
    file = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600) throw new ZerosDevError("artifact_invalid");
    const env = options.env ?? process.env, token = env.GITHUB_TOKEN ?? env.GH_TOKEN, fetchImpl = options.fetch ?? fetch;
    const api = createGitHubApi({ token, fetchImpl });
    stage = "collection";
    const report = await collectSoak({ api, trust, end: values.end, profile, now: options.now,
      read: async (_run, artifact) => {
        try { return jsonFromZip(await downloadArtifact({ prefix: REPO, token, fetch: fetchImpl }, artifact, 1024 * 1024), "receipt.json", 1024 * 1024); }
        catch { throw new ZerosDevError("artifact_invalid"); }
      } });
    const bytes = JSON.stringify(report, null, 2) + "\n";
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) throw new ZerosDevError("artifact_invalid");
    stage = "file";
    await file.writeFile(bytes); await file.sync();
    const after = await file.stat();
    if (!same(info, await lstat(destination)) || !same(parentInfo, await lstat(directory)) ||
      after.nlink !== 1 || after.uid !== info.uid || after.mode !== info.mode || await realpath(directory) !== directory)
      throw new ZerosDevError("artifact_invalid");
    await parent.sync();
    write({ schema: profile === "infrastructure" ? "zeros.dev-infrastructure-soak-result/v1" : "zeros.dev-soak-result/v1", status: report.status, collection: report.collection,
      ...(report.coverage ? { coverage: report.coverage } : {}),
      attempts: report.attempts.length, completeHours: report.slots.filter(row => row.status === "passed").length });
    return report.status === "passed" ? 0 : 1;
  } catch (error) {
    const code = error instanceof ZerosDevError ? error.code : stage === "input" ? "invalid_request" : stage === "file" ? "artifact_invalid" : closedError(error);
    write({ schema: profile === "infrastructure" ? "zeros.dev-infrastructure-soak-result/v1" : "zeros.dev-soak-result/v1", status: "incomplete", code }); return 1;
  } finally {
    await file?.close().catch(() => {}); await parent?.close().catch(() => {});
    // A failed write can leave a private partial file. Never unlink an output
    // pathname that another process may have replaced; retries use a new path.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void soakMain(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
