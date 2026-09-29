import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentIcon } from "../agent-icon";
import { bundledAgentSvg } from "../agent-icons-bundled";

describe("Codex mark", () => {
  it("is the Codex app mark in its own gradient, prompt in white", () => {
    const svg = bundledAgentSvg("codex")!;
    expect(svg).toContain("<title>Codex</title>");
    expect(svg).not.toContain("OpenAI");
    for (const stop of ["#B1A7FF", "#7A9DFF", "#3941FF"]) expect(svg).toContain(stop); // check:ui ignore-line (brand colour under test)
    expect(svg).toMatch(/<ellipse[^>]*fill="white"/);
  });

  it("has a single-colour twin for monochrome surfaces, its prompt cut out", () => {
    const mono = bundledAgentSvg("codex", { monochrome: true })!;
    expect(mono).toContain("<title>Codex</title>");
    expect(mono).toContain('fill="currentColor"');
    expect(mono).not.toMatch(/Gradient|<ellipse/);
    // Other marks recolour through currentColor and need no twin.
    expect(bundledAgentSvg("claude", { monochrome: true })).toBe(bundledAgentSvg("claude"));
  });

  it("gives every rendered mark its own gradient id", () => {
    const markup = renderToStaticMarkup(
      createElement(
        Fragment,
        null,
        createElement(AgentIcon, { agentId: "codex", iconUrl: null }),
        createElement(AgentIcon, { agentId: "codex", iconUrl: null }),
      ),
    );
    const ids = [...markup.matchAll(/<linearGradient[^>]*id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(markup).toContain(`url(#${id})`);
  });

  it("renders the twin when monochrome, and other agents as before", () => {
    const mono = renderToStaticMarkup(createElement(AgentIcon, { agentId: "codex", iconUrl: null, monochrome: true }));
    expect(mono).not.toMatch(/linearGradient|<ellipse/);
    const claude = renderToStaticMarkup(createElement(AgentIcon, { agentId: "claude", iconUrl: null }));
    expect(claude).toContain('fill="#D97757"'); // check:ui ignore-line (brand colour under test)
  });
});
