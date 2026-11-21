import { expect } from "@playwright/test";

// Render first, then reveal, block by block (renderers/use-text-reveal.ts),
// measured frame by frame on the streaming fixture's long reply. Linux Chrome
// proof, not native macOS. The scramble assertion: no word changes its box
// after it was shown. "Reveal: off" shows text as it arrives (the model
// before), which must fail the same assertion.

/** Stream the long reply and watch every frame. */
async function watch(probe, { button, reveal, stopAfter = null, ms = 4_500 }) {
  return probe.evaluate(async (root, { button, reveal, stopAfter, ms }) => {
    const toggle = [...root.querySelectorAll("button")].find((node) => /^Reveal: /.test(node.textContent));
    if ((toggle.textContent === "Reveal: on") !== reveal) toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const prose = () => root.querySelector(".zeros-agent-md");
    const texts = () => {
      const out = [];
      let total = 0;
      const walker = document.createTreeWalker(prose(), NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.data.trim()) continue;
        out.push({ node, start: total });
        total += node.data.length;
      }
      return { out, total };
    };
    /** Mask alpha at y, from the inline gradient's stops. */
    const alphaAt = (mask, y) => {
      if (!mask) return 1;
      const stops = [...mask.matchAll(/(black|transparent|color-mix\(in srgb, black ([\d.]+)%, transparent\)) (-?[\d.]+)px/g)]
        .map((match) => ({ alpha: match[1] === "black" ? 1 : match[1] === "transparent" ? 0 : Number(match[2]) / 100, at: Number(match[3]) }));
      let alpha = 1;
      for (const stop of stops) if (stop.at <= y) alpha = stop.alpha;
      return alpha;
    };
    [...root.querySelectorAll("button")].find((node) => node.textContent === button).click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const baseline = texts().total;
    const started = performance.now();
    let stoppedAt = null;
    if (stopAfter !== null)
      setTimeout(() => {
        [...root.querySelectorAll("button")].find((node) => node.textContent === "Stop the reply").click();
        stoppedAt = performance.now() - started;
      }, stopAfter);
    const seen = new Map(); // word position → its first character's box once shown
    const alphas = new Map(); // word position → its alpha each frame since shown
    const arrivals = new Map(); // position → when it was laid out
    const shownAt = new Map(); // position → when it was first above the clip
    const clips = [];
    let jumps = 0, dips = 0, linkChecks = 0, linkViolations = 0, frames = 0, revealingFrames = 0;
    const examples = [];
    const dipExamples = [];
    const stops = [];
    const range = document.createRange();
    await new Promise((resolve) => {
      const tick = () => {
        const now = performance.now() - started;
        frames++;
        const el = prose();
        const revealing = el.dataset.revealing !== undefined;
        if (revealing) revealingFrames++;
        const box = el.getBoundingClientRect();
        const clip = revealing && el.style.maxHeight ? parseFloat(el.style.maxHeight) : Infinity;
        const mask = revealing ? el.style.getPropertyValue("--reveal-mask") : "";
        if (clips.at(-1) !== clip) clips.push(clip);
        const { out, total } = texts();
        for (let at = Math.ceil(baseline / 50) * 50; at < total; at += 50) if (!arrivals.has(at)) arrivals.set(at, now);
        for (const { node, start } of out) {
          if (start + node.data.length < baseline - 20) continue;
          const re = /\S+/g;
          let match;
          while ((match = re.exec(node.data))) {
            const at = start + match.index;
            range.setStart(node, match.index); range.setEnd(node, match.index + 1);
            const rect = range.getBoundingClientRect();
            const y = rect.bottom - box.top;
            if (y > clip + 0.5) continue;
            for (const [position, time] of arrivals) if (position <= at && !shownAt.has(position) && at - position < 50) shownAt.set(position, now);
            const position = { x: rect.left - box.left, y: rect.top - box.top, word: match[0] };
            const before = seen.get(at);
            if (before && (Math.abs(before.x - position.x) > 1.5 || Math.abs(before.y - position.y) > 1.5)) {
              jumps++;
              if (examples.length < 4) examples.push({ was: before.word, now: position.word, dx: Math.round(position.x - before.x), dy: Math.round(position.y - before.y), at, y: Math.round(before.y), clip, total, t: Math.round(now) });
            }
            seen.set(at, position);
            // Each shown word's opacity only rises.
            const alpha = alphaAt(mask, (rect.top + rect.bottom) / 2 - box.top);
            const previous = alphas.get(at);
            if (previous !== undefined && alpha < previous - 0.01) {
              dips++;
              if (dipExamples.length < 3) dipExamples.push({ word: match[0], y: Math.round((rect.top + rect.bottom) / 2 - box.top), previous, alpha, clip, mask: mask.slice(0, 300) });
            }
            alphas.set(at, alpha);
          }
        }
        // Links not yet shown are not reachable.
        if (revealing) for (const link of el.querySelectorAll("a[href]")) {
          if (link.getBoundingClientRect().top - box.top < clip - 0.5) continue;
          linkChecks++;
          if (!link.inert && !link.closest("[inert]")) linkViolations++;
        }
        if (stoppedAt !== null)
          stops.push({ at: now, sinceStop: now - stoppedAt, revealing, clip: el.style.maxHeight, mask: getComputedStyle(el).maskImage, height: Math.round(box.height * 10) / 10 });
        if (now < ms) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
    const lags = [...shownAt].filter(([at]) => arrivals.get(at) > 300).map(([at, time]) => time - arrivals.get(at));
    // Lines shown in all, against the layout steps taken.
    const lineHeight = parseFloat(getComputedStyle(prose().querySelector("p") ?? prose()).lineHeight) || 24;
    const finite = clips.filter(Number.isFinite);
    const steps = finite.length - 1;
    const lines = finite.length > 1 ? Math.round((finite.at(-1) - finite[0]) / lineHeight) : 0;
    return {
      words: seen.size, jumps, examples, dips, dipExamples, linkChecks, linkViolations, stops, frames, revealingFrames, steps, lines,
      meanLagMs: lags.length ? Math.round(lags.reduce((sum, lag) => sum + lag, 0) / lags.length) : null,
      maxLagMs: lags.length ? Math.round(Math.max(...lags)) : null,
    };
  }, { button, reveal, stopAfter, ms });
}

export async function runTextRevealSmoke({ page, check }) {
  const probe = page.locator("#long-stream-probe");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // The old model laid text out as it was shown, a few characters a frame.
  const before = await watch(probe, { button: "Stream long reply in per-frame slices", reveal: false });
  const slices = await watch(probe, { button: "Stream long reply in per-frame slices", reveal: true });
  const steady = await watch(probe, { button: "Stream long reply in small deltas", reveal: true });
  const bursty = await watch(probe, { button: "Stream long reply in large deltas", reveal: true });
  check("Showing text as it arrives (the old model) moves words after they appeared",
    before.jumps > 0, JSON.stringify({ words: before.words, jumps: before.jumps, examples: before.examples }));
  check("Render first, then reveal (the same per-frame slices): no shown word ever moves",
    slices.words > 60 && slices.jumps === 0, JSON.stringify({ words: slices.words, jumps: slices.jumps, examples: slices.examples }));
  for (const [name, run] of [["steady", steady], ["bursty", bursty]]) {
    check(`Render first, then reveal (${name} deltas): no shown word ever moves`,
      run.words > 200 && run.jumps === 0, JSON.stringify({ words: run.words, jumps: run.jumps, examples: run.examples }));
    check(`Reveal (${name}): each released unit's opacity rises once, never dipping`,
      run.dips === 0 && run.revealingFrames > 50, JSON.stringify({ dips: run.dips, frames: run.revealingFrames, examples: run.dipExamples }));
    check(`Reveal (${name}): layout steps are fewer than the lines they show`,
      run.steps > 2 && run.lines > run.steps, JSON.stringify({ steps: run.steps, lines: run.lines }));
    check(`Reveal (${name}): text is shown within about 1.5s of being laid out`,
      run.meanLagMs !== null && run.meanLagMs <= 1_000 && run.maxLagMs <= 1_700,
      JSON.stringify({ meanLagMs: run.meanLagMs, maxLagMs: run.maxLagMs }));
    check(`Reveal (${name}): links not yet shown are inert`,
      run.linkChecks > 0 && run.linkViolations === 0, JSON.stringify({ checks: run.linkChecks, violations: run.linkViolations }));
  }
  // Stop mid-reveal: the very next frame shows everything; nothing moves after.
  const stopped = await watch(probe, { button: "Stream long reply in small deltas", reveal: true, stopAfter: 1_400, ms: 2_200 });
  const after = stopped.stops.filter((frame) => frame.sinceStop > 0);
  check("Stop shows the whole message in the next frame, with nothing revealing or moving afterwards",
    after.length > 5 && after.every((frame) => !frame.revealing && !frame.clip && frame.mask === "none" && frame.height === after[0].height),
    JSON.stringify({ frames: after.length, first: after[0] }));
  // Reduced motion: text as it arrives, never revealed.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reduced = await watch(probe, { button: "Stream long reply in small deltas", reveal: true, ms: 1_200 });
  check("Reduced motion shows text as it arrives", reduced.revealingFrames === 0 && reduced.linkChecks === 0,
    JSON.stringify({ revealingFrames: reduced.revealingFrames }));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  // Leave the probe settled: its reply would otherwise keep streaming for
  // seconds after this smoke, growing the page under whatever runs next.
  await probe.getByRole("button", { name: "Stop the reply", exact: true }).click();
  await expect(probe).toHaveAttribute("data-streaming", "");
  await expect(probe.locator(".zeros-agent-md[data-revealing]")).toHaveCount(0);
  return { before, slices, steady, bursty, stopped };
}
