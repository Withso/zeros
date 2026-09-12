import { describe, expect, it, vi } from "vitest";

import {
  DaytonaSandboxCommandRunner,
  daytonaToolboxResourceUrl,
  type DaytonaCommandClientLike,
  type DaytonaCommandSandboxLike,
} from "./daytona-command-runner.js";
import { DaytonaTransportError } from "./daytona-provider.js";

const config = {
  apiKey: "daytona-test-key-do-not-use",
  apiUrl: "https://api.example.test",
  allowedToolboxOrigins: ["https://proxy.example.test"],
  lookupTimeoutMs: 15_000,
  maxCommandTimeoutSeconds: 1_800,
  maxOutputBytes: 64,
};

function sandbox(
  id = "sandbox-exact-id",
  response: {
    exitCode: number;
    result: string;
    artifacts?: { stdout: string };
  } = { exitCode: 0, result: "complete\n" },
): DaytonaCommandSandboxLike {
  return {
    id,
    process: {
      executeCommand: vi.fn(async () => response),
    },
  };
}

function client(value: DaytonaCommandSandboxLike): DaytonaCommandClientLike {
  return { get: vi.fn(async () => value) };
}

function input(
  overrides: Partial<
    Parameters<DaytonaSandboxCommandRunner["execute"]>[0]
  > = {},
) {
  return {
    resourceId: "sandbox-exact-id",
    command: "/usr/local/bin/zeros-cloud-setup",
    cwd: "/workspace",
    env: {
      ZEROS_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
      ZEROS_EXECUTION_FENCE: "7",
    },
    timeoutSeconds: 600,
    ...overrides,
  };
}

