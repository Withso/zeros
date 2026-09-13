import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  buildScrambleGlyphs,
  DESIGN_ICONS,
  DESIGN_SCRAMBLE,
  renderGlyphRun,
  type ScrambleCell,
} from "../../components/scramble-text";

const css = readFileSync(
  new URL("../../components/hero-role.css", import.meta.url),
  "utf8",
);

describe("hero role baseline", () => {
  it("keeps revealed designers letters fixed as icons decode and the word settles", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const slots: ScrambleCell[] = [
        { kind: "icon", html: DESIGN_ICONS[0]! },
        { kind: "icon", html: DESIGN_ICONS[1]! },
        { kind: "char", ch: "A", color: "#68E098" },
        { kind: "icon", html: DESIGN_ICONS[2]! },
        { kind: "char", ch: "Z", color: "#B838F0" },
      ];
      await page.setContent(`<style>${css}</style>
        <h1 style="line-height:1.08;letter-spacing:-0.03em">
          for<span class="hero-role" style="font-family:Arial,sans-serif">
            <span class="hero-role-sizer" aria-hidden>developers</span>
            <span class="hero-role-word" aria-hidden>designers</span>
          </span>
        </h1>`);

      for (const fontSize of [40, 54, 64]) {
        const frames = [0.48, 0.6, 0.75, 0.85, 1].map((progress) =>
          renderGlyphRun(
            buildScrambleGlyphs(
              "developers",
              "designers",
              progress,
              DESIGN_SCRAMBLE,
              slots,
            ),
          ),
        );
        const measurements = await page.evaluate(
          ({ fontSize, frames }) => {
            const heading = document.querySelector("h1")!;
            const word =
              document.querySelector<HTMLElement>(".hero-role-word")!;
            heading.style.fontSize = `${fontSize}px`;
            const measure = () => {
              const text = word.querySelector(".hero-role-revealed") ?? word;
              const range = document.createRange();
              range.setStart(text.firstChild!, 0);
              range.setEnd(text.firstChild!, 1);
              return range.getBoundingClientRect().top;
            };
            word.className = "hero-role-word";
            word.textContent = "designers";
            const settled = measure();
            word.className = "hero-role-word is-scrambling scramble-developers";
            return {
              settled,
              frames: frames.map((html) => {
                word.innerHTML = html;
                return measure();
              }),
            };
          },
          { fontSize, frames },
        );

        for (const top of measurements.frames) {
          expect(
            Math.abs(top - measurements.settled),
            `font size ${fontSize}px`,
          ).toBeLessThan(0.5);
        }
      }
    } finally {
      await browser.close();
    }
  });
});
