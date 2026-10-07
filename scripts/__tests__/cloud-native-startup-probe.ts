/** Disposable Phase 4 probe. No provider authentication, prompt, or network. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CloudNativeBoundary } from "../../apps/desktop/src/engine/agents/containment/cloud-native-boundary";
import { resolveCloudRuntime } from "../../apps/desktop/src/engine/agents/containment/cloud-runtime-root.mjs";
import { codexAppServerFeatureArgs } from "../../apps/desktop/src/engine/agents/adapters/codex/app-server";
import { cloudCodexConfig } from "../../apps/desktop/src/engine/agents/adapters/codex/cloud-policy";
import type { CloudAgentLease } from "../../apps/desktop/src/engine/agents/cloud-agent-lease";
import type { CloudProviderExecution } from "../../apps/desktop/src/engine/agents/cloud-provider-execution";
import type {
  BoundaryProcess,
  BoundarySpawnRequest,
  PreparedBoundary,
} from "../../apps/desktop/src/engine/agents/containment/types";

const runtime = resolveCloudRuntime();
const supervisor = `${runtime.workerRoot}/apps/desktop/src/engine/agents/containment/zsr-supervisor.mjs`;
const generation = "12345678-1234-4234-8234-123456789abc";
const records: Record<string, unknown>[] = [];
let phase = "engine";
let sequence = 0;
const children = new Set<BoundaryProcess>();

async function initializeOnly(
  started: BoundaryProcess,
  provider: "claude" | "codex",
) {
  const request =
    provider === "codex"
      ? {
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "zeros_startup_probe", version: "0.0.0" },
            capabilities: { experimentalApi: true },
          },
        }
      : {
          type: "control_request",
          request_id: "phase4-initialize",
          request: { subtype: "initialize", sdkMcpServers: [] },
        };
  await new Promise<void>((resolve, reject) => {
    let response = "";
    const finish = () => {
      clearTimeout(timer);
      started.stdout?.off("data", onData);
    };
    const onData = (chunk: Buffer | string) => {
      response += String(chunk);
      if (response.length > 1024 * 1024) {
        finish();
        reject(new Error("provider initialization exceeds limit"));
        return;
      }
      for (;;) {
        const end = response.indexOf("\n");
        if (end < 0) break;
        const line = response.slice(0, end);
        response = response.slice(end + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish();
          reject(new Error("provider initialization is invalid JSON"));
          return;
        }
        if (
          provider === "codex"
            ? message.id === 1
            : message.type === "control_response" &&
              message.response?.request_id === "phase4-initialize"
        ) {
          finish();
          if (
            provider === "codex"
              ? !message.result
              : message.response.subtype !== "success"
          ) {
            reject(new Error("provider initialization rejected"));
            return;
          }
          records.push({ phase: `${provider}:initialize`, result: "passed" });
          resolve();
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error("provider initialization timed out"));
    }, 7000);
    started.stdout?.on("data", onData);
    void started.wait().then(() => {
      finish();
      reject(new Error("provider exited before initialization"));
    }, reject);
    started.stdin?.write(`${JSON.stringify(request)}\n`);
  });
}

function workload(): PreparedBoundary {
  return {
    generation,
    status: { backend: "cloud-worker" },
    // The network lease and workload's admission receipt are intentionally
    // synthetic. Native HOME, runtime marker, ZSR policy, mounts, canary and
    // real OS identity are not mocked.
    attestation: Promise.resolve(),
    async spawn(request: BoundarySpawnRequest): Promise<BoundaryProcess> {
      if (phase === "claude-unwritable-home:prepare-canary") {
        // Negative control: a real worker EACCES must fail the production
        // canary and emerge as W3's containment cause before provider launch.
        chmodSync(`${request.cloudNativeHome!.directory}/home`, 0o500);
      }
      const directory = `/tmp/startup-${sequence++}`;
      mkdirSync(directory, { mode: 0o700 });
      mkdirSync(`${directory}/commands`, { mode: 0o700 });
      const policy = {
        version: 1,
        executionId: `startup-${sequence}`,
        generation,
        actor: "agent-code",
        cwd: "/srv/zeros/workspace",
        workspaceRoot: "/srv/zeros/workspace",
        filesystem: {
          allowRead: ["/"],
          allowWrite: ["/tmp", "/srv/zeros/workspace", "/srv/zeros/home/agent"],
          denyRead: ["/run/zeros", "/srv/zeros/state"],
          denyWrite: [],
        },
        runtime: {
          localHostParity: true,
          normalNetwork: true,
          allowPty: true,
          allowedUnixSockets: [],
          allowedLocalPorts: [],
          deniedLocalPorts: [],
          cloudWorker: { version: 1, uid: 10001, gid: 10001 },
        },
      };
      const policyPath = `${directory}/policy.json`,
        commandPath = `${directory}/commands/command.json`;
      writeFileSync(policyPath, JSON.stringify(policy), { mode: 0o600 });
      writeFileSync(
        commandPath,
        JSON.stringify({
          version: 7,
          generation,
          command: request.command,
          args: request.args,
          cwd: request.cwd,
          env: request.env,
          cloudNativeHome: request.cloudNativeHome,
          deniedContainerSockets: [],
        }),
        { mode: 0o600 },
      );
      const child = spawn(
        runtime.node,
        [supervisor, "--policy", policyPath, "--command", commandPath],
        {
          env: {
            PATH: "/usr/bin:/bin",
            HOME: "/tmp",
            ZEROS_ZSR_RIPGREP_PATH: `${runtime.binRoot}/rg`,
          },
          detached: true,
          stdio: "pipe",
        },
      );
      // Early process failure is recorded by wait(), including when stdin has
      // already closed before the initialization message can be written.
      child.stdin.on("error", () => {});
      const label = phase;
      let output = "",
        diagnostics = "";
      child.stdout.on("data", (chunk) => {
        if (output.length < 4096)
          output += String(chunk).slice(0, 4096 - output.length);
      });
      child.stderr.on("data", (chunk) => {
        if (diagnostics.length < 4096)
          diagnostics += String(chunk).slice(0, 4096 - diagnostics.length);
      });
      const result = new Promise<{
        code: number | null;
        signal: string | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => {
          records.push({ phase: label, code, signal, output, diagnostics });
          resolve({ code, signal });
        });
      });
      const owned: BoundaryProcess = {
        pid: child.pid!,
        child,
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        wait: () => result,
        async signal(signal) {
          child.kill(signal);
        },
        async stopAndProve() {
          if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGTERM");
          await result;
        },
      };
      children.add(owned);
      void result.finally(() => children.delete(owned)).catch(() => {});
      return owned;
    },
    async stopAndProve() {
      await Promise.all([...children].map((child) => child.stopAndProve()));
    },
  } as unknown as PreparedBoundary;
}

async function probe(provider: "claude" | "codex", unwritableHome = false) {
  const label = `${provider}${unwritableHome ? "-unwritable-home" : ""}`;
  const attached = new Set<{ stopAndProve(): Promise<void> }>();
  const abort = new AbortController();
  let closing: Promise<void> | undefined;
  const lease = {
    leaseId: randomUUID(),
    signal: abort.signal,
    admission: {
      provider,
      model: provider === "claude" ? "claude-sonnet-4-5" : "gpt-5-codex",
    },
    assertLive() {
      if (abort.signal.aborted) throw new Error("probe retired");
    },
    takeMaterial() {
      // Empty placeholder exercises the normal Claude environment branch.
      // No key is read, minted, supplied, or used for authentication.
      return provider === "claude"
        ? { kind: "claude-api-key", apiKey: "" }
        : { kind: "codex-chatgpt" };
    },
    attach(value: { stopAndProve(): Promise<void> }) {
      attached.add(value);
    },
    async launch<T>(launch: () => Promise<T>) {
      return launch();
    },
    async retire(value: { stopAndProve(): Promise<void> }) {
      await value.stopAndProve();
      attached.delete(value);
    },
    async validate() {},
    close() {
      return (closing ??= (async () => {
        abort.abort();
        for (const resource of [...attached].reverse()) {
          await resource.stopAndProve();
          attached.delete(resource);
        }
      })());
    },
    codexAuth() {
      return null;
    },
  } as unknown as CloudAgentLease;
  try {
    phase = `${label}:prepare-canary`;
    const boundary = await CloudNativeBoundary.prepare(
      lease,
      workload(),
      `phase4-${label}`,
    );
    records.push({ phase: `${provider}:prepare`, result: "passed" });
    phase = `${provider}:identity`;
    const identity = await boundary.spawn({
      command: runtime.node,
      args: [
        "-e",
        "const fs=require('node:fs');const s=fs.readFileSync('/proc/self/status','utf8');process.stdout.write(JSON.stringify({uid:process.getuid(),gid:process.getgid(),home:process.env.HOME,capEff:/^CapEff:\\s+(\\w+)/m.exec(s)[1],noNewPrivs:/^NoNewPrivs:\\s+(\\d+)/m.exec(s)[1]}))",
      ],
      cwd: "/srv/zeros/workspace",
      env: {},
      stdio: "pipe",
    });
    identity.stdin?.end();
    await identity.wait();
    phase = `${provider}:version`;
    const version = await boundary.spawn({
      command: `${runtime.binRoot}/${provider}`,
      args: ["--version"],
      cwd: "/srv/zeros/workspace",
      env: {},
      stdio: "pipe",
    });
    version.stdin?.end();
    await version.wait();
    phase = `${provider}:startup-no-prompt`;
    const codexConfig = cloudCodexConfig({
      lease,
      coordinator: boundary,
    } as CloudProviderExecution);
    const started = await boundary.spawn({
      command: `${runtime.binRoot}/${provider}`,
      args:
        provider === "claude"
          ? [
              "--print",
              "--input-format",
              "stream-json",
              "--output-format",
              "stream-json",
              "--verbose",
              "--no-session-persistence",
              "--permission-prompt-tool",
              "stdio",
            ]
          : [
              "app-server",
              ...codexAppServerFeatureArgs(true),
              ...Object.entries(codexConfig).flatMap(([name, value]) => [
                "-c",
                `${name}=${JSON.stringify(value)}`,
              ]),
            ],
      cwd: "/srv/zeros/workspace",
      env: {
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
        CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
      },
      stdio: "pipe",
    });
    // Only protocol initialization, never a user message, account/login or
    // thread/turn API. NativeBoundary preserves the actual startup flags.
    await initializeOnly(started, provider);
    started.stdin?.end();
    if (provider === "codex") {
      records.push({ phase: "codex:shutdown", result: "intentional-stop" });
      await started.stopAndProve();
    } else {
      await started.wait();
    }
  } catch (error) {
    records.push({
      phase,
      failure: error instanceof Error ? error.message : "unknown error",
    });
  } finally {
    await lease.close();
  }
}

async function main() {
  const status = readFileSync("/proc/self/status", "utf8");
  records.push({
    phase: "engine",
    uid: process.getuid!(),
    capEff: /^CapEff:\s+(\w+)/m.exec(status)?.[1],
    runtimeProfile: runtime.profile,
  });
  await probe("claude");
  await probe("codex");
  await probe("claude", true);
  process.stdout.write(`${JSON.stringify(records)}\n`);
}
void main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : "probe failed");
  process.exitCode = 1;
});
