import { createHash } from "node:crypto";
import { constants, createReadStream, ReadStream } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  parseCanonicalManifest,
  RuntimeDescriptorSchema,
  type ClosedDiagnostic,
} from "../../../packages/protocol/src/cloud-runtime-bundle";

const publicationPath = "/internal/v1/runtime-bundles/publications";
const maxAttempts = 4;
const publicationTimeoutMs = 10 * 60_000;
const maxResponseBytes = 64 * 1024;
type Stage =
  | "validate_input"
  | "oidc"
  | "prepare"
  | "upload"
  | "complete"
  | "disabled"
  | "done";
type Check =
  | "input_schema"
  | "manifest_digest"
  | "manifest_schema"
  | "descriptor_manifest"
  | "source_commit"
  | "archive_size"
  | "archive_digest"
  | "response_schema"
  | "upload_headers"
  | "upload_conflict"
  | "http_status"
  | "network"
  | "timeout"
  | "unexpected_failure";

class PublicationError extends Error {
  constructor(
    readonly check: Check,
    readonly timedOut = false,
  ) {
    super("Runtime publication failed");
  }
}
function check(value: unknown, name: Check): asserts value {
  if (!value) throw new PublicationError(name);
}
function diagnostic(stage: Stage, error?: unknown): ClosedDiagnostic {
  return {
    schema: "zeros.diagnostic/v1",
    component: "publication",
    stage,
    ok: error === undefined,
    exitCode: error === undefined ? 0 : 1,
    timedOut: error instanceof PublicationError && error.timedOut,
    failedChecks:
      error === undefined
        ? []
        : [
            error instanceof PublicationError
              ? error.check
              : "unexpected_failure",
          ],
  };
}
function httpsUrl(value: string | undefined, name: Check): URL {
  try {
    check(value && value.length <= 16 * 1024, name);
    const url = new URL(value);
    check(
      url.protocol === "https:" && !url.username && !url.password && !url.hash,
      name,
    );
    return url;
  } catch {
    throw new PublicationError(name);
  }
}
function positiveInteger(
  value: string | undefined,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  check(value && /^[1-9][0-9]*$/.test(value), "input_schema");
  const number = Number(value);
  check(Number.isSafeInteger(number) && number <= maximum, "input_schema");
  return number;
}
async function readBoundedFile(file: string, maximum: number): Promise<Buffer> {
  // Check and read the same file through one descriptor; never follow a link.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    check(info.isFile() && info.size > 0 && info.size <= maximum, "input_schema");
    const bytes = await handle.readFile();
    check(bytes.length <= maximum, "input_schema");
    return bytes;
  } finally {
    await handle.close();
  }
}
async function responseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  check(reader, "response_schema");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      check(bytes <= maxResponseBytes, "response_schema");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PublicationError("response_schema");
  }
}

const prepareSchema = z
  .object({
    objectKey: z.string(),
    upload: z
      .object({
        url: z.string(),
        expiresAt: z.iso.datetime({ offset: true }),
        headers: z.record(z.string(), z.string()),
      })
      .strict()
      .nullable(),
  })
  .strict();
const oidcSchema = z.object({
  value: z
    .string()
    .max(16 * 1024)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
});
const completeSchema = z
  .object({ runtimeId: z.string(), registered: z.literal(true) })
  .strict();
const disabledSchema = z
  .object({ error: z.object({ code: z.literal("not_found") }).strict() })
  .strict();

