import { expect } from "@playwright/test";

export async function runSetupObservationSmoke({ page, check }) {
  const base = new URL(page.url()).origin;
  for (const placement of ["local", "organization-local", "cloud"]) {
    const probe = await page
      .context()
      .browser()
      .newPage({ viewport: page.viewportSize() });
    const errors = [];
    probe.on("pageerror", (error) => errors.push(error.message));
    try {
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
          if (ms !== 900 && ms !== 2000) return interval(callback, ms, ...args);
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
        window.__setupObservation = {
          timers: () => timers.size,
          ticks: () => ticks,
          visibility: (state) => {
            Object.defineProperty(document, "visibilityState", {
              configurable: true,
              value: state,
            });
            document.dispatchEvent(new Event("visibilitychange"));
          },
        };
      });
      const query = `?separate-owners&setup-observation${placement === "local" ? "" : `&${placement}`}`;
      await probe.goto(
        `${base}/apps/desktop/src/renderer/harnesses/harness-terminal-workbench.html${query}`,
        { waitUntil: "networkidle" },
      );
      await probe.evaluate(() =>
        window.__setupObservation.visibility("hidden"),
      );
      await probe
        .getByRole("button", { name: "New File, Browser, or Terminal tab" })
        .click();
      await probe
        .getByRole("option", { name: "Terminal", exact: true })
        .click();
      await probe
        .getByRole("tablist", { name: "Terminal sessions" })
        .getByRole("tab", { name: "Setup", exact: true })
        .click();
      const output = probe.locator("[data-terminal-workbench]");
      expect(
        await probe.evaluate(
          () =>
            window.__zerosTerminalSmoke.messages.filter(
              (row) => row.op === "workspace.setupInfo",
            ).length,
        ),
      ).toBe(0);
      expect(
        await probe.evaluate(() => window.__setupObservation.timers()),
      ).toBe(0);
      await probe.evaluate(() =>
        window.__setupObservation.visibility("visible"),
      );
      await expect(output).toContainText("Setup output preserved");
      check(
        `${placement} Setup does not start cold reads or retries in a hidden window`,
        true,
      );
      const id = await probe.evaluate(
        () =>
          window.__zerosTerminalSmoke.messages
            .filter(
              (row) =>
                row.op === "workspace.setupInfo" &&
                !row.params.statusOnly &&
                !row.params.omitLog,
            )
            .at(-1).params.workspaceId,
      );
      const reads = () =>
        probe.evaluate(
          (id) =>
            window.__zerosTerminalSmoke.messages.filter(
              (row) =>
                row.op === "workspace.setupInfo" &&
                !row.params.statusOnly &&
                !row.params.omitLog &&
                row.params.workspaceId === id,
            ).length,
          id,
        );
      await probe.evaluate(
        (id) =>
          window.__zerosTerminalSmoke.setupSnapshot(
            id,
            "running",
            "Visible setup output\r\n",
          ),
        id,
      );
      await expect(output).toContainText("Visible setup output");
      await expect
        .poll(() => probe.evaluate(() => window.__setupObservation.timers()))
        .toBeGreaterThan(0);
      await probe.evaluate(() =>
        window.__setupObservation.visibility("hidden"),
      );
      // This assertion is about cancellation, not a timer that wakes and skips.
      await expect
        .poll(() => probe.evaluate(() => window.__setupObservation.timers()))
        .toBe(0);
      const hiddenReads = await reads();
      const hiddenObserverReads = await probe.evaluate(
        () =>
          window.__zerosTerminalSmoke.messages.filter(
            (row) => row.op === "workspace.setupInfo",
          ).length,
      );
      await expect(probe.locator("[data-setup-summary]")).toHaveText("running");
      await probe.evaluate((id) => {
        window.__zerosTerminalSmoke.setupSnapshot(
          id,
          "passed",
          "Visible setup output\r\nFinished while hidden\r\n",
        );
        window.dispatchEvent(new Event("focus"));
      }, id);
      expect(await reads()).toBe(hiddenReads);
      expect(
        await probe.evaluate(
          () =>
            window.__zerosTerminalSmoke.messages.filter(
              (row) => row.op === "workspace.setupInfo",
            ).length,
        ),
      ).toBe(hiddenObserverReads);
      await expect(probe.locator("[data-setup-summary]")).toHaveText("running");
      expect(await output.textContent()).not.toContain("Finished while hidden");
      await probe.evaluate(() =>
        window.__setupObservation.visibility("visible"),
      );
      await expect(output).toContainText("Finished while hidden");
      await expect(probe.locator("[data-setup-summary]")).toHaveText("passed");
      expect(await reads()).toBe(hiddenReads + 1);
      check(
        `${placement} Setup cancels hidden polling and catches up without running or stopping setup`,
        true,
      );

      // A real setup invalidation arrives while a stale read is pending, then
      // the window hides before that read completes. It must not start a tail.
      await probe.evaluate((id) => {
        window.__zerosTerminalSmoke.holdSetupRead(id);
        window.__zerosTerminalSmoke.setupSnapshot(
          id,
          "running",
          "Held old output\r\n",
        );
      }, id);
      await expect
        .poll(() =>
          probe.evaluate(
            (id) => window.__zerosTerminalSmoke.pendingSetupRead(id),
            id,
          ),
        )
        .toBe(true);
      await probe.evaluate(
        (id) =>
          window.__zerosTerminalSmoke.setupSnapshot(
            id,
            "passed",
            "Latest hidden output\r\n",
          ),
        id,
      );
      await probe.evaluate(() =>
        window.__setupObservation.visibility("hidden"),
      );
      const heldReads = await reads();
      await probe.evaluate(
        ({ id, fail }) => window.__zerosTerminalSmoke.finishSetupRead(id, fail),
        { id, fail: placement === "organization-local" },
      );
      await expect
        .poll(() =>
          probe.evaluate(
            (id) => window.__zerosTerminalSmoke.pendingSetupRead(id),
            id,
          ),
        )
        .toBe(false);
      expect(await reads()).toBe(heldReads);
      expect(
        await probe.evaluate(() => window.__setupObservation.timers()),
      ).toBe(0);
      await probe.evaluate(() =>
        window.__setupObservation.visibility("visible"),
      );
      await expect(output).toContainText("Latest hidden output");
      expect(await reads()).toBe(heldReads + 1);
      check(
        `${placement} Setup parks in-flight invalidations while hidden and keeps exact latest output`,
        true,
      );

      // Reveal before the old read completes: a shared old flight cannot stand
      // in for the catch-up after events were missed while unsubscribed.
      await probe.evaluate((id) => {
        window.__zerosTerminalSmoke.holdSetupRead(id);
        window.__zerosTerminalSmoke.setupSnapshot(
          id,
          "passed",
          "Superseded\r\n",
        );
      }, id);
      await expect
        .poll(() =>
          probe.evaluate(
            (id) => window.__zerosTerminalSmoke.pendingSetupRead(id),
            id,
          ),
        )
        .toBe(true);
      await probe.evaluate(() =>
        window.__setupObservation.visibility("hidden"),
      );
      await probe.evaluate(
        (id) =>
          window.__zerosTerminalSmoke.setupSnapshot(
            id,
            "passed",
            "Latest hidden output\r\nCaught up after reveal\r\n",
          ),
        id,
      );
      const revealReads = await reads();
      await probe.evaluate(() =>
        window.__setupObservation.visibility("visible"),
      );
      await probe.evaluate((id) => {
        window.__zerosTerminalSmoke.holdSetupRead(id);
        window.__zerosTerminalSmoke.finishSetupRead(id);
      }, id);
      await expect.poll(reads).toBe(revealReads + 1);
      expect(await output.textContent()).not.toContain("Superseded");
      await expect(output).toContainText("Latest hidden output");
      await probe.evaluate(
        (id) => window.__zerosTerminalSmoke.finishSetupRead(id),
        id,
      );
      await expect(output).toContainText("Caught up after reveal");
      expect(await reads()).toBe(revealReads + 1);
      check(
        `${placement} Setup coalesces one fresh read when reveal overlaps an old flight`,
        true,
      );

      await probe.evaluate((id) => {
        window.__zerosTerminalSmoke.holdSetupRead(id);
        window.__zerosTerminalSmoke.setupSnapshot(
          id,
          "passed",
          "Owner A held\r\n",
        );
      }, id);
      await expect
        .poll(() =>
          probe.evaluate(
            (id) => window.__zerosTerminalSmoke.pendingSetupRead(id),
            id,
          ),
        )
        .toBe(true);
      await probe.evaluate(
        (id) =>
          window.__zerosTerminalSmoke.setupSnapshot(
            id,
            "passed",
            "Owner A latest\r\n",
          ),
        id,
      );
      await probe
        .getByRole("button", { name: "Workspace B", exact: true })
        .click();
      await probe
        .getByRole("button", { name: "New File, Browser, or Terminal tab" })
        .click();
      await probe
        .getByRole("option", { name: "Terminal", exact: true })
        .click();
      await probe
        .getByRole("tablist", { name: "Terminal sessions" })
        .getByRole("tab", { name: "Setup", exact: true })
        .click();
      await expect(output).toContainText("Setup output preserved");
      const other = await probe.evaluate(
        () =>
          window.__zerosTerminalSmoke.messages
            .filter(
              (row) =>
                row.op === "workspace.setupInfo" &&
                !row.params.statusOnly &&
                !row.params.omitLog,
            )
            .at(-1).params.workspaceId,
      );
      expect(other).not.toBe(id);
      const ownerReads = await reads();
      await probe.evaluate(
        (id) => window.__zerosTerminalSmoke.finishSetupRead(id),
        id,
      );
      await expect
        .poll(() =>
          probe.evaluate(
            (id) => window.__zerosTerminalSmoke.pendingSetupRead(id),
            id,
          ),
        )
        .toBe(false);
      expect(await reads()).toBe(ownerReads);
      expect(await output.textContent()).not.toContain("Owner A");
      await probe
        .getByRole("button", { name: "Workspace A", exact: true })
        .click();
      await expect(output).toContainText("Owner A latest");
      expect(await reads()).toBe(ownerReads + 1);
      check(
        `${placement} Setup fences late invalidations through owner A to B to A`,
        true,
      );
      for (const [replacement, log] of [
        ["equal-length", "NEW RUN ONLY\r\n"],
        ["longer", "NEW RUN ONLY\r\nNEW EXTRA OUTPUT\r\n"],
      ]) {
        // A normal visible reset establishes the old run. The next run's
        // empty-buffer transition happens entirely while the window is hidden.
        await probe.evaluate(
          (id) => window.__zerosTerminalSmoke.setupSnapshot(id, "running", ""),
          id,
        );
        await expect(output).toContainText("Starting setup");
        await probe.evaluate(
          (id) =>
            window.__zerosTerminalSmoke.setupSnapshot(
              id,
              "passed",
              "OLD RUN ONLY\r\n",
            ),
          id,
        );
        await expect(output).toContainText("OLD RUN ONLY");
        await probe.evaluate(() =>
          window.__setupObservation.visibility("hidden"),
        );
        const beforeRerun = await reads();
        await probe.evaluate(
          (id) => window.__zerosTerminalSmoke.setupSnapshot(id, "running", ""),
          id,
        );
        await probe.evaluate(
          ({ id, log }) =>
            window.__zerosTerminalSmoke.setupSnapshot(id, "failed", log),
          { id, log },
        );
        expect(await reads()).toBe(beforeRerun);
        expect(
          await probe.evaluate(() => window.__setupObservation.timers()),
        ).toBe(0);
        await probe.evaluate(() =>
          window.__setupObservation.visibility("visible"),
        );
        await expect(output).toContainText("NEW RUN ONLY");
        await expect(output).not.toContainText("OLD RUN ONLY");
        if (replacement === "longer")
          await expect(output).toContainText("NEW EXTRA OUTPUT");
        await expect(output).toContainText("Setup failed");
        expect(await reads()).toBe(beforeRerun + 1);
        check(
          `${placement} Setup replaces an ${replacement} log after a hidden rerun`,
          true,
        );
      }
      expect(
        await probe.evaluate(
          () =>
            window.__zerosTerminalSmoke.messages.filter((row) =>
              ["workspace.rerunSetup", "workspace.stopSetup"].includes(row.op),
            ).length,
        ),
      ).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await probe.close();
    }
  }
}
