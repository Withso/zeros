/** A bounded static SVG replay of the already laid-out passive document.
 * No screenshot or pixel buffer is created. The caller uses a bounded preview
 * when a timeline or page-canvas paint cannot be represented faithfully.
 * No authored JavaScript is retained in the image. */
export const DESIGN_SURFACE_VECTOR_SOURCE = String.raw`function designSurfaceVector() {
  if (document.querySelector("animate,animateMotion,animateTransform,set,marquee,video,audio,canvas")) return null;
  var viewportWidth = innerWidth, viewportHeight = innerHeight;
  if (!(viewportWidth > 0 && viewportHeight > 0 && viewportWidth <= 16384 && viewportHeight <= 16384)) return null;
    var clone = document.documentElement.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    // In an SVG image the document root is SVG, not this cloned HTML element.
    // Preserve :root (including html:root and themed selectors) with an exact
    // clone-only attribute of the same selector specificity. Edit parsed rules,
    // never strings inside declarations, URLs or quoted attribute selectors.
    var rootAttribute = "data-zeros-vector-root-" + Math.random().toString(36).slice(2);
    function rootSelector(selector) {
      var result = "", quote = null;
      for (var offset = 0; offset < selector.length; offset += 1) {
        var character = selector[offset];
        if (character === "\\") { result += selector.slice(offset, offset + 2); offset += 1; continue; }
        if (quote) { result += character; if (character === quote) quote = null; continue; }
        if (character === "'" || character === '"') { quote = character; result += character; continue; }
        if (selector.slice(offset, offset + 5).toLowerCase() === ":root" && !/[a-z0-9_-]/i.test(selector[offset + 5] || "")) {
          result += "[" + rootAttribute + "]"; offset += 4;
        } else result += character;
      }
      return result;
    }
    function rewriteRootRules(rules) {
      var changed = false;
      for (var ruleIndex = 0; ruleIndex < rules.length; ruleIndex += 1) {
        var rule = rules[ruleIndex];
        if (rule.selectorText) {
          var selector = rootSelector(rule.selectorText);
          if (selector !== rule.selectorText) { rule.selectorText = selector; changed = true; }
        }
        if (rule.cssRules && rewriteRootRules(rule.cssRules)) changed = true;
      }
      return changed;
    }
    Array.from(clone.querySelectorAll("style")).forEach(function(style) {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(style.textContent);
      if (rewriteRootRules(sheet.cssRules)) {
        clone.setAttribute(rootAttribute, "");
        style.textContent = Array.from(sheet.cssRules, function(rule) { return rule.cssText; }).join("\n");
      }
    });
    // A document propagates its BODY background to its transparent root
    // canvas. Inside foreignObject, BODY instead paints only its own box.
    // Reproduce that canvas paint without adding it twice for translucent fills.
    var captureBody = document.body;
    var clonedCaptureBody = clone.querySelector("body");
    var captureRootStyle = getComputedStyle(document.documentElement);
    var captureBodyStyle = captureBody ? getComputedStyle(captureBody) : null;
    var canvasBackgroundStyle = "";
    function captureColorIsTransparent(color) {
      return color === "transparent" || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color) ||
        /\/\s*0(?:\.0+)?%?\s*\)$/.test(color);
    }
    var propagatesBody = captureBody && clonedCaptureBody && captureBodyStyle &&
      captureRootStyle.backgroundImage === "none" &&
      captureColorIsTransparent(captureRootStyle.backgroundColor) &&
      captureBodyStyle.display !== "none" &&
      captureRootStyle.contain === "none" && captureBodyStyle.contain === "none" &&
      captureRootStyle.contentVisibility === "visible" && captureBodyStyle.contentVisibility === "visible";
    var canvasImage = propagatesBody ? captureBodyStyle.backgroundImage : captureRootStyle.backgroundImage;
    if (canvasImage !== "none") {
      // A page paints beyond a short root while sizing/positioning its image
      // against that root's box. foreignObject does not share that behavior.
      // Keep the native preview for this case; never stretch the gradient to
      // make it cover the viewport and silently change the authored pixels.
      var rootBounds = document.documentElement.getBoundingClientRect();
      if (rootBounds.x !== 0 || rootBounds.y !== 0 ||
          rootBounds.width !== viewportWidth || rootBounds.height !== viewportHeight) return null;
      // Root effects do not apply to the document canvas background. Keep
      // the native preview when a gradient would need a separate effect layer.
      if (captureRootStyle.opacity !== "1" || captureRootStyle.filter !== "none" ||
          captureRootStyle.transform !== "none") return null;
    }
    if (propagatesBody && (captureBodyStyle.backgroundImage !== "none" ||
        !captureColorIsTransparent(captureBodyStyle.backgroundColor))) {
      var backgroundProperties = ["background-color", "background-image", "background-position-x", "background-position-y",
        "background-size", "background-repeat", "background-attachment", "background-origin", "background-clip", "background-blend-mode"];
      function preserveBackground(target, style) {
        backgroundProperties.forEach(function (property) {
          target.style.setProperty(property, style.getPropertyValue(property), "important");
        });
      }
      // Changing the root/BODY paint must not change descendants that
      // explicitly inherit it. Preserve immediate children and both elements'
      // pseudo colors; deeper inheritance then follows those values.
      for (var captureChildIndex = 0; captureChildIndex < captureBody.children.length; captureChildIndex += 1) {
        var clonedCaptureChild = clonedCaptureBody.children[captureChildIndex];
        if (clonedCaptureChild && clonedCaptureChild.style) {
          preserveBackground(clonedCaptureChild, getComputedStyle(captureBody.children[captureChildIndex]));
        }
      }
      var capturePseudoCss = "";
      [document.documentElement, captureBody].forEach(function (element) {
        ["::before", "::after", "::first-line", "::first-letter"].forEach(function (pseudo) {
          var pseudoStyle = getComputedStyle(element, pseudo);
          if (pseudo === "::first-line" || pseudo === "::first-letter" ||
              (pseudoStyle.content !== "none" && pseudoStyle.content !== "normal")) {
            capturePseudoCss += element.localName + pseudo + "{" + backgroundProperties.map(function (property) {
              return property + ":" + pseudoStyle.getPropertyValue(property) + "!important";
            }).join(";") + "}";
          }
        });
      });
      if (capturePseudoCss) {
        var capturePseudoStyle = document.createElement("style");
        // The first important layer outranks authored important rules, even
        // ID selectors in later layers. An anonymous layer cannot collide
        // with an authored name. This stylesheet exists only in the clone.
        capturePseudoStyle.textContent = "@layer{" + capturePseudoCss + "}";
        var captureStyleParent = clone.querySelector("head") || clone;
        captureStyleParent.insertBefore(capturePseudoStyle, captureStyleParent.firstChild);
      }
      if (canvasImage === "none") {
        canvasBackgroundStyle = "background-color:" + captureBodyStyle.backgroundColor + "!important;";
      } else preserveBackground(clone, captureBodyStyle);
      clonedCaptureBody.style.setProperty("background-color", "transparent", "important");
      clonedCaptureBody.style.setProperty("background-image", "none", "important");
    }
    if (!propagatesBody && canvasImage === "none" && !captureColorIsTransparent(captureRootStyle.backgroundColor)) {
      canvasBackgroundStyle = "background-color:" + captureRootStyle.backgroundColor + "!important;";
      // Canvas paint is outside the HTML root's layout and opacity. Preserve
      // immediate inheritance before removing that paint from the clone.
      Array.from(document.documentElement.children).forEach(function(child, childIndex) {
        var clonedChild = clone.children[childIndex];
        if (clonedChild && clonedChild.style)
          clonedChild.style.setProperty("background-color", getComputedStyle(child).backgroundColor, "important");
      });
      var rootPseudoStyle = document.createElement("style");
      rootPseudoStyle.textContent = "@layer{" + ["::before", "::after", "::first-line", "::first-letter"].map(function(pseudo) {
        return "html" + pseudo + "{background-color:" + getComputedStyle(document.documentElement, pseudo).backgroundColor + "!important}";
      }).join("") + "}";
      var rootStyleParent = clone.querySelector("head") || clone;
      rootStyleParent.insertBefore(rootPseudoStyle, rootStyleParent.firstChild);
      clone.style.setProperty("background-color", "transparent", "important");
    }

    var scripts = clone.querySelectorAll("script");
    for (var index = scripts.length - 1; index >= 0; index -= 1) {
      scripts[index].remove();
    }
    scripts = null;
    // The SVG owns the viewport. Forcing it onto the HTML root would change
    // automatic sizing, percentage heights, grid and positioned descendants.
    clone.style.setProperty("overflow", "hidden", "important");
    var serialized = new XMLSerializer().serializeToString(clone);
    clone = null;
    if (serialized.length > 1024 * 1024) return null;
    // Authored svg/foreignObject rules must never move or resize the capture's
    // own containers. Keep inherited font/color and :root rules intact: copying
    // every computed property would freeze currentColor before descendants can
    // inherit it. Inline important geometry also outranks authored CSS layers.
    var captureContainerStyle = "all:initial!important;display:block!important;position:static!important;inset:auto!important;x:0!important;y:0!important;" +
      "margin:0!important;padding:0!important;border:0!important;" +
      "transform:none!important;translate:none!important;rotate:none!important;scale:none!important;zoom:1!important;" +
      "min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;" +
      "width:" + viewportWidth + "px!important;height:" + viewportHeight + "px!important;";
    var svg =
      "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + viewportWidth +
      "\" height=\"" + viewportHeight + "\" style=\"" + captureContainerStyle + canvasBackgroundStyle + "\" viewBox=\"0 0 " + viewportWidth +
      " " + viewportHeight + "\"><foreignObject x=\"0\" y=\"0\" width=\"" + viewportWidth +
      "\" height=\"" + viewportHeight + "\" style=\"" + captureContainerStyle + "\">" + serialized +
      "</foreignObject></svg>";
  return svg.length <= 1024 * 1024 ? svg : null;
}`;
