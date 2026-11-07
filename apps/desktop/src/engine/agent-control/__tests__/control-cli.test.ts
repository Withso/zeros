// `zeros computer` / `zeros browser` drive the chat's real agent-control
// server over `/call`: the same capability and handler as the MCP tools.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { DesignAgentMcpServer } from "../../design/design-agent-mcp";
import {
  compactBrowserText,
  matchApp,
  parseAppList,
  parseWindowList,
  runControlCli,
  type ControlCliIO,
} from "../control-cli";

const APPS = `Running:
- Google Chrome (pid 17341) com.google.Chrome
- Finder (pid 638) com.apple.finder
Installed, not running (open with open_app):
- Safari com.apple.Safari`;

const token = "test-capability-token-0123456789";
let server: DesignAgentMcpServer;
let calls: Array<{ name: string; input: unknown }>;
let windows: string;
let apps: string;
let launchText: string;
let launchWindows: string | null;
let launchedApps: string | null;
let urlWindows: string;
let directory: string;

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

beforeEach(async () => {
  calls = [];
  windows = `- window 51231: Google Chrome (pid 17341) "New Tab" at 0,0 size 800×600`;
  apps = APPS;
  launchText = "Done.";
  launchWindows = null;
  launchedApps = null;
  urlWindows = `- window 51231: Google Chrome (pid 17341) "Cursor Agent" at 0,0 size 800×600`;
  directory = await mkdtemp(path.join(tmpdir(), "zeros-control-cli-"));
  server = new DesignAgentMcpServer({
    token,
    name: "zeros_computer",
    credentialEnv: "ZEROS_COMPUTER_TOOLS_CAPABILITY",
    handler: {
      assertActive() {},
      listTools: () => [],
      callTool: async (name, input) => {
        calls.push({ name, input });
        switch (name) {
          case "list_apps":
            return text(apps);
          case "list_windows": {
            const pid = (input as { pid?: number }).pid;
            return text(windows.split("\n").filter((line) => pid === undefined || line.includes(`(pid ${pid})`)).join("\n"));
          }
          case "open_app":
            windows = launchWindows ?? windows;
            apps = launchedApps ?? apps;
            return text(launchText);
          case "open_url":
            windows = urlWindows;
            return text("Opened https://cursor.com/ in Google Chrome.");
          case "screenshot":
            return {
              content: [
                { type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" },
                { type: "text", text: "Google Chrome — window 51231" },
              ],
            };
          case "press_key":
            return { content: [{ type: "text", text: "The user did not allow Cursor to control Google Chrome." }], isError: true };
          default:
            return text("Done.");
        }
      },
    },
  });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  await rm(directory, { recursive: true, force: true });
});

function io(overrides: Partial<ControlCliIO> = {}): { io: Partial<ControlCliIO>; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      env: { ZEROS_COMPUTER_TOOLS_URL: server.callUrl, ZEROS_COMPUTER_TOOLS_CAPABILITY: `Bearer ${token}` },
      stdout: (value) => out.push(value),
      stderr: (value) => err.push(value),
      tmpdir: () => directory,
      sleep: async () => undefined,
      ...overrides,
    },
  };
}

