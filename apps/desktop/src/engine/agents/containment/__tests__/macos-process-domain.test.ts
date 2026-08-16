import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MacosProcessDomain,
  recoverMacosProcessDomains,
  type MacosProcessDomainCommandRunner,
} from "../macos-process-domain";
import { newTerritoryGeneration } from "../status";

function identity(pid: number, uid = process.getuid?.() ?? 0) {
  return JSON.stringify({
    version: 1,
    pid,
    uid,
    startSec: "1234",
    startUsec: "5678",
  });
}

describe("macOS ZSR process domain", () => {
  let root: string;
  let helperPath: string;
  let markerPath: string;
  let policyPath: string;
  let metadataPath: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "zeros-macos-domain-"));
    helperPath = path.join(root, "zsr-macos-process-domain");
    markerPath = path.join(root, "tools", "process-domain.marker");
    policyPath = path.join(root, "policy.json");
    metadataPath = path.join(root, "commands", "process-domain.json");
    await Promise.all([
      mkdir(path.dirname(markerPath), { recursive: true }),
      mkdir(path.dirname(metadataPath), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(helperPath, "helper", { mode: 0o500 }),
      writeFile(markerPath, "marker", { mode: 0o400 }),
      writeFile(policyPath, "{}", { mode: 0o600 }),
    ]);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists an engine identity and proves an exact live fingerprint", async () => {
    const runner = vi.fn<MacosProcessDomainCommandRunner>(
      async (_helper, args) => {
        if (args[0] === "self-test") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              version: 1,
              platform: "darwin",
              processIdentity: true,
              sandboxInspection: true,
              callerSandboxed: false,
            }),
            stderr: "",
          };
        }
        if (args[0] === "identity") {
          return {
            exitCode: 0,
            stdout: identity(Number(args[1])),
            stderr: "",
          };
        }
        if (args[0] === "match") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ version: 1, match: true }),
            stderr: "",
          };
        }
        if (args[0] === "listeners") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              version: 1,
              listeners: [
                { port: 4321, ipv4: true, ipv6: false },
                { port: 5432, ipv4: false, ipv6: true },
              ],
            }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            version: 1,
            matched: 2,
            termSignals: 2,
            stopSignals: 1,
            killSignals: 1,
            remaining: 0,
            provedEmpty: true,
          }),
          stderr: "",
        };
      },
    );
    const generation = newTerritoryGeneration();
    const domain = await MacosProcessDomain.create({
      helperPath,
      markerPath,
      policyPath,
      metadataPath,
      generation,
      enginePid: 4321,
      runner,
    });

    await expect(domain.matches(9876)).resolves.toBe(true);
    await expect(domain.listTcpListeners()).resolves.toEqual([
      { port: 4321, ipv4: true, ipv6: false },
      { port: 5432, ipv4: false, ipv6: true },
    ]);
    await expect(domain.reap()).resolves.toMatchObject({
      remaining: 0,
      provedEmpty: true,
    });
    const descriptor = JSON.parse(await readFile(metadataPath, "utf8"));
    expect(descriptor).toMatchObject({
      version: 1,
      platform: "darwin",
      generation,
      markerPath,
      policyPath,
      ownerUid: process.getuid?.(),
      engine: { pid: 4321, startSec: "1234", startUsec: "5678" },
    });
    expect((await stat(metadataPath)).mode & 0o777).toBe(0o600);
    expect(runner).toHaveBeenCalledWith(
      helperPath,
      expect.arrayContaining([
        "--allow",
        markerPath,
        "--deny",
        policyPath,
        "--exclude",
        "4321",
        "--pid",
        "9876",
      ]),
    );
  });

  it("fails closed on malformed or unproved helper output", async () => {
    const badRunner: MacosProcessDomainCommandRunner = async (_helper, args) => {
      if (args[0] === "self-test") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            version: 1,
            platform: "darwin",
            processIdentity: true,
            sandboxInspection: true,
            callerSandboxed: false,
          }),
          stderr: "",
        };
      }
      if (args[0] === "identity") {
        return { exitCode: 0, stdout: identity(Number(args[1])), stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          version: 1,
          matched: 1,
          termSignals: 1,
          stopSignals: 1,
          killSignals: 1,
          remaining: 1,
          provedEmpty: false,
        }),
        stderr: "",
      };
    };
    const domain = await MacosProcessDomain.create({
      helperPath,
      markerPath,
      policyPath,
      metadataPath,
      generation: newTerritoryGeneration(),
      runner: badRunner,
    });
    await expect(domain.reap()).rejects.toThrow(/not proven/);
    await expect(readFile(metadataPath, "utf8")).resolves.toContain(
      '"platform":"darwin"',
    );
  });

  it("recovers a dead engine generation and preserves a live one", async () => {
    const sessionsRoot = path.join(root, "sessions");
    const deadRoot = path.join(sessionsRoot, "dead", "boundary", "dead-gen");
    const liveRoot = path.join(sessionsRoot, "live", "boundary", "live-gen");
    await Promise.all(
      [deadRoot, liveRoot].flatMap((generationRoot) => [
        mkdir(path.join(generationRoot, "commands"), { recursive: true }),
        mkdir(path.join(generationRoot, "tools"), { recursive: true }),
      ]),
    );
    const uid = process.getuid?.() ?? 0;
    const writeDescriptor = async (
      generationRoot: string,
      generation: string,
      enginePid: number,
      startSec: string,
    ) => {
      const marker = path.join(
        generationRoot,
        "tools",
        "process-domain.marker",
      );
      const policy = path.join(generationRoot, "policy.json");
      await Promise.all([
        writeFile(marker, "marker", { mode: 0o400 }),
        writeFile(policy, "{}", { mode: 0o600 }),
      ]);
      await writeFile(
        path.join(generationRoot, "commands", "process-domain.json"),
        JSON.stringify({
          version: 1,
          platform: "darwin",
          generation,
          markerPath: marker,
          policyPath: policy,
          ownerUid: uid,
          engine: {
            version: 1,
            pid: enginePid,
            uid,
            startSec,
            startUsec: "1",
          },
          createdAt: 1,
        }),
        { mode: 0o600 },
      );
    };
    await Promise.all([
      writeDescriptor(deadRoot, "dead-gen", 111, "10"),
      writeDescriptor(liveRoot, "live-gen", 222, "20"),
    ]);
    const runner = vi.fn<MacosProcessDomainCommandRunner>(
      async (_helper, args) => {
        if (args[0] === "self-test") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              version: 1,
              platform: "darwin",
              processIdentity: true,
              sandboxInspection: true,
              callerSandboxed: false,
            }),
            stderr: "",
          };
        }
        if (args[0] === "identity" && args[1] === "111") {
          return { exitCode: 4, stdout: "", stderr: "gone" };
        }
        if (args[0] === "identity") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              version: 1,
              pid: 222,
              uid,
              startSec: "20",
              startUsec: "1",
            }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            version: 1,
            matched: 1,
            termSignals: 1,
            stopSignals: 1,
            killSignals: 1,
            remaining: 0,
            provedEmpty: true,
          }),
          stderr: "",
        };
      },
    );

    await expect(
      recoverMacosProcessDomains({ helperPath, sessionsRoot, runner }),
    ).resolves.toEqual({
      discovered: 2,
      recovered: 1,
      active: 1,
      preserved: 0,
    });
    await expect(
      stat(path.join(deadRoot, "commands", "process-domain.json.reaped")),
    ).resolves.toBeDefined();
    await expect(
      stat(path.join(liveRoot, "commands", "process-domain.json")),
    ).resolves.toBeDefined();
  });

  it("preserves recovery evidence and rejects malformed descriptors", async () => {
    const sessionsRoot = path.join(root, "sessions");
    const commandRoot = path.join(
      sessionsRoot,
      "broken",
      "boundary",
      "generation",
      "commands",
    );
    await mkdir(commandRoot, { recursive: true });
    await writeFile(path.join(commandRoot, "process-domain.json"), "{}", {
      mode: 0o600,
    });
    await expect(
      recoverMacosProcessDomains({
        helperPath,
        sessionsRoot,
        runner: async (_helper, args) => ({
          exitCode: 0,
          stdout:
            args[0] === "self-test"
              ? JSON.stringify({
                  version: 1,
                  platform: "darwin",
                  processIdentity: true,
                  sandboxInspection: true,
                  callerSandboxed: false,
                })
              : identity(Number(args[1])),
          stderr: "",
        }),
      }),
    ).rejects.toThrow(/could not recover 1/);
    await expect(
      readFile(path.join(commandRoot, "process-domain.json"), "utf8"),
    ).resolves.toBe("{}");
  });
});
