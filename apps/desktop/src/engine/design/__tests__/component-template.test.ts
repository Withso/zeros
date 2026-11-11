import { describe, expect, it } from "vitest";
import type { ComponentExpressionValue } from "@zeros/design-core";

import {
  COMPONENT_TEMPLATE_LIMITS,
  ComponentTemplateError,
  createComponentTemplateBudget,
  renderComponentTemplate,
  REFUSED_HOLE_ATTRIBUTES,
} from "../component-template";

const scope = new Map<string, ComponentExpressionValue>([
  ["width", 1120],
  ["attachments", 2],
  ["mode", "plan"],
  ["toolbar", true],
  ["send-label", "Send <now> & \"then\""],
]);
const render = (markup: string, ids: "part" | "copy" = "part", names = scope) =>
  renderComponentTemplate(markup, { scope: names, ids, budget: createComponentTemplateBudget() });
const refusal = (markup: string, names = scope) => {
  try {
    render(markup, "part", names);
  } catch (error) {
    expect(error).toBeInstanceOf(ComponentTemplateError);
    return (error as ComponentTemplateError).message;
  }
  throw new Error("rendered");
};

describe("a component's template", () => {
  it("fills holes in text and attributes, escaped", () => {
    expect(render('<p data-oid="p" class="mode-{{ mode }}" title="{{ send-label }}">{{ send-label }} {{ attachments + 1 }}</p>')).toBe(
      '<p data-zd-part="p" class="mode-plan" title="Send &lt;now&gt; &amp; &quot;then&quot;">Send &lt;now&gt; &amp; "then" 3</p>',
    );
  });

  it("keeps or drops an element, or a template wrapper's content, with data-zd-if", () => {
    expect(render('<div data-oid="a" data-zd-if="toolbar">On</div><div data-oid="b" data-zd-if="!toolbar">Off</div>')).toBe('<div data-zd-part="a">On</div>');
    expect(render('<template data-zd-if="attachments > 1"><i data-oid="i">many</i></template><template data-zd-if="false">x</template>')).toBe(
      '<i data-zd-part="i">many</i>',
    );
  });

  it("repeats with data-zd-for, giving each copy after the first its own part id", () => {
    expect(render('<ul data-oid="l"><li data-oid="c" data-zd-for="i in range(attachments)"><b data-oid="b">File {{ i + 1 }}</b></li></ul>')).toBe(
      '<ul data-zd-part="l"><li data-zd-part="c"><b data-zd-part="b">File 1</b></li><li data-zd-part="c#1"><b data-zd-part="b#1">File 2</b></li></ul>',
    );
    expect(render('<span data-zid="v" data-zd-for="v in [&quot;a&quot;, &quot;b&quot;]">{{ v }}</span>')).toBe(
      '<span data-zd-part="v">a</span><span data-zd-part="v#1">b</span>',
    );
  });

  it("on a main frame keeps the first copy's data-oid and marks the others as copies", () => {
    expect(render('<li data-oid="c" data-zd-for="i in range(3)">{{ i }}</li>', "copy")).toBe(
      '<li data-oid="c">0</li><li data-zd-copy="c#1">1</li><li data-zd-copy="c#2">2</li>',
    );
  });

  it("copies untouched markup byte for byte", () => {
    const markup = '<div data-oid="a" class=\'x\'   hidden><!-- {{ not a hole }} --><style>.a::before { content: "{{"; }</style>&nbsp;plain</div>';
    expect(render(markup, "copy")).toBe(markup);
  });

  it("evaluates nothing inside style, script or comments", () => {
    expect(render("<style>.a { width: {{ width }}px }</style>", "copy")).toBe("<style>.a { width: {{ width }}px }</style>");
    expect(render("<!-- {{ width }} -->", "copy")).toBe("<!-- {{ width }} -->");
  });

  it("writes a literal {{ through a text expression", () => {
    expect(render('<code data-oid="c">{{ "{{" }} width }}</code>', "copy")).toBe('<code data-oid="c">{{ width }}</code>');
  });

  it("refuses holes in attributes that load, run or carry identity", () => {
    expect(REFUSED_HOLE_ATTRIBUTES).toEqual(expect.arrayContaining([
      "style", "href", "src", "srcset", "action", "formaction", "poster", "srcdoc", "data", "xlink:href", "ping", "background",
      "cite", "manifest", "codebase", "id", "data-oid", "data-zid",
    ]));
    for (const attribute of [...REFUSED_HOLE_ATTRIBUTES, "onclick", "data-zd-part", "data-zd-anything"]) {
      const tag = attribute === "xlink:href" ? `<svg><use ${attribute}="{{ mode }}"></use></svg>` : `<div ${attribute}="{{ mode }}"></div>`;
      expect(refusal(tag), attribute).toMatch(/cannot take a hole/);
    }
    expect(refusal('<meta name="x" content="{{ mode }}">')).toMatch(/content .*cannot take a hole/);
    expect(render('<meta name="x" property="{{ mode }}">')).toBe('<meta name="x" property="plan">');
  });

  it("says what is wrong with a hole, a condition or a loop", () => {
    expect(refusal('<p>{{ width-1 }}</p>')).toMatch(/put spaces around the minus/);
    expect(refusal("<p>{{ width </p>")).toMatch(/not closed/);
    expect(refusal("<p>{{ range(2) }}</p>")).toMatch(/a list cannot fill a hole/);
    expect(refusal('<p data-zd-if="width">x</p>')).toMatch(/true or false/);
    expect(refusal('<p data-zd-for="width">x</p>')).toMatch(/name in list/);
    expect(refusal('<p data-zd-for="i in width">x</p>')).toMatch(/needs a list/);
    expect(refusal('<p data-zd-for="mode in [1]">x</p>')).toMatch(/already names/);
    expect(refusal('<p data-zd-for="constructor in [1]">x</p>')).toMatch(/reserved/);
    expect(refusal('<p data-zd-for="tostring in [1]">x</p>')).toMatch(/reserved/);
    expect(refusal('<p data-zd-for="__proto__ in [1]">x</p>')).toMatch(/lowercase letters/);
  });

  it("holds its limits", () => {
    const nested = '<a data-zd-for="a in range(2)"><b data-zd-for="b in range(2)"><i data-zd-for="c in range(2)"><s data-zd-for="d in range(2)">x</s></i></b></a>';
    expect(refusal(nested)).toMatch(/nest at most 3/);
    const wide = '<a data-zd-for="a in range(256)"><b data-zd-for="b in range(256)">x</b></a>';
    expect(refusal(wide)).toMatch(new RegExp(`${COMPONENT_TEMPLATE_LIMITS.iterations.toLocaleString("en-US")} repeats`));
    expect(refusal(`<p>${"{{ 1 }}".repeat(COMPONENT_TEMPLATE_LIMITS.holes + 1)}</p>`)).toMatch(/holes/);
    const budget = createComponentTemplateBudget();
    budget.expression.steps = 2;
    expect(() => renderComponentTemplate("<p>{{ 1 + 2 + 3 }}</p>", { scope, ids: "part", budget })).toThrow(/too many steps/);
  });
});
