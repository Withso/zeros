// ============================================================
// Run-wide incident log for the browser smoke harness
//
// The composer smoke drives ~1,200 checks through one dev server and a few
// long-lived pages. A disturbance outside the scenario that is running — the
// dev server reloading pages or re-optimizing dependencies, a renderer-
// initiated navigation, an uncaught error that unmounts a harness, a crashed
// renderer, or a stalled runner event loop — otherwise surfaces later as an
// unrelated locator timeout or "Execution context was destroyed" wherever the
// run happens to be. (Playwright reports any non-JavaScript protocol failure
// of page.evaluate with that navigation wording, so the message alone cannot
// tell a reload from a collected promise.)
//
// The log changes nothing a check waits for. It records those events with a
// timestamp and is printed only when the run fails, so the next intermittent
// failure names its own cause instead of needing another rerun to guess.
// ============================================================

const DEFAULT_LIMIT = 60;
const MAX_TEXT = 300;
// Vite prints these on stdout through its info logger, which the harness
// otherwise never shows. The startup banner (which includes the runner's
// network address) is deliberately not forwarded.
const DEV_SERVER_NOTICE = /optimi[sz]ed|dependenc|reload/i;
const ROUTINE_DEV_CLIENT = /^\[vite\] connect(ing\.\.\.|ed\.)$/;

function pathOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol.startsWith("http")
      ? `${parsed.pathname}${parsed.search}`
      : url.slice(0, MAX_TEXT);
  } catch {
    return String(url).slice(0, MAX_TEXT);
  }
}

function oneLine(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

export function createSmokeIncidentLog({
  limit = DEFAULT_LIMIT,
  clock = () => new Date(),
  write = (text) => process.stderr.write(text),
} = {}) {
  const incidents = [];
  let dropped = 0;

  const record = (text) => {
    incidents.push(`${clock().toISOString()} ${oneLine(text)}`);
    if (incidents.length > limit) {
      incidents.shift();
      dropped += 1;
    }
  };

  return {
    record,

    /** Record the dev server's dependency and reload notices from stdout. */
    watchDevServerOutput(stream) {
      let pending = "";
      stream.on("data", (chunk) => {
        pending += String(chunk);
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines)
          if (DEV_SERVER_NOTICE.test(line)) record(`dev server: ${line}`);
      });
    },

    /** Record renderer-side events for one runner-owned page. */
    async watchPage(page, { devServerOrigin } = {}) {
      const where = () => pathOf(page.url());
      page.on("pageerror", (error) =>
        record(
          `${where()}: uncaught ${error?.name ?? "Error"}: ${error?.message ?? error}`,
        ),
      );
      page.on("crash", () => record(`${where()}: renderer crashed`));
      // Only the dev client's own notices (lost connection, reload polling,
      // failed socket). Harness consoles carry routine expected errors, and
      // render failures already arrive as uncaught page errors.
      page.on("console", (message) => {
        const text = message.text();
        if (text.startsWith("[vite]") && !ROUTINE_DEV_CLIENT.test(text))
          record(`${where()}: dev client: ${text}`);
      });
      if (devServerOrigin)
        page.on("response", (response) => {
          if (
            response.status() >= 500 &&
            response.url().startsWith(devServerOrigin)
          )
            record(
              `${where()}: dev server answered ${response.status()} for ${pathOf(response.url())}`,
            );
        });
      // Playwright's own goto/reload are browser-initiated and never appear
      // here; this event is a navigation the page started by itself.
      const session = await page.context().newCDPSession(page);
      await session.send("Page.enable");
      const { frameTree } = await session.send("Page.getFrameTree");
      const mainFrameId = frameTree.frame.id;
      session.on("Page.frameRequestedNavigation", (event) => {
        if (event.frameId !== mainFrameId) return;
        record(
          `${where()}: renderer-initiated ${event.reason} navigation to ${pathOf(event.url)}`,
        );
      });
    },

    /** Record runner event-loop stalls, which make any pending wait time out. */
    watchEventLoop({ intervalMs = 100, stallMs = 1_000 } = {}) {
      let last = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        const stall = now - last - intervalMs;
        last = now;
        if (stall >= stallMs)
          record(`runner event loop stalled for ${Math.round(stall)}ms`);
      }, intervalMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },

    entries() {
      return [...incidents];
    },

    report(heading = "ui-smoke incidents") {
      if (incidents.length === 0) return;
      const scope = dropped
        ? ` (${incidents.length} most recent, ${dropped} older dropped)`
        : "";
      write(
        `\n${heading}${scope}:\n${incidents.map((entry) => `  ${entry}`).join("\n")}\n`,
      );
    },
  };
}
