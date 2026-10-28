import { expect } from "@playwright/test";

/** Real account information and cache; only native I/O and clock are fixtures. */
export async function runProviderUsageObservationSmoke({ page, check }) {
  const base = new URL(page.url()).origin;
  for (const provider of ["claude", "codex", "cursor"]) {
    const probe = await page
      .context()
      .browser()
      .newPage({ viewport: page.viewportSize() });
    const errors = [];
    probe.on("pageerror", (error) => errors.push(error.message));
    try {
      await probe.clock.install();
      await probe.addInitScript(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        const interval = window.setInterval.bind(window);
        const clear = window.clearInterval.bind(window);
        const timers = new Set();
        let ticks = 0;
        window.setInterval = (callback, ms, ...args) => {
          if (ms !== 60_000 && ms !== 30 * 60_000)
            return interval(callback, ms, ...args);
          const id = interval(() => {
            ticks++;
            callback(...args);
          }, ms);
          timers.add(id);
          return id;
        };
        window.clearInterval = (id) => {
          timers.delete(id);
          clear(id);
        };
        window.__usageTimers = {
          count: () => timers.size,
          ticks: () => ticks,
          visibility: (value) => {
            Object.defineProperty(document, "visibilityState", {
              configurable: true,
              value,
            });
            document.dispatchEvent(new Event("visibilitychange"));
          },
        };
      });
      await probe.goto(
        `${base}/apps/desktop/src/renderer/harnesses/harness-subscription.html?usage=${provider}&holdUsage=1&observeUsage`,
        { waitUntil: "networkidle" },
      );
      const name = { claude: "Claude", codex: "Codex", cursor: "Cursor" }[
        provider
      ];
      const info = probe.getByRole("region", {
        name: `${name} account information`,
      });
      const refresh = info.getByRole("button", {
        name: `Refresh ${name} usage`,
      });
      const reads = () =>
        probe.evaluate(() => window.__providerUsageObservation.reads());
      const statusReads = () =>
        probe.evaluate(() => window.__providerUsageObservation.statusReads());
      const registryReads = () =>
        probe.evaluate(() => window.__providerUsageObservation.registryReads());
      const cachedIdentity = () => probe.evaluate(async (provider) => {
        const { subscriptionCache } = await import(
          "/apps/desktop/src/renderer/features/settings/subscription-connection.ts"
        );
        return subscriptionCache.getSnapshot(provider).data?.email;
      }, provider);
      const timers = () => probe.evaluate(() => window.__usageTimers.count());
      const pending = (slot) =>
        probe.evaluate(
          (slot) => window.__providerUsageObservation.pending(slot),
          slot,
        );
      const release = (slot) =>
        probe.evaluate(
          (slot) => window.__providerUsageObservation.release(slot),
          slot,
        );
      // A cold hidden window has no confirmed native account yet. Neither
      // identity discovery nor usage observation should start until reveal.
      await expect(info).not.toContainText("user@example.test");
      expect(await statusReads()).toBe(0);
      expect(await reads()).toBe(0);
      expect(await timers()).toBe(0);
      await probe.evaluate(() => window.dispatchEvent(new Event("focus")));
      await probe.clock.fastForward(31 * 60_000);
      expect(await statusReads()).toBe(0);
      expect(await reads()).toBe(0);
      expect(await timers()).toBe(0);
      check(
        `${provider} usage starts no reads or recurring timers in a hidden document`,
        true,
      );

      await probe.evaluate(() => {
        window.__usageTimers.visibility("visible");
        window.dispatchEvent(new Event("focus"));
      });
      await expect.poll(() => pending("a")).toBe(1);
      await expect(info).toContainText("user@example.test");
      expect(await reads()).toBe(1);
      await release("a");
      await expect(info.getByRole("progressbar").first()).toHaveAttribute(
        "aria-valuenow",
        "20",
      );
      await expect(refresh).toHaveAttribute("aria-busy", "false");
      await expect.poll(timers).toBe(2);

      await probe.evaluate(() => {
        window.__usageTimers.visibility("hidden");
        // A focus callback can arrive before effect cleanup. It must be inert.
        window.dispatchEvent(new Event("focus"));
      });
      await expect.poll(timers).toBe(0);
      const hiddenReads = await reads();
      const hiddenTicks = await probe.evaluate(() =>
        window.__usageTimers.ticks(),
      );
      await probe.clock.fastForward(31 * 60_000);
      await probe.evaluate(() => window.dispatchEvent(new Event("focus")));
      expect(await reads()).toBe(hiddenReads);
      expect(await probe.evaluate(() => window.__usageTimers.ticks())).toBe(
        hiddenTicks,
      );
      await probe.evaluate(() => {
        window.__usageTimers.visibility("visible");
        window.dispatchEvent(new Event("focus"));
        window.dispatchEvent(new Event("focus"));
      });
      await expect.poll(() => pending("a")).toBe(1);
      expect(await reads()).toBe(hiddenReads + 1);
      await expect(info.getByRole("progressbar").first()).toHaveAttribute(
        "aria-valuenow",
        "20",
      );
      await expect(
        info.getByText("Loading usage limits", { exact: true }),
      ).toHaveCount(0);
      await expect(info).toContainText(
        provider === "cursor" ? "Resets in 1d 23h" : "Resets in 4h 29m",
      );
      await release("a");
      await expect(refresh).toHaveAttribute("aria-busy", "false");
      check(
        `${provider} usage removes hidden timers and coalesces reveal/focus while retaining data and current reset labels`,
        true,
      );

      // The old A read settles while B is current. Neither visibility nor an
      // account change may lend that response to the other cache identity.
      await refresh.click();
      await expect.poll(() => pending("a")).toBe(1);
      await probe.evaluate(() => window.__usageTimers.visibility("hidden"));
      const beforeSwitch = await reads();
      const beforeSwitchRegistry = await registryReads();
      await probe.evaluate(() => window.__providerUsageObservation.select("b"));
      // Hidden surfaces need not repaint. The native event must update the
      // cache without triggering a registry/usage read; reveal renders B.
      await expect.poll(cachedIdentity).toBe("second@example.test");
      expect(await reads()).toBe(beforeSwitch);
      expect(await registryReads()).toBe(beforeSwitchRegistry);
      await probe.evaluate(() => window.__usageTimers.visibility("visible"));
      await expect.poll(() => pending("b")).toBe(1);
      await expect(info).toContainText("second@example.test");
      expect(await reads()).toBe(beforeSwitch + 1);
      await release("a");
      await expect.poll(() => pending("a")).toBe(0);
      await expect(info.getByRole("progressbar")).toHaveCount(0);
      await expect(info).toContainText("second@example.test");
      await release("b");
      await expect(info.getByRole("progressbar").first()).toHaveAttribute(
        "aria-valuenow",
        "70",
      );
      await expect(refresh).toHaveAttribute("aria-busy", "false");
      await probe.evaluate(() => window.__usageTimers.visibility("hidden"));
      const beforeReturn = await reads();
      const beforeReturnRegistry = await registryReads();
      await probe.evaluate(() => window.__providerUsageObservation.select("a"));
      await expect.poll(cachedIdentity).toBe("user@example.test");
      expect(await reads()).toBe(beforeReturn);
      expect(await registryReads()).toBe(beforeReturnRegistry);
      await probe.evaluate(() => window.__usageTimers.visibility("visible"));
      await expect.poll(() => pending("a")).toBe(1);
      await expect(info).toContainText("user@example.test");
      expect(await reads()).toBe(beforeReturn + 1);
      await expect(info.getByRole("progressbar").first()).toHaveAttribute(
        "aria-valuenow",
        "20",
      );
      await expect(
        info.getByText("Loading usage limits", { exact: true }),
      ).toHaveCount(0);
      await release("a");
      await expect(refresh).toHaveAttribute("aria-busy", "false");
      check(
        `${provider} usage fences a held reply through hidden account A to B to A and restores only the exact account`,
        true,
      );
      expect(errors).toEqual([]);
    } finally {
      await probe.close();
    }
  }
}
