import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BoatSetupCommandRunner,
  isPublicBoatAddress,
  parseBoatHostKey,
  parseBoatSshEndpoint,
  boatAuthorizedKeyCommand,
  type BoatBootstrapExecution,
} from "./boat-setup-runner.js";
import { CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND } from "./daytona-setup-executor.js";

const keyBytes = Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from("ssh-ed25519"),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7),
]);
const HOST_KEY = `ssh-ed25519 ${keyBytes.toString("base64")}`;
const PUBLIC_KEY = `${HOST_KEY} zeros-bootstrap-test`;
const RESOURCE = "bx_23456789";
const SECRET = Buffer.from("private-admission-document").toString("base64url");
function fixture() {
  const request = vi.fn(async (path: string, input?: unknown) =>
    path === `/sandboxes/${RESOURCE}`
      ? {
          ok: true,
          sandbox: { id: RESOURCE, ip: "208.67.222.222" },
        }
      : {
          ok: true,
          success: true,
          exitCode: 0,
          stdout: String(
            (input as { body?: { command?: string } })?.body?.command,
          ).includes("ensure-cloud-worker-supervisor.mjs")
            ? "ready\n"
            : String(
                  (input as { body?: { command?: string } })?.body?.command,
                ).includes("authorized_keys")
              ? String(
                  (input as { body?: { command?: string } })?.body?.command,
                ).includes("expiry-time")
                ? "restricted\n"
                : "revoked\n"
              : HOST_KEY,
          stderr: "",
          timedOut: false,
        },
  );
  const channel = {
    publicKey: PUBLIC_KEY,
    execute: vi.fn(
      async (_input: BoatBootstrapExecution, _signal: AbortSignal) => ({
        exitCode: 0,
        output: "ready",
        outputTruncated: false,
      }),
    ),
    dispose: vi.fn(async () => {}),
  };
  const openChannel = vi.fn(async () => channel);
  const assertOwned = vi.fn(async () => {});
  const runner = new BoatSetupCommandRunner({
    client: { request },
    openChannel,
    assertOwned,
    maxOutputBytes: 1024,
    maxTimeoutSeconds: 600,
  });
  const input = {
    resourceId: RESOURCE,
    command: CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND,
    cwd: "/",
    env: { ZEROS_CLOUD_WORKSPACE_SETUP_B64: SECRET },
    timeoutSeconds: 60,
  };
  return { request, channel, openChannel, assertOwned, runner, input };
}

