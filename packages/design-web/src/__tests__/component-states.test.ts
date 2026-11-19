import { describe, expect, it } from "vitest";

import { designComponentStateSelector, mutateDesignComponentStateStyles, showDesignComponentState } from "../component-states";

const MAIN = `<!doctype html>
<html lang="en">
<head>
<template data-zd-options>
<zd-option name="label" type="text" label="Label" default="Save"></zd-option>
<zd-variant name="hover" zd-state="hover"></zd-variant>
<zd-variant name="pressed" zd-state="active"></zd-variant>
</template>
<style>
.btn { background: white; }
.btn:hover { background: silver; }
.btn:hover .label, .other:focus { color: navy; }
@media (min-width: 1px) { .btn:active { outline: 1px solid red; } }
@keyframes pulse { from { opacity: 1; } }
.btn::before { content: ":hover"; }
</style>
</head>
<body class="stage">
<button class="btn" data-oid="btn"><span class="label" data-oid="btn-label">Save</span></button>
</body>
</html>
`;

describe("showing a component's state variant", () => {
  it("marks its root layer and copies the rules that name the state, in their at-rules", () => {
    const shown = showDesignComponentState(MAIN, "active");
    expect(shown).toContain('<button class="btn" data-oid="btn" data-zd-shown-state="hover active">');
    const copies = /<style data-zd-shown-state>([\s\S]*?)<\/style>/.exec(shown)![1]!.split("\n");
    expect(copies).toEqual([
      '.btn[data-zd-shown-state~="hover"] { background: silver; }',
      '.btn[data-zd-shown-state~="hover"] .label, .other:focus { color: navy; }',
      '@media (min-width: 1px) { .btn[data-zd-shown-state~="active"] { outline: 1px solid red; } }',
    ]);
    // The authored style keeps every byte.
    expect(shown.replace(/<style data-zd-shown-state>[\s\S]*?<\/style>/, "").replace(' data-zd-shown-state="hover active"', "")).toBe(MAIN);
  });

  it("copies nothing for a state no rule names", () => {
    const shown = showDesignComponentState(MAIN, "disabled");
    expect(shown).not.toContain("<style data-zd-shown-state>");
    expect(shown).toContain('data-zd-shown-state="disabled"');
  });
});

describe("editing a component's state", () => {
  const edit = (source: string, nodeId: string, state: string, styles: [string, string | null][]) =>
    mutateDesignComponentStateStyles(source, "options/button.html", { nodeId, state, styles });

  it("adds the root's rule for the state to the main's style, then edits it in place", () => {
    const added = edit(MAIN, "btn", "hover", [["background", "black"]]);
    expect(added.selector).toBe(':is([data-oid="btn"], [data-zd-part="btn"]):hover');
    expect(added.source).toBe(MAIN.replace(".btn::before { content: \":hover\"; }\n",
      '.btn::before { content: ":hover"; }\n:is([data-oid="btn"], [data-zd-part="btn"]):hover { background: black !important; }\n'));
    const changed = edit(added.source, "btn", "hover", [["background", "gray"], ["color", "white"]]);
    expect(changed.source).toContain(':is([data-oid="btn"], [data-zd-part="btn"]):hover { background: gray !important; color: white !important; }');
    expect(edit(changed.source, "btn", "hover", [["background", null], ["color", null]]).source).toBe(MAIN);
  });

  it("writes a layer inside the root under the root's state", () => {
    expect(designComponentStateSelector("btn", "btn-label", "active")).toBe(':is([data-oid="btn"], [data-zd-part="btn"]):active :is([data-oid="btn-label"], [data-zd-part="btn-label"])');
    expect(edit(MAIN, "btn-label", "active", [["color", "red"]]).source).toContain(
      ':is([data-oid="btn"], [data-zd-part="btn"]):active :is([data-oid="btn-label"], [data-zd-part="btn-label"]) { color: red !important; }');
  });

  it("refuses a state the component has no variant for, or a file that is no component", () => {
    expect(() => edit(MAIN, "btn", "disabled", [["opacity", "0.5"]])).toThrow("Only a component with a disabled variant has that state; add it under Options.");
    expect(() => edit(MAIN, "btn", "visited", [["color", "red"]])).toThrow("There is no component state visited.");
    expect(() => edit("<!doctype html><html><head></head><body><div data-oid=\"a\"></div></body></html>", "a", "hover", [["color", "red"]]))
      .toThrow("Only a component with a hover variant");
    expect(() => edit(MAIN, "nope", "hover", [["color", "red"]])).toThrow("Design element nope is not in this component.");
  });

  it("adds a style to <head> when the main has none", () => {
    const bare = MAIN.replace(/<style>[\s\S]*?<\/style>\n/, "");
    expect(edit(bare, "btn", "hover", [["color", "red"]]).source).toContain(
      '</template>\n<style>\n:is([data-oid="btn"], [data-zd-part="btn"]):hover { color: red !important; }\n</style>\n</head>');
  });
});
