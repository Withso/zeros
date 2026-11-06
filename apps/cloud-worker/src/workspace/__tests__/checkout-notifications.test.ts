import { afterEach, expect, it, vi } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { WorkspaceService } from "../service";
import { repositoryFixture } from "./repository-fixture";

const services: WorkspaceService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); });
const refFrames = (frames: BridgeMessage[]) => frames.filter(frame => frame.type === "DB_CHANGED" && frame.gitRefsChanged);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

it("publishes native changes immediately and refs only after checkout acknowledgement", async () => {
  const { scope, state, git } = await repositoryFixture();
  const frames: BridgeMessage[] = [], held = deferred();
  const send = vi.fn(async () => {});
  const service = await WorkspaceService.open(scope, state, { watch: false, reportGithubCheckout: send, publish: frame => frames.push(frame) });
  services.push(service); await service.flush();
  send.mockImplementationOnce(() => held.promise);
  await git("switch", "-c", "topic/new");
  const polling = service.poll(true);
  try {
    await expect.poll(() => send.mock.calls.length).toBe(2);
    expect(frames.some(frame => frame.type === "DB_CHANGED")).toBe(true);
    expect(refFrames(frames)).toHaveLength(0);
  } finally { held.resolve(); await polling; }
  expect(refFrames(frames)).toHaveLength(1);
});

it("retries a failed checkout report before publishing an unchanged pending ref hint", async () => {
  const { scope, state, git } = await repositoryFixture();
  const frames: BridgeMessage[] = [], send = vi.fn(async () => {});
  const service = await WorkspaceService.open(scope, state, { watch: false, reportGithubCheckout: send, publish: frame => frames.push(frame) });
  services.push(service); await service.flush();
  send.mockRejectedValueOnce(new Error("temporary report failure"));
  await git("switch", "-c", "topic/new"); await service.poll();
  expect(refFrames(frames)).toHaveLength(0);
  await service.poll();
  expect(send).toHaveBeenCalledTimes(3);
  expect(refFrames(frames)).toHaveLength(1);
  await service.poll();
  expect(refFrames(frames)).toHaveLength(1);
});

it("does not publish a new branch against an older in-flight checkout acknowledgement", async () => {
  const { scope, state, git } = await repositoryFixture();
  const frames: BridgeMessage[] = [], first = deferred(), second = deferred();
  const send = vi.fn(async () => {}).mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const service = await WorkspaceService.open(scope, state, { watch: false, reportGithubCheckout: send, publish: frame => frames.push(frame) });
  services.push(service);
  await expect.poll(() => send.mock.calls.length).toBe(1);
  await git("switch", "-c", "topic/new");
  const polling = service.poll(true);
  try {
    await expect.poll(() => frames.length).toBeGreaterThan(0);
    expect(refFrames(frames)).toHaveLength(0);
    first.resolve();
    await expect.poll(() => send.mock.calls.length).toBe(2);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ branch: "topic/new" }));
    expect(refFrames(frames)).toHaveLength(0);
  } finally { first.resolve(); second.resolve(); await polling; }
  expect(refFrames(frames)).toHaveLength(1);
});

it("coalesces GitHub write hints behind a fresh checkout report without another poll", async () => {
  const { scope, state, git } = await repositoryFixture();
  const frames: BridgeMessage[] = [], held = deferred(), send = vi.fn(async () => {});
  const service = await WorkspaceService.open(scope, state, { watch: false, reportGithubCheckout: send, publish: frame => frames.push(frame) });
  services.push(service); await service.flush();
  send.mockImplementationOnce(() => held.promise);
  await git("switch", "-c", "topic/new");
  service.githubChanged(); service.githubChanged(); service.githubChanged();
  try {
    expect(refFrames(frames)).toHaveLength(0);
    await expect.poll(() => send.mock.calls.length).toBe(2);
  } finally { held.resolve(); await service.flush(); }
  expect(refFrames(frames)).toHaveLength(1);
  expect(send).toHaveBeenCalledTimes(2);
});

it("coalesces a GitHub write and its filesystem observation into one ref hint", async () => {
  const { scope, state, git } = await repositoryFixture();
  const frames: BridgeMessage[] = [];
  const service = await WorkspaceService.open(scope, state, { reportGithubCheckout: async () => {}, publish: frame => frames.push(frame) });
  services.push(service); await service.flush();
  await git("switch", "-c", "topic/new");
  service.githubChanged();
  await expect.poll(() => refFrames(frames).length).toBeGreaterThan(0);
  await service.flush();
  expect(refFrames(frames)).toHaveLength(1);
});
