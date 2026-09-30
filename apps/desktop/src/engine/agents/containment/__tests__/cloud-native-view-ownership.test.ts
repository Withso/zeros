import { expect, it, vi } from "vitest";

const entries = vi.hoisted(() => new Map<string, { directory: boolean; uid: number; mode: number; nlink?: number }>());
vi.mock("node:fs", async original => ({
  ...await original<typeof import("node:fs")>(),
  lstatSync: (file: string) => {
    const entry = entries.get(file);
    if (!entry) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
    return { isDirectory: () => entry.directory, isFile: () => !entry.directory, isSymbolicLink: () => false,
      uid: entry.uid, mode: entry.mode, nlink: entry.nlink ?? 1 };
  },
  realpathSync: (file: string) => file,
}));
const { assertOwnedCloudNativeHome } = await import("../cloud-native-view.mjs");

const directory = `/run/zeros/coordinators/${"a".repeat(32)}`, history = `/srv/zeros/state/native-agent-history/${"b".repeat(64)}/codex`;
const view = { directory, history: { provider: "codex", directory: history }, codexConfig: true };
function layout(installation: { mode: number; nlink?: number }) {
  entries.clear();
  for (const root of ["/run/zeros/coordinators", directory, "/srv/zeros/state/native-agent-history", history.slice(0, history.lastIndexOf("/"))])
    entries.set(root, { directory: true, uid: 0, mode: 0o700 });
  entries.set(`${directory}/home`, { directory: true, uid: 10001, mode: 0o700 });
  entries.set(history, { directory: true, uid: 10001, mode: 0o700 });
  entries.set(`${directory}/codex-config`, { directory: true, uid: 0, mode: 0o755 });
  entries.set(`${directory}/codex-installation-id`, { directory: false, uid: 10001, ...installation });
}

// Every later native spawn re-checks the view. Codex makes installation_id
// 0644 when it opens it, which refused all of them after the provider started.
it("keeps admitting the Codex view once the pinned CLI has opened its installation state", () => {
  layout({ mode: 0o100644 });
  expect(() => assertOwnedCloudNativeHome(view, { uid: 10001, gid: 10001 })).not.toThrow();
});

it.each([{ mode: 0o100664 }, { mode: 0o100606 }, { mode: 0o100600, nlink: 2 }])("refuses shared or linked Codex installation state: %j", installation => {
  layout(installation);
  expect(() => assertOwnedCloudNativeHome(view, { uid: 10001, gid: 10001 })).toThrow(/installation state/);
});
