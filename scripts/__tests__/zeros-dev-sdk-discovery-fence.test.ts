import { afterEach, describe, expect, it, vi } from "vitest";
import { sdkFixture } from "./zeros-dev-sdk-fixture";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const f = await sdkFixture(); cleanups.push(f.close); return f;
}
const observed = (work: Promise<void>) => work.then(() => ({ outcome: "returned" }), (error: unknown) => ({
  outcome: "failed", code: error && typeof error === "object" && "code" in error ? error.code : "unknown",
}));

describe("SDK negative discovery identity and deadline controls", () => {
  it.each([[404, "not_found"], [403, "feature_disabled"]] as const)(
    "rechecks a changed file-backed device before publishing session discovery skip %s/%s", async (status, code) => {
      const f = await fixture(); let finish!: (response: Response) => void;
      f.fetcher.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
      const result = observed(f.probe());
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
      f.changeDevice();
      finish(Response.json({ error: { code } }, { status }));
      expect(await result).toEqual({ outcome: "failed", code: "identity_changed" });
      expect(f.output.at(-1)).toMatchObject({ phase: "sdk_device_session", outcome: "failed", code: "identity_changed" });
      expect(f.output.some(row => row.outcome === "skipped")).toBe(false);
      expect(f.urls).toEqual([]);
    });

  it.each([[404, "not_found"], [403, "feature_disabled"]] as const)(
    "control: unchanged identity permits explicit session discovery skip %s/%s", async (status, code) => {
      const f = await fixture();
      f.fetcher.mockResolvedValueOnce(Response.json({ error: { code } }, { status }));
      expect(await observed(f.probe())).toEqual({ outcome: "returned" });
      expect(f.output).toHaveLength(4);
      expect(f.output.every(row => row.outcome === "skipped")).toBe(true);
      expect(f.urls).toEqual([]);
    });

  it("control: successful session response still fences the changed device", async () => {
    const f = await fixture(); let finish!: (response: Response) => void;
    f.fetcher.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const result = observed(f.probe());
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    f.changeDevice(); finish(Response.json(f.sessionResponse, { status: 201 }));
    expect(await result).toEqual({ outcome: "failed", code: "identity_changed" });
    expect(f.urls).toEqual([]);
  });

  it("control: runtime discovery skip rechecks the changed device", async () => {
    const f = await fixture(); const fetcher = f.fetcher.getMockImplementation()!;
    let finish!: (response: Response) => void;
    f.fetcher.mockImplementation((url, init) => String(url).endsWith("/runtime/connect")
      ? new Promise<Response>(resolve => { finish = resolve; }) : fetcher(url, init));
    const result = observed(f.probe());
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    f.changeDevice(); finish(Response.json({ error: { code: "not_found" } }, { status: 404 }));
    expect(await result).toEqual({ outcome: "failed", code: "identity_changed" });
    expect(f.output.at(-1)).toMatchObject({ phase: "sdk_runtime_connect", outcome: "failed" });
  });

  it("control: caller abort wins over late disabled discovery", async () => {
    const f = await fixture(); let finish!: (response: Response) => void;
    f.fetcher.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    const result = observed(f.probe());
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    f.controller.abort(); finish(Response.json({ error: { code: "not_found" } }, { status: 404 }));
    expect(await result).toEqual({ outcome: "failed", code: "deadline" });
    expect(f.urls).toEqual([]);
    expect(f.output.some(row => row.outcome === "skipped")).toBe(false);
  });

  it("control: the probe has its own 30-second deadline even when the caller has none", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    vi.mocked(f.api.workspace).mockImplementationOnce(() => new Promise(() => {}));
    const result = observed(f.probe()); let completed = false;
    void result.then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(29_999); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ outcome: "failed", code: "deadline" });
    expect(f.output).toHaveLength(1);
    expect(f.output[0]).toMatchObject({ phase: "sdk_device_session", outcome: "failed", code: "deadline" });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.urls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
