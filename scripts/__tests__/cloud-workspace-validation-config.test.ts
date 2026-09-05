// collectAgentCredEnv — the allowlist that couriers the provisioner's agent
// credentials into a cloud sandbox at create() time. It must (a) pass through
// ONLY set + non-blank allowlisted vars (an empty env would mask the real key
// with a blank one), and (b) NEVER blanket-copy process.env (that would leak
// DAYTONA_API_KEY and friends into the box).

import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  bridgeWsUrl,
  clearState,
  collectAgentCredEnv,
  collectCloudAccountBindingEnv,
  collectCloudGithubCredential,
  ENGINE_CLOUD_PORT,
  imageContractSha256,
  loadState,
  loadSnapshotAttestation,
  NODE_BASE_IMAGE,
  parseDaytonaPreviewHostSuffixes,
  parseDaytonaSshHosts,
  parseCloudValidationPort,
  parseCloudValidationResources,
  parseCloudValidationState,
  SANDBOX_AGENT_GID,
  SANDBOX_AGENT_UID,
  SANDBOX_DATA_DIR,
  SANDBOX_ENGINE_DIR,
  SANDBOX_REPO_DIR,
  saveState,
  saveSnapshotAttestation,
  withCloudValidationMutationLock,
  type CloudSnapshotAttestation,
  type CloudValidationState,
} from "../cloud-workspace-validation/config";

const tempRoots: string[] = [];
const statePath = () => {
  const root = mkdtempSync(join(tmpdir(), "zeros-cloud-validation-"));
  tempRoots.push(root);
  return join(root, "private", "state.json");
};

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("Daytona access host allowlists", () => {
  it("keeps the production SSH default and parses explicit exact hosts", () => {
    expect(parseDaytonaSshHosts(undefined)).toEqual(["ssh.app.daytona.io"]);
    expect(parseDaytonaPreviewHostSuffixes(undefined)).toEqual([
      "proxy.daytona.work",
    ]);
    expect(
      parseDaytonaSshHosts(
        "ssh.eu.example.test,ssh.us.example.test,ssh.eu.example.test",
      ),
    ).toEqual(["ssh.eu.example.test", "ssh.us.example.test"]);
    expect(() => parseDaytonaSshHosts("*.example.test")).toThrow(
      /DAYTONA_SSH_HOSTS/,
    );
  });
});

describe("collectAgentCredEnv", () => {
  const saved = new Map<string, string | undefined>();
  const setEnv = (k: string, v: string | undefined) => {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    saved.clear();
  });

  it("passes through only the set credential vars, trimmed", () => {
    setEnv("ANTHROPIC_API_KEY", "sk-ant-123");
    setEnv("OPENAI_API_KEY", ""); // blank must NOT become an empty env in the box
    setEnv("CURSOR_API_KEY", "  cur-xyz  "); // trimmed
    const env = collectAgentCredEnv();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-123");
    expect(env.CURSOR_API_KEY).toBe("cur-xyz");
    expect("OPENAI_API_KEY" in env).toBe(false);
  });

  it("never passes a non-allowlisted var (no blanket process.env copy)", () => {
    setEnv("DAYTONA_API_KEY", "leak-me");
    expect("DAYTONA_API_KEY" in collectAgentCredEnv()).toBe(false);
  });
});

