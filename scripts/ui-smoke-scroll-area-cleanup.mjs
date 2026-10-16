import { expect } from "@playwright/test";

const frames = (page, count = 12) => page.evaluate(async (remaining) => {
  while (remaining-- > 0) await new Promise(resolve => requestAnimationFrame(resolve));
}, count);

export async function runScrollAreaCleanupSmoke({ page, check, harnessBase }) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    // Observe only fixture viewports. A detached read is externally visible
    // work after retirement; this does not inspect or replace Radix callbacks.
    window.scrollAreaReadProbe = new Map();
    window.scrollAreaRetiredReads = new Map();
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
    Object.defineProperty(Element.prototype, "scrollTop", {
      ...descriptor,
      get() {
        const id = this.getAttribute("data-cleanup-probe");
        if (id) {
          const counts = window.scrollAreaReadProbe.get(id) ?? { connected: 0, detached: 0 };
          counts[this.isConnected ? "connected" : "detached"]++;
          window.scrollAreaReadProbe.set(id, counts);
        }
        return descriptor.get.call(this);
      },
    });
  });

  for (const horizontal of [false, true]) {
    const axis = horizontal ? "horizontal" : "vertical";
    const ready = async () => {
      await expect.poll(() => page.evaluate((direction) => {
        const viewport = window.scrollAreaCleanupFixture?.viewport();
        const thumb = window.scrollAreaCleanupFixture?.root()?.querySelector(`[data-orientation="${direction}"] > div`);
        if (!viewport || !thumb) return false;
        const rect = thumb.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (direction === "horizontal"
          ? viewport.scrollWidth > viewport.clientWidth
          : viewport.scrollHeight > viewport.clientHeight);
      }, axis)).toBe(true);
      await frames(page, 2);
    };
    const arm = (action, id) => page.evaluate(({ action, id, horizontal }) => {
      const fixture = window.scrollAreaCleanupFixture;
      const viewport = fixture.viewport();
      const originalRoot = fixture.root();
      viewport.setAttribute("data-cleanup-probe", id);
      window.scrollAreaReadProbe.set(id, { connected: 0, detached: 0 });
      const property = horizontal ? "scrollLeft" : "scrollTop";
      viewport[property] = 1_000;
      const before = window.scrollAreaReadProbe.get(id)?.connected ?? 0;
      // Dispatch and retire in one task, while the native 100ms debounce is
      // armed. An idle unmount cannot reproduce the orphaned animation loop.
      viewport.dispatchEvent(new Event("scroll"));
      const armed = (window.scrollAreaReadProbe.get(id)?.connected ?? 0) > before;
      fixture[action]();
      // Rebinding context may synchronously inspect the retiring element.
      // No animation work may read it after this retirement has returned.
      window.scrollAreaRetiredReads.set(id, window.scrollAreaReadProbe.get(id).detached);
      return { armed, detached: !viewport.isConnected, rootRetained: fixture.root() === originalRoot };
    }, { action, id, horizontal });
    const noDetachedReads = async (id, label) => {
      await frames(page);
      const counts = await page.evaluate(id => ({
        before: window.scrollAreaRetiredReads.get(id),
        after: window.scrollAreaReadProbe.get(id)?.detached,
      }), id);
      check(label, counts.after === counts.before, JSON.stringify(counts));
    };
    const scrollNewViewport = async (label) => {
      await ready();
      const thumb = page.locator(`[data-orientation="${axis}"] > div`).last();
      const before = await thumb.evaluate(element => element.style.transform);
      const viewport = page.locator("[data-radix-scroll-area-viewport]");
      await viewport.hover();
      await page.mouse.wheel(horizontal ? 400 : 0, horizontal ? 0 : 400);
      await expect.poll(() => thumb.evaluate(element => element.style.transform)).not.toBe(before);
      check(label, true);
    };

    await page.goto(`${harnessBase}/harness-scroll-area-cleanup.html?${horizontal ? "horizontal" : ""}`);
    await ready();
    const hidden = await arm("hide", "shared-first");
    check(`${axis} shared ScrollArea retires an armed scroll with its root ref`, hidden.armed && hidden.detached && !hidden.rootRetained, JSON.stringify(hidden));
    await noDetachedReads("shared-first", `${axis} shared ScrollArea cancels thumb work on unmount`);
    await page.evaluate(() => window.scrollAreaCleanupFixture.show());
    await scrollNewViewport(`${axis} remounted shared ScrollArea responds to native wheel`);
    await arm("hide", "shared-second");
    await noDetachedReads("shared-second", `${axis} remounted shared ScrollArea also cleans up`);

    await page.goto(`${harnessBase}/harness-scroll-area-cleanup.html?replaceable&${horizontal ? "horizontal" : ""}`);
    await ready();
    const replaced = await arm("replaceViewport", "replaced");
    check(`${axis} replacement preserves the root and retires the armed viewport`, replaced.armed && replaced.detached && replaced.rootRetained, JSON.stringify(replaced));
    await noDetachedReads("replaced", `${axis} surviving thumb releases the replaced viewport`);
    await scrollNewViewport(`${axis} surviving thumb observes its new viewport`);
    await arm("hide", "replacement-current");
    await noDetachedReads("replacement-current", `${axis} replacement thumb cleans up its new listener`);
  }
  check("ScrollArea cleanup harness has no uncaught errors", errors.length === 0, errors.join("; "));
}
