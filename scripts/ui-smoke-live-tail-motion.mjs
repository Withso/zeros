import { expect } from "@playwright/test";
// The live tail's motion, measured frame by frame in the real renderer
// (harness-working-groups' chain frames). Linux Chrome proof, not native
// macOS. Each transition is sampled on every animation frame: the loader
// line's on-screen position, its labels' opacity and filter, and the boxes
// that must not move (a lone call's label as it becomes a row, the group
// header taking the lone call's row).

/** Click a transition button in a chain frame and sample every frame. */
export async function sample(page, frameId, transition, ms = 1_800) {
  return page.locator(`#${frameId}`).evaluate(async (root, { transition, ms }) => {
    const button = [...root.querySelectorAll("[data-chain-controls] button")].find((node) => node.textContent === transition);
    button.click();
    const frames = [];
    const started = performance.now();
    const visible = (el) => {
      let opacity = 1;
      for (let node = el; node && node !== root; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      return opacity;
    };
    const boxOf = (el) => { const rect = el.getBoundingClientRect(); return { x: Math.round(rect.left * 10) / 10, y: Math.round(rect.top * 10) / 10 }; };
    // Read each frame as it is about to be painted: a ResizeObserver created
    // last (after the scroller's and the line's own) on a probe resized every
    // frame runs after layout and after their callbacks, before paint.
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:0;top:0;height:1px;width:1px;pointer-events:none;opacity:0";
    document.body.append(probe);
    let count = 0;
    await new Promise((resolve) => {
      const observer = new ResizeObserver(() => {
        const at = performance.now() - started;
        const line = root.querySelector('div[role="status"][aria-live="polite"]');
        const ticks = line ? [...line.querySelectorAll("[data-loader-tick]")] : [];
        const header = root.querySelector("[data-working-group]");
        const prose = root.querySelector("[data-chain-turn] .zeros-agent-md");
        const earlier = [...root.querySelectorAll("[data-chain-scroller] p")].filter((node) => !node.closest("[data-chain-turn]")).at(-1);
        // Every visible label naming a call (on the line or as a row).
        const labels = [...root.querySelectorAll("[data-chain-turn] span")]
          .filter((node) => node.children.length === 0 && /^(Read|Grep|Bash|Edit)\b/.test(node.textContent ?? ""))
          .map((node) => ({ text: node.parentElement?.textContent ?? "", ...boxOf(node), opacity: visible(node), filter: getComputedStyle(node.closest("[data-loader-tick]") ?? node).filter }));
        // How far each tail element is drawn from its layout position: its own
        // and its ancestors' transform and translate, up to the frame.
        const drawnOffset = (el) => {
          let y = 0;
          for (let node = el; node && node !== root; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.transform !== "none") y += new DOMMatrixReadOnly(style.transform).m42;
            if (style.translate !== "none") y += parseFloat(style.translate.split(" ")[1] ?? "0") || 0;
          }
          return y;
        };
        const tailElements = [line?.parentElement, ...ticks, root.querySelector("[data-working-group]"),
          root.querySelector("[data-chain-turn] .zeros-agent-md")].filter(Boolean);
        frames.push({
          at,
          offset: Math.max(0, ...tailElements.map((el) => Math.abs(drawnOffset(el)))),
          line: line ? { ...boxOf(line), glide: getComputedStyle(line.parentElement).translate, opacity: visible(line) } : null,
          ticks: ticks.map((node) => ({ text: node.textContent, state: node.dataset.loaderTick, opacity: Number(getComputedStyle(node).opacity), filter: getComputedStyle(node).filter })),
          header: header ? { ...boxOf(header), opacity: visible(header), text: header.textContent } : null,
          headers: [...root.querySelectorAll("[data-working-group]")].map((node) => ({ ...boxOf(node), opacity: visible(node), text: node.textContent })),
          rows: [...root.querySelectorAll("[data-chain-turn] .zeros-working-feed [data-list-row-disclosure], [data-chain-turn] [data-tool-row]")].map((node) => ({ ...boxOf(node), text: node.textContent.slice(0, 40) })),
          // The line's layout place in its turn (its settle transform excluded).
          lineOffset: root.querySelector("[data-live-tail-line]")?.offsetTop ?? null,
          turnHeight: root.querySelector("[data-chain-turn]")?.offsetHeight ?? null,
          // The message's first line: a fixed point in content above the line.
          message: prose ? { ...boxOf(prose), bottom: Math.round(prose.getBoundingClientRect().bottom * 10) / 10 } : null,
          earlier: earlier ? boxOf(earlier) : null,
          answer: (() => { const prose = [...root.querySelectorAll("[data-chain-turn] .zeros-agent-md")].at(-1); if (!prose) return null;
            const rect = prose.getBoundingClientRect(); return { y: Math.round(rect.top * 10) / 10, height: Math.round(rect.height * 10) / 10, revealing: prose.dataset.revealing !== undefined, clipped: !!prose.style.maxHeight }; })(),
          contentOffset: (() => { const content = root.querySelector("[data-chain-scroller] > div"); const t = content ? getComputedStyle(content).translate : "none"; return t === "none" ? 0 : parseFloat(t.split(" ")[1] ?? "0") || 0; })(),
          lineBottom: line ? Math.round(line.getBoundingClientRect().bottom * 10) / 10 : null,
          footer: root.querySelector("[data-chain-footer]") ? boxOf(root.querySelector("[data-chain-footer]")) : null,
          // Every agent message: its reveal styling, and how it is drawn.
          prose: [...root.querySelectorAll("[data-chain-turn] .zeros-agent-md")].map((node) => ({
            text: node.textContent.slice(0, 24),
            revealing: node.dataset.revealing !== undefined,
            held: node.dataset.revealHeld !== undefined,
            styled: !!node.getAttribute("style"),
            inert: node.querySelectorAll("[inert]").length,
            mask: getComputedStyle(node).maskImage,
            opacity: visible(node),
            height: Math.round(node.getBoundingClientRect().height * 10) / 10,
            inFlow: getComputedStyle(node.closest("[data-role]")).position !== "absolute",
            // Its own boxes, up to the turn (a pinned scroller's capped settle
            // of all its content is not the message's own motion).
            drawn: (() => { for (let el = node; el && el !== root && !el.matches("[data-chain-scroller] > div"); el = el.parentElement) { const style = getComputedStyle(el);
              if (style.transform !== "none" || style.translate !== "none" || style.filter !== "none") return false; } return true; })(),
          })),
          working: !!root.querySelector('[aria-label="Agent working"]'),
          // Anything in the turn (or the scroll content) still moved by motion.
          moving: [...root.querySelectorAll("[data-chain-turn], [data-chain-turn] *"), root.querySelector("[data-chain-scroller] > div")]
            .filter(Boolean).filter((node) => { const style = getComputedStyle(node); return style.transform !== "none" || style.translate !== "none" || style.filter !== "none"; }).length,
          labels,
        });
        if (at >= ms) { done = true; observer.disconnect(); resolve(); }
      });
      observer.observe(probe);
      // Resize the probe every frame until the observer has resolved the
      // sample (a time limit could stop it before the last callback).
      let done = false;
      const tick = () => {
        if (done) return;
        probe.style.width = `${1 + (++count % 2)}px`;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    probe.remove();
    return frames;
  }, { transition, ms });
}

/** The settle cap (shared/ui/motion/soft-motion.ts SOFT_SETTLE_CAP_PX). */
const SETTLE_CAP_PX = 5;

/** A move per 60Hz frame. On a loaded machine the browser can miss a frame;
 * a glide then covers two frames' distance in one sample, which is not a
 * jump. A real jump (a whole row in one frame) stays large either way. */
function perFrame(step, ms) {
  return step * Math.min(1, 16.7 / Math.max(ms, 1));
}

/** Largest single-frame move of the loader line while it is on screen. */
export function largestStep(frames, from = 600) {
  let largest = 0, at = 0;
  for (let index = 1; index < frames.length; index++) {
    if (frames[index].at < from) continue;
    const before = frames[index - 1].line, after = frames[index].line;
    // A line that re-enters somewhere else dissolves in there: not a move.
    if (!before || !after || before.opacity < 0.3 || after.opacity < 0.3) continue;
    const step = perFrame(Math.abs(after.y - before.y), frames[index].at - frames[index - 1].at);
    if (step > largest) { largest = step; at = Math.round(frames[index].at); }
  }
  return { largest: Math.round(largest * 10) / 10, at };
}

/** Largest single-frame move of a content row while it stays on screen. */
export function largestRowStep(frames, field, from = 600) {
  let largest = 0, at = 0;
  for (let index = 1; index < frames.length; index++) {
    if (frames[index].at < from) continue;
    const before = frames[index - 1][field], after = frames[index][field];
    if (!before || !after) continue;
    const step = perFrame(Math.abs(after.y - before.y), frames[index].at - frames[index - 1].at);
    if (step > largest) { largest = step; at = Math.round(frames[index].at); }
  }
  return { largest: Math.round(largest * 10) / 10, at };
}

/** Pinned frame with the content glide switched off or on. */
async function pinnedPair(page) {
  const frame = page.locator("#chain-pinned");
  const toggle = frame.getByRole("button", { name: /^Content glide: / });
  const result = {};
  for (const mode of ["off", "on"]) {
    if (!(await toggle.textContent()).endsWith(mode)) await toggle.click();
    result[mode] = {};
    for (const transition of ["2 Call to group", "4 Group to message"])
      result[mode][transition] = await sample(page, "chain-pinned", transition, transition.startsWith("4") ? 2_600 : 1_600);
  }
  return result;
}

/** Wait until the chain's line and content have carried no glide for three
 * frames in a row: the setup has settled. */
async function waitSettled(frame) {
  await frame.evaluate((root) => new Promise((resolve, reject) => {
    let still = 0;
    const started = performance.now();
    const tick = () => {
      const line = root.querySelector('div[role="status"][aria-live="polite"]');
      const content = root.querySelector("[data-chain-scroller] > div");
      const moving = (line && getComputedStyle(line.parentElement).translate !== "none") ||
        (content && getComputedStyle(content).translate !== "none");
      still = moving ? 0 : still + 1;
      if (still >= 3) resolve();
      else if (performance.now() - started > 3_000) reject(new Error("the chain did not settle"));
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

/** Reader toggles while the turn is live: an older group, the live group and
 * a tool row's details, each opened and closed. Samples every frame. */
async function sampleReaderToggles(page, frameId) {
  const frame = page.locator(`#${frameId}`);
  await frame.locator("[data-chain-controls] button", { hasText: "Live: two groups" }).click();
  await expect(frame.locator("[data-working-group]")).toHaveCount(2);
  await waitSettled(frame);
  return frame.evaluate(async (root) => {
    const headers = () => [...root.querySelectorAll("[data-working-group]")];
    const frames = [];
    let sampling = true;
    const tick = () => {
      if (!sampling) return;
      const line = root.querySelector('div[role="status"][aria-live="polite"]');
      const content = root.querySelector("[data-chain-scroller] > div");
      frames.push({
        line: line ? getComputedStyle(line.parentElement).translate : "none",
        content: content ? getComputedStyle(content).translate : "none",
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Each toggle is watched for 450ms: the window under test (any glide in
    // it fails), not a readiness guess.
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const toggles = [
      () => headers()[0]?.click(), // the older group, open
      () => root.querySelector(".zeros-working-feed [data-list-row-disclosure]")?.click(), // a tool row's details
      () => root.querySelector(".zeros-working-feed [data-list-row-disclosure]")?.click(),
      () => headers()[0]?.click(), // close it
      () => headers().at(-1)?.click(), // the live group, open
      () => headers().at(-1)?.click(), // and close
    ];
    for (const toggle of toggles) {
      toggle();
      await wait(450);
    }
    sampling = false;
    return { frames: frames.length, glides: frames.filter((frame) => frame.line !== "none" || frame.content !== "none").length };
  });
}

/** The reader opens the live group, then three calls arrive inside it. */
async function sampleOpenGroupGrowth(page, frameId) {
  const frame = page.locator(`#${frameId}`);
  await frame.locator("[data-chain-controls] button", { hasText: "Open group: three calls arrive" }).click();
  await waitSettled(frame);
  return frame.evaluate(async (root) => {
    // Open the live group only while the calls have not arrived yet (they
    // follow at 900ms+): the window is asserted open.
    const live = [...root.querySelectorAll("[data-working-group]")].at(-1);
    const before = live.getAttribute("aria-label");
    if (!/, 2 tool calls$/.test(before)) throw new Error(`the arrival window closed before the group opened: ${before}`);
    live.click();
    if (live.getAttribute("aria-expanded") !== "true") throw new Error("the live group did not open");
    const frames = [];
    const started = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const line = root.querySelector('div[role="status"][aria-live="polite"]');
        const content = root.querySelector("[data-chain-scroller] > div");
        frames.push({ line: line ? getComputedStyle(line.parentElement).translate : "none",
          content: content ? getComputedStyle(content).translate : "none" });
        if (performance.now() - started < 2_400) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const rows = root.querySelectorAll(".zeros-working-feed [data-list-row-disclosure]").length;
    return { frames: frames.length, rows, glides: frames.filter((frame) => frame.line !== "none" || frame.content !== "none").length };
  });
}

/** A call's input streams in pieces: sample the turn on every frame. */
async function sampleInputStream(page, button, ms) {
  return page.locator("#input-stream").evaluate(async (root, { button, ms }) => {
    [...root.querySelectorAll("[data-input-controls] button")].find((node) => node.textContent === button).click();
    const started = performance.now();
    const frames = [];
    await new Promise((resolve) => {
      const tick = () => {
        const header = root.querySelector("[data-working-group]");
        frames.push({
          at: performance.now() - started,
          // The caption and buttons name no placeholder; the rest is the turn.
          text: root.textContent,
          ticks: [...root.querySelectorAll("[data-loader-tick]")].map((node) => ({ state: node.dataset.loaderTick, text: node.textContent })),
          header: header?.getAttribute("aria-label")?.replace(/^Working, /, "") ?? null,
        });
        if (performance.now() - started < ms) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    return frames;
  }, { button, ms });
}

export async function measureLiveTail(page) {
  const results = {};
  for (const frameId of ["chain", "chain-unpinned", "chain-pinned"]) {
    results[frameId] = {};
    for (const transition of ["1 Timer to call", "2 Call to group", "3 Next call", "4 Group to message", "5 Lone call to message", "6 Message to call", "7 Turn ends", "8 Answer ends", "9 Answer stopped"])
      // Message transitions keep revealing after the change; sample until rest.
      results[frameId][transition] = await sample(page, frameId, transition, /^[4589]/.test(transition) ? 3_400 : 1_600);
  }
  results.pinnedGlide = await pinnedPair(page);
  results.openGroup = {};
  for (const frameId of ["chain-pinned", "chain-unpinned"]) results.openGroup[frameId] = await sampleOpenGroupGrowth(page, frameId);
  results.between = {};
  for (const frameId of ["chain", "chain-pinned", "chain-unpinned"])
    for (const transition of ["10 Between: commentary, 3 lines", "11 Between: commentary, 1 line", "12 Between: phase-less, 3 lines", "13 Between: phase-less, 1 line"])
      results.between[`${frameId} | ${transition}`] = await sample(page, frameId, transition, 3_000);
  results.input = {
    complete: await sampleInputStream(page, "Stream an edit's input", 1_800),
    never: await sampleInputStream(page, "Start a call whose input never completes", 3_200),
    edit: await sampleInputStream(page, "Stream an Edit slowly", 6_200),
    bash: await sampleInputStream(page, "Stream a Bash command slowly", 6_200),
    agent: await sampleInputStream(page, "Stream an Agent prompt slowly", 6_200),
  };
  results.toggles = {};
  for (const frameId of ["chain-pinned", "chain-unpinned"]) results.toggles[frameId] = await sampleReaderToggles(page, frameId);
  return results;
}

export async function runLiveTailMotionSmoke({ page, check }) {
  const results = await measureLiveTail(page);
  // Nothing travels: on every frame of every agent-driven transition, every
  // tail element is drawn within the settle cap of its layout position, and
  // at rest nothing is offset at all.
  for (const frameId of ["chain", "chain-unpinned", "chain-pinned"]) {
    for (const [transition, frames] of Object.entries(results[frameId])) {
      const judged = frames.filter((frame) => frame.at >= 600);
      const largest = Math.max(0, ...judged.map((frame) => frame.offset));
      const rest = judged.at(-1)?.offset ?? 0;
      check(`${frameId}: ${transition} draws nothing more than ${SETTLE_CAP_PX}px from its place, and nothing offset at rest`,
        largest <= SETTLE_CAP_PX + 0.6 && rest < 0.5, JSON.stringify({ largest: Math.round(largest * 10) / 10, rest: Math.round(rest * 10) / 10 }));
    }
  }
  // A swap reads as one dissolve: from the moment the old label starts to
  // leave until the new one has settled, the labels' opacities never sum
  // below 0.4. With the shared ease the design floor is 0.46; 0.4 leaves room
  // for frame sampling. Below that the line reads empty for a moment.
  for (const frameId of ["chain", "chain-unpinned"]) {
    // Call to group has no leaving label: the header takes the call's row.
    // Message to call moves the line itself: its new label is simply there.
    for (const transition of ["1 Timer to call", "3 Next call", "4 Group to message"]) {
      const frames = results[frameId][transition].filter((frame) => frame.at >= 600);
      const start = frames.findIndex((frame) => frame.ticks.some((tick) => tick.state === "out"));
      const settled = frames.findIndex((frame, index) => index > start &&
        !frame.ticks.some((tick) => tick.state === "out") && frame.ticks.some((tick) => tick.state === "in" && tick.opacity >= 0.95));
      const window = start < 0 ? [] : frames.slice(start, settled < 0 ? undefined : settled + 1);
      const sums = window.map((frame) => frame.ticks.reduce((sum, tick) => sum + tick.opacity, 0));
      const floor = sums.length ? Math.min(...sums) : 0;
      check(`${frameId}: ${transition} never leaves the line empty mid-swap`, sums.length > 0 && floor >= 0.4,
        JSON.stringify({ floor: Math.round(floor * 100) / 100, frames: sums.length }));
    }
  }
  // One calm change at a time: around the moment a message closes a group,
  // only the loader line's own label may be mid-fade; the header is one text
  // at full opacity; the message has no fade of its own; a line that moves
  // to a new row lands with its new label (no old label fading there).
  for (const frameId of ["chain", "chain-unpinned", "chain-pinned"]) {
    for (const transition of ["4 Group to message", "6 Message to call"]) {
      const frames = results[frameId][transition].filter((frame) => frame.at >= 600);
      const headers = frames.filter((frame) => frame.header);
      const twoTexts = headers.filter((frame) => /Working for/.test(frame.header.text) && /Worked for/.test(frame.header.text)).length;
      const dimHeader = headers.filter((frame) => frame.header.opacity < 0.999).length;
      const fadingProse = frames.filter((frame) => frame.prose.some((prose) => !prose.held && (prose.opacity < 0.999 || prose.mask !== "none"))).length;
      const leaving = transition.startsWith("6") ? frames.filter((frame) => frame.ticks.some((tick) => tick.state === "out")).length : 0;
      check(`${frameId}: ${transition} changes one thing at a time: only the loader label may dissolve`,
        frames.length > 20 && twoTexts === 0 && dimHeader === 0 && fadingProse === 0 && leaving === 0,
        JSON.stringify({ frames: frames.length, twoTexts, dimHeader, fadingProse, leaving }));
    }
    // An in-between message is absent while written, then complete in one
    // frame, with no opacity, transform, filter or mask of its own.
    const between = results[frameId]["6 Message to call"].filter((frame) => frame.at >= 300);
    const shown = between.findIndex((frame) => frame.prose[0] && !frame.prose[0].held);
    const before = shown < 0 ? [] : between.slice(0, shown);
    const after = shown < 0 ? [] : between.slice(shown);
    check(`${frameId}: an in-between message goes from absent to complete in one frame`,
      before.length > 5 && before.every((frame) => !frame.prose[0] || (frame.prose[0].held && !frame.prose[0].inFlow)) &&
        after.length > 20 && after.every((frame) => !frame.prose[0].revealing && !frame.prose[0].styled &&
          frame.prose[0].mask === "none" && frame.prose[0].opacity >= 0.999 && frame.prose[0].drawn &&
          frame.prose[0].height === after[0].prose[0].height),
      JSON.stringify({ held: before.length, shown: after.length, first: after[0]?.prose[0] }));
  }
  // No reveal styling stays on a message that is not the live tail: the
  // in-between message once the call follows it, and the earlier message
  // while the answer streams and finishes. Its last character is as opaque
  // as its first (no mask, full opacity, nothing inert).
  for (const frameId of ["chain", "chain-unpinned", "chain-pinned"]) {
    const stale = [];
    const afterCall = results[frameId]["6 Message to call"].filter((frame) => frame.at >= 300 && frame.ticks.some((tick) => /Edit/.test(tick.text)));
    for (const frame of afterCall) if (frame.prose[0] && (frame.prose[0].revealing || frame.prose[0].styled || frame.prose[0].inert || frame.prose[0].mask !== "none" || frame.prose[0].opacity < 0.999)) stale.push(Math.round(frame.at));
    for (const transition of ["8 Answer ends", "9 Answer stopped"]) for (const frame of results[frameId][transition].filter((f) => f.at >= 300)) {
      const earlier = frame.prose.slice(0, -1);
      if (frame.prose.length > 1 && earlier.some((prose) => prose.revealing || prose.styled || prose.inert || prose.mask !== "none" || prose.opacity < 0.999)) stale.push(Math.round(frame.at));
    }
    check(`${frameId}: no message that is not the live tail keeps reveal styling, and its last character is fully opaque`,
      afterCall.length > 20 && stale.length === 0, JSON.stringify({ frames: afterCall.length, stale: stale.slice(0, 5) }));
  }
  // Pinned: the scroller keeps the tail in place, so the line never moves.
  const pinned = results["chain-pinned"]["4 Group to message"].filter((frame) => frame.at >= 600);
  // Its counter-glide may run (the content above glides), but on screen it
  // holds within pixel rounding of the 24.75px lines.
  const ys = pinned.filter((frame) => frame.line).map((frame) => frame.line.y);
  check("A pinned transcript keeps the loader line still while a message streams",
    Math.max(...ys) - Math.min(...ys) <= 4,
    JSON.stringify({ spread: Math.round((Math.max(...ys) - Math.min(...ys)) * 10) / 10 }));
  // Pinned, the transcript above settles its last few px; the content is never
  // drawn further than the cap from its place (the snap before stage 6 jumped
  // a whole line; stage 6's glide travelled it).
  for (const transition of ["2 Call to group", "4 Group to message"]) {
    const frames = results.pinnedGlide.on[transition].filter((frame) => frame.at >= 600);
    const content = Math.max(0, ...frames.map((frame) => Math.abs(frame.contentOffset ?? 0)));
    check(`Pinned: ${transition} settles the content above within ${SETTLE_CAP_PX}px`,
      content <= SETTLE_CAP_PX + 0.6, JSON.stringify({ content: Math.round(content * 10) / 10 }));
  }
  // A live group the reader opened is theirs: calls arriving in it land in place.
  for (const [frameId, grown] of Object.entries(results.openGroup)) {
    check(`${frameId}: three calls arriving in a live group the reader opened glide nothing`,
      grown.frames > 60 && grown.rows >= 5 && grown.glides === 0, JSON.stringify(grown));
  }
  // The reader's own layout changes never travel.
  for (const [frameId, toggled] of Object.entries(results.toggles)) {
    check(`${frameId}: opening and closing groups and a tool row while live glides nothing`,
      toggled.frames > 60 && toggled.glides === 0, JSON.stringify(toggled));
  }
  // The turn ends: settled at once. From the first frame without the loader
  // line, nothing carries a transform, translate or filter, nothing announces
  // work, and nothing changes position afterwards.
  for (const frameId of ["chain", "chain-pinned", "chain-unpinned"]) {
    const frames = results[frameId]["7 Turn ends"].filter((frame) => frame.at >= 600);
    const end = frames.findIndex((frame) => !frame.line);
    const after = end < 0 ? [] : frames.slice(end);
    const still = (field) => after.every((frame) => !frame[field] || !after[0][field] || Math.abs(frame[field].y - after[0][field].y) < 0.5);
    check(`${frameId}: the turn ends with nothing moving`,
      after.length > 10 && after.every((frame) => frame.moving === 0 && !frame.working) && still("header") && still("message") && still("footer"),
      JSON.stringify({ frames: after.length, moving: Math.max(0, ...after.map((frame) => frame.moving)), working: after.some((frame) => frame.working) }));
  }
  // The agent finished the answer mid-reveal: from the first settled frame the
  // answer's box and the footer are final and never move, while the rest of
  // the text fades in where it already is (unclipped, revealing).
  for (const frameId of ["chain", "chain-pinned", "chain-unpinned"]) {
    const frames = results[frameId]["8 Answer ends"].filter((frame) => frame.at >= 300);
    const end = frames.findIndex((frame) => frame.footer);
    const after = end < 0 ? [] : frames.slice(end);
    const fading = after.filter((frame) => frame.answer?.revealing);
    const settledAt = after.findIndex((frame) => !frame.answer?.revealing);
    const still = (pick) => after.every((frame) => Math.abs(pick(frame) - pick(after[0])) < 0.5);
    check(`${frameId}: a natural end settles the layout at once and fades the rest in place`,
      after.length > 20 && fading.length >= 8 && fading.every((frame) => !frame.answer.clipped) && settledAt > 0 &&
        after[settledAt].at - after[0].at <= 1_000 && still((frame) => frame.answer.height) && still((frame) => frame.answer.y) &&
        still((frame) => frame.footer.y) && after.every((frame) => frame.moving === 0),
      JSON.stringify({ fadingFrames: fading.length, fadeMs: settledAt > 0 ? Math.round(after[settledAt].at - after[0].at) : null,
        heights: [...new Set(after.map((frame) => frame.answer?.height))].slice(0, 3) }));
    const stopped = results[frameId]["9 Answer stopped"].filter((frame) => frame.at >= 300);
    const stop = stopped.findIndex((frame) => frame.footer);
    const afterStop = stop < 0 ? [] : stopped.slice(stop);
    check(`${frameId}: a Stop mid-reveal shows the whole answer in one frame, nothing animating`,
      afterStop.length > 20 && afterStop.every((frame) => !frame.answer?.revealing && frame.moving === 0) &&
        afterStop.every((frame) => frame.answer.height === afterStop[0].answer.height && frame.footer.y === afterStop[0].footer.y),
      JSON.stringify({ frames: afterStop.length, revealing: afterStop.filter((frame) => frame.answer?.revealing).length }));
  }
  // Lone call → row: the label stays put and never blinks.
  const lone = results.chain["5 Lone call to message"].filter((frame) => frame.at >= 600).map((frame) => frame.labels.filter((label) => label.text.startsWith("Read")));
  const positions = lone.filter((labels) => labels.length).map((labels) => labels.sort((a, b) => b.opacity - a.opacity)[0]);
  const firstShown = lone.findIndex((labels) => labels.length);
  const blink = lone.slice(firstShown).some((labels) => !labels.length || Math.max(...labels.map((label) => label.opacity)) < 0.95);
  const drift = Math.max(...positions.map((label) => Math.hypot(label.x - positions[0].x, label.y - positions[0].y)));
  check("A lone call becomes a row in place: its label neither moves nor blinks", drift <= 1.5 && !blink,
    JSON.stringify({ drift: Math.round(drift * 10) / 10, blink }));
  // Call → group: the header takes the lone call's row.
  const toGroup = results.chain["2 Call to group"];
  const before = toGroup.find((frame) => frame.ticks.some((tick) => tick.text.includes("turn-partition.ts")));
  const after = toGroup.at(-1);
  const lineBefore = before?.line, header = after?.header;
  check("The group header appears where the lone call's label was", !!lineBefore && !!header && Math.abs(header.y - lineBefore.y) <= 2,
    JSON.stringify({ line: lineBefore?.y, header: header?.y }));
  // An in-between message appears as one calm step: from the frame before it
  // appears to 500ms after, what sits below it (the loader line's layout
  // place and the turn's height) changes exactly once, the loader label at
  // most once, and nothing is shown, hidden and shown again. A phase-less
  // message long enough to be an answer (12) reveals as output, so its last
  // line follows with the next call: it is judged on its first step.
  for (const [name, frames] of Object.entries(results.between)) {
    const appear = frames.findIndex((frame) => frame.prose[0] && !frame.prose[0].held);
    const window = appear < 1 ? [] : frames.filter((frame, index) => index >= appear - 1 && frame.at <= frames[appear].at + 500);
    const layouts = [], labels = [];
    for (const frame of window) {
      const layout = `${frame.lineOffset}|${frame.turnHeight}`;
      if (layouts.at(-1) !== layout) layouts.push(layout);
      const label = frame.ticks.filter((tick) => tick.state === "in").map((tick) => tick.text.replace(/^(\d+m )?\d+(\.\d)?s$/, "timer")).join("|");
      if (labels.at(-1) !== label) labels.push(label);
    }
    const flicker = (values) => values.some((value, index) => index > 1 && value === values[index - 2] && value !== values[index - 1]);
    const shownFlags = window.map((frame) => frame.prose[0] ? !frame.prose[0].held : false);
    const lineFlags = window.map((frame) => !!frame.line);
    const back = (flags) => flags.some((flag, index) => index > 0 && flags[index - 1] && !flag);
    const leaving = window.filter((frame) => frame.ticks.some((tick) => tick.state === "out")).length;
    const answer = name.includes("phase-less, 3 lines");
    check(answer
      ? `${name}: an answer-length message reveals, then completes with the next call, each a single step with nothing dissolving`
      : `${name}: the message appears in one calm step`,
    window.length > 20 && layouts.length === (answer ? 3 : 2) && labels.length <= (answer ? 3 : 2) && !flicker(labels) &&
      !back(shownFlags) && !back(lineFlags) && leaving === 0,
    JSON.stringify({ frames: window.length, layouts, labels, leaving }));
  }
  // A call is shown with its real description or not at all, however long
  // its input takes: while it streams the line keeps the previous call
  // briefly (2s), then its timer, then the call enters with its name and
  // description together. No frame shows a placeholder description, or a
  // call's bare name (Edit, Bash, Agent) without its description.
  const PLACEHOLDER = /Editing files?\b(?! [\w.-]+\.\w)|Running shell command|Reading file\b|Searching for files|Fetching URL|Searching web/;
  const BARE = /^(Edit|Bash|Agent|Read|Grep|Glob|Fetch|Write)$/;
  const FULL = {
    complete: /^Edit\s*event-stripe\.tsx$/, edit: /^Edit\s*event-stripe\.tsx$/,
    bash: /^Run the working-group tests\s*pnpm vitest run working-groups$/, agent: /^Agent\s*Audit the loader line$/,
  };
  for (const [name, frames] of Object.entries(results.input)) {
    const labels = [];
    for (const frame of frames.filter((f) => f.at >= 50)) {
      const label = frame.ticks.filter((tick) => tick.state === "in").map((tick) => tick.text.replace(/^(\d+m )?\d+(\.\d)?s$/, "timer")).join("|");
      if (label && labels.at(-1)?.text !== label) labels.push({ text: label, at: Math.round(frame.at) });
    }
    const placeholders = frames.filter((frame) => PLACEHOLDER.test(frame.text) || frame.ticks.some((tick) => PLACEHOLDER.test(tick.text))).length;
    const bare = frames.filter((frame) => frame.ticks.some((tick) => BARE.test(tick.text.trim()))).length;
    const headers = [...new Set(frames.filter((frame) => frame.header).map((frame) => frame.header))];
    const timerAt = labels.find((label) => label.text === "timer")?.at;
    const expected = name === "complete"
      ? labels.length === 2 && /^Grep/.test(labels[0].text) && FULL.complete.test(labels[1].text)
      : name === "never"
        ? labels.length === 2 && /^Grep/.test(labels[0].text) && labels[1].text === "timer" && timerAt >= 2_200 && timerAt <= 2_800
        : labels.length === 3 && /^Grep/.test(labels[0].text) && labels[1].text === "timer" && timerAt >= 2_200 && timerAt <= 2_800 &&
          FULL[name].test(labels[2].text) && labels[2].at >= 5_250 && labels[2].at <= 5_900;
    check(name === "complete"
      ? "A call whose input streams shows no placeholder; the line switches once, to its name and file together"
      : name === "never"
        ? "A call whose input never completes is never shown by name: after 2s the line returns to its timer"
        : `A slow ${name} call: the line keeps the previous call, then its timer, then the full label; never a bare name`,
    expected && placeholders === 0 && bare === 0 && headers.length <= 2, JSON.stringify({ labels, placeholders, bare, headers }));
  }
  // The STOPPED BY USER badge keeps the feed's 8px of air under a hovered
  // last group header or tool row (and under a message's own 8px).
  const gaps = {};
  for (const id of ["group", "row", "message"]) {
    const turn = page.locator(`[data-stopped-turn="${id}"]`);
    const target = id === "group" ? turn.locator("[data-working-group]").last()
      : id === "row" ? turn.locator("button").first() : turn.locator(".zeros-agent-md").last();
    await target.hover();
    // Hovered rows tint their background; the message has no hover state.
    if (id !== "message") await expect.poll(() => turn.evaluate((root) => [...root.querySelectorAll(":hover")]
      .some((node) => getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)"))).toBe(true);
    gaps[id] = await turn.evaluate((root, id) => {
      const badge = [...root.querySelectorAll("*")].find((node) => node.children.length === 0 && node.textContent === "STOPPED BY USER");
      const hovered = [...root.querySelectorAll(":hover")].reverse().find((node) => getComputedStyle(node).backgroundColor !== "rgba(0, 0, 0, 0)");
      const above = id === "message" ? root.querySelector(".zeros-agent-md") : hovered;
      if (!badge || !above) return null;
      return Math.round((badge.getBoundingClientRect().top - above.getBoundingClientRect().bottom) * 10) / 10;
    }, id);
  }
  await page.mouse.move(0, 0);
  check("The stopped badge keeps 8px of air under a hovered group header and tool row, 12px under a message",
    gaps.group === 8 && gaps.row === 8 && gaps.message === 12, JSON.stringify(gaps));
  return results;
}
