import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClosedDiagnosticSchema } from "../../packages/protocol/src/cloud-runtime-bundle";
import {
  baseRegistrationBody,
  registerRuntimeBase,
} from "../cloud-workspace-validation/runtime-base-v4/register-base";

const sourceCommit = "a".repeat(40);
const baseBuildSha256 = "b".repeat(64);
const snapshotName = "zeros-v2-test-base-v4-1";
const requestToken = "synthetic-actions-request";
const oidcToken = "synthetic.oidc.signature";
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

describe("verified Alpha base registration", () => {
  let directory: string;
  let receiptPath: string;
  let receipt: Record<string, unknown>;
  let env: NodeJS.ProcessEnv;
  let output: string[];
  let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(tmpdir(), "zeros-v2-test-base-registration-"),
    );
    receiptPath = path.join(directory, "base-receipt.json");
    const raw = await readFile(
      new URL(
        "../../packages/protocol/src/__tests__/fixtures/cloud-runtime/base-compatibility.valid.json",
        import.meta.url,
      ),
    );
    receipt = {
      schema: "zeros.runtime-base-receipt/v1",
      profile: "zeros-cloud-worker-v4",
      sourceCommit,
      baseBuildSha256,
      snapshotName,
      baseCompatibilityId: `bc1-${digest(raw)}`,
      compatibilityRawB64: raw.toString("base64"),
      cleanup: {
        confirmed: true,
        snapshot: "retained",
        sandboxes: ["bx_fixture"],
      },
      futureReceiptField: true,
    };
    await writeFile(receiptPath, JSON.stringify(receipt));
    env = {
      GITHUB_SHA: sourceCommit,
      CLOUD_WORKSPACE_CONTROL_PLANE_URL: "https://control.example.invalid",
      CLOUD_RUNTIME_OIDC_AUDIENCE: "zeros-control-plane-alpha",
      CLOUD_WORKSPACE_STORAGE_MIB: "20480",
      ACTIONS_ID_TOKEN_REQUEST_URL:
        "https://actions.example.invalid/token?request=fixture",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken,
    };
    output = [];
    for (const method of ["log", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation((...values) =>
        output.push(values.join(" ")),
      );
    fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      return Response.json(
        url.hostname === "actions.example.invalid"
          ? { value: oidcToken }
          : {
              baseImageId: snapshotName,
              baseCompatibilityId: receipt.baseCompatibilityId,
            },
      );
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  const run = (requestTimeoutMs?: number) =>
    registerRuntimeBase({
      receiptPath,
      env,
      fetch: fetcher,
      pause: async () => {},
      requestTimeoutMs,
    });

  it("builds the exact snapshot/build identity and preserves the raw contract bytes", () => {
    const body = baseRegistrationBody(receipt, sourceCommit);
    expect(body).toEqual({
      baseImageId: snapshotName,
      imageRef: `boat:${snapshotName}@sha256:${baseBuildSha256}`,
      sourceCommit,
      imageBuildSha256: baseBuildSha256,
      storageMib: 20_480,
      compatibilityRawB64: receipt.compatibilityRawB64,
      compatibilitySha256: String(receipt.baseCompatibilityId).slice(4),
    });
    expect(baseRegistrationBody(receipt, sourceCommit, 40960).storageMib).toBe(
      40960,
    );
  });

  it.each([
    { baseCompatibilityId: `bc1-${"c".repeat(64)}` },
    { compatibilityRawB64: Buffer.from("{}").toString("base64") },
    { compatibilityRawB64: undefined },
    { compatibilityRawB64: "not base64" },
    { sourceCommit: "c".repeat(40) },
    { snapshotName: "invalid/snapshot" },
    { baseBuildSha256: "invalid" },
    { cleanup: { confirmed: false, snapshot: "retained" } },
    { cleanup: { confirmed: true, snapshot: "deleted" } },
  ])(
    "rejects incompatible or unverified receipts before OIDC (%#)",
    async (changes) => {
      await writeFile(receiptPath, JSON.stringify({ ...receipt, ...changes }));
      expect((await run()).ok).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("rejects a different workflow source and invalid provisioning storage", async () => {
    env.GITHUB_SHA = "c".repeat(40);
    expect(await run()).toMatchObject({
      stage: "validate_input",
      failedChecks: ["source_commit"],
    });
    env.GITHUB_SHA = sourceCommit;
    env.CLOUD_WORKSPACE_STORAGE_MIB = "0";
    expect((await run()).ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not follow a receipt symlink or read an oversized receipt", async () => {
    const target = path.join(directory, "target.json");
    await writeFile(target, JSON.stringify(receipt));
    await rm(receiptPath);
    await symlink(target, receiptPath);
    expect((await run()).ok).toBe(false);
    await rm(receiptPath);
    await writeFile(receiptPath, " ".repeat(128 * 1024 + 1));
    expect((await run()).ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requests the configured OIDC audience and registers idempotently with closed output", async () => {
    env.CLOUD_RUNTIME_OIDC_AUDIENCE = "alpha-custom-audience";
    expect((await run()).ok).toBe(true);
    expect((await run()).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const [oidcUrl, oidcInit] = fetcher.mock.calls[0];
    expect(new URL(String(oidcUrl)).searchParams.get("audience")).toBe(
      "alpha-custom-audience",
    );
    expect(new Headers(oidcInit?.headers).get("authorization")).toBe(
      `Bearer ${requestToken}`,
    );
    const [cpUrl, cpInit] = fetcher.mock.calls[1];
    expect(String(cpUrl)).toBe(
      `${env.CLOUD_WORKSPACE_CONTROL_PLANE_URL}/internal/v1/runtime-bases`,
    );
    expect(cpInit?.method).toBe("POST");
    expect(new Headers(cpInit?.headers).get("authorization")).toBe(
      `Bearer ${oidcToken}`,
    );
    expect(cpInit?.redirect).toBe("error");
    expect(cpInit?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(cpInit?.body))).toEqual(
      baseRegistrationBody(receipt, sourceCommit),
    );
    expect(fetcher.mock.calls[3][1]?.body).toBe(cpInit?.body);
    expect(output).toHaveLength(2);
    for (const line of output) {
      expect(ClosedDiagnosticSchema.safeParse(JSON.parse(line)).success).toBe(
        true,
      );
      for (const value of [
        requestToken,
        oidcToken,
        sourceCommit,
        snapshotName,
        String(receipt.compatibilityRawB64),
      ])
        expect(line).not.toContain(value);
    }
  });

  it("retries a lost registration reply with the same identity", async () => {
    const original = fetcher.getMockImplementation()!;
    let lost = false;
    fetcher.mockImplementation(async (input, init) => {
      if (String(input).includes("/runtime-bases") && !lost) {
        lost = true;
        throw new Error(`${requestToken} ${oidcToken}`);
      }
      return original(input, init);
    });
    expect((await run()).ok).toBe(true);
    expect(fetcher.mock.calls[1][1]?.body).toBe(fetcher.mock.calls[2][1]?.body);
    expect(output.join("")).not.toContain(requestToken);
    expect(output.join("")).not.toContain(oidcToken);
  });

  it.each(["oidc", "register"])(
    "bounds %s timeouts and does not leak exception values",
    async (phase) => {
      const original = fetcher.getMockImplementation()!;
      fetcher.mockImplementation((input, init) => {
        if ((String(input).includes("/token") ? "oidc" : "register") !== phase)
          return original(input, init);
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error(oidcToken)),
            { once: true },
          ),
        );
      });
      expect(await run(10)).toMatchObject({
        stage: phase,
        ok: false,
        timedOut: true,
        failedChecks: ["timeout"],
      });
      expect(fetcher.mock.calls.length).toBeLessThanOrEqual(5);
      expect(output.join("")).not.toContain(oidcToken);
    },
  );

  it.each([
    {
      phase: "oidc",
      status: 403,
      value: { error: oidcToken },
      check: "http_status",
    },
    {
      phase: "oidc",
      status: 200,
      value: { value: requestToken },
      check: "response_schema",
    },
    {
      phase: "register",
      status: 409,
      value: {
        error: { code: "runtime_identity_conflict", message: oidcToken },
      },
      check: "http_status",
    },
    {
      phase: "register",
      status: 404,
      value: { error: { code: "not_found" } },
      check: "http_status",
    },
    {
      phase: "register",
      status: 200,
      value: { baseImageId: "another-base", baseCompatibilityId: "unknown" },
      check: "response_schema",
    },
  ])(
    "rejects $phase responses with $check and keeps their values private",
    async ({ phase, status, value, check }) => {
      const original = fetcher.getMockImplementation()!;
      fetcher.mockImplementation(async (input, init) =>
        (String(input).includes("/token") ? "oidc" : "register") === phase
          ? Response.json(value, { status })
          : original(input, init),
      );
      expect(await run()).toMatchObject({
        ok: false,
        stage: phase,
        failedChecks: [check],
      });
      expect(output.join("")).not.toContain(oidcToken);
      expect(output.join("")).not.toContain(requestToken);
    },
  );

  it("cancels an oversized OIDC response without logging it", async () => {
    const cancel = vi.fn();
    fetcher.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(64 * 1024 + 1));
          },
          cancel,
        }),
      ),
    );
    expect(await run()).toMatchObject({
      stage: "oidc",
      ok: false,
      failedChecks: ["response_schema"],
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    { CLOUD_WORKSPACE_CONTROL_PLANE_URL: "http://control.example.invalid" },
    {
      CLOUD_WORKSPACE_CONTROL_PLANE_URL: "https://control.example.invalid/path",
    },
    { ACTIONS_ID_TOKEN_REQUEST_URL: "http://actions.example.invalid/token" },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "invalid\nheader" },
    { CLOUD_RUNTIME_OIDC_AUDIENCE: "invalid audience" },
  ])(
    "rejects unsafe auth or endpoint inputs without logging values (%#)",
    async (changes) => {
      Object.assign(env, changes);
      expect((await run()).ok).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});

