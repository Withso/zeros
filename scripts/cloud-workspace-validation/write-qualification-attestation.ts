import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { loadSnapshotAttestation, loadState } from "./config";
import {
  createCloudQualificationAttestation,
  type CloudQualificationDisposition,
} from "./lib/qualification-attestation";

function required(name: string, maximumBytes: number): string {
  const value = process.env[name]?.trim();
  if (
    !value ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function writeNewFile(file: string, value: string): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if (realpathSync(directory) !== directory) {
    throw new Error("qualification attestation directory is unsafe");
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, value, "utf8");
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function main(): void {
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("qualification attestations may be written only in Actions");
  }
  const output = required(
    "ZEROS_CLOUD_QUALIFICATION_ATTESTATION_FILE",
    4_096,
  );
  const workspace = required("GITHUB_WORKSPACE", 4_096);
  if (
    !path.isAbsolute(output) ||
    !path.isAbsolute(workspace) ||
    output === workspace ||
    output.startsWith(`${workspace}${path.sep}`)
  ) {
    throw new Error("qualification attestation output must be outside the repository");
  }
  const disposition = required(
    "ZEROS_CLOUD_QUALIFICATION_DISPOSITION",
    32,
  ) as CloudQualificationDisposition;
  const snapshot = loadSnapshotAttestation();
  const state = loadState();
  const attestation = createCloudQualificationAttestation({
    disposition,
    snapshot,
    runtime: state,
    workflow: {
      repository: required("GITHUB_REPOSITORY", 256),
      runId: required("GITHUB_RUN_ID", 32),
      runAttempt: required("GITHUB_RUN_ATTEMPT", 16),
      ref: required("GITHUB_REF", 512),
      sha: required("GITHUB_SHA", 128),
    },
    qualifiedAt: new Date().toISOString(),
  });
  const serialized = `${JSON.stringify(attestation, null, 2)}\n`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  writeNewFile(output, serialized);
  writeNewFile(`${output}.sha256`, `${digest}  ${path.basename(output)}\n`);
  console.log(
    `Wrote sanitized cloud qualification attestation (${digest.slice(0, 12)}…).`,
  );
}

try {
  main();
} catch (error) {
  console.error(
    "cloud qualification attestation failed:",
    error instanceof Error ? error.message : "unknown failure",
  );
  process.exit(1);
}
