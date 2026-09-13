import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.exec, spawn: vi.fn() }));
vi.mock("node:fs", () => ({
  existsSync: () => true,
  readdirSync: () => [],
  statSync: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  mkdtemp: async () => "/tmp/private-icon",
  readFile: async () => Buffer.from("png-fixture"),
  rm: async () => {},
}));
vi.mock("../shell", () => ({ APPLESCRIPT_ESC: (value: string) => value }));
import { nativeAppIconByBundleId } from "../open-apps";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
describe("native app artwork discovery", () => {
  it("uses Launch Services when Spotlight does not index the installed app", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    mocks.exec.mockImplementation((cmd, args, _opts, callback) => {
      const result = cmd.endsWith("osascript")
        ? "/Applications/Fixture.app\n"
        : cmd.endsWith("plutil")
          ? args.includes("CFBundleIdentifier")
            ? "com.example.Fixture\n"
            : "AppIcon\n"
          : "";
      callback(null, result);
    });
    expect(await nativeAppIconByBundleId("com.example.Fixture")).toBe(
      "data:image/png;base64,cG5nLWZpeHR1cmU=",
    );
    expect(
      mocks.exec.mock.calls.some(([cmd]) => cmd.endsWith("osascript")),
    ).toBe(true);
    expect(mocks.exec.mock.calls.every(([cmd]) => cmd !== "open")).toBe(true);
  });
  it("never reads artwork from a mismatched Launch Services bundle", async () => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    mocks.exec.mockImplementation((cmd, _args, _opts, callback) =>
      callback(
        null,
        cmd.endsWith("osascript")
          ? "/Applications/Fixture.app\n"
          : cmd.endsWith("plutil")
            ? "com.different.App\n"
            : "",
      ),
    );
    expect(await nativeAppIconByBundleId("com.example.Fixture")).toBeNull();
    expect(mocks.exec.mock.calls.some(([cmd]) => cmd.endsWith("sips"))).toBe(
      false,
    );
  });
});
