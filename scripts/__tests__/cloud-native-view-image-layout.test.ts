import fs from "node:fs";
import { expect, it } from "vitest";
import { cloudNativeHomeMounts, CLOUD_NATIVE_HOME } from "../../apps/desktop/src/engine/agents/containment/cloud-native-view.mjs";

// The provider view's root is read-only, so bwrap cannot create a missing
// mount point outside the private HOME; the canary then fails admission
// ("Private coordinator admission failed"). The image must provide each one.
it("builds every mount point the native provider view needs outside its private HOME", () => {
  const build = fs.readFileSync("scripts/cloud-workspace-validation/boat-image/templates/build.sh", "utf8");
  const mounts = cloudNativeHomeMounts({ directory: `/run/zeros/coordinators/${"a".repeat(32)}`, codexConfig: true, skills: true,
    history: { provider: "codex", directory: `/srv/zeros/state/native-agent-history/${"b".repeat(64)}/codex` } });
  const targets = mounts.flatMap((arg, index) => ["--bind", "--ro-bind"].includes(arg) ? [mounts[index + 2]!] : arg === "--tmpfs" ? [mounts[index + 1]!] : []);
  const outside = targets.filter(target => target !== CLOUD_NATIVE_HOME && !target.startsWith(`${CLOUD_NATIVE_HOME}/`));
  expect(outside).toEqual(["/etc/codex"]);
  for (const target of outside) expect(build).toMatch(new RegExp(`^install -d -o root -g root -m 0755 (?:\\S+ )*${target}(?: |$)`, "m"));
});
