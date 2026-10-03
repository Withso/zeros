import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";
import { prepareDesignFrameAttachments } from "../design-frame-attachment";

const bridge = {} as RuntimeClient;
const mocks = vi.hoisted(() => ({ create: vi.fn(), inspect: vi.fn(), capture: vi.fn(), images: vi.fn() }));
vi.mock("../../../platform/bridge/design-context-bridge", () => ({
  createDesignFrameContext: mocks.create,
  inspectDesignFrameContext: mocks.inspect,
  captureDesignFrameContext: mocks.capture,
}));
vi.mock("../composer-editor/attachment-io", () => ({
  textFileAttachment: (name: string, text: string) => ({ name, text }),
  filesToAttachments: mocks.images,
}));

const target = { workspaceId: "workspace", directoryId: "directory", frame: "phone.html", intent: "code" as const };
const reference = { ...target, version: 1, frameId: "frame_1", revision: "a".repeat(24) };
describe("submitted Design frame attachments", () => {
  beforeEach(() => {
    mocks.create.mockReset().mockResolvedValue(reference);
    mocks.inspect.mockReset().mockResolvedValue({ status: "ready", reference, directory: "Design", source: "<main>Phone</main>", width: 390, height: 844 });
    mocks.capture.mockReset().mockResolvedValue({ reference, mimeType: "image/png", data: btoa("fixture pixels") });
    mocks.images.mockReset().mockResolvedValue([{ name: "design-phone.html.png", mimeType: "image/png" }]);
  });

  it("freezes the target across selection changes and delivers ordinary source context", async () => {
    const selected = { ...target };
    const sending = prepareDesignFrameAttachments(bridge, selected);
    selected.frame = "other.html";
    const [attachment] = await sending;
    expect(mocks.create).toHaveBeenCalledWith(bridge, "workspace", "phone.html", undefined, "directory");
    expect(attachment).toMatchObject({ name: "design-phone.html.md", text: expect.stringContaining("Design/phone.html") });
    expect(attachment).toMatchObject({ text: expect.stringContaining("390 × 844") });
  });

  it.each(["stale", "missing", "wrong-directory"])("does not submit a %s reference", async (status) => {
    mocks.inspect.mockResolvedValue({ status, reference });
    await expect(prepareDesignFrameAttachments(bridge, target)).rejects.toThrow(/changed|removed/);
  });

  it("rejects a reply from another workspace instead of attaching its source", async () => {
    mocks.create.mockResolvedValue({ ...reference, workspaceId: "other-workspace" });
    await expect(prepareDesignFrameAttachments(bridge, target)).rejects.toThrow(/changed/);
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it("encodes an optional image as an ordinary attachment at the source revision", async () => {
    const attachments = await prepareDesignFrameAttachments(bridge, { ...target, includeScreenshot: true });
    expect(attachments).toHaveLength(2);
    expect(mocks.capture).toHaveBeenCalledWith(bridge, reference);
    const file = mocks.images.mock.calls[0]![0][0] as File;
    expect(file.type).toBe("image/png");
    expect(await file.text()).toBe("fixture pixels");
  });

  it.each(["workspaceId", "directoryId", "frame", "frameId", "revision"] as const)("rejects stale capture %s before encoding an image", async (key) => {
    mocks.capture.mockResolvedValue({ reference: { ...reference, [key]: "replaced" }, mimeType: "image/png", data: btoa("stale") });
    await expect(prepareDesignFrameAttachments(bridge, { ...target, includeScreenshot: true })).rejects.toThrow(/changed while capturing/);
    expect(mocks.images).not.toHaveBeenCalled();
  });

  it("does not attach inspection source from a different reference", async () => {
    mocks.inspect.mockResolvedValue({ status: "ready", reference: { ...reference, directoryId: "other" }, source: "Wrong source", directory: "Other", width: 390, height: 844 });
    await expect(prepareDesignFrameAttachments(bridge, target)).rejects.toThrow(/changed/);
  });
});
