import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => {
  const page = { setDefaultTimeout: vi.fn(), setContent: vi.fn(async (_html: string, _options?: unknown) => {}), evaluate: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from("png-fixture")) };
  const context = { route: vi.fn(async () => {}), newPage: vi.fn(async () => page), close: vi.fn(async () => {}) };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}), version: () => "fixture" };
  return { page, context, browser, launch: vi.fn(async () => browser), png: vi.fn() };
});
vi.mock("playwright-core", () => ({ chromium: { launch: fixture.launch } }));
vi.mock("../capture-service", () => ({ assertDesignCapturePng: fixture.png }));
const input = { version: 1 as const, html: '<script>unsafe()</script><body onclick="unsafe()">Fixture</body>',
  revision: "revision", width: 1, height: 1, colorScheme: "light" as const };
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
beforeEach(() => {
  vi.spyOn(process,"geteuid").mockReturnValue(10003);
  vi.spyOn(process,"getegid").mockReturnValue(10003);
});
describe.runIf(process.platform==="linux")("fixed cloud PNG worker", () => {
  it("reports only the non-root engine capture identity without claiming agent isolation", async () => {
    const worker = await import("../design-capture-worker");
    const result = await worker.captureCloudDesignFrame(input);
    expect(result).toMatchObject({ identity: { uid: 10003, gid: 10003 }, data: Buffer.from("png-fixture").toString("base64") });
    expect(result).not.toHaveProperty("secure");
  });
  it.each([[0,0],[10001,10001],[10002,10002],[10003,0]])("refuses a foreign effective capture identity %s/%s before launching Chromium",async(uid,gid)=>{
    vi.spyOn(process,"geteuid").mockReturnValue(uid);vi.spyOn(process,"getegid").mockReturnValue(gid);
    const worker=await import("../design-capture-worker");
    await expect(worker.captureCloudDesignFrame(input)).rejects.toThrow("capture identity");
    expect(fixture.launch).not.toHaveBeenCalled();
  });
  it("retains Chromium sandbox, offline/no-JS/CSP/sanitization, PNG validation and browser cleanup", async () => {
    const worker = await import("../design-capture-worker");
    await worker.captureCloudDesignFrame(input);
    expect(fixture.launch).toHaveBeenCalledWith(expect.objectContaining({ headless: true, chromiumSandbox: true }));
    expect(fixture.browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ javaScriptEnabled: false, offline: true,
      serviceWorkers: "block", acceptDownloads: false }));
    expect(fixture.context.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    const html = fixture.page.setContent.mock.calls[0]![0];
    expect(html).not.toMatch(/<script|onclick=/); expect(html).toContain("script-src 'none'");
    expect(fixture.png).toHaveBeenCalledWith(Buffer.from("png-fixture"), 1, 1);
    expect(fixture.context.close).toHaveBeenCalledOnce(); expect(fixture.browser.close).toHaveBeenCalledOnce();
  });
});
