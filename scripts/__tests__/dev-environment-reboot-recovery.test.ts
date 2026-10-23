import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureWorkspace, saveWorkspace } from "../dev-environment/state.mjs";
import { launchPredatesBoot, recoverLaunchAfterReboot } from "../dev-environment/reboot-recovery.mjs";

// A sandbox reboot left electron:cloud stuck: --stop could not reach the dead
// supervisor, and start refused while the launch receipt stayed unconfirmed.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function launched(writtenSecondsAgo: number, boot?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-reboot-")); roots.push(root);
  const workspace = ensureWorkspace({ repositoryRoot: root, homeDir: root, env: {} });
  workspace.state.launcher = { port: 40000, token: "fixture-token", runId: "11111111-1111-4111-8111-111111111111", pid: 999999, boot };
  saveWorkspace(workspace);
  fs.writeFileSync(path.join(workspace.directory, "run.lock"), JSON.stringify({ pid: 999999, token: "t", owner: workspace.state.owner }), { mode: 0o600 });
  const written = new Date(Date.now() - writtenSecondsAgo * 1000);
  fs.utimesSync(workspace.file, written, written);
  return workspace;
}

it("clears a launch recorded in an earlier boot, because no process survives a reboot", () => {
  const workspace = launched(60, "boot-a");
  expect(recoverLaunchAfterReboot(workspace, { boot: "boot-b" })).toBe(true);
  expect(workspace.state.launcher).toBeUndefined();
  expect(fs.existsSync(path.join(workspace.directory, "run.lock"))).toBe(false);
  expect(JSON.parse(fs.readFileSync(workspace.file, "utf8")).launcher).toBeUndefined();
});

it("keeps a launch from this boot even when the clock says it predates boot, as after a VM memory restore", () => {
  const workspace = launched(3600, "boot-a");
  expect(recoverLaunchAfterReboot(workspace, { boot: "boot-a", uptimeSeconds: 600 })).toBe(false);
  expect(recoverLaunchAfterReboot(workspace, { boot: null, uptimeSeconds: 600 })).toBe(false);
  expect(workspace.state.launcher).toMatchObject({ pid: 999999, boot: "boot-a" });
  expect(fs.existsSync(path.join(workspace.directory, "run.lock"))).toBe(true);
});

it("clears an older receipt without a boot when it was last written before this boot", () => {
  const workspace = launched(3600);
  expect(launchPredatesBoot(workspace.file, { uptimeSeconds: 600 })).toBe(true);
  expect(recoverLaunchAfterReboot(workspace, { uptimeSeconds: 600 })).toBe(true);
  expect(workspace.state.launcher).toBeUndefined();
  expect(fs.existsSync(path.join(workspace.directory, "run.lock"))).toBe(false);
  expect(JSON.parse(fs.readFileSync(workspace.file, "utf8")).launcher).toBeUndefined();
});

it("keeps an older receipt from the current boot unconfirmed, so a crashed supervisor still needs --stop", () => {
  const workspace = launched(60);
  expect(recoverLaunchAfterReboot(workspace, { uptimeSeconds: 3600 })).toBe(false);
  expect(workspace.state.launcher).toMatchObject({ pid: 999999 });
  expect(fs.existsSync(path.join(workspace.directory, "run.lock"))).toBe(true);
  // A boot within seconds of the last write is too close to prove.
  expect(launchPredatesBoot(workspace.file, { uptimeSeconds: 58 })).toBe(false);
});
