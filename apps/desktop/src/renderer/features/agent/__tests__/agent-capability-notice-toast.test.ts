import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ warning: vi.fn(), info: vi.fn() }));
vi.mock("../../../shared/ui/primitives/elements/toast", () => ({
  toast: { warning: mocks.warning, info: mocks.info },
}));

describe("agent capability notice toast", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.warning.mockClear();
    mocks.info.mockClear();
  });

  it("says once per app session that Codex switched to the Zeros browser", async () => {
    const { notifyAgentCapabilityNotice } = await import(
      "../agent-capability-notice-toast"
    );
    const notice = {
      code: "codex-browser-unavailable" as const,
      fallback: "zeros-browser" as const,
    };

    expect(notifyAgentCapabilityNotice({ notice })).toBe(true);
    expect(notifyAgentCapabilityNotice({ notice })).toBe(false);
    expect(mocks.warning).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledExactlyOnceWith(
      "Codex's built-in browser isn't available, so Codex is using the Zeros browser.",
      { id: "agent-capability-notice:codex-browser-unavailable::zeros-browser" },
    );
  });

  it("keeps the plugin fix in the description when Codex falls back", async () => {
    const { notifyAgentCapabilityNotice } = await import(
      "../agent-capability-notice-toast"
    );

    notifyAgentCapabilityNotice({
      notice: {
        code: "codex-browser-plugin-incomplete",
        version: "26.1007.21159",
        fallback: "zeros-browser",
      },
    });

    expect(mocks.warning).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      "Codex's built-in browser isn't available, so Codex is using the Zeros browser.",
      expect.objectContaining({
        description: expect.stringMatching(/Open the ChatGPT app/),
      }),
    );
  });

  it("ignores an unavailable notice that has no fallback", async () => {
    const { notifyAgentCapabilityNotice } = await import(
      "../agent-capability-notice-toast"
    );

    expect(
      notifyAgentCapabilityNotice({
        notice: { code: "codex-browser-unavailable" },
      }),
    ).toBe(false);
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.warning).not.toHaveBeenCalled();
  });

  it("warns once per plugin version when Codex cannot use its built-in browser", async () => {
    const { notifyAgentCapabilityNotice } = await import(
      "../agent-capability-notice-toast"
    );
    const notice = {
      code: "codex-browser-plugin-unsupported" as const,
      version: "27.1.0",
    };

    expect(notifyAgentCapabilityNotice({ notice })).toBe(true);
    expect(notifyAgentCapabilityNotice({ notice })).toBe(false);
    expect(mocks.warning).toHaveBeenCalledExactlyOnceWith(
      "Codex can't use its built-in browser",
      {
        id: "agent-capability-notice:codex-browser-plugin-unsupported:27.1.0:",
        description: expect.stringContaining("version 27.1.0"),
      },
    );

    expect(
      notifyAgentCapabilityNotice({ notice: { ...notice, version: "27.2.0" } }),
    ).toBe(true);
    expect(mocks.warning).toHaveBeenCalledTimes(2);
  });

  it("asks the user to open ChatGPT when its Browser plugin is incomplete", async () => {
    const { notifyAgentCapabilityNotice } = await import(
      "../agent-capability-notice-toast"
    );

    notifyAgentCapabilityNotice({
      notice: { code: "codex-browser-plugin-incomplete", version: "26.1007.21159" },
    });

    expect(mocks.warning).toHaveBeenCalledWith(
      "Codex can't use its built-in browser",
      expect.objectContaining({
        description: expect.stringMatching(/Open the ChatGPT app/),
      }),
    );
  });

  it.each([
    [{ fallback: "zeros-browser" as const }, "info", "Codex's built-in browser isn't available, so Codex is using the Zeros browser."],
    [{}, "warning", "Codex can't use its built-in browser"],
  ] as const)("names the node_repl configuration when Codex starts without its browser (%o)", async (extra, kind, title) => {
    const { notifyAgentCapabilityNotice } = await import(
      "../agent-capability-notice-toast"
    );

    expect(
      notifyAgentCapabilityNotice({
        notice: { code: "codex-browser-config-conflict", ...extra },
      }),
    ).toBe(true);
    expect(mocks[kind]).toHaveBeenCalledExactlyOnceWith(
      title,
      expect.objectContaining({
        description: expect.stringMatching(/changes node_repl in a way Zeros can't verify/),
      }),
    );
  });

  it("ignores a notice code from a newer engine", async () => {
    const { notifyAgentCapabilityNotice } = await import(
      "../agent-capability-notice-toast"
    );

    expect(
      notifyAgentCapabilityNotice({
        notice: { code: "future-notice" as never },
      }),
    ).toBe(false);
    expect(mocks.warning).not.toHaveBeenCalled();
  });
});
