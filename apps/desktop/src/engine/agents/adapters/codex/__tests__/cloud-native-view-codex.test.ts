import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { resolveCodexBinary } from "../binary-resolver";
import { CLOUD_CODEX_CONFIG } from "../cloud-policy";
import { codexAppServerFeatureArgs } from "../app-server";
import { cloudNativeHomeMounts, CLOUD_NATIVE_HOME } from "../../../containment/cloud-native-view.mjs";
import { prepareCloudCodexConfigView } from "../../../containment/cloud-native-boundary";

// Rebuild the production mount list with unprivileged namespaces. Paths are
// relocated under a scratch root; the order, targets and modes are unchanged.
const namespaces = process.platform === "linux" && spawnSync("unshare", ["-rm", "true"]).status === 0;

describe.runIf(namespaces)("pinned Codex inside the native cloud provider view", () => {
  it("initializes and starts a thread with the read-only configuration view", async () => {
    const binary = await resolveCodexBinary({});
    const root = await mkdtemp(path.join(os.homedir(), ".zeros-codex-view-"));
    const id = "a".repeat(32), coordinator = `/run/zeros/coordinators/${id}`, historyPath = `/srv/zeros/state/native-agent-history/${"b".repeat(64)}/codex`;
    const relocate = (target: string) => target === "/etc/codex" ? `${root}/etc-codex`
      : target.startsWith(CLOUD_NATIVE_HOME) ? `${root}/agent-home${target.slice(CLOUD_NATIVE_HOME.length)}`
      : target.startsWith(coordinator) ? `${root}/coordinator${target.slice(coordinator.length)}`
      : target === historyPath ? `${root}/history` : (() => { throw new Error(`unmapped ${target}`); })();
    try {
      for (const directory of ["agent-home", "etc-codex", "history", "ws", "coordinator/home/.codex"]) await mkdir(`${root}/${directory}`, { recursive: true });
      await mkdir(`${root}/coordinator/skills`);
      await prepareCloudCodexConfigView(`${root}/coordinator`);
      const mounts = cloudNativeHomeMounts({ directory: coordinator, history: { provider: "codex", directory: historyPath }, codexConfig: true, skills: true });
      const script: string[] = ["set -e"];
      for (let i = 0; i < mounts.length;) {
        const flag = mounts[i]!;
        // Like bwrap, create a missing directory mount point; that fails inside a
        // read-only mount, so the view must already provide it there.
        if (flag === "--tmpfs") { const target = relocate(mounts[i + 1]!); script.push(`[ -e '${target}' ] || mkdir -p '${target}'`, `mount -t tmpfs tmpfs '${target}'`); i += 2; continue; }
        const source = relocate(mounts[i + 1]!), target = relocate(mounts[i + 2]!);
        script.push(`[ -e '${target}' ] || mkdir -p '${target}'`, `mount --bind '${source}' '${target}'`);
        if (flag === "--ro-bind") script.push(`mount -o remount,ro,bind '${target}'`);
        i += 3;
      }
      const codexHome = `${root}/agent-home/.codex`;
      const config = { ...CLOUD_CODEX_CONFIG, sqlite_home: `${codexHome}/sessions/.zeros-state` };
      const codex = [path.join(binary.sandboxRuntimeRoot!, "bin", "codex"), "app-server", ...codexAppServerFeatureArgs(true),
        ...Object.entries(config).flatMap(([name, value]) => ["-c", `${name}=${JSON.stringify(value)}`])];
      await writeFile(`${root}/mounts.sh`, `${script.join("\n")}\nexec "$@"\n`);
      const child = spawn("unshare", ["-rm", "sh", `${root}/mounts.sh`, ...codex],
        { cwd: `${root}/ws`, env: { PATH: "/usr/bin:/bin", HOME: `${root}/agent-home`, CODEX_HOME: codexHome, LANG: "C.UTF-8" }, stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", () => {});
      let stderr = ""; child.stderr.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-4096); });
      const lines = createInterface({ input: child.stdout }), pending = new Map<number, (value: { result?: unknown; error?: unknown }) => void>();
      lines.on("line", line => { try { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); } catch { /* notifications */ } });
      const exited = new Promise<never>((_, reject) => child.once("exit", code => reject(new Error(`Codex exited (${code}): ${stderr}`))));
      const call = (id: number, method: string, params: unknown) => Promise.race([exited, new Promise<{ result?: unknown; error?: unknown }>(resolve => {
        pending.set(id, resolve); child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      })]);
      try {
        expect(await call(1, "initialize", { clientInfo: { name: "qualification", version: "1" }, capabilities: { experimentalApi: true } })).toMatchObject({ result: {} });
        child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        const started = await call(2, "thread/start", { model: "gpt-5.6-luna", modelProvider: "openai", cwd: `${root}/ws`, config, sandbox: "workspace-write", approvalPolicy: "on-request", experimentalRawEvents: false });
        expect(started.error).toBeUndefined();
        expect(stderr).not.toMatch(/failed to install system skills/);
      } finally { lines.close(); child.kill("SIGKILL"); }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});
