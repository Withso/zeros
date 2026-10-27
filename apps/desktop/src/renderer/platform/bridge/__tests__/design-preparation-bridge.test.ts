import { expect, it, vi } from "vitest";
import { bridgeDesignPrepareFrames, bridgeDesignSetRuntimeAudit, rememberDesignDirectoryIdentity } from "../design-bridge";
import type { RuntimeClient } from "../ws-client";
import { DESIGN_LAZY_PREPARATION_CAPABILITY } from "@zeros/protocol/design-catalog";

const input = { workspaceId: "local", directoryId: "design_test", catalogRevision: "a".repeat(64), files: ["page/f0.html"] };
const frame = { file: input.files[0], frameId: "f0", pageId: "page", title: "Frame", kind: "frame", x: 0, y: 0,
  width: 100, height: 100, z: 0, sourceVersion: "b".repeat(24), nodeCount: 1, modifiedAt: 0 };
const reply = () => ({ directoryId: input.directoryId, catalogRevision: input.catalogRevision, frames: [frame], errors: [] });
function client(value: unknown, capable = true, surfaces = false) {
  return { supportsEngineCapability: (capability: string) => capable && (capability === DESIGN_LAZY_PREPARATION_CAPABILITY || surfaces), request: vi.fn(async () => ({ type: "WORKSPACE_RESPONSE", result: value })) };
}
it("negotiates and retains passive HTML costs through the actual preparation reply decoder", async () => {
  const value = { ...reply(), frames: [{ ...frame, surfaceCost: { sourceBytes: 400, nodes: 7, imageBytes: 0 } }] };
  const bridge = client(value, true, true);
  await expect(bridgeDesignPrepareFrames(bridge as unknown as RuntimeClient, input)).resolves.toEqual(value);
  expect(bridge.request).toHaveBeenCalledWith({ type: "WORKSPACE_REQUEST", op: "design.frames.prepare", params: { ...input, surfaceCosts: true } }, 20_000);
});
it("prepares an exact Local directory without retargeting to a later selection", async () => {
  const bridge = client(reply());
  rememberDesignDirectoryIdentity(input.workspaceId, "design_other");
  await expect(bridgeDesignPrepareFrames(bridge as unknown as RuntimeClient, input)).resolves.toEqual(reply());
  expect(bridge.request).toHaveBeenCalledWith({ type: "WORKSPACE_REQUEST", op: "design.frames.prepare", params: input }, 20_000);
});
it("rejects foreign ownership, incomplete coverage, and invalid prepared geometry", async () => {
  for (const value of [
    { ...reply(), directoryId: "design_other" }, { ...reply(), frames: [] },
    { ...reply(), frames: [frame, frame] }, { ...reply(), frames: [{ ...frame, width: -1 }] },
    { ...reply(), frames: [{ ...frame, sourceVersion: input.catalogRevision }] },
  ]) await expect(bridgeDesignPrepareFrames(client(value) as unknown as RuntimeClient, input)).rejects.toThrow();
});
it("keeps Cloud Design disabled and leaves old engines on their compatibility path", async () => {
  for (const [workspaceId, capable] of [["cloud://org/workspace", true], ["local", false]] as const) {
    const bridge = client(reply(), capable);
    await expect(bridgeDesignPrepareFrames(bridge as unknown as RuntimeClient, { ...input, workspaceId })).rejects.toThrow(/Local engine/);
    expect(bridge.request).not.toHaveBeenCalled();
  }
});
it("does not admit a reply from a retired connection", async () => {
  let status!: (value: string) => void;
  let resolve!: (value: unknown) => void;
  const bridge = { supportsEngineCapability: () => true, onStatusChange: (listener: typeof status) => { status = listener; return vi.fn(); },
    request: () => new Promise((done) => { resolve = done; }) } as unknown as RuntimeClient;
  const pending = bridgeDesignPrepareFrames(bridge, input);
  status("disconnected"); status("connected");
  resolve({ type: "WORKSPACE_RESPONSE", result: reply() });
  await expect(pending).rejects.toThrow(/retired/);
});

it.each(["audit-limit", "layer-tree-limit"] as const)("accepts an exact-frame %s audit readback", async (ruleId) => {
  const warning = { ruleId, oid: "root", message: "The runtime reached its inspection limit.", fix: "Simplify this frame." };
  const violations = [{ ...warning, file: frame.file, severity: "warning", line: 2, column: 1 }];
  const result = { ok: true, sourceVersion: frame.sourceVersion, violations };
  await expect(bridgeDesignSetRuntimeAudit(client(result) as unknown as RuntimeClient, "local", {
    frame: frame.file, sourceVersion: frame.sourceVersion, warnings: [warning],
  })).resolves.toEqual({ sourceVersion: frame.sourceVersion, violations });
});

it("rejects foreign generations, foreign frames, and malformed audit readbacks", async () => {
  const violation = { ruleId: "contrast", file: frame.file, severity: "warning", message: "Contrast needs review.", line: 1, column: 1 };
  const result = { sourceVersion: frame.sourceVersion, violations: [violation] };
  for (const value of [
    { ...result, sourceVersion: "c".repeat(24) },
    { ...result, violations: [{ ...violation, file: "other.html" }] },
    { ...result, violations: [{ ...violation, ruleId: "unknown-rule" }] },
    { ...result, violations: [{ ...violation, severity: "error" }] },
    { ...result, violations: [{ ...violation, line: 0 }] },
    { ...result, violations: [{ ...violation, column: 1.5 }] },
    { ...result, violations: [{ ...violation, oid: 42 }] },
    { ...result, violations: [{ ...violation, fix: {} }] },
    { ...result, violations: Array.from({ length: 129 }, () => violation) },
  ]) {
    await expect(bridgeDesignSetRuntimeAudit(client(value) as unknown as RuntimeClient, "local", {
      frame: frame.file, sourceVersion: frame.sourceVersion, warnings: [],
    })).rejects.toThrow("design.runtime.audit: malformed engine response");
  }
});

it("retains compatibility with engines that omit audit readback", async () => {
  await expect(bridgeDesignSetRuntimeAudit(client({ ok: true }) as unknown as RuntimeClient, "local", {
    frame: frame.file, sourceVersion: frame.sourceVersion, warnings: [],
  })).resolves.toBeUndefined();
});
