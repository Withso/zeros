import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClosedDiagnosticSchema,
  type RuntimeDescriptor,
} from "../../packages/protocol/src/cloud-runtime-bundle";
import { publishRuntimeBundle } from "../cloud-workspace-validation/runtime-bundle/publish";

const cpOrigin = "https://control.example.invalid";
const oidcOrigin = "https://actions.example.invalid";
const storeOrigin = "https://objects.example.invalid";
const requestToken = "synthetic-actions-request";
const oidcToken = "synthetic.oidc.signature";
const publicationPath = "/internal/v1/runtime-bundles/publications";
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
type Stage = "oidc" | "prepare" | "upload" | "complete";
type Failure = number | "network" | "lost_response" | "hang";
type RecordedRequest = {
  stage: Stage;
  method: string | undefined;
  headers: IncomingHttpHeaders;
  url: string;
  body: Buffer;
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Test server did not listen");
  return `http://127.0.0.1:${address.port}`;
}

describe("Alpha runtime bundle publication", () => {
  let outDir: string;
  let archive: Buffer;
  let descriptor: RuntimeDescriptor;
  let manifestHeader: Record<string, unknown>;
  let env: NodeJS.ProcessEnv;
  let cp: Server;
  let store: Server;
  let fetcher: typeof fetch;
  let stored: Buffer | null;
  let disabled: "prepare" | "complete" | null;
  let notFoundCode: string;
  let forceUpload: boolean;
  let raceUpload: boolean;
  let afterUpload: (() => void) | null;
  let tokenExpiresAt: number;
  let uploadHeaders: Record<string, string>;
  let uploadUrl: string;
  let completion: { runtimeId: string; registered: boolean } | null;
  let failures: Record<Stage, Failure[]>;
  let requests: RecordedRequest[];
  let output: string[];
  const pause = vi.fn(async (_milliseconds: number) => {});

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(tmpdir(), "zeros-v2-test-publication-"));
    const raw = await readFile(
      new URL(
        "../../packages/protocol/src/__tests__/fixtures/cloud-runtime/manifest.valid-without-self-test.json",
        import.meta.url,
      ),
    );
    const { files, ...header } = JSON.parse(raw.toString("utf8"));
    manifestHeader = header;
    archive = gzipSync(Buffer.from("runtime archive fixture"));
    descriptor = {
      runtimeId: `r1-${digest(raw)}`,
      manifestSha256: digest(raw),
      archiveSha256: digest(archive),
      archiveBytes: archive.length,
      expandedBytes: files.reduce(
        (sum: number, file: { type: string; size?: number }) =>
          sum + (file.type === "file" ? file.size! : 0),
        0,
      ),
      sourceCommit: header.source.commit,
      nodeModulesAbi: header.platform.nodeModulesAbi,
      bootstrapProtocolVersion: header.protocols.bootstrap,
      engineProtocolVersion: header.protocols.engine,
    };
    await writeFile(path.join(outDir, "manifest.json"), raw);
    await writeFile(
      path.join(outDir, "descriptor.json"),
      JSON.stringify(descriptor),
    );
    await writeFile(
      path.join(outDir, `${descriptor.runtimeId}.tar.gz`),
      archive,
    );
    env = {
      CLOUD_WORKSPACE_CONTROL_PLANE_URL: cpOrigin,
      CLOUD_RUNTIME_OIDC_AUDIENCE: "zeros-control-plane-alpha",
      ACTIONS_ID_TOKEN_REQUEST_URL: `${oidcOrigin}/token?request=fixture`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken,
      GITHUB_SHA: descriptor.sourceCommit,
      GITHUB_RUN_NUMBER: "17",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    };
    stored = null;
    disabled = null;
    notFoundCode = "not_found";
    forceUpload = false;
    raceUpload = false;
    afterUpload = null;
    tokenExpiresAt = 0;
    completion = null;
    uploadHeaders = {
      "If-None-Match": "*",
      "Content-Length": String(archive.length),
      "Content-Type": "application/gzip",
      "Cache-Control": "no-store",
    };
    uploadUrl = `${storeOrigin}/bundle?signature=synthetic-upload-capability`;
    failures = { oidc: [], prepare: [], upload: [], complete: [] };
    requests = [];
    output = [];
    pause.mockClear();
    for (const method of ["log", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation((...values) =>
        output.push(values.join(" ")),
      );

    const handler =
      (objectStore: boolean) =>
      async (
        request: import("node:http").IncomingMessage,
        response: import("node:http").ServerResponse,
      ) => {
        const stage: Stage = objectStore
          ? "upload"
          : request.url!.startsWith("/token")
            ? "oidc"
            : request.url === `${publicationPath}/complete`
              ? "complete"
              : "prepare";
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        requests.push({
          stage,
          method: request.method,
          headers: request.headers,
          url: request.url!,
          body,
        });
        const json = (status: number, value: unknown) => {
          response.writeHead(status, { "Content-Type": "application/json" });
          response.end(JSON.stringify(value));
        };
        const failure = failures[stage].shift();
        if (failure === "network") {
          response.destroy();
          return;
        }
        if (failure === "hang") return;
        if (typeof failure === "number") {
          json(failure, {
            error: {
              code: failure === 404 ? notFoundCode : "fixture_failure",
              message: `${cpOrigin} ${oidcToken} ${requestToken}`,
            },
          });
          return;
        }
        if (stage === disabled) {
          json(404, { error: { code: "not_found" } });
          return;
        }
        if (stage === "oidc") {
          tokenExpiresAt = Date.now() + 5 * 60_000;
          json(200, { value: oidcToken });
          return;
        }
        if (stage !== "upload" && Date.now() >= tokenExpiresAt) {
          json(401, { error: { code: "runtime_oidc_rejected" } });
          return;
        }
        if (stage === "prepare") {
          if (stored && stored.length !== descriptor.archiveBytes) {
            json(409, { error: { code: "runtime_artifact_size_conflict" } });
            return;
          }
          json(200, {
            objectKey: `runtime/v1/${descriptor.runtimeId}/${descriptor.archiveSha256}.tar.gz`,
            upload:
              stored && !forceUpload
                ? null
                : {
                    url: uploadUrl,
                    expiresAt: new Date(Date.now() + 900_000).toISOString(),
                    headers: uploadHeaders,
                  },
          });
          return;
        }
        if (stage === "upload") {
          if (raceUpload) stored = archive;
          if (stored) {
            json(412, { error: { code: "precondition_failed" } });
            return;
          }
          stored = body;
          afterUpload?.();
          if (failure === "lost_response") {
            response.destroy();
            return;
          }
          response.writeHead(200);
          response.end();
          return;
        }
        if (!stored || stored.length !== descriptor.archiveBytes) {
          json(409, { error: { code: "runtime_artifact_missing" } });
          return;
        }
        if (failure === "lost_response") {
          response.destroy();
          return;
        }
        json(
          200,
          completion ?? { runtimeId: descriptor.runtimeId, registered: true },
        );
      };
    cp = createServer(handler(false));
    store = createServer(handler(true));
    const cpLocal = await listen(cp),
      storeLocal = await listen(store);
    // Production inputs remain HTTPS. Only this test transport rewrites them to
    // disposable loopback servers, exercising Node's real streaming fetch.
    fetcher = (input, init) => {
      const url = new URL(String(input));
      return fetch(
        `${url.origin === storeOrigin ? storeLocal : cpLocal}${url.pathname}${url.search}`,
        init,
      );
    };
  });

  afterEach(async () => {
    for (const server of [cp, store]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(outDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const at = (stage: Stage) =>
    requests.filter((request) => request.stage === stage);
  const publish = (
    options: { requestTimeoutMs?: number; fetch?: typeof fetch } = {},
  ) => publishRuntimeBundle({ outDir, env, fetch: fetcher, pause, ...options });
  function expectClosedOutput() {
    expect(output).toHaveLength(1);
    expect(
      ClosedDiagnosticSchema.safeParse(JSON.parse(output[0])).success,
    ).toBe(true);
    expect(output.join("\n")).not.toMatch(
      /https?:\/\/|example\.invalid|synthetic|Bearer|signature|requestToken|oidcToken/,
    );
  }

  it("streams the exact archive and completes the same stateless body, including an idempotent rerun", async () => {
    expect(await publish()).toMatchObject({
      component: "publication",
      stage: "done",
      ok: true,
    });
    expect(stored).toEqual(archive);
    const body = JSON.parse(at("prepare")[0].body.toString());
    expect(body).toEqual({
      descriptor,
      manifestHeader,
      releaseOrder: 123,
      githubRunId: 123,
      githubRunAttempt: 2,
    });
    expect(at("complete")[0].body).toEqual(at("prepare")[0].body);
    expect(at("oidc")[0]).toMatchObject({
      method: "GET",
      headers: { authorization: `Bearer ${requestToken}` },
    });
    const oidcRequest = new URL(at("oidc")[0].url, oidcOrigin);
    expect(oidcRequest.searchParams.get("audience")).toBe(
      env.CLOUD_RUNTIME_OIDC_AUDIENCE,
    );
    expect(oidcRequest.searchParams.get("request")).toBe("fixture");
    expect(at("prepare")[0].headers.authorization).toBe(`Bearer ${oidcToken}`);
    expect(at("upload")[0]).toMatchObject({
      method: "PUT",
      headers: {
        "content-length": String(archive.length),
        "if-none-match": "*",
        "content-type": "application/gzip",
      },
    });
    expect(at("upload")[0].headers.authorization).toBeUndefined();
    expectClosedOutput();
    output.length = 0;
    expect(await publish()).toMatchObject({ stage: "done", ok: true });
    expect(at("upload")).toHaveLength(1);
    expect(at("complete")).toHaveLength(2);
    expect(at("complete")[1].body).toEqual(at("prepare")[0].body);
    expectClosedOutput();
  });

  it("requires control-plane upload:null confirmation after a racing 412", async () => {
    raceUpload = true;
    expect(await publish()).toMatchObject({ stage: "done", ok: true });
    expect(at("prepare")).toHaveLength(2);
    expect(at("upload")).toHaveLength(1);
    expect(at("complete")).toHaveLength(1);
    expect(at("prepare")[1].body).toEqual(at("prepare")[0].body);
    expectClosedOutput();
  });

  it("completes with fresh OIDC after a long upload outlives the initial token", async () => {
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    afterUpload = () => clock.mockReturnValue(started + 6 * 60_000);
    expect(await publish()).toMatchObject({ stage: "done", ok: true });
    expect(at("oidc")).toHaveLength(2);
    expect(at("complete")[0].body).toEqual(at("prepare")[0].body);
    expectClosedOutput();
  });

  it("fails a 412 when the control plane still supplies an upload capability", async () => {
    raceUpload = true;
    forceUpload = true;
    expect(await publish()).toMatchObject({
      stage: "upload",
      ok: false,
      failedChecks: ["upload_conflict"],
    });
    expect(at("complete")).toHaveLength(0);
    expect(at("upload")).toHaveLength(1);
    expectClosedOutput();
  });

  it("reconciles a lost PUT response without overwriting or sending credentials to storage", async () => {
    failures.upload = ["lost_response"];
    expect(await publish()).toMatchObject({ stage: "done", ok: true });
    expect(at("upload")).toHaveLength(2);
    expect(
      at("upload").every(
        (request) =>
          request.body.equals(archive) &&
          request.headers.authorization === undefined,
      ),
    ).toBe(true);
    expect(at("prepare")).toHaveLength(2);
    expect(pause.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      1000,
    ]);
    expectClosedOutput();
  });

  it.each(["prepare", "complete"] as const)(
    "succeeds with a closed disabled diagnostic on the CP's disabled %s response",
    async (stage) => {
      disabled = stage;
      expect(await publish()).toMatchObject({
        stage: "disabled",
        ok: true,
        exitCode: 0,
        failedChecks: [],
      });
      expect(at("upload")).toHaveLength(stage === "prepare" ? 0 : 1);
      expect(pause).not.toHaveBeenCalled();
      expectClosedOutput();
    },
  );

  it("does not swallow other 404 codes or an object-store 404", async () => {
    failures.prepare = [404];
    notFoundCode = "unknown_resource";
    expect(await publish()).toMatchObject({
      ok: false,
      failedChecks: ["http_status"],
    });
    expectClosedOutput();
    output.length = 0;
    failures.upload = [404];
    expect(await publish()).toMatchObject({
      stage: "upload",
      ok: false,
      failedChecks: ["http_status"],
    });
    expectClosedOutput();
  });

  it.each(["oidc", "prepare", "upload", "complete"] as const)(
    "retries %s network and 5xx failures with bounded backoff",
    async (stage) => {
      failures[stage] = [503, "network", 500];
      expect(await publish()).toMatchObject({ stage: "done", ok: true });
      expect(at(stage)).toHaveLength(stage === "oidc" ? 5 : 4);
      expect(pause.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
        1000, 2000, 4000,
      ]);
      if (stage === "upload")
        expect(
          at("upload").every((request) => request.body.equals(archive)),
        ).toBe(true);
      if (stage === "complete")
        expect(
          at("complete").every((request) =>
            request.body.equals(at("prepare")[0].body),
          ),
        ).toBe(true);
      expectClosedOutput();
    },
  );

  it.each(["oidc", "prepare", "upload", "complete"] as const)(
    "stops %s after four failing attempts without logging response bodies",
    async (stage) => {
      failures[stage] = [503, 502, 500, 503, 200];
      expect(await publish()).toMatchObject({
        stage,
        ok: false,
        exitCode: 1,
        failedChecks: ["http_status"],
      });
      expect(at(stage)).toHaveLength(4);
      expect(pause).toHaveBeenCalledTimes(3);
      expectClosedOutput();
    },
  );

  it("does not retry identity conflicts or other 4xx responses", async () => {
    failures.prepare = [409];
    expect(await publish()).toMatchObject({
      stage: "prepare",
      ok: false,
      failedChecks: ["http_status"],
    });
    expect(at("prepare")).toHaveLength(1);
    expect(pause).not.toHaveBeenCalled();
    expect(at("upload")).toHaveLength(0);
    expectClosedOutput();
  });

  it("aborts hung requests and reports a closed timeout", async () => {
    failures.oidc = ["hang", "hang", "hang", "hang"];
    expect(await publish({ requestTimeoutMs: 100 })).toMatchObject({
      stage: "oidc",
      ok: false,
      timedOut: true,
      failedChecks: ["timeout"],
    });
    expect(at("oidc")).toHaveLength(4);
    expectClosedOutput();
  });

  it.each(["length", "condition", "http_url"] as const)(
    "rejects invalid presigned %s before uploading",
    async (kind) => {
      if (kind === "length")
        uploadHeaders["Content-Length"] = String(archive.length + 1);
      if (kind === "condition") delete uploadHeaders["If-None-Match"];
      if (kind === "http_url") uploadUrl = uploadUrl.replace("https:", "http:");
      expect(await publish()).toMatchObject({ ok: false });
      expect(at("upload")).toHaveLength(0);
      expect(at("complete")).toHaveLength(0);
      expectClosedOutput();
    },
  );

  it("requires a completion acknowledgement for the exact runtime", async () => {
    completion = { runtimeId: "r1-" + "0".repeat(64), registered: true };
    expect(await publish()).toMatchObject({
      stage: "complete",
      ok: false,
      failedChecks: ["response_schema"],
    });
    expectClosedOutput();
  });

  it.each([
    "manifest_digest",
    "archive_size",
    "archive_digest",
    "source_commit",
    "descriptor_manifest",
  ] as const)("checks %s before obtaining any authority", async (kind) => {
    if (kind === "manifest_digest")
      await writeFile(path.join(outDir, "manifest.json"), "{}");
    if (kind === "archive_size")
      await writeFile(
        path.join(outDir, `${descriptor.runtimeId}.tar.gz`),
        "short",
      );
    if (kind === "archive_digest")
      await writeFile(
        path.join(outDir, `${descriptor.runtimeId}.tar.gz`),
        Buffer.alloc(archive.length),
      );
    if (kind === "source_commit") env.GITHUB_SHA = "0".repeat(40);
    if (kind === "descriptor_manifest") {
      descriptor.nodeModulesAbi++;
      await writeFile(
        path.join(outDir, "descriptor.json"),
        JSON.stringify(descriptor),
      );
    }
    expect(await publish()).toMatchObject({
      stage: "validate_input",
      ok: false,
      failedChecks: [kind],
    });
    expect(requests).toHaveLength(0);
    expectClosedOutput();
  });

  it.each([
    "GITHUB_RUN_NUMBER",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "CLOUD_RUNTIME_OIDC_AUDIENCE",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  ])("requires %s without printing its value", async (name) => {
    delete env[name];
    expect(await publish()).toMatchObject({
      stage: "validate_input",
      ok: false,
      failedChecks: ["input_schema"],
    });
    expect(requests).toHaveLength(0);
    expectClosedOutput();
  });

  it("keeps CLI parsing and file errors closed, with a failing process exit", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/cloud-workspace-validation/runtime-bundle/publish.ts",
        "--out-dir",
        path.join(outDir, "absent"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...env, PATH: process.env.PATH },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const diagnostic = JSON.parse(result.stdout.trim());
    expect(ClosedDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
    expect(diagnostic).toMatchObject({
      component: "publication",
      stage: "validate_input",
      ok: false,
    });
    expect(result.stdout).not.toMatch(
      /https?:\/\/|example\.invalid|synthetic|zeros-v2-test/,
    );
  });
});