describe("zeros computer", () => {
  it("opens a URL by app name and waits for its window in one command", async () => {
    const run = io();
    const code = await runControlCli("computer", ["open", "--app", "chrome", "https://cursor.com", "--wait-title", "cursor", "--json"], run.io);
    expect(code).toBe(0);
    // Chrome was already running, so its pid needs no second app listing.
    expect(calls.map((call) => call.name)).toEqual(["list_apps", "open_url", "list_windows"]);
    expect(calls[1]!.input).toEqual({ bundle_id: "com.google.Chrome", url: "https://cursor.com" });
    const line = JSON.parse(run.out.join(""));
    expect(line).toMatchObject({
      ok: true,
      command: "computer.open",
      data: { app: "Google Chrome", windowId: 51231, title: "Cursor Agent" },
    });
  });

  it("waits on the pid a launch reports without listing apps again", async () => {
    launchText = "Launched Safari (pid 4242) in background.";
    launchWindows = `- window 9: Safari (pid 4242) "Start Page" at 0,0 size 800×600`;
    const run = io();
    expect(await runControlCli("computer", ["open", "--app", "safari", "--wait-title", "start"], run.io)).toBe(0);
    expect(calls.map((call) => call.name)).toEqual(["list_apps", "open_app", "list_windows"]);
    expect(calls[2]!.input).toEqual({ pid: 4242 });
  });

  it("lists apps again when a launch names no pid", async () => {
    launchWindows = `- window 9: Safari (pid 4242) "Start Page" at 0,0 size 800×600`;
    launchedApps = "Running:\n- Safari (pid 4242) com.apple.Safari";
    const run = io();
    expect(await runControlCli("computer", ["open", "--app", "safari", "--wait-title", "start"], run.io)).toBe(0);
    expect(calls.map((call) => call.name)).toEqual(["list_apps", "open_app", "list_apps", "list_windows"]);
    expect(calls[3]!.input).toEqual({ pid: 4242 });
  });

  it("finds an app that restarted under a new pid once its old pid shows no window", async () => {
    // The listing still names Chrome's old pid; Chrome now runs as 5000.
    urlWindows = `- window 61: Google Chrome (pid 5000) "Cursor Agent" at 0,0 size 800×600`;
    const run = io();
    const code = await runControlCli("computer", ["open", "--app", "chrome", "https://cursor.com", "--wait-title", "cursor"], {
      ...run.io,
      sleep: async () => {
        apps = "Running:\n- Google Chrome (pid 5000) com.google.Chrome";
      },
    });
    expect(code).toBe(0);
    expect(calls.filter((call) => call.name === "list_apps")).toHaveLength(2);
    expect(calls.at(-1)).toEqual({ name: "list_windows", input: { pid: 5000 } });
  });

  it("saves screenshots to files instead of printing image data", async () => {
    const run = io();
    const out = path.join(directory, "shot.png");
    expect(await runControlCli("computer", ["shot", "--app", "Google Chrome", "--out", out], run.io)).toBe(0);
    expect(calls.at(-1)).toEqual({ name: "screenshot", input: { pid: 17341, window_id: 51231 } });
    expect(await readFile(out, "utf8")).toBe("png-bytes");
    expect(run.out.join("")).toContain(`image: ${out}`);
  });

  it("creates the folders of a --out path that does not exist yet", async () => {
    const run = io();
    const out = path.join(directory, "new", "nested", "shot.png");
    expect(await runControlCli("computer", ["shot", "--app", "Google Chrome", "--out", out], run.io)).toBe(0);
    expect(await readFile(out, "utf8")).toBe("png-bytes");
  });

  it("accepts screenshot as another name for shot", async () => {
    const run = io();
    expect(await runControlCli("computer", ["screenshot", "--app", "chrome", "--json"], run.io)).toBe(0);
    expect(calls.at(-1)).toEqual({ name: "screenshot", input: { pid: 17341, window_id: 51231 } });
    expect(JSON.parse(run.out.join(""))).toMatchObject({ ok: true, command: "computer.shot" });
  });

  it("reports a refused action as a failure with the host's text", async () => {
    const run = io();
    expect(await runControlCli("computer", ["key", "--pid", "17341", "return"], run.io)).toBe(1);
    expect(run.err.join("")).toContain("did not allow");
  });

  it("runs a batch in one process and stops at the first failure", async () => {
    const steps = JSON.stringify([["apps"], ["key", "--pid", "17341", "return"], ["apps"]]);
    const run = io({ readStdin: async () => steps });
    expect(await runControlCli("computer", ["batch", "-"], run.io)).toBe(1);
    expect(calls.filter((call) => call.name === "list_apps")).toHaveLength(1);
  });

  it("prints one command's usage for --help, -h and help VERB, without calling Zeros", async () => {
    for (const argv of [["open", "--help"], ["open", "-h"], ["help", "open"], ["open", "--app", "chrome", "--help"]]) {
      const run = io({ env: {} });
      expect(await runControlCli("computer", argv, run.io)).toBe(0);
      const printed = run.out.join("");
      expect(printed).toContain("Usage: zeros computer open --app A [URL] [--wait-title T]");
      expect(printed).toContain("--wait-ms (15000)");
      expect(printed).not.toContain("drag --app");
    }
    const alias = io({ env: {} });
    expect(await runControlCli("computer", ["screenshot", "--help"], alias.io)).toBe(0);
    expect(alias.out.join("")).toContain("Usage: zeros computer shot --app A|--pid N");
    const scroll = io({ env: {} });
    expect(await runControlCli("computer", ["scroll", "--help"], scroll.io)).toBe(0);
    expect(scroll.out.join("")).toContain("[--element T | --window W --x X --y Y]");
    const browser = io({ env: {} });
    expect(await runControlCli("browser", ["reload", "--help"], browser.io)).toBe(0);
    expect(browser.out.join("")).toContain("Usage: zeros browser back | forward | reload | close");
    // An unknown command still gets the full list; text after -- is input.
    const unknown = io({ env: {} });
    expect(await runControlCli("computer", ["fly", "--help"], unknown.io)).toBe(0);
    expect(unknown.out.join("")).toContain("drag --app");
    const typed = io();
    expect(await runControlCli("computer", ["type", "--pid", "17341", "--", "--help"], typed.io)).toBe(0);
    expect(calls.at(-1)).toMatchObject({ name: "type_text", input: { pid: 17341, text: "--help" } });
    expect(calls.filter((call) => call.name !== "type_text")).toEqual([]);
  });

  it("refuses without the chat's capability, and the server refuses a wrong token", async () => {
    const missing = io({ env: {} });
    expect(await runControlCli("computer", ["apps"], missing.io)).toBe(3);
    const wrong = io({ env: { ZEROS_COMPUTER_TOOLS_URL: server.callUrl, ZEROS_COMPUTER_TOOLS_CAPABILITY: "Bearer wrong" } });
    expect(await runControlCli("computer", ["apps"], wrong.io)).toBe(3);
    expect(calls).toEqual([]);
  });

  it("refuses browser-originated calls to /call", async () => {
    const response = await fetch(server.callUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Origin: "https://evil.example", "Content-Type": "application/json" },
      body: JSON.stringify({ name: "list_apps", arguments: {} }),
    });
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("control CLI parsing", () => {
  it("reads the controller's app and window lists", () => {
    expect(parseAppList(APPS)).toEqual([
      { name: "Google Chrome", pid: 17341, bundleId: "com.google.Chrome" },
      { name: "Finder", pid: 638, bundleId: "com.apple.finder" },
      { name: "Safari", pid: null, bundleId: "com.apple.Safari" },
    ]);
    expect(parseWindowList(`- window 7: Notes (pid 9) "A \\"quoted\\" note" at -10,20 size 100×200\n- window 8: Notes (pid 9)`)).toEqual([
      { windowId: 7, app: "Notes", pid: 9, title: 'A \\"quoted\\" note' },
      { windowId: 8, app: "Notes", pid: 9, title: "" },
    ]);
  });

  it("matches apps by bundle ID or name, preferring running apps", () => {
    const apps = parseAppList(APPS);
    expect(matchApp(apps, "chrome")?.bundleId).toBe("com.google.Chrome");
    expect(matchApp(apps, "COM.APPLE.SAFARI")?.name).toBe("Safari");
    expect(matchApp(apps, "nothing")).toBeNull();
    const two = parseAppList("Running:\n- Xcode (pid 1) com.apple.dt.Xcode\n- Visual Studio Code (pid 2) com.microsoft.VSCode");
    expect(() => matchApp(two, "code")).toThrow("matches Xcode (com.apple.dt.Xcode), Visual Studio Code");
    expect(matchApp(two, "xcode")?.pid).toBe(1);
  });

  it("compacts a page snapshot and keeps refs", () => {
    const snapshot = JSON.stringify({
      title: "Docs",
      url: "https://example.com/docs",
      text: `Intro\n${"filler ".repeat(1_000)}\nPricing plans`,
      elements: [
        { ref: "b1_aaaaaaaaaaaaaaaaaaaaaaaa", role: "link", name: "Pricing", href: "https://example.com/pricing" },
        { ref: "b2_aaaaaaaaaaaaaaaaaaaaaaaa", role: "button", name: "Sign in" },
      ],
    });
    const compact = compactBrowserText(snapshot, {});
    expect(compact.length).toBeLessThan(2_600);
    expect(compact).toContain("b1_aaaaaaaaaaaaaaaaaaaaaaaa link");
    const found = compactBrowserText(snapshot, { find: "pricing" });
    expect(found).toContain("Pricing plans");
    expect(found).not.toContain("Sign in");
  });
});
