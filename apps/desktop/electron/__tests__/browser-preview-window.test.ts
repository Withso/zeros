import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (...args: unknown[]) => void;

const { Emitter, mocks } = vi.hoisted(() => {
  class Emitter {
    listeners = new Map<string, Listener[]>();
    on(name: string, listener: Listener) {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
      return this;
    }
    once(name: string, listener: Listener) {
      return this.on(name, listener);
    }
    emit(name: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(name) ?? []) listener(...args);
    }
  }
  return {
    Emitter,
    mocks: {
      commands: new Map<string, (args: Record<string, unknown>, event: unknown) => unknown>(),
      created: [] as Array<{ options: Record<string, unknown>; win: unknown }>,
      openExternal: vi.fn(async () => undefined),
    },
  };
});
type Emitter = InstanceType<typeof Emitter>;

vi.mock("../ipc/router", () => ({
  setCommand: (name: string, handler: (args: Record<string, unknown>, event: unknown) => unknown) =>
    mocks.commands.set(name, handler),
}));

vi.mock("electron", () => {
  class FakeContents extends Emitter {
    url = "";
    windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;
    openDevTools = vi.fn();
    getURL = () => this.url;
    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
      this.windowOpenHandler = handler;
    }
  }
  class FakeWindow extends Emitter {
    webContents = new FakeContents();
    destroyed = false;
    title: string;
    loadURL = vi.fn(async (url: string) => {
      this.webContents.url = url;
    });
    show = vi.fn();
    focus = vi.fn();
    restore = vi.fn();
    isMinimized = () => false;
    isDestroyed = () => this.destroyed;
    setTitle = vi.fn((title: string) => {
      this.title = title;
    });
    close = vi.fn(() => {
      this.destroyed = true;
      this.emit("closed");
    });
    constructor(options: Record<string, unknown>) {
      super();
      this.title = String(options.title ?? "");
      mocks.created.push({ options, win: this });
    }
  }
  const display = { workArea: { x: 0, y: 0, width: 1440, height: 900 } };
  return {
    BrowserWindow: FakeWindow,
    screen: {
      getDisplayMatching: () => display,
      getPrimaryDisplay: () => display,
    },
    shell: { openExternal: mocks.openExternal },
  };
});

import {
  closeBrowserPreviewWindows,
  MAX_BROWSER_PREVIEW_WINDOWS,
  previewWindowTitle,
  registerBrowserPreviewWindowCommands,
} from "../browser-preview-window";
import { previewFrameAuthorizations } from "../preview-frame-authorizations";

interface TestWindow extends Emitter {
  webContents: Emitter & {
    url: string;
    windowOpenHandler: ((details: { url: string }) => { action: string }) | null;
    openDevTools: ReturnType<typeof vi.fn>;
    session?: unknown;
    mainFrame?: unknown;
  };
  loadURL: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  close: () => void;
  title: string;
  destroyed: boolean;
}

const mainSession = { id: "default-session" };
const mainFrame = { id: "main-frame" };

function makeMainWindow() {
  const main = new Emitter() as Emitter & Record<string, unknown>;
  main.webContents = { session: mainSession, mainFrame };
  main.isDestroyed = () => false;
  main.getBounds = () => ({ x: 0, y: 0, width: 1600, height: 1000 });
  return main;
}

let main = makeMainWindow();

function invoke(args: Record<string, unknown>, event?: unknown) {
  const handler = mocks.commands.get("browser:open-window");
  if (!handler) throw new Error("browser:open-window not registered");
  return handler(args, event ?? { sender: main.webContents, senderFrame: mainFrame });
}

function lastWindow(): TestWindow {
  return mocks.created.at(-1)!.win as TestWindow;
}

function navigationEvent(url: string, isMainFrame = true) {
  return { url, isMainFrame, preventDefault: vi.fn() };
}

beforeEach(() => {
  closeBrowserPreviewWindows();
  previewFrameAuthorizations.clear();
  mocks.created.length = 0;
  mocks.commands.clear();
  mocks.openExternal.mockClear();
  main = makeMainWindow();
  registerBrowserPreviewWindowCommands({
    mainWindow: main as never,
    isAppUrl: (url) => url.startsWith("http://localhost:5193"),
  });
});