describe("Boat bootstrap transport", () => {
  it("sends admission only through a host-key-pinned SSH stdin channel", async () => {
    const f = fixture();
    await expect(
      f.runner.execute(f.input, new AbortController().signal),
    ).resolves.toEqual({
      exitCode: 0,
      output: "ready",
      outputTruncated: false,
    });
    expect(f.assertOwned).toHaveBeenCalledWith(RESOURCE);
    expect(f.request.mock.calls.some(([url]) => url.endsWith("/sshkey"))).toBe(
      false,
    );
    expect(f.request.mock.calls[0]?.[1]).toMatchObject({
      body: {
        command:
          "/usr/bin/sudo -n /opt/zeros-runtime/bin/node /opt/zeros-runtime/lib/zeros/ensure-cloud-worker-supervisor.mjs",
      },
    });
    expect(f.channel.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "208.67.222.222",
        hostPublicKey: HOST_KEY,
        stdin: SECRET,
        timeoutSeconds: 60,
      }),
      expect.any(AbortSignal),
    );
    const delivered = f.channel.execute.mock.calls[0][0];
    expect(delivered.command).not.toContain(SECRET);
    expect(JSON.stringify(f.request.mock.calls)).not.toContain(SECRET);
    expect(f.channel.dispose).toHaveBeenCalledOnce();
    expect(f.request.mock.calls.at(-1)?.[1]).toMatchObject({
      method: "POST",
      body: { command: expect.stringContaining("authorized_keys") },
    });
    const restriction = f.request.mock.calls.find(([, input]) =>
      String(
        (input as { body?: { command?: string } })?.body?.command,
      ).includes("expiry-time"),
    );
    expect(restriction).toBeDefined();
    expect(restriction?.[1]).toMatchObject({
      body: { command: expect.stringContaining("restrict,") },
    });
  });

  it.each([
    { command: "cat /root/private" },
    { cwd: "/tmp" },
    {
      env: {
        ZEROS_CLOUD_WORKSPACE_SETUP_B64: SECRET,
        BOAT_API_KEY: "never-forward",
      },
    },
    { timeoutSeconds: 601 },
    { resourceId: "../../escape" },
    { env: { ZEROS_CLOUD_WORKSPACE_SETUP_B64: "not base64" } },
  ])(
    "rejects invalid setup input before any provider operation: %j",
    async (overrides) => {
      const f = fixture();
      await expect(
        f.runner.execute(
          { ...f.input, ...overrides },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "provider_command_invalid" });
      expect(f.openChannel).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it("cannot install a key on another generation's allocation", async () => {
    const f = fixture();
    f.assertOwned.mockRejectedValueOnce(new Error("not owned"));
    await expect(
      f.runner.execute(f.input, new AbortController().signal),
    ).rejects.toBeDefined();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.openChannel).not.toHaveBeenCalled();
  });

  it("uses the provider's public SSH gateway when the machine has an IPv6-only address", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, input) =>
      url === `/sandboxes/${RESOURCE}`
        ? {
            ok: true,
            sandbox: {
              id: RESOURCE,
              ip: "2606:4700:4700::1111",
              sshEndpoint: "208.67.222.222:19037",
            },
          }
        : original(url, input),
    );
    await f.runner.execute(f.input, new AbortController().signal);
    expect(f.channel.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "208.67.222.222",
        port: 19037,
        hostPublicKey: HOST_KEY,
      }),
      expect.any(AbortSignal),
    );
  });

  it("does not send bootstrap credentials or install a key without broker readiness", async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({
      ok: true,
      success: true,
      exitCode: 0,
      stdout: "unconfirmed\n",
      stderr: "",
      timedOut: false,
    });
    await expect(
      f.runner.execute(f.input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "provider_bootstrap_unavailable" });
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.channel.execute).not.toHaveBeenCalled();
    expect(f.channel.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    "127.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fe80::1",
    "10.0.0.1",
    "boat.example.test",
  ])("refuses a provider-returned nonpublic SSH address %s", async (host) => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path, input) =>
      path === `/sandboxes/${RESOURCE}`
        ? { ok: true, sandbox: { id: RESOURCE, ip: host } }
        : original(path, input),
    );
    await expect(
      f.runner.execute(f.input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "provider_access_response_invalid" });
    expect(f.channel.execute).not.toHaveBeenCalled();
    expect(f.channel.dispose).toHaveBeenCalledOnce();
  });

  it("retains uncertainty after a lost SSH reply and always destroys the private key", async () => {
    const f = fixture();
    f.channel.execute.mockRejectedValueOnce(new Error(`secret ${SECRET}`));
    await expect(
      f.runner.execute(f.input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "provider_command_unconfirmed" });
    expect(f.channel.execute).toHaveBeenCalledOnce();
    expect(f.channel.dispose).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.request.mock.calls)).not.toContain(SECRET);
  });

  it("does not report setup success when bootstrap-key revocation failed", async () => {
    const f = fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path, input) => {
      if (
        String(
          (input as { body?: { command?: string } })?.body?.command,
        ).includes("print('revoked')")
      )
        throw new Error("unavailable");
      return original(path, input);
    });
    await expect(
      f.runner.execute(f.input, new AbortController().signal),
    ).rejects.toMatchObject({ code: "provider_bootstrap_cleanup_unconfirmed" });
    expect(f.channel.dispose).toHaveBeenCalledOnce();
  });

  it("validates the SSH key's wire format and numeric routing boundary", () => {
    expect(
      parseBoatSshEndpoint({ sshEndpoint: "[2606:4700:4700::1111]:2222" }),
    ).toEqual({ host: "2606:4700:4700::1111", port: 2222 });
    for (const sshEndpoint of [
      "127.0.0.1:22",
      "192.168.0.1:2222",
      "208.67.222.222:0",
      "208.67.222.222:65536",
      "208.67.222.222:22\n",
      "example.test:22",
      "ssh://208.67.222.222:22",
      "2002:0a00:0001::1:22",
    ])
      expect(() =>
        parseBoatSshEndpoint({ ip: "208.67.222.222", sshEndpoint }),
      ).toThrow();
    expect(parseBoatHostKey(`${HOST_KEY} host-comment\n`)).toBe(HOST_KEY);
    for (const key of [
      "ssh-rsa AAAA",
      `${HOST_KEY}\n${HOST_KEY}`,
      "ssh-ed25519 AAAA",
      `${HOST_KEY}x`,
    ])
      expect(() => parseBoatHostKey(key)).toThrow();
    expect(isPublicBoatAddress("208.67.222.222")).toBe(true);
    expect(isPublicBoatAddress("2606:4700:4700::1111")).toBe(true);
    for (const address of [
      "192.168.1.1",
      "100.64.0.1",
      "224.0.0.1",
      "2001:db8::1",
      "fc00::1",
      "0.0.0.0",
      "2002:0a00:0001::1",
      "2001:0000:4136:e378:8000:63bf:3fff:fdd2",
      "2001:20::1",
      "3fff::1",
      "192.88.99.1",
    ])
      expect(isPublicBoatAddress(address)).toBe(false);
  });

  it.skipIf(process.platform !== "linux")(
    "atomically installs only expiring forced-command keys and preserves other keys during revocation",
    () => {
      const home = mkdtempSync(path.join(tmpdir(), "zeros-bootstrap-key-"));
      const invoke = (restriction?: { command: string; seconds: number }) => {
        const command = boatAuthorizedKeyCommand(
          PUBLIC_KEY,
          restriction,
        ).replace("'/home/user'", JSON.stringify(home));
        return spawnSync("/bin/sh", ["-c", command], {
          encoding: "utf8",
          timeout: 3000,
        });
      };
      try {
        const restriction = {
          seconds: 90,
          command: `/usr/bin/sudo -n /usr/bin/timeout --signal=TERM --kill-after=5s 60s ${CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND} --stdin`,
        };
        expect(invoke(restriction).status).toBe(0);
        const file = path.join(home, ".ssh/authorized_keys");
        const installed = readFileSync(file, "utf8");
        expect(installed).toMatch(
          /^restrict,expiry-time="[0-9]{14}Z",command=/,
        );
        expect(installed.split("\n").filter(Boolean)).toHaveLength(1);
        const unrelated = "ssh-ed25519 unrelated-public-material retained";
        writeFileSync(file, `${unrelated}\n${installed}`);
        expect(invoke().status).toBe(0);
        expect(readFileSync(file, "utf8")).toBe(
          `${unrelated}\n#${installed.slice(1)}`,
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== "linux")(
    "refuses key-directory and key-file aliases before modifying their target",
    () => {
      for (const alias of ["directory", "file"]) {
        const root = mkdtempSync(path.join(tmpdir(), "zeros-bootstrap-alias-"));
        const home = path.join(root, "login");
        mkdirSync(home, { mode: 0o700 });
        const target = path.join(root, "target");
        if (alias === "directory") {
          mkdirSync(target);
          symlinkSync(target, path.join(home, ".ssh"));
        } else {
          writeFileSync(target, "preserve");
          mkdirSync(path.join(home, ".ssh"));
          symlinkSync(target, path.join(home, ".ssh/authorized_keys"));
        }
        try {
          const command = boatAuthorizedKeyCommand(PUBLIC_KEY).replace(
            "'/home/user'",
            JSON.stringify(home),
          );
          expect(
            spawnSync("/bin/sh", ["-c", command], {
              encoding: "utf8",
              timeout: 3000,
            }).status,
          ).not.toBe(0);
          if (alias === "file")
            expect(readFileSync(target, "utf8")).toBe("preserve");
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );
});