describe("qualified cloud owner and GitHub credential inputs", () => {
  it("requires asymmetric account binding and never includes the client JWT", () => {
    const env = collectCloudAccountBindingEnv({
      ZEROS_CLOUD_OWNER_SUB: "auth0|owner",
      ZEROS_ACCOUNT_JWT_JWKS_URL:
        "https://identity.example.test/.well-known/jwks.json",
      ZEROS_ACCOUNT_JWT_AUD: "zeros-api",
      ZEROS_ACCOUNT_ACCESS_TOKEN: "must-stay-with-the-client",
    });
    expect(env).toEqual({
      ZEROS_CLOUD_OWNER_SUB: "auth0|owner",
      ZEROS_ACCOUNT_JWT_JWKS_URL:
        "https://identity.example.test/.well-known/jwks.json",
      ZEROS_ACCOUNT_JWT_AUD: "zeros-api",
      ZEROS_REQUIRE_ACCOUNT: "1",
    });
    expect(JSON.stringify(env)).not.toContain("must-stay-with-the-client");
    expect(() =>
      collectCloudAccountBindingEnv({
        ZEROS_CLOUD_OWNER_SUB: "auth0|owner",
      }),
    ).toThrow(/asymmetric account binding/i);
  });

  it("carries the exact WorkOS token contract into live image qualification", () => {
    expect(
      collectCloudAccountBindingEnv({
        ZEROS_CLOUD_OWNER_SUB: "user_workos_owner",
        ZEROS_ACCOUNT_JWT_JWKS_URL:
          "https://api.workos.com/sso/jwks/client_desktop_example",
        ZEROS_ACCOUNT_JWT_ISS:
          "https://api.workos.com/user_management/client_example_web",
        ZEROS_ACCOUNT_JWT_AUD: "https://api.zeros.build",
        ZEROS_ACCOUNT_JWT_CONTRACT: "zeros-access-v1",
        ZEROS_ACCOUNT_JWT_CLIENT_ID: "client_desktop_example",
      }),
    ).toMatchObject({
      ZEROS_ACCOUNT_JWT_CONTRACT: "zeros-access-v1",
      ZEROS_ACCOUNT_JWT_CLIENT_ID: "client_desktop_example",
    });
    expect(() =>
      collectCloudAccountBindingEnv({
        ZEROS_CLOUD_OWNER_SUB: "user_workos_owner",
        ZEROS_ACCOUNT_JWT_JWKS_URL:
          "https://api.workos.com/sso/jwks/client_desktop_example",
        ZEROS_ACCOUNT_JWT_ISS:
          "https://api.workos.com/user_management/client_example_web",
        ZEROS_ACCOUNT_JWT_AUD: "https://api.zeros.build",
        ZEROS_ACCOUNT_JWT_CONTRACT: "zeros-access-v1",
      }),
    ).toThrow(/client id/i);
  });

  it("preserves the exact slashless token issuer after URL validation", () => {
    const issuer = "https://issuer.example.test";
    expect(
      collectCloudAccountBindingEnv({
        ZEROS_CLOUD_OWNER_SUB: "user_workos_owner",
        ZEROS_ACCOUNT_JWT_JWKS_URL:
          "https://issuer.example.test/.well-known/jwks.json",
        ZEROS_ACCOUNT_JWT_ISS: issuer,
        ZEROS_ACCOUNT_JWT_AUD: "https://api.zeros.build",
        ZEROS_ACCOUNT_JWT_CONTRACT: "zeros-access-v1",
        ZEROS_ACCOUNT_JWT_CLIENT_ID: "client_desktop_example",
      }).ZEROS_ACCOUNT_JWT_ISS,
    ).toBe(issuer);
  });

  it("parses a working GitHub credential without putting it in cloud state", () => {
    expect(
      collectCloudGithubCredential({
        ZEROS_CLOUD_GITHUB_TOKEN: "github_pat_working-copy",
        ZEROS_CLOUD_GITHUB_METHOD: "pat",
        ZEROS_CLOUD_GITHUB_LOGIN: "octocat",
      }),
    ).toEqual({
      method: "pat",
      accessToken: "github_pat_working-copy",
      gitHost: "github.com",
      gitHttpUsername: "x-access-token",
      login: "octocat",
    });
    expect(collectCloudGithubCredential({})).toBeNull();
    expect(() =>
      collectCloudGithubCredential({
        ZEROS_CLOUD_GITHUB_TOKEN: "token\nsmuggled",
      }),
    ).toThrow(/GitHub credential/i);
  });
});