describe("DaytonaSandboxCommandRunner", () => {
  it("constructs the narrow generated production adapter without provider I/O", () => {
    expect(() => new DaytonaSandboxCommandRunner(config)).not.toThrow();
  });

  it("binds provider toolbox URLs to an explicit HTTPS origin allowlist", () => {
    const allowed = new Set(["https://proxy.example.test"]);
    expect(
      daytonaToolboxResourceUrl(
        "https://proxy.example.test/toolbox/",
        "sandbox-exact-id",
        allowed,
      ),
    ).toBe("https://proxy.example.test/toolbox/sandbox-exact-id");
    for (const raw of [
      "https://evil.example.test/toolbox/",
      "https://proxy.example.test@evil.example.test/toolbox/",
      "https://proxy.example.test/toolbox/?redirect=evil",
      "http://proxy.example.test/toolbox/",
    ]) {
      expect(() =>
        daytonaToolboxResourceUrl(raw, "sandbox-exact-id", allowed),
      ).toThrowError(
        expect.objectContaining({ code: "provider_toolbox_url_invalid" }),
      );
    }
  });

  it("executes against the exact sandbox with an explicit provider deadline", async () => {
    const target = sandbox();
    const sdk = client(target);
    const runner = new DaytonaSandboxCommandRunner(config, sdk);
    const signal = new AbortController().signal;

    await expect(runner.execute(input(), signal)).resolves.toEqual({
      exitCode: 0,
      output: "complete\n",
      outputTruncated: false,
    });

    expect(sdk.get).toHaveBeenCalledWith("sandbox-exact-id", signal);
    expect(target.process.executeCommand).toHaveBeenCalledWith(
      "/usr/local/bin/zeros-cloud-setup",
      "/workspace",
      {
        ZEROS_WORKSPACE_ID: "00000000-0000-4000-8000-000000000001",
        ZEROS_EXECUTION_FENCE: "7",
      },
      600,
      signal,
    );
  });

  it("bounds multibyte provider output without splitting a character", async () => {
    const runner = new DaytonaSandboxCommandRunner(
      { ...config, maxOutputBytes: 5 },
      client(sandbox("sandbox-exact-id", { exitCode: 17, result: "ééé" })),
    );

    await expect(
      runner.execute(input(), new AbortController().signal),
    ).resolves.toEqual({
      exitCode: 17,
      output: "éé",
      outputTruncated: true,
    });
  });

  it("rejects unbounded commands, relative cwd values, and invalid env before lookup", async () => {
    const target = sandbox();
    const sdk = client(target);
    const runner = new DaytonaSandboxCommandRunner(config, sdk);
    const signal = new AbortController().signal;

    for (const invalid of [
      input({ timeoutSeconds: 0 }),
      input({ timeoutSeconds: config.maxCommandTimeoutSeconds + 1 }),
      input({ cwd: "workspace" }),
      input({ env: { "INVALID-NAME": "value" } }),
      input({ command: " setup\nnext " }),
    ]) {
      await expect(runner.execute(invalid, signal)).rejects.toMatchObject({
        code: "provider_command_invalid",
        retryable: false,
      });
    }

    expect(sdk.get).not.toHaveBeenCalled();
    expect(target.process.executeCommand).not.toHaveBeenCalled();
  });

  it("fails closed when Daytona resolves a different sandbox id", async () => {
    const target = sandbox("sandbox-similar-name");
    const runner = new DaytonaSandboxCommandRunner(config, client(target));

    await expect(
      runner.execute(input(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "provider_resource_mismatch",
      retryable: false,
    });
    expect(target.process.executeCommand).not.toHaveBeenCalled();
  });

  it("does not contact Daytona when the setup execution is already aborted", async () => {
    const target = sandbox();
    const sdk = client(target);
    const runner = new DaytonaSandboxCommandRunner(config, sdk);
    const controller = new AbortController();
    controller.abort();

    await expect(
      runner.execute(input(), controller.signal),
    ).rejects.toMatchObject({
      code: "provider_command_aborted",
      retryable: true,
    });
    expect(sdk.get).not.toHaveBeenCalled();
    expect(target.process.executeCommand).not.toHaveBeenCalled();
  });

  it("bounds a stalled read-only sandbox lookup", async () => {
    const sdk: DaytonaCommandClientLike = {
      get: vi.fn(() => new Promise<DaytonaCommandSandboxLike>(() => undefined)),
    };
    const runner = new DaytonaSandboxCommandRunner(
      { ...config, lookupTimeoutMs: 100 },
      sdk,
    );

    await expect(
      runner.execute(input(), new AbortController().signal),
    ).rejects.toMatchObject({
      code: "provider_lookup_timeout",
      retryable: true,
    });
  });

  it("honors abort while Daytona remains bounded by the provider deadline", async () => {
    let resolveCommand!: (value: { exitCode: number; result: string }) => void;
    const command = new Promise<{ exitCode: number; result: string }>(
      (resolve) => {
        resolveCommand = resolve;
      },
    );
    const target = sandbox();
    target.process.executeCommand = vi.fn(() => command);
    const runner = new DaytonaSandboxCommandRunner(config, client(target));
    const controller = new AbortController();

    const execution = runner.execute(
      input({ timeoutSeconds: 15 }),
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(target.process.executeCommand).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(Object),
        15,
        controller.signal,
      ),
    );
    controller.abort();

    await expect(execution).rejects.toMatchObject({
      code: "provider_command_aborted",
      retryable: true,
    });
    resolveCommand({ exitCode: 0, result: "late result" });
  });

  it("normalizes retryable Daytona transport failures without exposing inputs", async () => {
    const sdk: DaytonaCommandClientLike = {
      get: vi.fn(async () => {
        throw new DaytonaTransportError("secret-bearing provider response", {
          statusCode: 429,
          headers: { "retry-after": "3" },
        });
      }),
    };
    const runner = new DaytonaSandboxCommandRunner(config, sdk);

    const execution = runner.execute(input(), new AbortController().signal);
    await expect(execution).rejects.toMatchObject({
      code: "provider_temporarily_unavailable",
      retryable: true,
      retryAfterMs: 3_000,
    });
    await expect(execution).rejects.not.toThrow("secret-bearing");
  });
});
