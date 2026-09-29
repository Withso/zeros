import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cloudNativeHomeMounts, cloudNativeBwrapWrapper } from "../cloud-native-view.mjs";

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
