import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Source-string pins for the empty-chat provenance block, in the same idiom as
// shell/__tests__/run-wave-placement.test.ts. These are all EXPLICIT founder
// directions from 2026-07-29 rather than defaults, so each one is a value
// someone would otherwise "tidy up" back to the primitive's default without
// knowing it was chosen. The renderer has no DOM test harness (vitest runs in
// the node environment), so pinning the source is how UI decisions are held.

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("chat provenance block styling", () => {
  const provenance = () => source("src/zeros/agent/chat-provenance.tsx");

  it("sets every row at 14px in the default foreground", () => {
    // text-sm is 14px app-wide (zeros-tokens.css overrides text-xs to 13px, so
    // the previous text-xs was a size DOWN, not the same size).
    expect(provenance()).toContain(
      '<div className="text-fg2 flex items-center gap-2 text-sm">',
    );
  });

  it("puts 12px between the rows", () => {
    expect(provenance()).toMatch(
      /<div className="flex flex-col gap-3 p-3">/,
    );
  });

  it("uses ONE font — no mono, and no <code> to sneak the UA's in", () => {
    // The branch and base refs were `--fg1` mono. Three short lines in three
    // treatments read as three kinds of content.
    const src = provenance();
    expect(src).not.toContain("font-mono");
    expect(src).not.toContain("text-fg1 truncate");
    // A rendered <code> element, not the word in the comment explaining why
    // there isn't one.
    expect(src).not.toMatch(/<code[\s>]/);
  });

  it("uses the bare Terminal glyph for the setup row", () => {
    const src = provenance();
    expect(src).toContain("Terminal");
    expect(src).not.toContain("SquareTerminal");
  });

  it("hovers the Configure link by colour alone", () => {
    // An underline fought the block's flatness; the pointer cursor already
    // says clickable.
    const src = provenance();
    expect(src).toContain("hover:text-fg1 cursor-pointer transition-colors");
    expect(src).not.toContain("hover:underline");
    expect(src).not.toContain("underline-offset");
  });
});

describe("workspace name chip", () => {
  it("is the blue container pair", () => {
    // --blue-bg fill with --blue-primary text. `-primary` rather than the
    // family's usual `-fg` partner is deliberate (2026-07-29 direction); both
    // clear AA on the two themes.
    const badge = source("src/zeros/ui/primitives/badge.tsx");
    expect(badge).toContain("bg-blue-bg text-blue-primary");
    // Typography lives in the variant, not at the call site (RULES.md Rule 5).
    expect(badge).toContain("text-sm font-normal");
    // The fill must not shift on hover — no single lighten/darken works in
    // both themes when the token is near-black in one and near-white in the
    // other. See the comment on the variant.
    expect(badge).toContain("hover:border-blue-primary");
    expect(badge).not.toContain("bg-bg1-highlight text-fg1");
  });

  it("matches the sentence it sits in — 14px, regular, UI font", () => {
    const topbar = source("src/shell/column2-topbar.tsx");
    expect(topbar).toContain('variant="accent"');
    expect(topbar).toContain('className="cursor-pointer"');
    expect(topbar).not.toContain("font-mono font-normal");
  });
});

describe("Settings → Git prefix pane", () => {
  const pane = () => source("src/zeros/panels/git-defaults-section.tsx");

  it("asks for a name, not a separator-carrying fragment", () => {
    // The old placeholder ("e.g. feature/ or myname-") taught the verbatim
    // semantics that the slash-join replaced.
    const src = pane();
    expect(src).toContain('placeholder="eg. name or product"');
    expect(src).not.toContain("include the separator");
  });

  it("renders the radio and the custom field off OPTIMISTIC state", () => {
    // Both must key on `selected` (pending ?? saved), never on the saved value
    // alone — that is what made a click appear to do nothing until the write
    // round trip finished.
    const src = pane();
    expect(src).toContain("const selected = pending ?? savedType;");
    expect(src).toContain("value={selected}");
    expect(src).toContain('selected === "custom"');
    expect(src).not.toContain("savedType === value");
  });

  it("yields the optimistic pick on AGREEMENT, not on any settings echo", () => {
    // Settings broadcasts are global, so clearing on "a newer tree arrived"
    // lets one click's echo clear the NEXT click's optimism and the dot jumps
    // backwards. Matching the value is inherently per-click.
    const src = pane();
    expect(src).toContain("savedType === pending");
    // …with a bounded valve, since a managed layer can outrank our write and
    // agreement then never comes.
    expect(src).toContain("OPTIMISTIC_HOLD_MS");
  });

  it("reads the GitHub login from the connected account, never a literal", () => {
    // The founder asked to confirm the handle shown in the label was their
    // real connected account rather than a hardcoded example. It is — the hook
    // does a `gh` auth read — and this keeps it that way: the pane must take
    // the login as a value and must not contain a login-shaped string of its
    // own.
    const src = pane();
    expect(src).toContain("const login = useGithubLogin();");
    expect(src).toContain("labelFor(value, login)");
    // Decoded rather than written out, the same way check-secrets.mjs stores
    // its own patterns: this repo is public, and a test that spelled the
    // maintainer's handle would be the leak it exists to prevent.
    const handle = Buffer.from("aWFtYXJ1bnJr", "base64").toString("utf8");
    expect(src).not.toMatch(new RegExp(handle, "i"));
    // The hook itself must keep asking git, not memoize a build-time constant.
    expect(source("src/zeros/panels/use-github-login.ts")).toContain(
      "await ghAuthStatus()",
    );
  });

  it("renders the login as a chip, not a parenthetical", () => {
    const src = pane();
    expect(src).toContain('badgeVariants({ variant: "neutral" })');
    // The parens were the old delimiter; the fill does that job now.
    expect(src).not.toContain("GitHub username (${login})");
  });

  it("gives that chip a fill that is not the card under it", () => {
    // --bg2, NOT the --bg1-highlight originally named: the settings card is
    // itself --bg1-highlight, so that pairing is the same colour as its own
    // background in BOTH themes and the chip disappears. This is the assertion
    // that catches a well-meaning "match the requested token" revert.
    const badge = source("src/zeros/ui/primitives/badge.tsx");
    expect(badge).toMatch(/neutral:\s*"[^"]*bg-bg2[^"]*text-fg1[^"]*"/);
    expect(badge).not.toMatch(/neutral:\s*"[^"]*bg-bg1-highlight/);
    // Same card fill, restated here so the collision is checked against the
    // real value rather than a remembered one.
    expect(source("src/zeros/settings/settings-ui.tsx")).toContain(
      '"bg-bg1-highlight divide-border1 rounded-lg px-3 [&>*]:py-3"',
    );
  });

  it("keeps the preview line to the founder's two strings", () => {
    const src = pane();
    expect(src).toContain('"New branches will have no prefix."');
    expect(src).toContain('"Enter a prefix."');
    // The clause that used to trail the custom prompt.
    expect(src).not.toContain("separated by a slash");
  });

  it("uses the shared RadioGroup primitive", () => {
    // RULES.md: "If a primitive is missing, extend /src/zeros/ui/ first."
    // Hand-rolled role="radio" buttons were also three tab stops with no arrow
    // keys, so a keyboard user tabbed past options instead of choosing.
    const src = pane();
    expect(src).toContain("RadioGroup");
    expect(src).not.toContain('role="radio"');
    expect(src).not.toContain('role="radiogroup"');
  });
});
