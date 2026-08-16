// GitHub Actions-only wrapper around the pure validation identity generator.
// Values are appended to the runner's protected GITHUB_ENV command file; the
// JWT is masked before later steps can emit it accidentally.

import { appendFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCloudValidationIdentity } from "./lib/validation-identity";

function positiveRunPart(name: string): string {
  const value = process.env[name] ?? "";
  if (!/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function main(): void {
  if (process.env.GITHUB_ACTIONS !== "true") {
    throw new Error("prepare-ci-identity may run only inside GitHub Actions");
  }
  const environmentFile = process.env.GITHUB_ENV ?? "";
  if (!path.isAbsolute(environmentFile)) {
    throw new Error("GITHUB_ENV is not an absolute runner command file");
  }
  const stat = lstatSync(environmentFile);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (uid !== null && stat.uid !== uid)
  ) {
    throw new Error("GITHUB_ENV is not a safe runner command file");
  }
  const runId = positiveRunPart("GITHUB_RUN_ID");
  const attempt = positiveRunPart("GITHUB_RUN_ATTEMPT");
  const identity = createCloudValidationIdentity({
    ownerSubject: `zsr-ci:${runId}:${attempt}`,
    ttlSeconds: 8 * 60 * 60,
  });
  process.stdout.write(`::add-mask::${identity.accessToken}\n`);

  const values: Record<string, string> = {
    ZEROS_CLOUD_OWNER_SUB: identity.ownerSubject,
    ZEROS_ACCOUNT_ACCESS_TOKEN: identity.accessToken,
    ZEROS_ACCOUNT_JWT_PUBLIC_KEY: identity.publicKey,
    ZEROS_ACCOUNT_JWT_AUD: identity.audience,
    ZEROS_ACCOUNT_JWT_ISS: identity.issuer,
  };
  for (const [name, value] of Object.entries(values)) {
    const delimiter = `ZEROS_${randomUUID().replaceAll("-", "")}`;
    appendFileSync(
      environmentFile,
      `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
      "utf8",
    );
  }
  console.log("Prepared an ephemeral asymmetric cloud qualification identity.");
}

try {
  main();
} catch (error) {
  console.error(
    "cloud qualification identity setup failed:",
    error instanceof Error ? error.message : "unknown failure",
  );
  process.exit(1);
}
