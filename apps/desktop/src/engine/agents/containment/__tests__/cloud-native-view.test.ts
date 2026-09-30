import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLOUD_CODEX_STATE_DIRECTORIES, CLOUD_NATIVE_HOME, cloudNativeHomeMounts, cloudNativeBwrapWrapper } from "../cloud-native-view.mjs";
import { prepareCloudSkillHomes } from "../cloud-native-boundary";

const home = {
  directory: `/run/zeros/coordinators/${"a".repeat(32)}`,
  history: { provider: "claude", directory: `/srv/zeros/state/native-agent-history/${"b".repeat(64)}/claude` },
};

describe("native cloud provider home", () => {
  it("projects only this run's home and this conversation's native history", () => {
    expect(cloudNativeHomeMounts(home)).toEqual([
      "--bind", `${home.directory}/home`, "/srv/zeros/home/agent",
      "--bind", home.history.directory, "/srv/zeros/home/agent/.claude/projects",
    ]);
  });

  it.each([
    { ...home, directory: "/run/zeros" },
    { ...home, directory: `${home.directory}/../${"c".repeat(32)}` },
    { ...home, history: { ...home.history, directory: "/srv/zeros/state" } },
    { ...home, history: { ...home.history, provider: "codex" } },
    { ...home, history: { ...home.history, provider: ["claude"] } },
    { ...home, command: "/bin/bash" },
  ])("refuses a wider or ambiguous private mount: %j", value => {
    expect(() => cloudNativeHomeMounts(value)).toThrow();
  });

  it.each(["cursor", "codex"])("keeps the %s store scoped", provider => {
    const target = provider === "cursor" ? ".cursor/zeros-store" : ".codex/sessions";
    expect(cloudNativeHomeMounts({ ...home, history: { provider, directory: home.history.directory.replace(/claude$/, provider) } }).at(-1))
      .toBe(`/srv/zeros/home/agent/${target}`);
  });

  it("preserves the installed filesystem/process policy and literal command arguments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "zeros-native-view-"));
    try {
      const executable = path.join(root, "bwrap");
      const wrapper = path.join(root, "wrapper");
      await writeFile(executable, '#!/bin/bash\nprintf "%s\\0" "$@"\n', { mode: 0o700 });
      await writeFile(wrapper, cloudNativeBwrapWrapper(executable, home), { mode: 0o700 });
      const policy = ["--ro-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--ro-bind", "/design", "/design"];
      const command = ["--", "/usr/bin/setpriv", "--reuid=10001", "--", "/bin/bash", "-c", "printf '%s' '$(not-a-command)'\n"];
      const result = spawnSync("/bin/bash", [wrapper, ...policy, ...command], { encoding: "utf8", env: {} });
      expect(result.status).toBe(0);
      expect(result.stdout.split("\0").slice(0, -1)).toEqual([...policy, ...cloudNativeHomeMounts(home), ...command]);
      const malformed = spawnSync("/bin/bash", [wrapper, ...policy], { encoding: "utf8", env: {} });
      expect(malformed.status).not.toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

it("makes native Codex user and system configuration immutable while preserving history writes", () => {
  const codex = { ...home, codexConfig: true, skills: true, history: { provider: "codex", directory: home.history.directory.replace(/claude$/, "codex") } };
  const mounts = cloudNativeHomeMounts(codex);
  const triples = Array.from({ length: mounts.length / 3 }, (_, i) => mounts.slice(i * 3, i * 3 + 3));
  expect(mounts.slice(3, 9)).toEqual(["--ro-bind", `${home.directory}/codex-config`, "/srv/zeros/home/agent/.codex", "--ro-bind", `${home.directory}/codex-config`, "/etc/codex"]);
  expect(mounts.join("\n")).toContain(`--bind\n${codex.history.directory}\n/srv/zeros/home/agent/.codex/sessions`);
  expect(triples[0]).toEqual(["--bind", `${home.directory}/home`, "/srv/zeros/home/agent"]);
  expect(() => cloudNativeHomeMounts({ ...home, codexConfig: true })).toThrow();
});

it("keeps the pinned Codex CLI's own startup state writable without a writable configuration source", () => {
  const codex = { ...home, codexConfig: true, skills: true, history: { provider: "codex", directory: home.history.directory.replace(/claude$/, "codex") } };
  const mounts = cloudNativeHomeMounts(codex), text = mounts.join("\n");
  // Codex 0.154 opens installation_id read-write at startup and locks thread
  // writers at thread/start; either on the read-only view kills the process.
  expect(text).toContain(`--bind\n${home.directory}/codex-installation-id\n/srv/zeros/home/agent/.codex/installation_id`);
  for (const name of ["thread-writer-locks", ".tmp"]) expect(text).toContain(`--tmpfs\n/srv/zeros/home/agent/.codex/${name}`);
  // Codex replaces its bundled system skills under skills/, so that tree is
  // private; organization skills stay read-only through ~/.agents/skills.
  expect(text).toContain("--tmpfs\n/srv/zeros/home/agent/.codex/skills");
  expect(text).toContain(`--ro-bind\n${home.directory}/skills\n/srv/zeros/home/agent/.agents/skills`);
  expect(text).not.toContain(`--ro-bind\n${home.directory}/skills\n/srv/zeros/home/agent/.codex/skills`);
  const writable = mounts.flatMap((arg, i) => arg === "--bind" ? [mounts[i + 2]] : arg === "--tmpfs" ? [mounts[i + 1]] : []);
  expect(writable.filter(target => target?.startsWith("/etc/codex") || /\/\.codex\/(config\.toml|managed_config\.toml|requirements\.toml|rules|plugins)$/.test(target ?? ""))).toEqual([]);
  expect(writable.filter(target => target === "/srv/zeros/home/agent/.codex")).toEqual([]);
});

// bwrap mounts as root before the workload drops to the worker. A default
// tmpfs is then root-owned 0755, and Codex cannot open its thread-writer lock
// ("Permission denied (os error 13)" at thread/start).
it("leaves each private Codex state slot writable by the worker", () => {
  const codex = { ...home, codexConfig: true, skills: true, history: { provider: "codex", directory: home.history.directory.replace(/claude$/, "codex") } };
  const mounts = cloudNativeHomeMounts(codex);
  const slots = mounts.flatMap((arg, i) => arg === "--tmpfs" ? [i] : []);
  expect(slots.map(i => mounts[i + 1])).toEqual(CLOUD_CODEX_STATE_DIRECTORIES.map(name => `${CLOUD_NATIVE_HOME}/.codex/${name}`));
  for (const i of slots) expect(mounts.slice(i - 2, i)).toEqual(["--perms", "1777"]);
});

// bwrap creates a missing parent of a mount point root-owned 0700, which hid
// the organization's skills (Codex reads ~/.agents/skills) from the worker.
it.each(["claude", "cursor", "codex"] as const)("gives the worker every %s home that receives organization skills", async provider => {
  const view = { ...home, skills: true, ...(provider === "codex" ? { codexConfig: true } : {}),
    history: { provider, directory: home.history.directory.replace(/claude$/, provider) } };
  const mounts = cloudNativeHomeMounts(view);
  const parents = mounts.flatMap((arg, i) => arg === "--ro-bind" && mounts[i + 1] === `${home.directory}/skills` ? [path.posix.dirname(mounts[i + 2]!)] : []);
  expect(parents.length).toBeGreaterThan(0);
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-skill-homes-"));
  try {
    await mkdir(`${root}/home/.${provider}`, { recursive: true, mode: 0o700 });
    await prepareCloudSkillHomes(root, provider, process.getuid!(), process.getgid!());
    for (const parent of parents) {
      const entry = await stat(`${root}/home${parent.slice(CLOUD_NATIVE_HOME.length)}`);
      expect(entry.isDirectory() && entry.uid === process.getuid!() && (entry.mode & 0o777) === 0o700, parent).toBe(true);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