export async function publishRuntimeBundle(options: {
  outDir: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  pause?: (milliseconds: number) => Promise<unknown>;
  requestTimeoutMs?: number;
}): Promise<ClosedDiagnostic> {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? fetch;
  const pause = options.pause ?? sleep;
  const deadline = Date.now() + publicationTimeoutMs;
  let stage: Stage = "validate_input";
  const finish = (result: ClosedDiagnostic) => {
    // Never interpolate inputs, responses or exceptions into CI output.
    console.log(JSON.stringify(result));
    return result;
  };
  type Request = RequestInit & { duplex?: "half" };
  async function request(
    url: URL,
    input: Request | (() => Request),
    json = true,
    timeoutMs = options.requestTimeoutMs ?? 30_000,
  ) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new PublicationError("timeout", true);
      const signal = AbortSignal.timeout(Math.min(timeoutMs, remaining));
      const init = typeof input === "function" ? input() : input;
      try {
        const response = await fetcher(url.toString(), {
          ...init,
          redirect: "error",
          signal,
        });
        if (response.status >= 500 && response.status <= 599) {
          await response.body?.cancel().catch(() => {});
          if (attempt === maxAttempts - 1)
            throw new PublicationError("http_status");
        } else {
          const value = json ? await responseJson(response) : null;
          if (!json) await response.body?.cancel().catch(() => {});
          return { ok: response.ok, status: response.status, value };
        }
      } catch (error) {
        if (error instanceof PublicationError) throw error;
        if (attempt === maxAttempts - 1 || Date.now() >= deadline)
          throw new PublicationError(
            signal.aborted ? "timeout" : "network",
            signal.aborted,
          );
      } finally {
        // A retry opens a fresh archive stream. Failed requests must not retain
        // a file descriptor or reuse an already-consumed body.
        const body: unknown = init.body;
        if (body instanceof ReadStream) body.destroy();
      }
      const backoffMs = 1000 * 2 ** attempt;
      if (Date.now() + backoffMs >= deadline)
        throw new PublicationError("timeout", true);
      await pause(backoffMs);
    }
    throw new PublicationError("network");
  }

  try {
    const origin = httpsUrl(
      env.CLOUD_WORKSPACE_CONTROL_PLANE_URL,
      "input_schema",
    );
    check(origin.pathname === "/" && !origin.search, "input_schema");
    const oidcUrl = httpsUrl(env.ACTIONS_ID_TOKEN_REQUEST_URL, "input_schema");
    const audience = env.CLOUD_RUNTIME_OIDC_AUDIENCE;
    check(
      audience && audience.length <= 256 && !/\s/.test(audience),
      "input_schema",
    );
    const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
    check(
      requestToken &&
        requestToken.length <= 16 * 1024 &&
        !/[\r\n]/.test(requestToken),
      "input_schema",
    );
    oidcUrl.searchParams.set("audience", audience);
    const releaseOrder = positiveInteger(env.GITHUB_RUN_NUMBER);
    const githubRunId = positiveInteger(env.GITHUB_RUN_ID);
    const githubRunAttempt = positiveInteger(
      env.GITHUB_RUN_ATTEMPT,
      2_147_483_647,
    );
    const descriptorResult = RuntimeDescriptorSchema.safeParse(
      JSON.parse(
        (
          await readBoundedFile(
            path.join(options.outDir, "descriptor.json"),
            16 * 1024,
          )
        ).toString("utf8"),
      ),
    );
    check(descriptorResult.success, "input_schema");
    const descriptor = descriptorResult.data;
    check(descriptor.sourceCommit === env.GITHUB_SHA, "source_commit");
    const rawManifest = await readBoundedFile(
      path.join(options.outDir, "manifest.json"),
      64 * 1024 * 1024,
    );
    check(
      createHash("sha256").update(rawManifest).digest("hex") ===
        descriptor.manifestSha256,
      "manifest_digest",
    );
    const manifest = (() => {
      try {
        return parseCanonicalManifest(rawManifest, descriptor.manifestSha256)
          .manifest;
      } catch {
        throw new PublicationError("manifest_schema");
      }
    })();
    const { files, ...manifestHeader } = manifest;
    check(
      manifest.source.commit === descriptor.sourceCommit &&
        manifest.platform.nodeModulesAbi === descriptor.nodeModulesAbi &&
        manifest.protocols.bootstrap === descriptor.bootstrapProtocolVersion &&
        manifest.protocols.engine === descriptor.engineProtocolVersion &&
        files.reduce(
          (bytes, file) => bytes + (file.type === "file" ? file.size : 0),
          0,
        ) === descriptor.expandedBytes,
      "descriptor_manifest",
    );
    const archivePath = path.join(
      options.outDir,
      `${descriptor.runtimeId}.tar.gz`,
    );
    const archiveInfo = await lstat(archivePath);
    check(
      archiveInfo.isFile() && archiveInfo.size === descriptor.archiveBytes,
      "archive_size",
    );
    const archiveHash = createHash("sha256");
    for await (const chunk of createReadStream(archivePath))
      archiveHash.update(chunk);
    check(
      archiveHash.digest("hex") === descriptor.archiveSha256,
      "archive_digest",
    );
    // Reuse the exact serialized identity for every prepare/complete request.
    // The control plane derives and verifies provenance from the OIDC claims.
    const body = JSON.stringify({
      descriptor,
      manifestHeader,
      releaseOrder,
      githubRunId,
      githubRunAttempt,
    });

    async function cpRequest(url: URL) {
      // Upload retries can outlive an OIDC JWT. Mint fresh authentication for
      // each CP phase while retaining the exact same publication identity.
      const nextStage = stage;
      stage = "oidc";
      const tokenResponse = await request(oidcUrl, {
        headers: { Authorization: `Bearer ${requestToken}` },
      });
      check(tokenResponse.ok, "http_status");
      const token = oidcSchema.safeParse(tokenResponse.value);
      check(token.success, "response_schema");
      stage = nextStage;
      return request(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.data.value}`,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
        body,
      });
    }
    const endpoint = new URL(publicationPath, origin);
    async function prepare() {
      const response = await cpRequest(endpoint);
      // B5's disabled route intentionally returns only this closed 404. Other
      // 404 bodies, and all storage errors, remain publication failures.
      if (
        response.status === 404 &&
        disabledSchema.safeParse(response.value).success
      )
        return null;
      check(response.ok, "http_status");
      const prepared = prepareSchema.safeParse(response.value);
      check(
        prepared.success &&
          prepared.data.objectKey ===
            `runtime/v1/${descriptor.runtimeId}/${descriptor.archiveSha256}.tar.gz`,
        "response_schema",
      );
      return prepared.data;
    }
    stage = "prepare";
    const prepared = await prepare();
    if (!prepared) return finish(diagnostic("disabled"));
    if (prepared.upload) {
      stage = "upload";
      const upload = prepared.upload;
      const url = httpsUrl(upload.url, "response_schema");
      check(Date.parse(upload.expiresAt) > Date.now(), "response_schema");
      let headers: Headers;
      try {
        headers = new Headers(upload.headers);
      } catch {
        throw new PublicationError("upload_headers");
      }
      check(
        headers.get("content-length") === String(descriptor.archiveBytes) &&
          headers.get("if-none-match") === "*" &&
          ![
            "authorization",
            "proxy-authorization",
            "cookie",
            "transfer-encoding",
          ].some((name) => headers.has(name)),
        "upload_headers",
      );
      const uploaded = await request(
        url,
        () => ({
          method: "PUT",
          headers,
          body: createReadStream(archivePath) as unknown as BodyInit,
          duplex: "half",
        }),
        false,
        120_000,
      );
      if (uploaded.status === 412) {
        // A lost reply or concurrent create is not proof of the object. Ask
        // the CP to HEAD the original identity and require upload:null.
        const confirmed = await prepare();
        if (!confirmed) return finish(diagnostic("disabled"));
        check(confirmed.upload === null, "upload_conflict");
      } else check(uploaded.ok, "http_status");
    }
    stage = "complete";
    const response = await cpRequest(
      new URL(`${publicationPath}/complete`, origin),
    );
    if (
      response.status === 404 &&
      disabledSchema.safeParse(response.value).success
    )
      return finish(diagnostic("disabled"));
    check(response.ok, "http_status");
    const completed = completeSchema.safeParse(response.value);
    check(
      completed.success && completed.data.runtimeId === descriptor.runtimeId,
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
  void (async () => {
    const { values } = parseArgs({
      options: { "out-dir": { type: "string" } },
      strict: true,
    });
    check(values["out-dir"], "input_schema");
    const result = await publishRuntimeBundle({ outDir: values["out-dir"] });
    process.exitCode = result.ok ? 0 : 1;
  })().catch(() => {
    console.log(
      JSON.stringify(
        diagnostic("validate_input", new PublicationError("input_schema")),
      ),
    );
    process.exitCode = 1;
  });
}
