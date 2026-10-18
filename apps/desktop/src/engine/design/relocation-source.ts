import { parse } from "parse5";
import postcss from "postcss";
import {
  designRelocationSchema,
  designRelocationStyles,
} from "@zeros/protocol/design-relocation";
import { validateDesignCssValue } from "@zeros/design-web";
import { elementRecords } from "./source";

export function assertDesignRelocationSource(
  source: string,
  nodeId?: string,
): void {
  const fail = (reason: string): never => {
    throw new Error(
      `This layer cannot be relocated safely: ${reason}. Keep it in its current frame or simplify that context first.`,
    );
  };
  const checkCss = (css: string, rootSizing = false, documentBox = false) => {
    const root = postcss.parse(css);
    root.walkAtRules((rule) => {
      if (
        !["layer", "property", "font-face", "charset"].includes(
          rule.name.toLowerCase(),
        )
      )
        fail(`unsupported @${rule.name} context`);
    });
    root.walkRules((rule) => {
      for (const raw of rule.selectors) {
        const selector = raw.trim();
        if (
          !/^(?:\*|:root|[a-z][a-z0-9-]*|\.[a-zA-Z_][\w-]*|#[a-zA-Z_][\w-]*|\[data-oid=(?:"[^"]+"|'[^']+')\])$/.test(
            selector,
          )
        ) {
          if (
            /^\*::(?:before|after)$/.test(selector) &&
            rule.nodes.every(
              (node) => node.type === "decl" && node.prop === "box-sizing",
            )
          )
            continue;
          fail("a contextual or structural CSS selector");
        }
      }
    });
    root.walkDecls((declaration) => {
      if (
        declaration.important ||
        declaration.prop === "all" ||
        /^(?:(?:min|max)-)?(?:inline-size|block-size)$|^(?:inset|margin|padding)-(?:inline|block)/.test(
          declaration.prop,
        )
      )
        fail("a layout override the planner cannot normalize");
      if (
        (declaration.prop.startsWith("padding") ||
          declaration.prop.startsWith("--")) &&
        declaration.value.includes("%")
      )
        fail("parent-relative spacing");
      const targetsDocument =
        documentBox ||
        (declaration.parent?.type === "rule" &&
          declaration.parent.selectors.some((selector) =>
            ["html", "body", ":root", "*"].includes(selector.trim()),
          ));
      if (
        targetsDocument &&
        /^(?:position|transform|translate|rotate|scale|zoom|margin(?:-|$)|padding(?:-|$)|border.*width|border$)/.test(
          declaration.prop,
        ) &&
        !/^(?:static|none|normal|1|0(?:px)?(?:\s+0(?:px)?)*)$/.test(
          declaration.value.trim(),
        )
      )
        fail("document-level coordinates");
      if (
        !(
          rootSizing &&
          /^(?:(?:min|max)-)?(?:width|height)$/.test(declaration.prop)
        ) &&
        /\b(?:[\d.]+)(?:vw|vh|vmin|vmax|svw|svh|lvw|lvh|dvw|dvh|cqw|cqh|cqi|cqb)\b/i.test(
          declaration.value,
        )
      )
        fail("viewport-dependent sizing");
      if (
        /^(?:animation|transition|perspective|transform-style|filter|backdrop-filter|clip-path|mask|counter|container|anchor|content|mix-blend-mode|zoom)/.test(
          declaration.prop,
        )
      ) {
        if (!["none", "normal", "0s", "1"].includes(declaration.value.trim()))
          fail(`unsupported ${declaration.prop}`);
      }
      if (
        declaration.prop === "transform" &&
        /(?:3d|perspective|rotate[XY]|translateZ|scaleZ)\(/i.test(
          declaration.value,
        )
      )
        fail("a three-dimensional transform");
      if (/\b(?:subgrid|anchor\(|anchor-size\()/.test(declaration.value))
        fail("layout tied to an ancestor");
    });
  };
  for (const { element } of elementRecords(parse(source))) {
    if (
      element.tagName === "link" &&
      element.attrs.some(
        ({ name, value }) => name === "rel" && value === "stylesheet",
      )
    )
      fail("an unresolved stylesheet");
    if (element.tagName === "style")
      checkCss(
        element.childNodes
          .map((node) => ("value" in node ? node.value : ""))
          .join(""),
      );
    const inline = element.attrs.find(({ name }) => name === "style")?.value;
    const movingRoot = element.attrs.some(
      ({ name, value }) => name === "data-oid" && value === nodeId,
    );
    if (inline)
      checkCss(
        `.inline { ${inline} }`,
        movingRoot ||
          element.attrs.some(({ name }) => name === "data-zeros-frame-root"),
        ["html", "body"].includes(element.tagName),
      );
    if (
      element.tagName.includes("-") ||
      element.attrs.some(({ name }) => name === "data-zid")
    )
      fail("a component instance");
  }
}

export function designRelocationRootStyles(
  input: unknown,
): Record<string, string> {
  const relocation = designRelocationSchema.parse(input);
  for (const [property, value] of Object.entries(relocation.inheritedStyles)) {
    validateDesignCssValue(property, value);
    if (value.toLowerCase().includes("url("))
      throw new Error("Inherited asset references cannot be relocated safely.");
  }
  return designRelocationStyles(relocation);
}
