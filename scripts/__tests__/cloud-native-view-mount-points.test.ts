import { expect, it } from "vitest";
import { cloudNativeHomeMounts, CLOUD_NATIVE_HOME } from "../../apps/desktop/src/engine/agents/containment/cloud-native-view.mjs";
import { cloudEngineViewArguments } from "../cloud-workspace-validation/sandbox/cloud-engine-view.mjs";
import { testCloudRuntime } from "../../apps/desktop/src/engine/agents/__tests__/helpers/test-cloud-runtime";

const runtime = testCloudRuntime();
const view = "/run/zeros/view/runtime-11111111-1111-4111-8111-111111111111";

// The native provider view's root is the engine view: a read-only root that
// projects only selected image paths. bwrap cannot create a missing mount
// point there, so the admission canary exits 1 ("Private coordinator admission
// failed"). The engine view itself must provide each mount source and each
// mount point outside the provider's private HOME.
it.each(["serve", "qualify", "resident"] as const)("provides every native provider view mount in the %s engine view", operation => {
  const mounts = cloudNativeHomeMounts({ directory: `/run/zeros/coordinators/${"a".repeat(32)}`, codexConfig: true, skills: true,
    history: { provider: "codex", directory: `/srv/zeros/state/native-agent-history/${"b".repeat(64)}/codex` } });
  const pairs = mounts.flatMap((arg, index) => ["--bind", "--ro-bind"].includes(arg) ? [[mounts[index + 1]!, mounts[index + 2]!]]
    : arg === "--tmpfs" ? [[undefined, mounts[index + 1]!]] : []);
  const outside = pairs.map(([, target]) => target).filter(target => target !== CLOUD_NATIVE_HOME && !target.startsWith(`${CLOUD_NATIVE_HOME}/`));
  expect(outside).toEqual(["/etc/codex"]);
  const args = cloudEngineViewArguments(operation, 4, runtime, view);
  // V4 also remounts the private setup subtree before sealing the whole root.
  const readOnly = args.lastIndexOf("--remount-ro");
  expect(args.slice(readOnly, readOnly + 2)).toEqual(["--remount-ro", "/"]);
  const provided = args.slice(0, readOnly).flatMap((arg, index, args) =>
    arg === "--dir" ? [args[index + 1]!] : ["--bind", "--ro-bind"].includes(arg) ? [args[index + 2]!] : []);
  const visible = (path: string) => provided.some(root => root !== "/" && (path === root || path.startsWith(`${root}/`)));
  for (const path of [CLOUD_NATIVE_HOME, ...outside, ...pairs.flatMap(([source]) => source ? [source] : [])])
    expect(visible(path), path).toBe(true);
});

it.each([1, 2, 3])("refuses retired engine profile %i before projecting provider mounts", version => {
  expect(() => cloudEngineViewArguments("serve", version, runtime, view)).toThrow(/profile version/);
});

it("refuses the retired qualify-agent entry even with v4 authority", () => {
  expect(() => cloudEngineViewArguments("qualify-agent", 4, runtime, view)).toThrow(/launch operation/);
});
