import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUpdate, type AgentMessage } from "@zeros/protocol/agent-messages";
import type { ContentBlock, SessionNotification } from "@zeros/protocol/agent-events";
import { CodexEventMapper as Mapper } from "../event-mapper";

// Native ESM namespaces are immutable. Keep real I/O behind a configurable
// module seam so the test can hold the actual open/restore race.
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4P9MFAAR3Ad0FpxN3AAAAAElFTkSuQmCC", "base64");
const jpeg = Buffer.from("ffd8ffe000104a4649460001", "hex");
const webp = Buffer.from("524946460c0000005745425056503820", "hex");
const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

async function directory() {
  const path = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "zeros-generated-image-")));
  temporary.push(path);
  return path;
}

function transcript(resolveImage?: (path: string) => Promise<ContentBlock | undefined>) {
  let messages: AgentMessage[] = [];
  const events: SessionNotification[] = [];
  const mapper = new Mapper({ sessionId: "image-session", resolveImage, emit: (event) => {
    events.push(event);
    messages = applyUpdate(messages, event);
  } });
  mapper.startTurn();
  const item = (value: Record<string, unknown>, completed = true) => mapper.handle(completed ? "item/completed" : "item/started", { item: {
    type: "imageGeneration", id: "image", status: "completed", revisedPrompt: null, failure: null,
    ...value,
  } });
  const image = (index = 0) => {
    const message = messages[index];
    return message?.kind === "tool" ? message.content?.find((block) => block.type === "content" && block.content.type === "image") : undefined;
  };
  return { mapper, item, image, events, messages: () => messages };
}

