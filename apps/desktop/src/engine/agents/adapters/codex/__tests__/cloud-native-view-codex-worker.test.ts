import { execFileSync, spawn } from "node:child_process";
import { chown, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";
import { resolveCodexBinary } from "../binary-resolver";
import { CLOUD_CODEX_CONFIG } from "../cloud-policy";
import { codexAppServerFeatureArgs } from "../app-server";
import { assertOwnedCloudNativeHome, cloudNativeHomeMounts, CLOUD_NATIVE_HOME } from "../../../containment/cloud-native-view.mjs";
import { prepareCloudCodexConfigView, prepareCloudSkillHomes } from "../../../containment/cloud-native-boundary";
import { materializeCloudSkills } from "../../../cloud-skills";

// The cloud worker's bwrap mounts the view as root and only then drops to the
// worker, so ownership and modes matter; unprivileged namespaces cannot model
// that. This fixture uses the fixed production paths and requires an explicit
// disposable-root invocation; it never replaces an existing /srv/zeros.
const WORKER = 10001;
describe.runIf(process.platform === "linux" && process.getuid?.() === 0 && process.env.ZEROS_RUN_ROOT_FIXTURES === "1")("pinned Codex as the cloud worker", () => {
  it("starts a thread and reads organization skills in the production provider view", async () => {
    const binary = await resolveCodexBinary({});
    const directory = `/run/zeros/coordinators/${"e".repeat(32)}`, history = `/srv/zeros/state/native-agent-history/${"f".repeat(64)}/codex`;
    // Outside /tmp, which the view replaces with a private tmpfs.
    const scratch = await mkdtemp("/var/tmp/zeros-codex-worker-");
    await mkdir("/srv/zeros", { mode: 0o755 });
    const ownsRun = !existsSync("/run/zeros"), ownsEtc = !existsSync("/etc/codex");
    try {
      if (!ownsRun) throw new Error("/run/zeros already exists; use a disposable root");
      for (const entry of ["/srv/zeros/home", "/srv/zeros/state"]) await mkdir(entry, { mode: 0o755 });
      await mkdir(CLOUD_NATIVE_HOME, { mode: 0o755 });
      await mkdir("/srv/zeros/workspace", { mode: 0o755 }); await chown("/srv/zeros/workspace", WORKER, WORKER);
      await mkdir(path.dirname(history), { recursive: true, mode: 0o700 });
      await mkdir(history, { mode: 0o700 }); await chown(history, WORKER, WORKER);
      // The engine view provides this empty mount point (cloud-engine-view.mjs).
      if (ownsEtc) await mkdir("/etc/codex", { mode: 0o755 });
      await mkdir("/run/zeros/coordinators", { recursive: true, mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
      // The same preparation as CloudNativeBoundary.prepare for a Codex lease with customization.
      await mkdir(`${directory}/home`, { mode: 0o700 }); await chown(`${directory}/home`, WORKER, WORKER);
      await mkdir(`${directory}/home/.codex`, { mode: 0o700 }); await chown(`${directory}/home/.codex`, WORKER, WORKER);
      await materializeCloudSkills(directory, [{ name: "zeros-worker-check", description: "Worker check", content: "Reply with the word ready." }]);
      await prepareCloudSkillHomes(directory, "codex", WORKER, WORKER);
      await prepareCloudCodexConfigView(directory); await chown(`${directory}/codex-installation-id`, WORKER, WORKER);
      const view = { directory, history: { provider: "codex", directory: history }, codexConfig: true, skills: true };
      assertOwnedCloudNativeHome(view, { uid: WORKER, gid: WORKER });
      // The worker cannot traverse a private home directory holding the pinned CLI.
      execFileSync("cp", ["-a", binary.sandboxRuntimeRoot!, `${scratch}/codex`]); execFileSync("chmod", ["-R", "a+rX", scratch]);
      const codex = [`${scratch}/codex/bin/codex`, "app-server", ...codexAppServerFeatureArgs(true),
        ...Object.entries(CLOUD_CODEX_CONFIG).flatMap(([name, value]) => ["-c", `${name}=${JSON.stringify(value)}`])];
      // The privileged-worker policy shape: read-only root, the workspace, then
      // the native view before the drop to the worker identity.
      const child = spawn("/usr/bin/bwrap", ["--new-session", "--die-with-parent", "--ro-bind", "/", "/",
        "--bind", "/srv/zeros/workspace", "/srv/zeros/workspace", "--perms", "1777", "--tmpfs", "/tmp", "--dev-bind", "/dev", "/dev",
        "--unshare-pid", "--proc", "/proc", "--cap-drop", "ALL", "--cap-add", "CAP_SETUID", "--cap-add", "CAP_SETGID", "--cap-add", "CAP_SETPCAP",
        ...cloudNativeHomeMounts(view), "--chdir", "/srv/zeros/workspace", "--",
        "/usr/bin/setpriv", `--reuid=${WORKER}`, `--regid=${WORKER}`, "--clear-groups", "--inh-caps=-all", "--bounding-set=-all", "--no-new-privs",
        "/usr/bin/env", "-i", `HOME=${CLOUD_NATIVE_HOME}`, `CODEX_HOME=${CLOUD_NATIVE_HOME}/.codex`, "PATH=/usr/bin:/bin", "LANG=C.UTF-8", ...codex],
      { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", () => {});
      let stderr = ""; child.stderr.on("data", bytes => { stderr = (stderr + String(bytes)).slice(-8192); });
      const lines = createInterface({ input: child.stdout }), pending = new Map<number, (value: { result?: any; error?: unknown }) => void>();
      lines.on("line", line => { try { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); } catch { /* notifications */ } });
      const exited = new Promise<never>((_, reject) => child.once("exit", code => reject(new Error(`Codex exited (${code}): ${stderr}`))));
      const call = (id: number, method: string, params: unknown) => Promise.race([exited, new Promise<{ result?: any; error?: unknown }>(resolve => {
        pending.set(id, resolve); child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      })]);
      try {
        expect(await call(1, "initialize", { clientInfo: { name: "qualification", version: "1" }, capabilities: { experimentalApi: true } })).toMatchObject({ result: {} });
        child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        const started = await call(2, "thread/start", { model: "gpt-5.6-luna", modelProvider: "openai", cwd: "/srv/zeros/workspace",
          config: CLOUD_CODEX_CONFIG, sandbox: "workspace-write", approvalPolicy: "on-request", experimentalRawEvents: false });
        expect(started.error).toBeUndefined();
        const listed = await call(3, "skills/list", { cwds: ["/srv/zeros/workspace"], forceReload: true });
        const skills = (listed.result?.data ?? []).flatMap((entry: { skills: Array<{ name: string; path: string }> }) => entry.skills);
        expect(skills.find((skill: { name: string }) => skill.name === "zeros-worker-check")?.path)
          .toBe(`${CLOUD_NATIVE_HOME}/.agents/skills/zeros-worker-check/SKILL.md`);
        expect(stderr).not.toMatch(/Permission denied|Read-only file system|failed to install system skills/);
      } finally { lines.close(); child.kill("SIGKILL"); }
    } finally {
      await rm("/srv/zeros", { recursive: true, force: true });
      if (ownsRun) await rm("/run/zeros", { recursive: true, force: true });
      if (ownsEtc) await rm("/etc/codex", { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  }, 90_000);
});