describe("cloud worker image contract", () => {
  it("rejects malformed or unexpectedly expensive provider resources before an API call", () => {
    expect(parseCloudValidationPort(undefined)).toBe(39_393);
    expect(parseCloudValidationPort("65535")).toBe(65_535);
    for (const value of ["0", "22222", "01", "1.5", "1e3", "65536"]) {
      expect(() => parseCloudValidationPort(value)).toThrow(/cloud port/i);
    }

    expect(parseCloudValidationResources({})).toEqual({
      cpu: 2,
      memory: 4,
      disk: 10,
    });
    expect(
      parseCloudValidationResources({
        ZEROS_SANDBOX_CPU: "4",
        ZEROS_SANDBOX_MEMORY: "16",
        ZEROS_SANDBOX_DISK: "100",
      }),
    ).toEqual({ cpu: 4, memory: 16, disk: 100 });
    for (const [name, value] of [
      ["ZEROS_SANDBOX_CPU", "NaN"],
      ["ZEROS_SANDBOX_CPU", "65"],
      ["ZEROS_SANDBOX_MEMORY", "0"],
      ["ZEROS_SANDBOX_MEMORY", "257"],
      ["ZEROS_SANDBOX_DISK", "Infinity"],
      ["ZEROS_SANDBOX_DISK", "1025"],
    ] as const) {
      expect(() => parseCloudValidationResources({ [name]: value })).toThrow(
        new RegExp(name),
      );
    }
  });

  it("separates immutable coordinator bytes from the writable checkout", () => {
    expect(NODE_BASE_IMAGE).toMatch(/@sha256:[a-f0-9]{64}$/);
    expect(SANDBOX_ENGINE_DIR).toBe("/opt/zeros");
    expect(SANDBOX_REPO_DIR).toBe("/workspace/zeros");
    expect(SANDBOX_DATA_DIR).toBe("/var/lib/zeros");
    expect(SANDBOX_ENGINE_DIR).not.toBe(SANDBOX_REPO_DIR);
  });

  it("hashes the complete local image contract", () => {
    expect(imageContractSha256()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("persists the immutable snapshot identity owner-only", () => {
    const file = statePath();
    const attestation: CloudSnapshotAttestation = {
      version: 1,
      snapshotId: "snapshot-id",
      snapshotName: "snapshot-name",
      snapshotImageName: "image-name",
      snapshotState: "active",
      baseImage: NODE_BASE_IMAGE,
      repositoryUrlSha256: "b".repeat(64),
      repositoryRef: "main",
      sourceCommit: "c".repeat(40),
      imageContractSha256: imageContractSha256(),
      bakedAt: "2026-08-14T00:00:00.000Z",
    };
    saveSnapshotAttestation(attestation, file);
    expect(loadSnapshotAttestation(file)).toEqual(attestation);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it("keeps the baked marker synchronized with the dedicated worker", () => {
    const marker = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "scripts/cloud-workspace-validation/sandbox/cloud-worker.json",
        ),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(marker).toEqual({
      version: 1,
      backend: "cloud-worker",
      profile: "zeros-cloud-worker-v1",
      uid: SANDBOX_AGENT_UID,
      gid: SANDBOX_AGENT_GID,
      toolchain: {
        node: "/usr/local/bin/node",
        supervisor:
          "/opt/zeros/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs",
        bwrap: "/usr/bin/bwrap",
        setpriv: "/usr/bin/setpriv",
      },
    });
  });
});

describe("cloud validation connection state", () => {
  const state: CloudValidationState = {
    sandboxId: "sandbox-test",
    previewUrl: "https://39393-sandbox-id.proxy.daytona.work",
    previewToken: "preview-token-placeholder",
    cloudToken: "cloud-token-placeholder",
    region: "test",
    createdAt: "2026-08-05T00:00:00.000Z",
    snapshotId: "snapshot-test",
    snapshotImageName: "snapshot-image-test",
    runtimeAttestationSha256: "a".repeat(64),
  };

  it("atomically writes owner-only state and removes it during cleanup", () => {
    const file = statePath();
    saveState(state, file);

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(state);
    expect(JSON.stringify(JSON.parse(readFileSync(file, "utf8")))).not.toMatch(
      /github_pat|accessToken|refreshToken/,
    );
    expect(loadState(file)).toEqual(state);
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    }
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);

    const refreshed = { ...state, region: "updated" };
    saveState(refreshed, file);
    expect(loadState(file)).toEqual(refreshed);

    clearState(file);
    expect(existsSync(file)).toBe(false);
  });

  it("round-trips a signed engine ingress and its revocable generations", () => {
    const token = "signed-engine-token-1234";
    const ingress = {
      generation: "engine-ingress-generation-one",
      expiresAt: 1_800_000_060_000,
      port: ENGINE_CLOUD_PORT,
      token,
      url: `https://${ENGINE_CLOUD_PORT}-${token}.proxy.daytona.work/`,
      retiring: [
        {
          generation: "engine-ingress-generation-old",
          expiresAt: 1_800_000_030_000,
          port: ENGINE_CLOUD_PORT,
          token: "signed-engine-token-old-1",
        },
      ],
    };
    const qualified: CloudValidationState = {
      ...state,
      previewUrl: ingress.url,
      previewToken: ingress.token,
      engineIngress: ingress,
    };
    const file = statePath();

    saveState(qualified, file);

    expect(loadState(file)).toEqual(qualified);
  });

  it.each([
    {
      name: "query bearer",
      mutate: (value: Record<string, unknown>) => {
        const ingress = value.engineIngress as Record<string, unknown>;
        ingress.url = `${String(ingress.url)}?token=leak`;
        value.previewUrl = ingress.url;
      },
    },
    {
      name: "wrong provider hostname token",
      mutate: (value: Record<string, unknown>) => {
        const ingress = value.engineIngress as Record<string, unknown>;
        ingress.url = `https://${ENGINE_CLOUD_PORT}-other-token.proxy.daytona.work/`;
        value.previewUrl = ingress.url;
      },
    },
    {
      name: "an attacker-controlled provider suffix",
      mutate: (value: Record<string, unknown>) => {
        const ingress = value.engineIngress as Record<string, unknown>;
        ingress.url = `https://${ENGINE_CLOUD_PORT}-signed-engine-token-1234.attacker.example/`;
        value.previewUrl = ingress.url;
      },
    },
    {
      name: "wrong engine port",
      mutate: (value: Record<string, unknown>) => {
        const ingress = value.engineIngress as Record<string, unknown>;
        ingress.port = ENGINE_CLOUD_PORT + 1;
      },
    },
    {
      name: "inconsistent legacy alias",
      mutate: (value: Record<string, unknown>) => {
        value.previewToken = "different-revocation-token";
      },
    },
  ])("rejects signed ingress with $name", ({ mutate }) => {
    const token = "signed-engine-token-1234";
    const raw: Record<string, unknown> = {
      ...state,
      previewUrl: `https://${ENGINE_CLOUD_PORT}-${token}.proxy.daytona.work/`,
      previewToken: token,
      engineIngress: {
        generation: "engine-ingress-generation-one",
        expiresAt: 1_800_000_060_000,
        port: ENGINE_CLOUD_PORT,
        token,
        url: `https://${ENGINE_CLOUD_PORT}-${token}.proxy.daytona.work/`,
      },
    };
    mutate(raw);

    expect(() => parseCloudValidationState(raw)).toThrow(
      /engine ingress|invalid/i,
    );
  });

  it("keeps the cloud bearer out of the WebSocket request target", () => {
    const url = bridgeWsUrl(
      "https://preview.example.test/original?token=legacy-query-value",
    );
    const parsed = new URL(url);

    expect(parsed.protocol).toBe("wss:");
    expect(parsed.pathname).toBe("/ws");
    expect(parsed.searchParams.has("token")).toBe(false);
  });

  it("rejects malformed or symlink-rerouted private state", () => {
    const malformed = statePath();
    mkdirSync(dirname(malformed), { recursive: true, mode: 0o700 });
    writeFileSync(malformed, '{"sandboxId":"only-one-field"}\n', {
      mode: 0o600,
    });
    expect(() => loadState(malformed)).toThrow(/validation state/i);

    if (process.platform !== "win32") {
      const root = mkdtempSync(join(tmpdir(), "zeros-cloud-symlink-"));
      tempRoots.push(root);
      const target = join(root, "target");
      const alias = join(root, "alias");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, alias, "dir");
      expect(() => saveState(state, join(alias, "state.json"))).toThrow(
        /private state directory/i,
      );
    }
  });
});

describe("cloud validation mutation lock", () => {
  it("serializes competing mutations and releases after failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "zeros-cloud-lock-"));
    tempRoots.push(root);
    const lockDirectory = join(root, "private", "mutation.lock");
    const events: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const first = withCloudValidationMutationLock(
      async () => {
        events.push("first:start");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        events.push("first:end");
      },
      { lockDirectory, timeoutMs: 2_000, pollMs: 10 },
    );
    while (!releaseFirst)
      await new Promise((resolve) => setTimeout(resolve, 1));
    const second = withCloudValidationMutationLock(
      async () => {
        events.push("second");
      },
      { lockDirectory, timeoutMs: 2_000, pollMs: 10 },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
    expect(existsSync(lockDirectory)).toBe(false);

    await expect(
      withCloudValidationMutationLock(
        async () => {
          throw new Error("operation failed");
        },
        { lockDirectory, timeoutMs: 2_000, pollMs: 10 },
      ),
    ).rejects.toThrow("operation failed");
    expect(existsSync(lockDirectory)).toBe(false);
  });
});
