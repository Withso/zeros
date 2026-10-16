import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("browser working chrome", () => {
  it("moves the shimmer highlight left to right and keeps Stop in the tab pill", () => {
    const css = readFileSync(
      resolve(process.cwd(), "styles/global/animations.css"),
      "utf8",
    );
    const strip = readFileSync(
      resolve(
        process.cwd(),
        "apps/desktop/src/renderer/shell/workbench/tab-strip.tsx",
      ),
      "utf8",
    );
    const browser = readFileSync(
      resolve(
        process.cwd(),
        "apps/desktop/src/renderer/shell/workbench/tabs/browser-tab.tsx",
      ),
      "utf8",
    );
    const sessionsProvider = readFileSync(
      resolve(
        process.cwd(),
        "apps/desktop/src/renderer/features/agent/sessions-provider.tsx",
      ),
      "utf8",
    );

    expect(css).toMatch(
      /@keyframes zeros-browser-tab-shimmer[\s\S]*?0%\s*\{\s*background-position:\s*120% 0[\s\S]*?100%\s*\{\s*background-position:\s*-120% 0/,
    );
    expect(strip).toMatch(/<IconButton\b[^>]*label="Stop agent browser work"/);
    expect(strip).toContain("CircleStop");
    expect(strip).not.toContain("sessions.cancel(conversationId)");
    expect(strip).toMatch(/sessions\s*\.stopBrowserUse\(/);
    expect(strip).toContain('nativeInvoke("browser_session_close"');
    expect(sessionsProvider).toContain("{ deliveryWatchdog: false }");
    expect(browser).not.toContain("<span>Agent working</span>");
    expect(browser.match(/\.current\?\.blur\(\)/g)).toHaveLength(2);
    expect(browser).toContain("state.faviconDataUrl");
    expect(strip).toContain("ordinaryBrowserFavicon");
    expect(strip).toContain("useBrowserTabFavicon");
  });

  it("settles the Browser approval when the page's control bar or Esc stops the agent", () => {
    const sessionsProvider = readFileSync(
      resolve(
        process.cwd(),
        "apps/desktop/src/renderer/features/agent/sessions-provider.tsx",
      ),
      "utf8",
    );
    // Main already stopped the page; the renderer only settles the question,
    // exactly as the Browser tab's own Stop does.
    const listener = sessionsProvider.match(
      /nativeListen<[^>]*>\(\s*"browser-agent-stopped"[\s\S]*?\}\s*\)/,
    )?.[0];
    expect(listener).toBeDefined();
    expect(listener).toContain("dismissBrowserApproval(");
    expect(listener).not.toContain("browser_session_stop");
    expect(sessionsProvider).toMatch(
      /const stopBrowserUse[\s\S]*?dismissBrowserApproval\(chatId\)/,
    );
  });
});
