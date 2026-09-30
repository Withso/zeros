import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceService } from "../service";
import { closeState, setStateRootForTesting } from "../../git";

const roots: string[] = [];
afterEach(() => { closeState(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("cloud customization workspace dispatch", () => {
  it("routes only admitted cloud identities to the control plane and preserves the device-only preference gate", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cloud-customization-")); roots.push(root); setStateRootForTesting(path.join(root, "state"));
    const service = new WorkspaceService(root, { primaryDesignWorkspace: true }), request = vi.fn().mockResolvedValue([]);
    service.setCloudCustomizationRequest(request);
    const actor = { userId: randomUUID(), deviceId: randomUUID(), sessionId: randomUUID() };
    const options = { remote: true, cloudWorker: true, cloudActorIdentity: actor };
    await expect(service.handle("skills.listZeros", { repoRoot: root }, options)).resolves.toEqual([]);
    expect(request).toHaveBeenCalledWith(actor.sessionId, "skills.listZeros", {});
    await expect(service.handle("skills.listZeros", {}, { remote: true })).rejects.toThrow(/only on this device/);
    await expect(service.handle("skills.listZeros", { repoRoot: "/home/another-user" }, options)).rejects.toThrow(/device configuration/);
    await expect(service.handle("settings.syncAgentPreferences", {}, options)).rejects.toThrow(/this device/);
  });
});