describe("Codex generated image previews", () => {
  it.each(["legacy", "attachment upload fallback"])("preserves %s inline bytes and avoids file I/O", (shape) => {
    const reader = vi.fn();
    const t = transcript(reader);
    t.item({ result: "aGVsbG8=", savedPath: "/missing/image.png", ...(shape === "legacy" ? {} : { fileId: "opaque-file" }) });
    expect(t.image()).toEqual({ type: "content", content: { type: "image", mimeType: "image/png", data: "aGVsbG8=" } });
    expect(reader).not.toHaveBeenCalled();
    expect(t.messages()[0]).toMatchObject({ status: "completed", rawOutput: { savedPath: "/missing/image.png" } });
  });

  it.each([["PNG", png, "image/png"], ["JPEG", jpeg, "image/jpeg"], ["WebP", webp, "image/webp"]] as const)("recovers %s by magic bytes, independent of its filename", async (_, bytes, mimeType) => {
    const path = join(await directory(), "saved.bin");
    await fs.writeFile(path, bytes);
    const t = transcript();
    t.item({ fileId: "opaque-attachment", savedPath: path });
    await expect.poll(() => t.image()).toEqual({ type: "content", content: { type: "image", mimeType, data: bytes.toString("base64") } });
    expect(t.messages()[0]).toMatchObject({ status: "completed", rawOutput: { savedPath: path } });
    expect(JSON.stringify(t.messages()[0])).not.toContain("opaque-attachment");
  });

  it.each(["", "not inline data", "x".repeat(16 * 1024 * 1024 + 1)])("uses the saved file when the inline result is unusable (%#)", async (result) => {
    const path = join(await directory(), "saved.png");
    await fs.writeFile(path, png);
    const t = transcript();
    t.item({ result, savedPath: path });
    await expect.poll(() => t.image()).toMatchObject({ content: { data: png.toString("base64") } });
  });

  it.each(["missing path", "missing file", "oversized", "encoded bound", "text", "directory", "leaf symlink", "parent symlink", "parent traversal"])("keeps a plain placeholder for %s", async (kind) => {
    const root = await directory();
    let path: string | undefined = join(root, "saved.png");
    if (kind === "missing path") path = undefined;
    else if (kind === "text") await fs.writeFile(path!, "not an image");
    else if (kind === "directory") await fs.mkdir(path!);
    else if (kind === "oversized" || kind === "encoded bound") {
      const handle = await fs.open(path!, "w");
      try { await handle.write(png); await handle.truncate((kind === "oversized" ? 16 : 12) * 1024 * 1024 + 1); }
      finally { await handle.close(); }
    } else if (kind === "leaf symlink") {
      const target = join(root, "target.png");
      await fs.writeFile(target, png);
      await fs.symlink(target, path!);
    } else if (kind === "parent symlink") {
      await fs.mkdir(join(root, "real"));
      await fs.writeFile(join(root, "real", "saved.png"), png);
      await fs.symlink(join(root, "real"), join(root, "alias"), "dir");
      path = join(root, "alias", "saved.png");
    } else if (kind === "parent traversal") {
      await fs.writeFile(path!, png);
      // Keep the native spelling: join() would normalize away the missing parent.
      path = `${root}/missing/../saved.png`;
    }
    const t = transcript();
    t.item({ fileId: "opaque-file", savedPath: path });
    expect(t.messages()[0]).toMatchObject({ status: "completed", content: [{ type: "content", content: { type: "text", text: "Image saved by Codex" } }] });
    await t.mapper.flushImageReads();
    expect(t.image()).toBeUndefined();
  });

  it("retains observed input paths and hashes without making them generated output", () => {
    const inputImages = [{ path: "/workspace/beach.jpg", sha256: "a".repeat(64) }, { path: "/workspace/mask.png", sha256: "b".repeat(64) }];
    const t = transcript();
    t.item({ result: png.toString("base64"), savedPath: "/workspace/poster.png", inputImages });
    expect(t.messages()[0]).toMatchObject({ title: "Generating image", rawOutput: { savedPath: "/workspace/poster.png", inputImages } });
    const legacy = transcript();
    legacy.item({ result: png.toString("base64") });
    expect(legacy.messages()[0]).not.toHaveProperty("rawOutput.inputImages");
  });

  it("rejects a parent swapped to a symlink during open, even after the original name is restored", async () => {
    const root = await directory();
    const owned = join(root, "owned");
    const other = join(root, "other");
    await fs.mkdir(owned);
    await fs.mkdir(other);
    await fs.writeFile(join(owned, "saved.png"), jpeg);
    await fs.writeFile(join(other, "saved.png"), png);
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      await fs.rename(owned, `${owned}-original`);
      await fs.symlink(other, owned, "dir");
      try { return await originalOpen(...args); }
      finally { await fs.unlink(owned); await fs.rename(`${owned}-original`, owned); }
    });
    const t = transcript();
    t.item({ fileId: "opaque-file", savedPath: join(owned, "saved.png") });
    await t.mapper.flushImageReads();
    expect(fs.open).toHaveBeenCalledOnce();
    expect(t.image()).toBeUndefined();
  });

  it("keeps optional image I/O failures out of the turn lifecycle", async () => {
    const t = transcript(() => Promise.reject(new Error("unreadable fixture")));
    t.item({ fileId: "opaque-file", savedPath: "/workspace/poster.png" });
    await t.mapper.flushImageReads();
    expect(t.image()).toBeUndefined();
    expect(t.messages()[0]).toMatchObject({ status: "completed" });
    expect(t.mapper.terminalError).toBeNull();
    expect(t.mapper.sawTurnTerminal).toBe(false);
  });

  it("reads once at completion without blocking messages or turn settlement", async () => {
    let finish!: (value: ContentBlock) => void;
    const reader = vi.fn(() => new Promise<ContentBlock>((resolve) => { finish = resolve; }));
    const t = transcript(reader);
    const native = { fileId: "opaque-file", savedPath: "/workspace/poster.png" };
    t.item(native, false);
    expect(reader).not.toHaveBeenCalled();
    t.item(native);
    t.item(native);
    await expect.poll(() => reader.mock.calls.length).toBe(1);
    t.mapper.handle("item/agentMessage/delta", { itemId: "reply", delta: "Continuing immediately" });
    t.mapper.handle("turn/completed", { turn: { status: "completed" } });
    expect(t.messages()[1]).toMatchObject({ text: "Continuing immediately" });
    expect(t.mapper.sawTurnTerminal).toBe(true);
    finish({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    await expect.poll(() => t.image()).toBeDefined();
    expect(t.events.at(-1)?.update).not.toHaveProperty("status");
    expect(t.messages()[0]).toMatchObject({ status: "completed" });
    expect(t.mapper.sawTurnTerminal).toBe(true);
  });

  it.each(["stop", "replacement"])("fences a delayed image after %s", async (ending) => {
    let finish!: (value: ContentBlock) => void;
    const t = transcript(() => new Promise<ContentBlock>((resolve) => { finish = resolve; }));
    t.item({ fileId: "opaque-file", savedPath: "/workspace/poster.png" });
    await expect.poll(() => typeof finish).toBe("function");
    if (ending === "stop") t.mapper.endAgentActivity();
    else {
      t.mapper.startTurn();
      t.item({ result: jpeg.toString("base64") });
    }
    const before = t.events.length;
    finish({ type: "image", mimeType: "image/png", data: png.toString("base64") });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(t.events).toHaveLength(before);
    expect(t.image()).toBeUndefined();
  });
});
