import { createHash } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { ClosedDiagnostic } from "../../../packages/protocol/src/cloud-runtime-bundle";
import {
  githubActionsOidcRequest,
  httpsUrl,
  PublicationError,
  readBoundedFile,
  requestGithubActionsOidcToken,
  responseJson,
} from "../runtime-bundle/publish";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z.object({
  schema: z.literal("zeros.runtime-base-receipt/v1"),
  profile: z.literal("zeros-cloud-worker-v4"),
  snapshotName: z.string().regex(/^zeros-v2-test-[a-z0-9-]{1,49}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  baseBuildSha256: sha256,
  baseCompatibilityId: z.string().regex(/^bc1-[a-f0-9]{64}$/),
  compatibilityRawB64: z.string().min(4).max(87_384),
  cleanup: z.object({
    confirmed: z.literal(true),
    snapshot: z.literal("retained"),
  }),
});
const registeredSchema = z
  .object({ baseImageId: z.string(), baseCompatibilityId: z.string() })
  .strict();
// Match the allowed range in apps/control-plane/src/config.ts. The caller must
// provide the control plane's qualified Boat storage capacity explicitly.
const storageSchema = z.number().int().min(1_024).max(2_097_152);
type Stage = "validate_input" | "oidc" | "register" | "done";
type Check =
  | "input_schema"
  | "source_commit"
  | "compatibility_digest"
  | "response_schema"
  | "http_status"
  | "network"
  | "timeout"
  | "unexpected_failure";

class RegistrationError extends Error {
  constructor(
    readonly check: Check,
    readonly timedOut = false,
  ) {
    super("Runtime base registration failed");
  }
}
function check(value: unknown, name: Check): asserts value {
  if (!value) throw new RegistrationError(name);
}
function diagnostic(stage: Stage, error?: unknown): ClosedDiagnostic {
  const known =
    error instanceof RegistrationError || error instanceof PublicationError;
  return {
    schema: "zeros.diagnostic/v1",
    component: "publication",
    stage,
    ok: error === undefined,
    exitCode: error === undefined ? 0 : 1,
    timedOut: known && error.timedOut,
    failedChecks:
      error === undefined ? [] : [known ? error.check : "unexpected_failure"],
  };
}

export function baseRegistrationBody(
  value: unknown,
  githubSha: string | undefined,
  storageMib: number,
) {
  const parsed = receiptSchema.safeParse(value);
  check(
    parsed.success && storageSchema.safeParse(storageMib).success,
    "input_schema",
  );
  const receipt = parsed.data;
  check(receipt.sourceCommit === githubSha, "source_commit");
  const bytes = Buffer.from(receipt.compatibilityRawB64, "base64");
  check(
    bytes.length <= 65_536 &&
      bytes.toString("base64") === receipt.compatibilityRawB64,
    "input_schema",
  );
  const compatibilitySha256 = createHash("sha256").update(bytes).digest("hex");
  check(
    `bc1-${compatibilitySha256}` === receipt.baseCompatibilityId,
    "compatibility_digest",
  );
  return {
    baseImageId: receipt.snapshotName,
    imageRef: `boat:${receipt.snapshotName}@sha256:${receipt.baseBuildSha256}`,
    sourceCommit: receipt.sourceCommit,
    imageBuildSha256: receipt.baseBuildSha256,
    storageMib,
    compatibilityRawB64: receipt.compatibilityRawB64,
    compatibilitySha256,
  };
}

export async function registerRuntimeBase(options: {
  receiptPath: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  pause?: (milliseconds: number) => Promise<unknown>;
  requestTimeoutMs?: number;
}): Promise<ClosedDiagnostic> {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? fetch;
  const pause = options.pause ?? sleep;
  const deadline = Date.now() + 2 * 60_000;
  let stage: Stage = "validate_input";
  const finish = (result: ClosedDiagnostic) => {
    // Inputs, JWTs, response bodies and exception text never reach CI output.
    console.log(JSON.stringify(result));
    return result;
  };
  async function request(url: URL, init: RequestInit) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new RegistrationError("timeout", true);
      const signal = AbortSignal.timeout(
        Math.min(options.requestTimeoutMs ?? 30_000, remaining),
      );
      try {
        const response = await fetcher(url.toString(), {
          ...init,
          redirect: "error",
          signal,
        });
        if (response.status >= 500 && response.status <= 599) {
          await response.body?.cancel().catch(() => {});
          if (attempt === 3) throw new RegistrationError("http_status");
        } else {
          if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            throw new RegistrationError("http_status");
          }
          return { ok: true, value: await responseJson(response) };
        }
      } catch (error) {
        if (
          error instanceof RegistrationError ||
          error instanceof PublicationError
        )
          throw error;
        if (attempt === 3 || Date.now() >= deadline)
          throw new RegistrationError(
            signal.aborted ? "timeout" : "network",
            signal.aborted,
          );
      }
      const backoffMs = 1000 * 2 ** attempt;
      if (Date.now() + backoffMs >= deadline)
        throw new RegistrationError("timeout", true);
      await pause(backoffMs);
    }
    throw new RegistrationError("network");
  }

  try {
    const origin = httpsUrl(
      env.CLOUD_WORKSPACE_CONTROL_PLANE_URL,
      "input_schema",
    );
    check(origin.pathname === "/" && !origin.search, "input_schema");
    const oidcRequest = githubActionsOidcRequest(env);
    const storageValue = env.CLOUD_WORKSPACE_STORAGE_MIB;
    check(
      storageValue !== undefined && /^[1-9][0-9]*$/.test(storageValue),
      "input_schema",
    );
    const storageMib = Number(storageValue);
    let receipt: unknown;
    try {
      receipt = JSON.parse(
        (await readBoundedFile(options.receiptPath, 128 * 1024)).toString(
          "utf8",
        ),
      );
    } catch {
      throw new RegistrationError("input_schema");
    }
    const body = baseRegistrationBody(receipt, env.GITHUB_SHA, storageMib);
    stage = "oidc";
    const token = await requestGithubActionsOidcToken(oidcRequest, request);
    stage = "register";
    // The CP returns the same identities on an exact re-registration. A 409
    // means a conflicting/revoked identity and must remain a failure.
    const response = await request(
      new URL("/internal/v1/runtime-bases", origin),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        body: JSON.stringify(body),
      },
    );
    const registered = registeredSchema.safeParse(response.value);
    check(
      registered.success &&
        registered.data.baseImageId === body.baseImageId &&
        registered.data.baseCompatibilityId ===
          `bc1-${body.compatibilitySha256}`,
      "response_schema",
    );
    return finish(diagnostic("done"));
  } catch (error) {
    return finish(diagnostic(stage, error));
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: { receipt: { type: "string" } },
      allowPositionals: false,
    });
    check(values.receipt, "input_schema");
    void registerRuntimeBase({ receiptPath: values.receipt }).then((result) => {
      process.exitCode = result.ok ? 0 : 1;
    });
  } catch {
    console.log(
      JSON.stringify(
        diagnostic("validate_input", new RegistrationError("input_schema")),
      ),
    );
    process.exitCode = 1;
  }
}
