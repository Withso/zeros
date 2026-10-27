import { expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  receive: undefined as ((request: { sourceId: string; requestId: string; offset: number; length: number }) => void) | undefined,
  invoke: vi.fn(async (_command: string, _args: Record<string, unknown>) => "zeros-media://file/fixture"),
  read: vi.fn(),
}));
vi.mock("../runtime", () => ({
  isNativeRuntime: () => true,
  nativeInvoke: native.invoke,
  nativeListen: async (_name: string, receive: typeof native.receive) => {
    native.receive = receive;
    return () => {};
  },
}));
vi.mock("../files", () => ({ createWorkspaceMediaReader: () => native.read }));

it("releases native backpressure when an already-queued range arrives after its preview closes", async () => {
  const { openWorkspaceMedia } = await import("../file-media");
  const lease = await openWorkspaceMedia({ cwd: "/repo", path: "clip.webm", bytes: 10,
    media: { version: "1:2:10", mimeType: "video/webm" } });
  const sourceId = native.invoke.mock.calls.find(([command]) => command === "file_media_open")![1].sourceId as string;
  lease.release();
  native.receive!({ sourceId, requestId: "already-queued", offset: 0, length: 10 });
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("file_media_reply", { requestId: "already-queued", error: true }));
  expect(native.read).not.toHaveBeenCalled();
});