describe("manual Alpha base workflow", () => {
  it("installs both frozen dependency trees before the pre-provider tests", async () => {
    const workflow = await readFile(
      new URL(
        "../../.github/workflows/cloud-runtime-base.yml",
        import.meta.url,
      ),
      "utf8",
    );
    const verifyStep = workflow
      .split("- name: Verify base tools before provider access")[1]
      ?.split("\n      - name:")[0];
    expect(verifyStep).toBeDefined();
    const rootInstall = verifyStep!.indexOf("pnpm install --frozen-lockfile");
    const controlPlaneInstall = verifyStep!.indexOf(
      "pnpm --dir apps/control-plane install --frozen-lockfile",
    );
    const tests = verifyStep!.indexOf("pnpm exec vitest run");
    expect(rootInstall).toBeGreaterThanOrEqual(0);
    expect(controlPlaneInstall).toBeGreaterThan(rootInstall);
    expect(tests).toBeGreaterThan(controlPlaneInstall);
  });

  it("registers only after successful build, cold boot and cleanup with narrowly scoped OIDC", async () => {
    const workflow = await readFile(
      new URL(
        "../../.github/workflows/cloud-runtime-base.yml",
        import.meta.url,
      ),
      "utf8",
    );
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/pull_request|push:\s/);
    expect(workflow).toContain(
      "github.event.repository.fork == false && github.ref == 'refs/heads/main'",
    );
    expect(workflow).toContain("environment: alpha");
    expect(workflow).toMatch(
      /build:[\s\S]*?permissions:\s*\n\s+contents: read\s*\n\s+id-token: write/,
    );
    const build = workflow.indexOf("runtime-base-v4 build");
    const cleanup = workflow.indexOf("runtime-base-v4 cleanup");
    const register = workflow.indexOf(
      "- name: Register verified base with Alpha",
    );
    expect(build).toBeGreaterThan(0);
    expect(cleanup).toBeGreaterThan(build);
    expect(register).toBeGreaterThan(cleanup);
    const step = workflow.slice(register);
    expect(step).toContain("if: success()");
    expect(step).toContain(
      "CLOUD_WORKSPACE_CONTROL_PLANE_URL: ${{ vars.VITE_CONTROL_PLANE_URL }}",
    );
    expect(step).toContain(
      "CLOUD_RUNTIME_OIDC_AUDIENCE: ${{ vars.CLOUD_RUNTIME_OIDC_AUDIENCE || 'zeros-control-plane-alpha' }}",
    );
    expect(step).toContain(
      "CLOUD_WORKSPACE_STORAGE_MIB: ${{ vars.CLOUD_WORKSPACE_STORAGE_MIB || '20480' }}",
    );
    expect(step).toContain("runtime-base-v4/register-base.ts");
    expect(step).toContain(
      '--receipt "$ZEROS_BOAT_IMAGE_STATE_DIR/runtime-base-v4/base-receipt.json"',
    );
    expect(step).not.toMatch(/secrets\.|BOAT_API_KEY/);
  });
});
