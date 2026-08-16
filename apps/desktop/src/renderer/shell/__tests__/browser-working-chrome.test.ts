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
    expect(strip).toContain('aria-label="Stop agent browser work"');
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
});
