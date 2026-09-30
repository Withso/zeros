import { expect, it } from "vitest";
import { cloudNativeHomeMounts, CLOUD_NATIVE_HOME } from "../../apps/desktop/src/engine/agents/containment/cloud-native-view.mjs";
import { cloudEngineViewArguments } from "../cloud-workspace-validation/sandbox/cloud-engine-view.mjs";

// The native provider view's root is the engine view: a read-only root that
// projects only selected image paths. bwrap cannot create a missing mount
// point there, so the admission canary exits 1 ("Private coordinator admission
// failed"). The engine view itself must provide each mount source and each
// mount point outside the provider's private HOME.
it.each(["serve", "qualify-agent"] as const)("provides every native provider view mount in the %s engine view", operation => {
  const mounts = cloudNativeHomeMounts({ directory: `/run/zeros/coordinators/${"a".repeat(32)}`, codexConfig: true, skills: true,
    history: { provider: "codex", directory: `/srv/zeros/state/native-agent-history/${"b".repeat(64)}/codex` } });
  const pairs = mounts.flatMap((arg, index) => ["--bind", "--ro-bind"].includes(arg) ? [[mounts[index + 1]!, mounts[index + 2]!]]
    : arg === "--tmpfs" ? [[undefined, mounts[index + 1]!]] : []);
  const outside = pairs.map(([, target]) => target).filter(target => target !== CLOUD_NATIVE_HOME && !target.startsWith(`${CLOUD_NATIVE_HOME}/`));
  expect(outside).toEqual(["/etc/codex"]);
  const view = cloudEngineViewArguments(operation, 3);
  const readOnly = view.indexOf("--remount-ro");
  expect(view.slice(readOnly, readOnly + 2)).toEqual(["--remount-ro", "/"]);
  const provided = view.slice(0, readOnly).flatMap((arg, index, args) =>
    arg === "--dir" ? [args[index + 1]!] : ["--bind", "--ro-bind"].includes(arg) ? [args[index + 2]!] : []);
  const visible = (path: string) => provided.some(root => root !== "/" && (path === root || path.startsWith(`${root}/`)));
  for (const path of [CLOUD_NATIVE_HOME, ...outside, ...pairs.flatMap(([source]) => source ? [source] : [])])
    expect(visible(path), path).toBe(true);
});