describe("browser:open-window request validation", () => {
  it("rejects senders other than the app window's main frame", () => {
    expect(
      invoke(
        { key: "zeros-browser-tab-1", url: "https://example.com/" },
        { sender: main.webContents, senderFrame: { id: "child-iframe" } },
      ),
    ).toEqual({ ok: false, reason: "unauthorized" });
    expect(mocks.created).toHaveLength(0);
  });

  it.each([
    [{ key: "tab-1", url: "https://example.com/" }],
    [{ key: "zeros-browser-", url: "https://example.com/" }],
    [{ key: "zeros-browser-tab 1", url: "https://example.com/" }],
    [{ key: `zeros-browser-${"a".repeat(301)}`, url: "https://example.com/" }],
  ])("rejects malformed requests %#", (args) => {
    expect(invoke(args)).toEqual({ ok: false, reason: "invalid-request" });
    expect(mocks.created).toHaveLength(0);
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "zeros://open",
    "https://user:pass@example.com/",
    " https://example.com/",
    "http://localhost:5193/",
    42,
  ])("rejects non-web or app-document URL %s", (url) => {
    expect(invoke({ key: "zeros-browser-tab-1", url })).toEqual({
      ok: false,
      reason: "unsupported-url",
    });
    expect(mocks.created).toHaveLength(0);
  });
});

