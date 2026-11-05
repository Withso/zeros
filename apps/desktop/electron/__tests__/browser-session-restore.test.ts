import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

import { parseBrowserRestoreRequest } from "../browser/surface";

// The restore path is private to the Electron browser service, which needs a
// live Electron runtime to import. Run its real source in an isolated context
// with only the collaborators it is allowed to reach.
const source = ts.createSourceFile(
  "service.ts",
  readFileSync(new URL("../browser/service.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);

function declaration(name: string): string {
  const node = source.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!node) throw new Error(`service.ts no longer declares ${name}()`);
  return node.getText(source);
}

interface FakeLease {
  view: { webContents: FakeContents };
  status: string;
  currentTool?: string;
  pendingUrl: string | null;
  actor: "agent" | "user";
}

interface FakeContents {
  destroyed: boolean;
  isDestroyed(): boolean;
  loadURL: ReturnType<typeof vi.fn>;
}

interface FakeRecord {
  id: string;
  owner: { conversationId: string };
  touchedAt: number;
  lease: FakeLease | null;
}

function load() {
  const publishState = vi.fn(
    (_options: unknown, record: FakeRecord, status: string, tool?: string) => ({
      browserSessionId: record.id,
      status,
      tool,
      url: record.lease?.pendingUrl ?? "",
    }),
  );
  const recordTrace = vi.fn();
  const sandbox: Record<string, unknown> = { publishState, recordTrace };
  vm.runInNewContext(
    ts.transpileModule(
      [
        declaration("startUserBrowserLoad"),
        declaration("conversationBrowserRecord"),
        declaration("restoreUserBrowserPage"),
        "globalThis.restore = restoreUserBrowserPage;",
        "globalThis.find = conversationBrowserRecord;",
      ].join("\n"),
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    sandbox,
  );
  return {
    publishState,
    recordTrace,
    restore: sandbox.restore as (
      record: FakeRecord,
      url: string,
      context: Record<string, unknown>,
    ) => { browserSessionId: string; status: string; url: string },
    find: sandbox.find as (
      records: Iterable<FakeRecord>,
      conversationId: string,
    ) => FakeRecord | undefined,
  };
}

function contents(
  load: (url: string) => Promise<void> = async () => undefined,
): FakeContents {
  return {
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    loadURL: vi.fn(load),
  };
}

function lease(webContents = contents()): FakeLease {
  return {
    view: { webContents },
    status: "ready",
    pendingUrl: null,
    actor: "user",
  };
}

function record(
  id: string,
  conversationId: string,
  current: FakeLease | null,
  touchedAt = 1,
): FakeRecord {
  return { id, owner: { conversationId }, touchedAt, lease: current };
}

describe("reopening a conversation's page for its Browser tab", () => {
  it("binds a page the record still holds without navigating it", () => {
    const { restore, publishState } = load();
    const live = lease();
    live.status = "working";
    live.currentTool = "click";
    live.actor = "agent";
    const owned = record("browser_live", "conversation-a", live);
    const openLease = vi.fn();

    const state = restore(owned, "https://cursor.com/", {
      options: {},
      openLease,
      scheduleLeaseCleanup: vi.fn(),
    });

    expect(state).toMatchObject({ browserSessionId: "browser_live", status: "working" });
    expect(publishState).toHaveBeenCalledWith({}, owned, "working", "click");
    expect(openLease).not.toHaveBeenCalled();
    expect(live.view.webContents.loadURL).not.toHaveBeenCalled();
    expect(owned.lease).toBe(live);
  });

  it("opens a user-owned page at the tab's address when the page is gone", async () => {
    const { restore, publishState, recordTrace } = load();
    let finishLoad!: () => void;
    const fresh = lease(
      contents(
        () =>
          new Promise<void>((resolve) => {
            finishLoad = resolve;
          }),
      ),
    );
    const owned = record("browser_closed", "conversation-a", null);

    const state = restore(owned, "https://cursor.com/", {
      options: {},
      openLease: () => fresh,
      scheduleLeaseCleanup: vi.fn(),
    });

    expect(owned.lease).toBe(fresh);
    expect(fresh.view.webContents.loadURL).toHaveBeenCalledWith(
      "https://cursor.com/",
    );
    expect(recordTrace).toHaveBeenCalledWith(fresh, "tool", "open");
    expect(state).toEqual({
      browserSessionId: "browser_closed",
      status: "ready",
      tool: "open",
      url: "https://cursor.com/",
    });

    finishLoad();
    await vi.waitFor(() => expect(publishState).toHaveBeenCalledTimes(2));
    expect(fresh.pendingUrl).toBeNull();
  });

  it("replaces a page whose renderer is gone", () => {
    const { restore } = load();
    const dead = lease();
    dead.view.webContents.destroyed = true;
    const fresh = lease();
    const owned = record("browser_crashed", "conversation-a", dead);
    const scheduleLeaseCleanup = vi.fn(async () => undefined);

    restore(owned, "https://cursor.com/", {
      options: {},
      openLease: () => fresh,
      scheduleLeaseCleanup,
    });

    expect(scheduleLeaseCleanup).toHaveBeenCalledWith(dead);
    expect(owned.lease).toBe(fresh);
  });

  it("does not publish a load that settles after its page was replaced", async () => {
    const { restore, publishState } = load();
    let finishLoad!: () => void;
    const first = lease(
      contents(
        () =>
          new Promise<void>((resolve) => {
            finishLoad = resolve;
          }),
      ),
    );
    const owned = record("browser_replaced", "conversation-a", null);
    restore(owned, "https://cursor.com/", {
      options: {},
      openLease: () => first,
      scheduleLeaseCleanup: vi.fn(),
    });
    owned.lease = lease();
    publishState.mockClear();

    finishLoad();
    await Promise.resolve();
    await Promise.resolve();

    expect(publishState).not.toHaveBeenCalled();
  });

  it("finds the conversation's record, preferring its live page", () => {
    const { find } = load();
    const parked = record("browser_parked", "conversation-a", null, 9);
    const live = record("browser_live", "conversation-a", lease(), 1);
    const other = record("browser_other", "conversation-b", lease(), 20);

    expect(find([parked, other], "conversation-a")).toBe(parked);
    expect(find([parked, live, other], "conversation-a")).toBe(live);
    expect(find([live, parked], "conversation-a")).toBe(live);
    expect(
      find(
        [
          record("browser_old", "conversation-a", null, 1),
          record("browser_new", "conversation-a", null, 5),
        ],
        "conversation-a",
      )?.id,
    ).toBe("browser_new");
    expect(find([other], "conversation-a")).toBeUndefined();
  });
});

describe("the trusted reopen request", () => {
  it("names the conversation and address, with an optional Local owner", () => {
    expect(
      parseBrowserRestoreRequest({
        conversationId: "conversation-a",
        url: "https://cursor.com/",
      }),
    ).toEqual({ conversationId: "conversation-a", url: "https://cursor.com/" });
    // The owner always takes the request's conversation, never its own.
    expect(
      parseBrowserRestoreRequest({
        conversationId: "conversation-a",
        url: "https://cursor.com/",
        owner: {
          workspaceId: "ws-local",
          workspaceRoot: "/Users/dev/zeros",
          conversationId: "conversation-b",
        },
      }),
    ).toEqual({
      conversationId: "conversation-a",
      url: "https://cursor.com/",
      owner: {
        workspaceId: "ws-local",
        conversationId: "conversation-a",
        workspaceRoot: "/Users/dev/zeros",
      },
    });
  });

  it.each([
    [{ url: "https://cursor.com/" }],
    [{ conversationId: "conversation a", url: "https://cursor.com/" }],
    [{ conversationId: "conversation-a" }],
    [{ conversationId: "conversation-a", url: `https://a.test/${"x".repeat(8_200)}` }],
  ])("rejects a malformed request %#", (args) => {
    expect(() => parseBrowserRestoreRequest(args)).toThrow(
      "Invalid browser restore request.",
    );
  });

  it.each([
    [null],
    [["ws-local", "/Users/dev/zeros"]],
    [{ workspaceId: "ws local", workspaceRoot: "/Users/dev/zeros" }],
    [{ workspaceId: "ws-local", workspaceRoot: "relative/zeros" }],
    [{ workspaceId: "ws-local", workspaceRoot: "cloud://org/ws" }],
  ])("rejects an owner that is not a Local workspace %#", (owner) => {
    expect(() =>
      parseBrowserRestoreRequest({
        conversationId: "conversation-a",
        url: "https://cursor.com/",
        owner,
      }),
    ).toThrow("Invalid browser restore owner.");
  });
});
