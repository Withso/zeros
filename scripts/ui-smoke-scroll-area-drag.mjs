import { expect } from "@playwright/test";

const frames = (page, count = 3) => page.evaluate(async remaining => {
  while (remaining-- > 0) await new Promise(resolve => requestAnimationFrame(resolve));
}, count);

export async function runScrollAreaDragSmoke({ page, check, harnessBase }) {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    // Count actual releases without substituting pointer or style behavior.
    window.scrollAreaCaptureReleases = [];
    const original = Element.prototype.releasePointerCapture;
    Element.prototype.releasePointerCapture = function (pointerId) {
      if (this.closest("[data-orientation]")) window.scrollAreaCaptureReleases.push(pointerId);
      return original.call(this, pointerId);
    };
  });

  for (const horizontal of [false, true]) {
    const axis = horizontal ? "horizontal" : "vertical";
    const selector = `[data-drag-target-root] [data-orientation="${axis}"] > div`;
    const position = () => page.evaluate(horizontal => {
      const viewport = window.scrollAreaDragFixture.viewport();
      return viewport ? viewport[horizontal ? "scrollLeft" : "scrollTop"] : null;
    }, horizontal);
    const ready = async () => {
      await expect.poll(() => page.locator(selector).last().boundingBox()).not.toBeNull();
      await frames(page);
    };
    const start = async () => {
      await ready();
      const box = await page.locator(selector).last().boundingBox();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      const destination = { x: x + (horizontal ? 90 : 0), y: y + (horizontal ? 0 : 90) };
      await page.mouse.move(destination.x, destination.y, { steps: 3 });
      return destination;
    };

    // A callback ref can detach/reattach during a healthy parent render. The
    // ordinary branch retains ARCH212's probe; the native branch also changes
    // the caller's forwarded ref while keeping every DOM node in place.
    for (const callerRef of [false, true]) {
      const params = new URLSearchParams();
      if (horizontal) params.set("horizontal", "");
      if (callerRef) { params.set("replaceable", ""); params.set("consumer-ref", ""); }
      const kind = callerRef ? "caller ref reassignment" : "ordinary parent rerender";
      await page.goto(`${harnessBase}/harness-scroll-area-drag.html?${params}`);
      await ready();
      await page.evaluate(() => { document.body.style.webkitUserSelect = "text"; });
      const destination = await start();
      const during = await page.evaluate(({ selector, horizontal }) => {
        const fixture = window.scrollAreaDragFixture;
        const thumb = document.querySelector(selector), viewport = fixture.viewport();
        window.scrollAreaRerenderNodes = { thumb, bar: thumb.parentElement, viewport, root: fixture.root(), pointerId: fixture.pointer() };
        return { captured: thumb.hasPointerCapture(fixture.pointer()), selection: document.body.style.webkitUserSelect,
          behavior: viewport.style.scrollBehavior, position: viewport[horizontal ? "scrollLeft" : "scrollTop"] };
      }, { selector, horizontal });
      check(`${axis} ${kind}: physical drag is active before rerender`, during.captured && during.selection === "none" && during.behavior === "auto" && during.position > 0, JSON.stringify(during));
      await page.evaluate(() => window.scrollAreaDragFixture.replaceThumb());
      const after = await page.evaluate(({ selector, horizontal }) => {
        const fixture = window.scrollAreaDragFixture, old = window.scrollAreaRerenderNodes;
        const thumb = document.querySelector(selector);
        const refs = fixture.thumbRefEvents();
        return { sameRoot: old.root === fixture.root(), sameViewport: old.viewport === fixture.viewport(),
          sameBar: old.bar === thumb.parentElement, sameThumb: old.thumb === thumb,
          connected: [old.root, old.viewport, old.bar, old.thumb].every(node => node.isConnected),
          captured: thumb.hasPointerCapture(old.pointerId), selection: document.body.style.webkitUserSelect,
          behavior: old.viewport.style.scrollBehavior, position: old.viewport[horizontal ? "scrollLeft" : "scrollTop"],
          forwardedDetach: refs.some(event => event.revision === 0 && event.node === null),
          forwardedAttach: refs.at(-1)?.revision === 1 && refs.at(-1)?.node === thumb,
          releases: window.scrollAreaCaptureReleases.length };
      }, { selector, horizontal });
      check(`${axis} ${kind}: root, viewport, bar and thumb keep their connected DOM identity`, after.sameRoot && after.sameViewport && after.sameBar && after.sameThumb && after.connected, JSON.stringify(after));
      if (callerRef) check(`${axis} ${kind}: old and new forwarded refs receive their real detach and attach`, after.forwardedDetach && after.forwardedAttach, JSON.stringify(after));
      check(`${axis} ${kind}: ref reassignment preserves capture and temporary styles`, after.captured && after.selection === "none" && after.behavior === "auto" && after.releases === 0, JSON.stringify(after));
      await page.mouse.move(destination.x + (horizontal ? 70 : 0), destination.y + (horizontal ? 0 : 70), { steps: 3 });
      const moved = await position();
      check(`${axis} ${kind}: the same physical gesture continues scrolling`, moved > after.position, JSON.stringify({ before: after.position, after: moved }));
      await page.mouse.up();
      const ended = await page.evaluate(() => {
        const fixture = window.scrollAreaDragFixture, old = window.scrollAreaRerenderNodes;
        return { captured: old.thumb.hasPointerCapture(old.pointerId), selection: document.body.style.webkitUserSelect,
          behavior: old.viewport.style.scrollBehavior, ups: fixture.pointerUps(), releases: window.scrollAreaCaptureReleases.length };
      });
      check(`${axis} ${kind}: physical up retires the surviving drag once`, !ended.captured && ended.selection === "text" && ended.behavior === "smooth" && ended.ups === 1 && ended.releases === 1, JSON.stringify(ended));
    }

    for (const ending of ["pointerup", "pointercancel", "lostpointercapture", "unmount", "replace", "shrink", "replace-thumb", "remove-thumb"]) {
      const params = new URLSearchParams();
      if (horizontal) params.set("horizontal", "");
      if (ending === "replace" || ending === "replace-thumb" || ending === "remove-thumb") params.set("replaceable", "");
      if (ending === "replace-thumb" || ending === "remove-thumb") params.set("replaceable-thumb", "");
      await page.goto(`${harnessBase}/harness-scroll-area-drag.html?${params}`);
      await ready();
      await page.evaluate(() => { document.body.style.webkitUserSelect = "text"; });
      const destination = await start();
      const during = await page.evaluate(selector => {
        const fixture = window.scrollAreaDragFixture;
        const thumb = document.querySelector(selector);
        window.scrollAreaRetiringNodes = { thumb, bar: thumb.parentElement, viewport: fixture.viewport(), root: fixture.root() };
        return { selection: document.body.style.webkitUserSelect, behavior: fixture.viewport().style.scrollBehavior, captured: thumb.hasPointerCapture(fixture.pointer()) };
      }, selector);
      check(`${axis} ${ending}: real thumb drag owns capture and temporary styles`, during.captured && during.selection === "none" && during.behavior === "auto", JSON.stringify(during));

      if (ending === "pointerup") await page.mouse.up();
      else await page.evaluate(({ ending, selector }) => {
        const fixture = window.scrollAreaDragFixture;
        const thumb = document.querySelector(selector);
        if (ending === "pointercancel") thumb.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: fixture.pointer(), pointerType: "mouse" }));
        if (ending === "lostpointercapture") thumb.releasePointerCapture(fixture.pointer());
        if (ending === "unmount") fixture.hide();
        if (ending === "replace") fixture.replaceViewport();
        if (ending === "replace-thumb") fixture.replaceThumb();
        if (ending === "remove-thumb") fixture.hideThumb();
        if (ending === "shrink") fixture.shrink();
      }, { ending, selector });
      if (ending === "remove-thumb") {
        const removed = await page.evaluate(() => {
          const fixture = window.scrollAreaDragFixture, old = window.scrollAreaRetiringNodes;
          return { removed: !old.thumb.isConnected, sameRoot: old.root === fixture.root(),
            sameViewport: old.viewport === fixture.viewport(), sameBar: old.bar.isConnected,
            selection: document.body.style.webkitUserSelect, behavior: old.viewport.style.scrollBehavior };
        });
        check(`${axis} remove-thumb: removal alone retires before later pointer events`, removed.removed && removed.sameRoot && removed.sameViewport && removed.sameBar && removed.selection === "text" && removed.behavior === "smooth", JSON.stringify(removed));
      }
      // A real subsequent pointer event flushes pending lost-capture dispatch.
      await page.mouse.move(destination.x, destination.y);
      await frames(page);
      const after = await page.evaluate(({ ending, selector }) => {
        const fixture = window.scrollAreaDragFixture;
        const old = ending === "unmount" || ending === "replace" ? fixture.retiredViewport() : fixture.viewport();
        const thumb = document.querySelector(selector);
        return { selection: document.body.style.webkitUserSelect, behavior: old?.style.scrollBehavior, captured: thumb?.hasPointerCapture(fixture.pointer()) ?? false, ups: fixture.pointerUps(), releases: window.scrollAreaCaptureReleases.length };
      }, { ending, selector });
      check(`${axis} ${ending}: restores exact pre-drag styles`, after.selection === "text" && after.behavior === "smooth", JSON.stringify(after));
      check(`${axis} ${ending}: retires capture once without a synthetic pointerup`, !after.captured && after.ups === (ending === "pointerup" ? 1 : 0) && after.releases <= 1, JSON.stringify(after));
      const beforeMove = await position();
      await page.mouse.move(destination.x + (horizontal ? 70 : 0), destination.y + (horizontal ? 0 : 70), { steps: 3 });
      await frames(page);
      check(`${axis} ${ending}: later movement cannot scroll the retired drag`, await position() === beforeMove);
      await page.mouse.up();

      if (ending === "unmount" || ending === "shrink" || ending === "remove-thumb") await page.evaluate(() => window.scrollAreaDragFixture.show());
      await ready();
      await page.evaluate(() => window.scrollAreaDragFixture.viewport().scrollTo({ top: 0, left: 0, behavior: "instant" }));
      await frames(page);
      await start();
      check(`${axis} ${ending}: a fresh thumb drag still scrolls`, (await position()) > 0);
      await page.mouse.up();
      await page.locator("[data-radix-scroll-area-viewport]").hover();
      const beforeWheel = await position();
      await page.mouse.wheel(horizontal ? 200 : 0, horizontal ? 0 : 200);
      await expect.poll(position).not.toBe(beforeWheel);
      check(`${axis} ${ending}: native wheel still works`, true);
    }

    // Public handler composition cannot veto the retirement of a physical
    // pointer. This is a real shared ScrollBar under the native Root/Viewport.
    for (const ending of ["pointerup", "pointercancel", "lostpointercapture"]) {
      await page.goto(`${harnessBase}/harness-scroll-area-drag.html?replaceable&prevent-default&${horizontal ? "horizontal" : ""}`);
      await ready();
      await page.evaluate(() => { document.body.style.webkitUserSelect = "text"; });
      const destination = await start();
      if (ending === "pointerup") await page.mouse.up();
      else await page.evaluate(({ ending, selector }) => {
        const fixture = window.scrollAreaDragFixture;
        const thumb = document.querySelector(selector);
        if (ending === "pointercancel") thumb.dispatchEvent(new PointerEvent(ending, { bubbles: true, cancelable: true, pointerId: fixture.pointer(), pointerType: "mouse" }));
        else thumb.releasePointerCapture(fixture.pointer());
      }, { ending, selector });
      await page.mouse.move(destination.x, destination.y);
      await frames(page);
      const result = await page.evaluate(() => ({ selection: document.body.style.webkitUserSelect, behavior: window.scrollAreaDragFixture.viewport().style.scrollBehavior, ups: window.scrollAreaDragFixture.pointerUps() }));
      check(`${axis} ${ending}: composes consumer handlers while retiring`, result.selection === "text" && result.behavior === "smooth" && result.ups === (ending === "pointerup" ? 1 : 0), JSON.stringify(result));
      await page.mouse.up();
    }

    await page.goto(`${harnessBase}/harness-scroll-area-drag.html?${horizontal ? "horizontal" : ""}`);
    await ready();
    await page.evaluate(() => { document.body.style.webkitUserSelect = "text"; });
    const destination = await start();
    const beforeForeign = await position();
    await page.evaluate(({ selector, destination }) => {
      const fixture = window.scrollAreaDragFixture;
      const thumb = document.querySelector(selector);
      for (const type of ["pointermove", "pointerup", "pointercancel", "lostpointercapture"]) thumb.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: fixture.pointer() + 100, pointerType: "mouse", clientX: destination.x + 70, clientY: destination.y + 70 }));
    }, { selector, destination });
    const afterForeign = await position();
    check(`${axis}: foreign-pointer events cannot move or retire the active drag`, afterForeign === beforeForeign && await page.evaluate(() => document.body.style.webkitUserSelect === "none"));
    await page.mouse.move(destination.x + (horizontal ? 30 : 0), destination.y + (horizontal ? 0 : 30));
    check(`${axis}: original pointer retains the active drag`, (await position()) !== afterForeign);
    await page.evaluate(() => {
      const pointerId = window.scrollAreaDragFixture.pointer();
      window.scrollAreaLateCancel = new PointerEvent("pointercancel", { bubbles: true, pointerId, pointerType: "mouse" });
      window.scrollAreaLateMove = new PointerEvent("pointermove", { bubbles: true, pointerId, pointerType: "mouse", clientX: 350, clientY: 250 });
    });
    await page.mouse.up();
    await frames(page);
    await page.evaluate(() => window.scrollAreaDragFixture.viewport().scrollTo({ top: 0, left: 0, behavior: "instant" }));
    await frames(page);
    const fresh = await start();
    const beforeLate = await position();
    await page.evaluate(selector => {
      const thumb = document.querySelector(selector);
      thumb.dispatchEvent(window.scrollAreaLateMove);
      thumb.dispatchEvent(window.scrollAreaLateCancel);
      // A delayed loss notification cannot retire a newly acquired capture.
      thumb.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId: window.scrollAreaDragFixture.pointer(), pointerType: "mouse" }));
    }, selector);
    check(`${axis}: late retirement cannot finish a newer drag on the same pointer`, await position() === beforeLate && await page.evaluate(selector => document.body.style.webkitUserSelect === "none" && document.querySelector(selector).hasPointerCapture(window.scrollAreaDragFixture.pointer()), selector));
    await page.mouse.move(fresh.x + (horizontal ? 30 : 0), fresh.y + (horizontal ? 0 : 30));
    check(`${axis}: the newer drag survives late events`, (await position()) > beforeLate);
    await page.mouse.up();

    const trackClick = async () => {
      const bar = await page.locator(`[data-drag-target-root] [data-orientation="${axis}"]`).boundingBox();
      await page.mouse.click(bar.x + bar.width * (horizontal ? 0.8 : 0.5), bar.y + bar.height * (horizontal ? 0.5 : 0.8));
      await frames(page);
      return position();
    };
    await page.goto(`${harnessBase}/harness-scroll-area-drag.html?${horizontal ? "horizontal" : ""}`);
    await ready();
    const freshTrack = await trackClick();
    await page.goto(`${harnessBase}/harness-scroll-area-drag.html?${horizontal ? "horizontal" : ""}`);
    await ready();
    await start();
    await page.evaluate(selector => {
      const fixture = window.scrollAreaDragFixture;
      const thumb = document.querySelector(selector);
      thumb.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: fixture.pointer(), pointerType: "mouse" }));
      if (thumb.hasPointerCapture(fixture.pointer())) thumb.releasePointerCapture(fixture.pointer());
    }, selector);
    // End the input device outside the scrollbar. A later up on the thumb
    // would itself clear the old offset and conceal the cancellation defect.
    await page.mouse.move(250, 150);
    await page.mouse.up();
    await page.evaluate(() => window.scrollAreaDragFixture.viewport().scrollTo({ top: 0, left: 0, behavior: "instant" }));
    await frames(page);
    const afterCancelTrack = await trackClick();
    check(`${axis}: track click after cancellation matches a fresh track click`, freshTrack > 0 && afterCancelTrack === freshTrack, JSON.stringify({ freshTrack, afterCancelTrack }));
    await page.evaluate(() => { const viewport = window.scrollAreaDragFixture.viewport(); viewport.tabIndex = 0; viewport.focus(); });
    const beforeKey = await position();
    await page.keyboard.press(horizontal ? "ArrowLeft" : "PageUp");
    await expect.poll(position).not.toBe(beforeKey);
    check(`${axis}: native keyboard scrolling still works`, true);
    await page.evaluate(() => window.scrollAreaDragFixture.viewport().scrollTo({ top: 0, left: 0, behavior: "instant" }));
    await frames(page);
    const content = await page.locator("[data-drag-target-root] .select-text").boundingBox();
    await page.mouse.move(content.x + 5, content.y + 8);
    await page.mouse.down();
    await page.mouse.move(content.x + 180, content.y + 8, { steps: 8 });
    await page.mouse.up();
    check(`${axis}: content still supports native text selection`, await page.evaluate(() => (window.getSelection()?.toString().length ?? 0) > 2));
    await page.keyboard.press("Control+A");
    check(`${axis}: Select All still selects the content`, await page.evaluate(() => window.getSelection()?.toString().includes("Synthetic scrollable content")));

    await page.goto(`${harnessBase}/harness-scroll-area-drag.html?replaceable&prevent-start&${horizontal ? "horizontal" : ""}`);
    await ready();
    await page.evaluate(() => { document.body.style.webkitUserSelect = "text"; });
    await start();
    check(`${axis}: a consumer can still prevent drag admission`, await position() === 0 && await page.evaluate(selector => document.body.style.webkitUserSelect === "text" && window.scrollAreaDragFixture.viewport().style.scrollBehavior === "smooth" && !document.querySelector(selector).hasPointerCapture(window.scrollAreaDragFixture.pointer()), selector));
    await page.mouse.up();

    for (const externalChange of [false, true]) {
      await page.goto(`${harnessBase}/harness-scroll-area-drag.html?${horizontal ? "horizontal" : ""}`);
      await ready();
      await page.evaluate(() => {
        document.body.style.setProperty("-webkit-user-select", "text", "important");
        window.scrollAreaDragFixture.viewport().style.setProperty("scroll-behavior", "smooth", "important");
      });
      await start();
      if (externalChange) await page.evaluate(() => {
        document.body.style.setProperty("-webkit-user-select", "auto", "important");
        window.scrollAreaDragFixture.viewport().style.setProperty("scroll-behavior", "auto", "important");
      });
      await page.mouse.up();
      const styles = await page.evaluate(() => {
        const body = document.body.style, viewport = window.scrollAreaDragFixture.viewport().style;
        return { selection: body.getPropertyValue("-webkit-user-select"), selectionPriority: body.getPropertyPriority("-webkit-user-select"), behavior: viewport.getPropertyValue("scroll-behavior"), behaviorPriority: viewport.getPropertyPriority("scroll-behavior") };
      });
      check(`${axis}: retirement ${externalChange ? "preserves later external style ownership" : "restores original style priorities"}`, styles.selection === (externalChange ? "auto" : "text") && styles.behavior === (externalChange ? "auto" : "smooth") && styles.selectionPriority === "important" && styles.behaviorPriority === "important", JSON.stringify(styles));
    }

    await page.goto(`${harnessBase}/harness-scroll-area-drag.html?nested&${horizontal ? "horizontal" : ""}`);
    await ready();
    await page.evaluate(() => { document.body.style.webkitUserSelect = "text"; });
    await start();
    const outerDuring = await page.evaluate(() => document.querySelector("main > div > [data-radix-scroll-area-viewport]").style.scrollBehavior);
    await page.mouse.up();
    check(`${axis}: nested scrollbar leaves the outer viewport untouched`, outerDuring === "" && await page.evaluate(() => document.body.style.webkitUserSelect === "text" && window.scrollAreaDragFixture.viewport().style.scrollBehavior === "smooth"));
  }

  // Genuine concurrent touch pointers share the body and viewport style
  // leases. Retiring one axis must not restore styles still used by the other.
  await page.goto(`${harnessBase}/harness-scroll-area-drag.html?dual`);
  await expect.poll(() => page.locator('[data-orientation="horizontal"] > div').boundingBox()).not.toBeNull();
  await frames(page);
  await page.evaluate(() => { document.body.style.webkitUserSelect = "text"; });
  const vertical = await page.locator('[data-orientation="vertical"] > div').boundingBox();
  const horizontal = await page.locator('[data-orientation="horizontal"] > div').boundingBox();
  const first = { id: 1, x: vertical.x + vertical.width / 2, y: vertical.y + vertical.height / 2 };
  const second = { id: 2, x: horizontal.x + horizontal.width / 2, y: horizontal.y + horizontal.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [first, second] });
    first.y += 70; second.x += 70;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [first, second] });
    const moving = await page.evaluate(() => { const viewport = window.scrollAreaDragFixture.viewport(); return { x: viewport.scrollLeft, y: viewport.scrollTop }; });
    check("concurrent native touch drags can move both axes", moving.x > 0 && moving.y > 0, JSON.stringify(moving));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [second] });
    check("retiring one touch retains the other drag's temporary styles", await page.evaluate(() => document.body.style.webkitUserSelect === "none" && window.scrollAreaDragFixture.viewport().style.scrollBehavior === "auto"));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await frames(page);
    check("last touch cancellation restores the original shared styles", await page.evaluate(() => document.body.style.webkitUserSelect === "text" && window.scrollAreaDragFixture.viewport().style.scrollBehavior === "smooth"));
  } finally { await cdp.detach(); }
  check("ScrollArea drag harness has no uncaught errors", errors.length === 0, errors.join("; "));
}