describe("browser:open-window windows", () => {
  it("opens a hardened preview window on the shared session and shows it when ready", () => {
    expect(
      invoke({ key: "zeros-browser-tab-1", url: "https://www.apple.com/in/", title: "Apple (India)" }),
    ).toEqual({ ok: true, reused: false });
    const { options } = mocks.created[0]!;
    expect(options).toMatchObject({
      show: false,
      width: 1024,
      height: 768,
      x: 208,
      y: 66,
      title: "Preview · Apple (India)",
      webPreferences: {
        session: mainSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
      },
    });
    expect((options.webPreferences as Record<string, unknown>).preload).toBeUndefined();
    const win = lastWindow();
    expect(win.loadURL).toHaveBeenCalledWith("https://www.apple.com/in/");
    expect(win.show).not.toHaveBeenCalled();
    win.emit("ready-to-show");
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it("titles the window from page-title-updated", () => {
    invoke({ key: "zeros-browser-tab-1", url: "https://example.com/" });
    const win = lastWindow();
    expect(win.title).toBe("Preview · example.com");
    const event = { preventDefault: vi.fn() };
    win.webContents.emit("page-title-updated", event, "Example\u0000 Domain");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(win.title).toBe("Preview · Example  Domain");
    expect(previewWindowTitle(null, "not a url")).toBe("Preview · not a url");
  });

  it("reuses and focuses the window for a key, navigating only when the requested URL changes", () => {
    invoke({ key: "zeros-browser-tab-1", url: "https://example.com/" });
    const win = lastWindow();
    // A redirect inside the window must not be undone by a repeat request.
    win.webContents.url = "https://www.example.com/landing";
    expect(invoke({ key: "zeros-browser-tab-1", url: "https://example.com/" })).toEqual({
      ok: true,
      reused: true,
    });
    expect(mocks.created).toHaveLength(1);
    expect(win.loadURL).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalled();
    invoke({ key: "zeros-browser-tab-1", url: "https://example.com/docs" });
    expect(win.loadURL).toHaveBeenLastCalledWith("https://example.com/docs");
    invoke({ key: "zeros-browser-tab-2", url: "https://example.com/" });
    expect(mocks.created).toHaveLength(2);
  });

  it("never opens DevTools: Open DevTools inspects the tab's own iframe instead", () => {
    expect(
      invoke({ key: "zeros-browser-tab-1", url: "https://example.com/", devTools: true }),
    ).toEqual({ ok: true, reused: false });
    invoke({ key: "zeros-browser-tab-1", url: "https://example.com/", devTools: true });
    expect(lastWindow().webContents.openDevTools).not.toHaveBeenCalled();
  });

  it("forgets a closed window and creates a fresh one for the key", () => {
    invoke({ key: "zeros-browser-tab-1", url: "https://example.com/" });
    lastWindow().close();
    invoke({ key: "zeros-browser-tab-1", url: "https://example.com/" });
    expect(mocks.created).toHaveLength(2);
  });

  it("bounds the number of open preview windows", () => {
    for (let i = 0; i < MAX_BROWSER_PREVIEW_WINDOWS; i += 1) {
      expect(invoke({ key: `zeros-browser-tab-${i}`, url: "https://example.com/" })).toMatchObject({ ok: true });
    }
    expect(invoke({ key: "zeros-browser-tab-extra", url: "https://example.com/" })).toEqual({
      ok: false,
      reason: "too-many-windows",
    });
  });

  it("closes every preview when the app window closes and re-registers idempotently", () => {
    invoke({ key: "zeros-browser-tab-1", url: "https://example.com/" });
    const first = lastWindow();
    main.emit("closed");
    expect(first.destroyed).toBe(true);
    const next = makeMainWindow();
    registerBrowserPreviewWindowCommands({ mainWindow: next as never, isAppUrl: () => false });
    main = next;
    expect(invoke({ key: "zeros-browser-tab-1", url: "https://example.com/" })).toMatchObject({
      ok: true,
      reused: false,
    });
  });

  it("never lets a page's beforeunload block closing", () => {
    invoke({ key: "zeros-browser-tab-1", url: "https://example.com/" });
    const event = { preventDefault: vi.fn() };
    lastWindow().webContents.emit("will-prevent-unload", event);
    expect(event.preventDefault).toHaveBeenCalled();
  });
});

describe("browser:open-window navigation and popup policy", () => {
  beforeEach(() => {
    invoke({ key: "zeros-browser-tab-1", url: "https://example.com/" });
  });

  it("limits top-level navigation and redirects to ordinary http(s) pages", () => {
    const contents = lastWindow().webContents;
    for (const [eventName, url, blocked] of [
      ["will-frame-navigate", "https://example.org/", false],
      ["will-frame-navigate", "file:///Users/me/secret", true],
      ["will-frame-navigate", "zeros://auth", true],
      ["will-frame-navigate", "http://localhost:5193/", true],
      ["will-redirect", "http://example.org/", false],
      ["will-redirect", "data:text/html,hi", true],
    ] as const) {
      const event = navigationEvent(url);
      contents.emit(eventName, event);
      expect(event.preventDefault, `${eventName} ${url}`).toHaveBeenCalledTimes(blocked ? 1 : 0);
    }
  });

  it("allows ordinary subframe content but no privileged schemes", () => {
    const contents = lastWindow().webContents;
    for (const [url, blocked] of [
      ["https://cdn.example.org/embed", false],
      ["about:blank", false],
      ["data:text/html,hi", false],
      ["file:///etc/hosts", true],
      ["zeros-design://frame", true],
    ] as const) {
      const event = navigationEvent(url, false);
      contents.emit("will-frame-navigate", event);
      expect(event.preventDefault, url).toHaveBeenCalledTimes(blocked ? 1 : 0);
    }
  });

  it("denies popups and opens vetted http(s) targets externally, like the app window", () => {
    const contents = lastWindow().webContents;
    expect(contents.windowOpenHandler!({ url: "https://example.org/login" })).toEqual({ action: "deny" });
    expect(mocks.openExternal).toHaveBeenCalledWith("https://example.org/login");
    expect(contents.windowOpenHandler!({ url: "file:///etc/hosts" })).toEqual({ action: "deny" });
    expect(mocks.openExternal).toHaveBeenCalledTimes(1);
  });
});

describe("browser:open-window cloud previews", () => {
  const scope = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";

  it.each(["http://localhost:3000/", "http://127.0.0.1:5173/app", "http://[::1]:8080/", "http://app.localhost/"])(
    "refuses a cloud workspace's logical loopback URL %s",
    (url) => {
      expect(invoke({ key: "zeros-browser-tab-1", url, scope })).toEqual({
        ok: false,
        reason: "cloud-preview-unsupported",
      });
      expect(mocks.created).toHaveLength(0);
    },
  );

  it("opens external sites from cloud workspaces and loopback URLs from Local workspaces", () => {
    expect(invoke({ key: "zeros-browser-tab-1", url: "https://www.apple.com/in/", scope })).toMatchObject({ ok: true });
    expect(invoke({ key: "zeros-browser-tab-2", url: "http://localhost:3000/", scope: "/Users/me/project" })).toMatchObject({
      ok: true,
    });
  });

  it("never loads or navigates into an admitted volatile preview origin", () => {
    expect(
      previewFrameAuthorizations.authorize({
        frameName: "zeros-browser-tab-9",
        origin: "https://p-abc.preview.example.dev",
      }),
    ).toBe(true);
    expect(invoke({ key: "zeros-browser-tab-1", url: "https://p-abc.preview.example.dev/" })).toEqual({
      ok: false,
      reason: "cloud-preview-unsupported",
    });
    invoke({ key: "zeros-browser-tab-2", url: "https://example.com/" });
    const contents = lastWindow().webContents;
    const top = navigationEvent("https://p-abc.preview.example.dev/app");
    contents.emit("will-frame-navigate", top);
    expect(top.preventDefault).toHaveBeenCalled();
    const sub = navigationEvent("https://p-abc.preview.example.dev/app", false);
    contents.emit("will-redirect", sub);
    expect(sub.preventDefault).toHaveBeenCalled();
  });
});
