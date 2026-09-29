import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ActivityShimmer } from "../../shared/ui/loading/activity-shimmer";
import {
  GIBBERISH_THINKING,
  GIBBERISH_THINKING_MS,
  gibberishThinking,
} from "../../shared/ui/loading/gibberish-thinking";

vi.mock("../../shared/ui/loading/zeros-spinner", () => ({
  ZerosSpinner: () => createElement("span", { "data-agent-loader": "" }),
}));

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const VOWEL = /^[aeiou]/i;
/** Nothing crude may come out of a misspelling. */
const BLOCKED = [
  "cunt", "cum", "fuck", "fuk", "shit", "sex", "dick", "cock", "puss", "tit", "anal", "anul",
  "butt", "piss", "crap", "damn", "bitch", "wank", "twat", "prick", "jizz", "semen", "nude",
  "boob", "tuch", "tush", "kunt", "knob", "thot", "slut", "whore", "porn", "rape", "fag", "nig",
  "nazi", "hell", "poop", "turd", "arse", "spunk", "dyke", "lust", "perv", "sperm", "vag",
];

describe("the gibberish thinking phrases", () => {
  it("are a hundred agent-at-work phrases of up to three words", () => {
    expect(GIBBERISH_THINKING).toHaveLength(100);
    expect(new Set(GIBBERISH_THINKING.map(([phrase]) => phrase)).size).toBe(100);
    expect(new Set(GIBBERISH_THINKING.map(([, gibberish]) => gibberish)).size).toBe(100);
    for (const [phrase] of GIBBERISH_THINKING) expect(phrase.split(" ").length).toBeLessThanOrEqual(3);
    expect(GIBBERISH_THINKING).toContainEqual(["Thinking", "Thenkeng"]);
    expect(GIBBERISH_THINKING).toContainEqual(["Working too hard", "Wurkong tuu herd"]);
    expect(GIBBERISH_THINKING).toContainEqual(["Planning", "Plunneng"]);
  });

  it("are misspelled but still read as the phrase", () => {
    for (const [phrase, gibberish] of GIBBERISH_THINKING) {
      expect(gibberish.toLowerCase(), phrase).not.toBe(phrase.toLowerCase());
      const words = phrase.split(" ");
      const garbled = gibberish.split(" ");
      expect(garbled, phrase).toHaveLength(words.length);
      words.forEach((word, i) => {
        const twisted = garbled[i];
        // Consonants carry a word, so each keeps its first one (a word that
        // starts on a vowel may swap it), and its length within two letters.
        if (VOWEL.test(word)) expect(twisted, phrase).toMatch(VOWEL);
        else expect(twisted[0].toLowerCase(), phrase).toBe(word[0].toLowerCase());
        expect(Math.abs(twisted.length - word.length), phrase).toBeLessThanOrEqual(2);
      });
      for (const word of BLOCKED) expect(gibberish.toLowerCase(), gibberish).not.toContain(word);
    }
  });

  it("change every three seconds, never repeating until all hundred have shown", () => {
    expect(GIBBERISH_THINKING_MS).toBe(3000);
    const startedAt = 1_727_000_000_000;
    // The same turn at the same moment always says the same thing.
    expect(gibberishThinking(startedAt, 7)).toBe(gibberishThinking(startedAt, 7));
    const run = Array.from({ length: 100 }, (_, step) => gibberishThinking(startedAt, step));
    expect(new Set(run).size).toBe(100);
    for (let step = 1; step < 250; step++) {
      expect(gibberishThinking(startedAt, step)).not.toBe(gibberishThinking(startedAt, step - 1));
    }
    // Other turns go round in other orders.
    const openers = new Set(Array.from({ length: 200 }, (_, i) => gibberishThinking(startedAt + i * 1_337, 0)));
    expect(openers.size).toBeGreaterThan(60);
  });
});

describe("the turn rail with gibberish thinking", () => {
  const render = (props: Parameters<typeof ActivityShimmer>[0]) =>
    renderToStaticMarkup(createElement(ActivityShimmer, props));

  it("shows no phrase unless it is turned on", () => {
    const markup = render({ startedAt: Date.now() });
    expect(markup).not.toContain("zeros-gibberish-thinking");
  });

  it("puts the turn's current phrase, shimmering, between the loader and the timer", () => {
    const startedAt = Date.now() - 37_500;
    const markup = render({ startedAt, gibberish: true });
    // 37.5s in: the thirteenth phrase, halfway through its three seconds.
    const phrase = gibberishThinking(startedAt, 12);
    const loader = markup.indexOf("data-agent-loader");
    const shown = markup.indexOf(`>${phrase}</span>`);
    const timer = markup.indexOf(">37.");
    expect(loader).toBeGreaterThan(-1);
    expect(shown).toBeGreaterThan(loader);
    expect(timer).toBeGreaterThan(shown);
    // Decorative: screen readers hear "Agent working", not nonsense.
    // 13px (text-xs here), one shimmer per phrase: the sweep's cycle is
    // locked to the phrase's three seconds.
    expect(markup).toMatch(
      new RegExp(
        `<span aria-hidden="true" class="[^"]*zeros-gibberish-thinking[^"]*\\btext-xs\\b[^"]*" style="animation-delay:-1[45]\\d\\dms">${phrase}</span>`,
      ),
    );
    expect(render({ startedAt, gibberish: true })).toContain(`>${phrase}</span>`);
  });

  it("brings the next phrase in on the shared frame loop", () => {
    const text = source("apps/desktop/src/renderer/shared/ui/loading/activity-shimmer.tsx");
    expect(text).toContain("startLoaderRun(");
    expect(text).toContain("GIBBERISH_THINKING_MS");
  });

  it("shimmers in the theme's greys, and holds still for reduced motion", () => {
    const css = source("styles/global/animations.css");
    expect(css).toMatch(/@keyframes zeros-gibberish-thinking/);
    expect(css).toMatch(/\.zeros-gibberish-thinking \{[^}]*var\(--fg3\)[^}]*var\(--fg1\)[^}]*background-clip: text;[^}]*animation: zeros-gibberish-thinking 3s linear infinite;/s);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toMatch(/\.zeros-gibberish-thinking \{\s*animation: none !important;\s*color: var\(--fg2\);\s*background: none;/);
  });
});

describe("the Gibberish agent thinking option", () => {
  it("is an Experimental switch, and the turn rail follows it", () => {
    const settings = source("apps/desktop/src/renderer/features/settings/settings-page.tsx");
    const panel = settings.slice(settings.indexOf("function ExperimentalPanel"), settings.indexOf("function InternalPanel"));
    expect(panel).toContain('useExperimentalFeature("gibberishAgentThinking")');
    expect(panel).toContain('label="Gibberish agent thinking"');
    const list = source("apps/desktop/src/renderer/features/agent/turn-event-list.tsx");
    expect(list).toContain('useExperimentalFeature("gibberishAgentThinking")');
    expect(list).toMatch(/<ActivityShimmer[\s\S]*?gibberish=\{gibberish\}/);
  });
});
