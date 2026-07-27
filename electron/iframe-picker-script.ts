// ──────────────────────────────────────────────────────────
// Iframe picker script — Design Mode element picker (Stage 2)
// ──────────────────────────────────────────────────────────
//
// Roadmap 03b Stage 2 of the iframe migration. This is the
// picker that replaces the old WebContentsView preload script
// (electron/preload-webview.ts, deleted in Phase 4.7). It runs
// inside the iframe's MAIN WORLD — same JS context as the page,
// so React fibers / Vue instances / styled-component class
// names are all visible directly (no main-world re-inject hop).
//
// Injection: main process calls `WebFrameMain.executeJavaScript`
// with this script. Cross-origin iframes are fine — the call is
// a privileged Electron API that bypasses the same-origin policy.
//
// Communication:
//   - parent → picker:  iframe.contentWindow.postMessage({type, ...}, "*")
//   - picker → parent:  window.parent.postMessage({type, payload}, "*")
//
// Both directions work cross-origin (postMessage is the standard
// cross-origin bridge). No ipcRenderer / Electron APIs needed at
// runtime — the picker is plain web JS once injected.
//
// Idempotency: the IIFE checks for a sentinel on `window` and
// no-ops if a previous activation is already mounted. This makes
// repeat install calls safe (e.g., the user toggles design mode
// twice).
//
// IMPORTANT: this is a STRING. Don't refactor inside via
// template-literal interpolation (`${x}`) — write plain strings
// with `+` concat. The only outer interpolation is the message
// prefix constant, which keeps the rest of the script literal.

const MSG_PREFIX = "zeros:picker:";

export const PICKER_SCRIPT = `
(function() {
  var MSG_PREFIX = ${JSON.stringify(MSG_PREFIX)};
  var SENTINEL = "__zerosPickerInstalled__";
  var PICKER_VERSION = 8;
  // Upgrade path: tear down older picker installs so fork handlers
  // stay in sync after hot reload / electron restart without
  // requiring a full page navigation.
  if (window[SENTINEL]) {
    if (window[SENTINEL].version >= PICKER_VERSION) {
      window[SENTINEL].refreshParent();
      return;
    }
    if (typeof window[SENTINEL].destroy === "function") {
      window[SENTINEL].destroy();
    }
  }

  // ── State ───────────────────────────────────────────────
  var active = false;
  // frozen: picker is on but paused after a selection has been
  // reported to the parent. Hover, scroll, click all do nothing
  // until the parent dismisses the chip (clear-selections) or
  // exits design mode (deactivate). Existing overlays stay so
  // the user can see what they picked.
  var frozen = false;
  var lastHover = null;
  var overlay = null;
  // selectedSet: O(1) membership; markedList: ordered array
  // mirroring insertion order, so the parent can ask for
  // remove-by-index. The two stay in sync: every add updates both,
  // every remove updates both. Map keeps the overlay DOM ref per
  // element for cleanup.
  var selectedSet = new Set();
  var markedList = [];
  var selectedOverlays = new Map();
  // pendingShiftPicks accumulates payloads DURING shift-hold so
  // we can flush them as a batch when Shift is released. After
  // flush this is cleared, but markedList retains the overlays.
  var pendingShiftPicks = [];
  var lastMousePos = { x: 0, y: 0 };

  // ── Overlay paint ───────────────────────────────────────
  // position:absolute in DOCUMENT coords — \`fixed\` breaks on
  // pages with transformed ancestors (Vercel / Apple). Document
  // coords + absolute keep the overlay glued to its element
  // across scroll. Same reasoning as Phase 4.6.1.
  var OVERLAY_ID = "__zeros_designmode_overlay__";
  var OVERLAY_STYLE = [
    "position:absolute",
    "pointer-events:none",
    "z-index:2147483647",
    "border:2px solid #3b82f6",
    "background:rgba(59,130,246,0.15)",
    "border-radius:2px",
    "display:none",
    "box-shadow:0 0 0 1px rgba(59,130,246,0.5)",
    "box-sizing:border-box",
    "transition:left 60ms ease-out, top 60ms ease-out, width 60ms ease-out, height 60ms ease-out"
  ].join(";");

  function ensureOverlay() {
    if (overlay && document.body && document.body.contains(overlay)) return overlay;
    if (!document.body) return null;
    var el = document.createElement("div");
    el.id = OVERLAY_ID;
    el.setAttribute("style", OVERLAY_STYLE);
    el.setAttribute("aria-hidden", "true");
    document.body.appendChild(el);
    overlay = el;
    return el;
  }

  function paintOverlay(el) {
    var box = ensureOverlay();
    if (!box) return;
    var r = el.getBoundingClientRect();
    var docLeft = r.left + window.scrollX;
    var docTop = r.top + window.scrollY;
    box.style.display = "block";
    box.style.left = docLeft + "px";
    box.style.top = docTop + "px";
    box.style.width = r.width + "px";
    box.style.height = r.height + "px";
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = "none";
    lastHover = null;
  }

  function paintSelectedOverlay(el) {
    if (!document.body) return null;
    var r = el.getBoundingClientRect();
    var docLeft = r.left + window.scrollX;
    var docTop = r.top + window.scrollY;
    var box = document.createElement("div");
    box.setAttribute("aria-hidden", "true");
    box.setAttribute("style", [
      "position:absolute",
      "pointer-events:none",
      "z-index:2147483646",
      "border:3px solid #3b82f6",
      "background:rgba(59,130,246,0.18)",
      "border-radius:2px",
      "box-shadow:0 0 0 1px rgba(59,130,246,0.6)",
      "box-sizing:border-box",
      "left:" + docLeft + "px",
      "top:" + docTop + "px",
      "width:" + r.width + "px",
      "height:" + r.height + "px"
    ].join(";"));
    document.body.appendChild(box);
    return box;
  }

  function removeSelected(el) {
    selectedSet.delete(el);
    var idx = markedList.indexOf(el);
    if (idx !== -1) markedList.splice(idx, 1);
    var ov = selectedOverlays.get(el);
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    selectedOverlays.delete(el);
    pendingShiftPicks = pendingShiftPicks.filter(function(p) {
      return p.__el !== el;
    });
  }

  function clearAllSelections() {
    selectedSet.forEach(function(el) {
      var ov = selectedOverlays.get(el);
      if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    });
    selectedSet.clear();
    markedList = [];
    selectedOverlays.clear();
    pendingShiftPicks = [];
  }

  // ── Freeze lockdown ─────────────────────────────────────
  // When chip is up, the user shouldn't be able to interact with
  // the iframe content at all — no clicks, no hover effects, no
  // scrolling. We achieve this with a fullscreen capturing overlay
  // that swallows pointer + wheel + touch events. Cheaper than
  // body{pointer-events:none} because some sites have JS that
  // mutates body style and would fight us.
  var freezeBlocker = null;
  function makeFreezeBlocker() {
    var div = document.createElement("div");
    div.setAttribute("aria-hidden", "true");
    div.setAttribute("style", [
      "position:fixed",
      "inset:0",
      "z-index:2147483645",
      "background:transparent",
      "pointer-events:auto",
      "cursor:default"
    ].join(";"));
    var swallow = function(e) {
      e.preventDefault();
      e.stopPropagation();
    };
    // wheel / touchmove need passive:false to be preventDefault-able.
    div.addEventListener("mousedown", swallow, true);
    div.addEventListener("mouseup", swallow, true);
    div.addEventListener("click", swallow, true);
    div.addEventListener("dblclick", swallow, true);
    div.addEventListener("contextmenu", swallow, true);
    div.addEventListener("wheel", swallow, { capture: true, passive: false });
    div.addEventListener("touchstart", swallow, { capture: true, passive: false });
    div.addEventListener("touchmove", swallow, { capture: true, passive: false });
    div.addEventListener("touchend", swallow, true);
    return div;
  }
  function setFrozen(next) {
    if (frozen === next) return;
    frozen = next;
    if (frozen) {
      if (!freezeBlocker && document.body) {
        freezeBlocker = makeFreezeBlocker();
        document.body.appendChild(freezeBlocker);
      }
    } else {
      if (freezeBlocker && freezeBlocker.parentNode) {
        freezeBlocker.parentNode.removeChild(freezeBlocker);
      }
      freezeBlocker = null;
    }
  }

  // ── Targeting (shadow-DOM piercing) ─────────────────────
  function targetFromEvent(e) {
    var path = e.composedPath();
    for (var i = 0; i < path.length; i++) {
      if (path[i] instanceof Element) return path[i];
    }
    return null;
  }

  // ── Component detection (main-world — no isolation hop) ──
  var REACT_SKIP = [
    /^Provider$/, /^Consumer$/, /^Context$/, /^Fragment$/,
    /^Suspense$/, /^StrictMode$/, /^Profiler$/, /^Portal$/,
    /^ForwardRef$/, /^Memo$/, /^Lazy$/,
    /^ClientPage/, /^ClientSegment/, /^ClientRoot/,
    /^InnerLayout/, /^OuterLayout/, /^RenderFromTemplate/,
    /^ScrollAndFocus/, /^RedirectBoundary/, /^NotFoundBoundary/,
    /^ErrorBoundary/, /^HotReload/, /^Router$/, /^Head$/,
    /^AppRouterAnnouncer/, /^Routes$/, /^Route$/,
    /^BrowserRouter/, /^Switch$/, /^Outlet$/,
    /^ThemeProvider/, /^StyleSheetManager/, /^HelmetProvider/,
    /^QueryClientProvider/, /^I18nextProvider/
  ];
  var SEMANTIC_TAG_MAP = {
    nav: "Navigation", header: "Header", footer: "Footer",
    main: "Main", aside: "Sidebar", article: "Article",
    section: "Section", form: "Form", dialog: "Dialog"
  };
  var ROLE_NAME_MAP = {
    banner: "Banner", navigation: "Navigation", main: "Main",
    complementary: "Sidebar", search: "Search", alert: "Alert",
    alertdialog: "AlertDialog", tablist: "TabList", tab: "Tab",
    tabpanel: "TabPanel", toolbar: "Toolbar", menu: "Menu",
    menubar: "MenuBar", menuitem: "MenuItem", listbox: "Listbox",
    option: "Option", tree: "Tree", treeitem: "TreeItem"
  };
  var CSS_MODULE_RE = /^([A-Z][a-zA-Z0-9]+)_[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9]{5,}$/;
  var STYLED_COMPONENT_RE = /^([A-Z][a-zA-Z0-9]+)-[a-zA-Z0-9]+$/;

  function reactFiberKey(el) {
    var keys = Object.keys(el);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0) {
        return k;
      }
    }
    return null;
  }

  function fiberName(fiber) {
    if (!fiber || !fiber.type) return null;
    var type = fiber.type;
    if (typeof type === "function") return type.displayName || type.name || null;
    if (typeof type === "string") return null;
    if (type.$$typeof) {
      var sym = String(type.$$typeof);
      if (sym.indexOf("forward_ref") !== -1) {
        return type.displayName || (type.render && (type.render.displayName || type.render.name)) || null;
      }
      if (sym.indexOf("memo") !== -1) {
        return type.displayName || (type.type && (type.type.displayName || type.type.name)) || null;
      }
      if (sym.indexOf("context") !== -1) {
        return type.displayName || (type._context && type._context.displayName) || null;
      }
      if (sym.indexOf("lazy") !== -1) return type.displayName || null;
    }
    return null;
  }

  // Skip names that look like minified output. Production React
  // builds rewrite function names to single chars ("K") or short
  // mangled sequences ("_u", "Hd5"). Returning these to the chat
  // is worse than no name at all — better to fall through to
  // data-attrs / aria / semantic detection, which often survive
  // minification.
  function isLikelyMinified(name) {
    // 1 char (e.g. "K", "_") or 2-char ("_u", "Hd"), always mangled.
    if (name.length <= 2) return true;
    // 3-char that's all lowercase or matches "_xx" — also likely
    // minified. Real React names are PascalCase ≥ 3 chars
    // ("Btn" is the realistic floor).
    if (name.length === 3 && /^[_$]?[a-z][a-z0-9]?$/.test(name)) return true;
    return false;
  }

  function detectReactComponent(el) {
    var key = reactFiberKey(el);
    if (!key) return null;
    var cur = el[key];
    var depth = 0;
    while (cur && depth < 15) {
      var name = fiberName(cur);
      if (name) {
        var skip = false;
        for (var i = 0; i < REACT_SKIP.length; i++) {
          if (REACT_SKIP[i].test(name)) { skip = true; break; }
        }
        // Filter minified output too — they pass REACT_SKIP but
        // are useless as labels. Walking up the fiber tree won't
        // help (whole app is minified), so this falls through to
        // detectComponentName's other strategies.
        if (!skip && !isLikelyMinified(name)) return name;
      }
      cur = cur.return || null;
      depth += 1;
    }
    return null;
  }

  function detectVueComponent(el) {
    var inst = el.__vue__ || el.__vueParentComponent;
    if (!inst) return null;
    if (inst.type) return inst.type.name || inst.type.__name || null;
    if (inst.$options) return inst.$options.name || inst.$options._componentTag || null;
    return null;
  }

  function detectDataAttr(el) {
    var attrs = ["data-component", "data-component-name", "data-testid", "data-test-id", "data-cy"];
    for (var i = 0; i < attrs.length; i++) {
      var v = el.getAttribute(attrs[i]);
      if (v) {
        return v
          .replace(/[-_](.)/g, function(_, c) { return c.toUpperCase(); })
          .replace(/^(.)/, function(_, c) { return c.toUpperCase(); });
      }
    }
    return null;
  }

  function detectCssModuleClass(el) {
    var list = Array.from(el.classList);
    for (var i = 0; i < list.length; i++) {
      var m1 = list[i].match(CSS_MODULE_RE);
      if (m1) return m1[1];
      var m2 = list[i].match(STYLED_COMPONENT_RE);
      if (m2) return m2[1];
    }
    return null;
  }

  function detectAriaLabel(el) {
    var lbl = el.getAttribute("aria-label");
    if (lbl) return lbl.trim().slice(0, 30);
    var ref = el.getAttribute("aria-labelledby");
    if (ref) {
      try {
        var t = document.getElementById(ref);
        if (t && t.textContent) return t.textContent.trim().slice(0, 30);
      } catch (e) { /* */ }
    }
    return null;
  }

  function detectRoleName(el) {
    var role = el.getAttribute("role");
    return (role && ROLE_NAME_MAP[role]) || null;
  }

  function detectComponentName(el) {
    if (!el || el.nodeType !== 1) return null;
    return (
      detectReactComponent(el) ||
      detectVueComponent(el) ||
      detectDataAttr(el) ||
      detectCssModuleClass(el) ||
      detectAriaLabel(el) ||
      detectRoleName(el) ||
      SEMANTIC_TAG_MAP[el.tagName.toLowerCase()] ||
      null
    );
  }

  // ── Selector builder ────────────────────────────────────
  function buildSelector(el) {
    var parts = [];
    var cur = el;
    var depth = 0;
    while (cur && cur !== document.body && cur !== document.documentElement && depth < 8) {
      var part = cur.tagName.toLowerCase();
      var id = cur.getAttribute("id");
      if (id) {
        try {
          part = part + "#" + CSS.escape(id);
        } catch (e) {
          part = part + '[id="' + id.replace(/"/g, '\\\\"') + '"]';
        }
        parts.unshift(part);
        break;
      }
      if (cur.classList.length > 0) {
        var cls = null;
        var classes = Array.from(cur.classList);
        for (var i = 0; i < classes.length; i++) {
          var c = classes[i];
          if (c.length > 0 && c.length < 40 &&
              !/^(hover|focus|active|disabled|js-|css-|sc-|chakra-|MuiBox|tw-)/.test(c) &&
              !/^[a-z]+-[0-9]+$/.test(c) &&
              !/^[a-z]+-\\[/.test(c)) {
            cls = c;
            break;
          }
        }
        if (cls) {
          try { part = part + "." + CSS.escape(cls); }
          catch (e) { /* skip class on escape failure */ }
        }
      }
      var parent = cur.parentNode;
      if (parent && parent !== document) {
        var sameTag = [];
        for (var j = 0; j < parent.children.length; j++) {
          if (parent.children[j].tagName === cur.tagName) sameTag.push(parent.children[j]);
        }
        if (sameTag.length > 1) {
          part = part + ":nth-of-type(" + (sameTag.indexOf(cur) + 1) + ")";
        }
      }
      parts.unshift(part);
      cur = cur.parentElement;
      depth += 1;
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }

  // ── Computed styles extraction ─────────────────────────
  var STYLE_PROPS = [
    "color","backgroundColor","fontFamily","fontSize","fontWeight",
    "lineHeight","letterSpacing","textAlign","padding","margin",
    "border","borderRadius","display","flexDirection","justifyContent",
    "alignItems","gap","width","height","position","opacity","boxShadow"
  ];
  function extractComputedStyles(el) {
    try {
      var cs = window.getComputedStyle(el);
      var out = {};
      for (var i = 0; i < STYLE_PROPS.length; i++) {
        var prop = STYLE_PROPS[i];
        var kebab = prop.replace(/[A-Z]/g, function(m) { return "-" + m.toLowerCase(); });
        var v = cs.getPropertyValue(kebab);
        if (v) out[prop] = v.trim();
      }
      return out;
    } catch (e) { return {}; }
  }

  function buildPickPayload(target, e) {
    var r = target.getBoundingClientRect();
    var hasShadowRoot = Boolean(target.shadowRoot);
    return {
      selector: buildSelector(target),
      tag: target.tagName.toLowerCase(),
      componentName: detectComponentName(target),
      rect: {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height)
      },
      click: { x: Math.round(e.clientX), y: Math.round(e.clientY) },
      styles: extractComputedStyles(target),
      devicePixelRatio: window.devicePixelRatio || 1,
      altKey: e.altKey,
      hasShadowRoot: hasShadowRoot,
      href: (typeof location !== "undefined") ? location.href : ""
    };
  }

  // ── Parent comms ─────────────────────────────────────────
  // Refreshed on each install in case the iframe was detached
  // (which severs the prior window.parent reference).
  var parentWindow = window.parent;
  function postToParent(type, data) {
    try {
      parentWindow.postMessage(Object.assign({ type: MSG_PREFIX + type }, data || {}), "*");
    } catch (e) { /* */ }
  }

  // ── Event handlers ──────────────────────────────────────
  function onMouseMove(e) {
    if (!active || frozen) return;
    lastMousePos.x = e.clientX;
    lastMousePos.y = e.clientY;
    var target = targetFromEvent(e);
    if (!target || target === lastHover) return;
    if (target === overlay) return;
    if (selectedSet.has(target)) { hideOverlay(); return; }
    lastHover = target;
    paintOverlay(target);
  }

  function onScroll() {
    if (!active || frozen) return;
    hideOverlay();
  }

  function onMouseDown(e) {
    if (!active || frozen) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    var target = targetFromEvent(e);
    if (!target) return;
    if (e.shiftKey) {
      if (selectedSet.has(target)) {
        removeSelected(target);
        hideOverlay();
        return;
      }
      var overlayEl = paintSelectedOverlay(target);
      if (!overlayEl) return;
      selectedSet.add(target);
      markedList.push(target);
      selectedOverlays.set(target, overlayEl);
      hideOverlay();
      var payload = buildPickPayload(target, e);
      // Stash the DOM ref for later remove() match — strip before posting.
      payload.__el = target;
      pendingShiftPicks.push(payload);
      return;
    }
    var single = buildPickPayload(target, e);
    // Track the picked element for fork resolution (single pick).
    clearAllSelections();
    selectedSet.add(target);
    markedList = [target];
    var pickedOverlay = paintSelectedOverlay(target);
    if (pickedOverlay) selectedOverlays.set(target, pickedOverlay);
    // Freeze the picker on plain clicks — chip is about to appear,
    // no more hover / click / scroll until parent clears or
    // deactivates. ⌥+click goes straight to the composer (no chip),
    // so the user can ⌥+click multiple times in succession — don't
    // freeze for those.
    if (!e.altKey) {
      setFrozen(true);
      hideOverlay();
    }
    postToParent("single-selected", { payload: single });
  }

  function onClick(e) {
    if (!active || frozen) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onKeyDown(e) {
    if (!active) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      deactivate();
      postToParent("exited");
    }
  }

  function flushBatch() {
    if (!active) return;
    if (pendingShiftPicks.length === 0) return;
    // Strip the __el helper before posting (DOM nodes don't
    // serialize via postMessage and the parent doesn't need them).
    var elements = pendingShiftPicks.map(function(p) {
      var clone = Object.assign({}, p);
      delete clone.__el;
      return clone;
    });
    pendingShiftPicks = [];
    // Freeze — chip is about to appear. See onMouseDown for reasoning.
    setFrozen(true);
    hideOverlay();
    postToParent("batch-selected", {
      elements: elements,
      click: { x: lastMousePos.x, y: lastMousePos.y }
    });
  }

  function onKeyUp(e) {
    if (e.key !== "Shift") return;
    flushBatch();
  }

  // ⌘+Shift+D from inside the iframe — bubble to parent so the
  // global shortcut works when focus is in the page (e.g., user
  // is reading article content). Attached unconditionally so
  // entering design mode from a cold page works.
  function onToggleRequestKey(e) {
    if (!e.shiftKey) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.code !== "KeyD") return;
    e.preventDefault();
    e.stopPropagation();
    postToParent("toggle-request");
  }

  // ── Activate / deactivate ──────────────────────────────
  function activate() {
    if (active) return;
    active = true;
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    try { document.body.style.setProperty("cursor", "crosshair", "important"); } catch (e) { /* */ }
    ensureOverlay();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    setFrozen(false);
    hideOverlay();
    clearAllSelections();
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("scroll", onScroll, true);
    try { document.body.style.removeProperty("cursor"); } catch (e) { /* */ }
  }

  // ── Variant fork snapshot (Tier 2 matched rules + Tier 3 fallback) ──
  var ZEROS_ATTR = "data-Zeros";
  var PICKER_OVERLAY_ID = "__zeros_designmode_overlay__";
  var FORK_CSS_MAX_BYTES = 524288;
  var FORK_CSS_MAX_BYTES_LOCAL = 2097152;
  var FORK_HTML_MAX_BYTES = 4194304;
  var FORK_DOM_NODE_MAX = 10000;
  var FORK_CSS_COLLECT_MAX = FORK_CSS_MAX_BYTES_LOCAL + 1;
  var FORK_MOCK_IMAGE_MAX = 200;
  var FORK_MOCK_TEXT_MAX = 500;
  var FORK_BEHAVIOR_NODE_MAX = 5000;
  var FORK_BEHAVIOR_MAX = 1000;
  var FORK_SCRIPT_MAX = 250;
  var FORK_FALLBACK_PROPS = [
    "color","background-color","font-family","font-size","font-weight",
    "line-height","letter-spacing","text-align","padding","margin",
    "border","border-radius","display","flex-direction","justify-content",
    "align-items","gap","flex","flex-wrap","flex-grow","flex-shrink","flex-basis",
    "grid-template-columns","grid-template-rows","grid-column","grid-row",
    "position","top","left","right","bottom",
    "opacity","box-shadow","background-image","background-size",
    "background-position","background-repeat","overflow","overflow-x","overflow-y",
    "object-fit","aspect-ratio","transform","filter","backdrop-filter",
    "animation","animation-name","transition","clip-path","mask",
    "text-overflow","white-space","word-break","vertical-align"
  ];
  // Never bake fixed dimensions — they lock responsive reflow when
  // the variant iframe width changes.
  var FORK_SKIP_DIMENSION_PROPS = {
    "width": true, "height": true, "min-width": true, "min-height": true,
    "max-width": true, "max-height": true
  };

  function isLocalDevPage() {
    try {
      var h = location.hostname.toLowerCase();
      var ipv4 = h.match(/^127(?:\\.\\d{1,3}){3}$/);
      var validIpv4 = false;
      if (ipv4) {
        validIpv4 = h.split(".").every(function(part) {
          return Number(part) >= 0 && Number(part) <= 255;
        });
      }
      return (
        h === "localhost" ||
        validIpv4 ||
        h === "0.0.0.0" ||
        h === "::1" ||
        h === "[::1]" ||
        h.slice(-10) === ".localhost"
      );
    } catch (e) {
      return false;
    }
  }

  function selectorBaseTargetsSubtree(selector, root, inSubtree) {
    var sel = selector.trim();
    if (!sel || sel.charAt(0) === "@") return false;
    if (/^(html|body|:root|\\*)\\b/.test(sel)) return true;
    // Strip pseudo-classes/elements for matching — keep :hover/:focus rules.
    var base = sel.replace(/::?[a-zA-Z0-9_-]+(?:\\([^)]*\\))?/g, "").trim();
    if (!base) return false;
    try {
      var hits = document.querySelectorAll(base);
      for (var i = 0; i < hits.length; i++) {
        var hit = hits[i];
        if (inSubtree[hit]) return true;
        if (root.contains(hit)) return true;
      }
    } catch (e) { /* invalid selector */ }
    return false;
  }

  function resolveForkTarget(selector, index) {
    if (typeof index === "number" && index >= 0 && index < markedList.length) {
      var fromList = markedList[index];
      if (fromList && fromList.parentNode) return fromList;
    }
    if (selector) {
      try {
        var found = document.querySelector(selector);
        if (found) return found;
      } catch (e) { /* invalid selector */ }
    }
    if (markedList.length > 0) {
      var last = markedList[markedList.length - 1];
      if (last && last.parentNode) return last;
    }
    return null;
  }

  function extractMockData(el) {
    var images = [];
    var texts = [];
    var imgs = el.querySelectorAll("img");
    for (var i = 0; i < imgs.length && images.length < FORK_MOCK_IMAGE_MAX; i++) {
      if (imgs[i].src && imgs[i].src.length <= 8192) images.push(imgs[i].src);
    }
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var node;
    while (texts.length < FORK_MOCK_TEXT_MAX && (node = walker.nextNode())) {
      var t = node.textContent ? node.textContent.trim() : "";
      if (t.length > 0) texts.push(t.slice(0, 8192));
    }
    return { images: images, texts: texts };
  }

  function sanitizeSnapshotHtml(html) {
    var wrap = document.createElement("div");
    wrap.innerHTML = html;
    var scripts = wrap.querySelectorAll("script");
    for (var i = 0; i < scripts.length; i++) scripts[i].remove();
    var all = wrap.querySelectorAll("*");
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      var attrs = Array.from(el.attributes);
      for (var k = 0; k < attrs.length; k++) {
        if (attrs[k].name.indexOf("on") === 0) el.removeAttribute(attrs[k].name);
      }
    }
    var zerosNodes = wrap.querySelectorAll("[" + ZEROS_ATTR + "]");
    for (var z = 0; z < zerosNodes.length; z++) zerosNodes[z].remove();
    var overlays = wrap.querySelectorAll("#" + PICKER_OVERLAY_ID);
    for (var o = 0; o < overlays.length; o++) overlays[o].remove();
    return wrap.innerHTML;
  }

  function absolutifyUrls(html, baseUrl) {
    var parser = new DOMParser();
    var doc = parser.parseFromString("<body>" + html + "</body>", "text/html");
    var body = doc.body;
    var media = body.querySelectorAll("img[src], video[src], source[src], audio[src], picture source[src]");
    for (var i = 0; i < media.length; i++) {
      var src = media[i].getAttribute("src");
      if (src && src.indexOf("data:") !== 0 && src.indexOf("http") !== 0) {
        try { media[i].setAttribute("src", new URL(src, baseUrl).href); } catch (e) { /* */ }
      }
    }
    var posters = body.querySelectorAll("video[poster]");
    for (var p = 0; p < posters.length; p++) {
      var poster = posters[p].getAttribute("poster");
      if (poster && poster.indexOf("data:") !== 0 && poster.indexOf("http") !== 0) {
        try { posters[p].setAttribute("poster", new URL(poster, baseUrl).href); } catch (e) { /* */ }
      }
    }
    var svgRefs = body.querySelectorAll("image[href], image[xlink\\:href], use[href], use[xlink\\:href]");
    for (var r = 0; r < svgRefs.length; r++) {
      var hrefAttr = svgRefs[r].hasAttribute("href") ? "href" : "xlink:href";
      var hrefVal = svgRefs[r].getAttribute(hrefAttr);
      if (hrefVal && hrefVal.indexOf("data:") !== 0 && hrefVal.indexOf("http") !== 0) {
        try { svgRefs[r].setAttribute(hrefAttr, new URL(hrefVal, baseUrl).href); } catch (e) { /* */ }
      }
    }
    var srcsets = body.querySelectorAll("img[srcset]");
    for (var s = 0; s < srcsets.length; s++) {
      var srcset = srcsets[s].getAttribute("srcset");
      if (!srcset) continue;
      var fixed = srcset.replace(/(\\S+)(\\s+\\S+)?/g, function(_, url, descriptor) {
        if (url.indexOf("data:") === 0 || url.indexOf("http") === 0) return _;
        try { return new URL(url, baseUrl).href + (descriptor || ""); } catch (e) { return _; }
      });
      srcsets[s].setAttribute("srcset", fixed);
    }
    var styled = body.querySelectorAll("[style]");
    for (var st = 0; st < styled.length; st++) {
      var style = styled[st].getAttribute("style") || "";
      var fixedStyle = style.replace(/url\\(["']?([^"')]+)["']?\\)/g, function(match, url) {
        if (url.indexOf("data:") === 0 || url.indexOf("http") === 0) return match;
        try { return 'url("' + new URL(url, baseUrl).href + '")'; } catch (e) { return match; }
      });
      styled[st].setAttribute("style", fixedStyle);
    }
    return body.innerHTML;
  }

  function collectSubtreeNodes(root) {
    var nodes = [root];
    var desc = root.querySelectorAll("*");
    for (var i = 0; i < desc.length; i++) nodes.push(desc[i]);
    return nodes;
  }

  function subtreeSetFromRoot(root) {
    var set = Object.create(null);
    var nodes = collectSubtreeNodes(root);
    for (var i = 0; i < nodes.length; i++) set[nodes[i]] = true;
    return set;
  }

  function selectorAffectsSubtree(selector, root, inSubtree) {
    return selectorBaseTargetsSubtree(selector, root, inSubtree);
  }

  function collectMatchedCssRules(root) {
    var inSubtree = subtreeSetFromRoot(root);
    var matched = [];
    var seen = Object.create(null);
    var fontFace = [];
    var keyframes = [];

    function pushUnique(list, text) {
      if (!text || seen[text]) return;
      seen[text] = true;
      list.push(text);
    }

    function walkRules(rules, rootEl) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        if (!rule) continue;
        if (rule.type === CSSRule.STYLE_RULE && rule.selectorText) {
          var parts = rule.selectorText.split(",");
          for (var p = 0; p < parts.length; p++) {
            if (selectorAffectsSubtree(parts[p], rootEl, inSubtree)) {
              pushUnique(matched, rule.cssText);
              break;
            }
          }
        } else if (rule.type === CSSRule.MEDIA_RULE && rule.cssRules) {
          var anyMedia = false;
          for (var j = 0; j < rule.cssRules.length; j++) {
            var mr = rule.cssRules[j];
            if (mr.type === CSSRule.STYLE_RULE && mr.selectorText) {
              var mParts = mr.selectorText.split(",");
              for (var mp = 0; mp < mParts.length; mp++) {
                if (selectorAffectsSubtree(mParts[mp], rootEl, inSubtree)) {
                  anyMedia = true;
                  break;
                }
              }
            }
            if (anyMedia) break;
          }
          // Include the full @media block so sibling rules in the
          // same breakpoint cascade correctly (Tailwind, etc.).
          if (anyMedia) {
            pushUnique(matched, rule.cssText);
          }
        } else if (rule.type === CSSRule.LAYER_RULE && rule.cssRules) {
          walkRules(rule.cssRules, rootEl);
        } else if (rule.type === CSSRule.SUPPORTS_RULE && rule.cssRules) {
          var anySupports = false;
          for (var sj = 0; sj < rule.cssRules.length; sj++) {
            var sr = rule.cssRules[sj];
            if (sr.type === CSSRule.STYLE_RULE && sr.selectorText) {
              var sParts = sr.selectorText.split(",");
              for (var sp = 0; sp < sParts.length; sp++) {
                if (selectorAffectsSubtree(sParts[sp], rootEl, inSubtree)) {
                  anySupports = true;
                  break;
                }
              }
            }
            if (anySupports) break;
          }
          if (anySupports) {
            pushUnique(matched, rule.cssText);
          } else {
            walkRules(rule.cssRules, rootEl);
          }
        } else if (rule.cssRules && rule.type === 18) {
          // CSSContainerRule — include full block when any inner rule hits.
          var anyContainer = false;
          for (var cj = 0; cj < rule.cssRules.length; cj++) {
            var cr = rule.cssRules[cj];
            if (cr.type === CSSRule.STYLE_RULE && cr.selectorText) {
              var cParts = cr.selectorText.split(",");
              for (var cp = 0; cp < cParts.length; cp++) {
                if (selectorAffectsSubtree(cParts[cp], rootEl, inSubtree)) {
                  anyContainer = true;
                  break;
                }
              }
            }
            if (anyContainer) break;
          }
          if (anyContainer) {
            pushUnique(matched, rule.cssText);
          }
        } else if (rule.type === CSSRule.FONT_FACE_RULE) {
          pushUnique(fontFace, rule.cssText);
        } else if (rule.type === CSSRule.KEYFRAMES_RULE) {
          pushUnique(keyframes, rule.cssText);
        }
      }
    }

    for (var s = 0; s < document.styleSheets.length; s++) {
      try {
        walkRules(document.styleSheets[s].cssRules, root);
      } catch (e) { /* cross-origin */ }
    }
    if (document.adoptedStyleSheets && document.adoptedStyleSheets.length > 0) {
      for (var a = 0; a < document.adoptedStyleSheets.length; a++) {
        try {
          walkRules(document.adoptedStyleSheets[a].cssRules, root);
        } catch (e) { /* */ }
      }
    }
    if (matched.length === 0) {
      var styles = document.querySelectorAll("style");
      for (var t = 0; t < styles.length; t++) {
        var text = styles[t].textContent;
        if (text && !styles[t].hasAttribute("data-Zeros-variant-css")) {
          pushUnique(matched, text);
        }
      }
    }
    return fontFace.concat(keyframes).concat(matched).join("\\n");
  }

  function collectRootThemeVariables() {
    try {
      var rootStyle = window.getComputedStyle(document.documentElement);
      var parts = [];
      var byteCount = 0;
      for (var i = 0; i < rootStyle.length && byteCount < 131072; i++) {
        var name = rootStyle[i];
        if (name.indexOf("--") === 0) {
          var val = rootStyle.getPropertyValue(name);
          if (val) {
            var declaration = name + ":" + val;
            var remaining = Math.max(0, 131072 - byteCount);
            var cappedDeclaration = declaration.slice(0, remaining);
            parts.push(cappedDeclaration);
            byteCount += cappedDeclaration.length + 1;
          }
        }
      }
      if (parts.length === 0) return "";
      return ":root{" + parts.join(";") + "}";
    } catch (e) {
      return "";
    }
  }

  function prepareResponsiveClone(cloneRoot) {
    if (!cloneRoot || !cloneRoot.style) return;
    cloneRoot.style.removeProperty("width");
    cloneRoot.style.removeProperty("height");
    cloneRoot.style.removeProperty("max-width");
    cloneRoot.style.removeProperty("min-width");
    cloneRoot.style.width = "100%";
    cloneRoot.style.maxWidth = "100%";
  }

  function wrapWithAncestorContext(el, clone) {
    var current = clone;
    var parent = el.parentElement;
    var depth = 0;
    while (parent && depth < 3 && parent !== document.body && parent !== document.documentElement) {
      var wrapper = document.createElement("div");
      try {
        var cs = window.getComputedStyle(parent);
        var parts = ["width:100%", "box-sizing:border-box"];
        if (cs.display && cs.display !== "inline") {
          parts.push("display:" + cs.display);
        }
        if (cs.display === "flex" || cs.display === "inline-flex") {
          parts.push("flex-direction:" + cs.flexDirection);
          parts.push("align-items:" + cs.alignItems);
          parts.push("justify-content:" + cs.justifyContent);
          parts.push("flex-wrap:" + cs.flexWrap);
          if (cs.gap && cs.gap !== "normal" && cs.gap !== "0px") {
            parts.push("gap:" + cs.gap);
          }
        }
        if (cs.display === "grid" || cs.display === "inline-grid") {
          parts.push("grid-template-columns:" + cs.gridTemplateColumns);
          if (cs.gap && cs.gap !== "normal" && cs.gap !== "0px") {
            parts.push("gap:" + cs.gap);
          }
        }
        wrapper.setAttribute("style", parts.join(";"));
        if (parent.className && typeof parent.className === "string") {
          wrapper.className = parent.className;
        }
      } catch (e) {
        wrapper.setAttribute("style", "width:100%");
      }
      wrapper.appendChild(current);
      current = wrapper;
      parent = parent.parentElement;
      depth++;
    }
    return current;
  }

  function prepareForkTargetAsync(el) {
    return new Promise(function(resolve) {
      try {
        el.scrollIntoView({ block: "center", inline: "nearest" });
      } catch (e) { /* */ }
      var pending = [];
      var imgs = el.querySelectorAll("img");
      for (var i = 0; i < imgs.length && i < FORK_MOCK_IMAGE_MAX; i++) {
        try { imgs[i].loading = "eager"; } catch (e) { /* */ }
        var lazySrc =
          imgs[i].getAttribute("data-src") ||
          imgs[i].getAttribute("data-lazy-src") ||
          imgs[i].getAttribute("data-original");
        if (lazySrc && !imgs[i].getAttribute("src")) {
          imgs[i].setAttribute("src", lazySrc);
        }
        if (!imgs[i].complete) {
          pending.push(new Promise(function(res) {
            imgs[i].addEventListener("load", res, { once: true });
            imgs[i].addEventListener("error", res, { once: true });
          }));
        }
      }
      var videos = el.querySelectorAll("video");
      for (var v = 0; v < videos.length && v < FORK_MOCK_IMAGE_MAX; v++) {
        try {
          videos[v].preload = "auto";
          var playPromise = videos[v].play();
          if (playPromise && playPromise.then) {
            pending.push(playPromise.catch(function() {}));
          }
        } catch (e) { /* autoplay blocked */ }
      }
      var done = function() { resolve(); };
      var timer = setTimeout(done, 3500);
      if (pending.length === 0) {
        clearTimeout(timer);
        setTimeout(done, 80);
        return;
      }
      Promise.all(pending).then(function() {
        clearTimeout(timer);
        setTimeout(done, 120);
      }).catch(function() {
        clearTimeout(timer);
        done();
      });
    });
  }

  function cloneNodeWithShadow(source) {
    if (!source || source.nodeType !== 1) {
      return source ? source.cloneNode(true) : null;
    }
    var clone = source.cloneNode(false);
    if (source.shadowRoot) {
      var shadowHost = document.createElement("div");
      shadowHost.setAttribute("data-zeros-shadow-root", "");
      var shadowKids = source.shadowRoot.childNodes;
      for (var s = 0; s < shadowKids.length; s++) {
        var sk = shadowKids[s];
        if (sk.nodeType === 1) {
          shadowHost.appendChild(cloneNodeWithShadow(sk));
        } else if (sk.nodeType === 3) {
          shadowHost.appendChild(sk.cloneNode(true));
        }
      }
      clone.appendChild(shadowHost);
    }
    var kids = source.childNodes;
    for (var c = 0; c < kids.length; c++) {
      var child = kids[c];
      if (child.nodeType === 1) {
        clone.appendChild(cloneNodeWithShadow(child));
      } else if (child.nodeType === 3) {
        clone.appendChild(child.cloneNode(true));
      }
    }
    return clone;
  }

  function pseudoStylesToInline(pcs) {
    var parts = [];
    for (var p = 0; p < FORK_FALLBACK_PROPS.length; p++) {
      var prop = FORK_FALLBACK_PROPS[p];
      if (FORK_SKIP_DIMENSION_PROPS[prop]) continue;
      var val = pcs.getPropertyValue(prop);
      if (!val || val === "none" || val === "normal" || val === "auto" || val === "0px") continue;
      parts.push(prop + ":" + val);
    }
    var content = pcs.getPropertyValue("content");
    if (content && content !== "none" && content !== '""') {
      parts.push("content:" + content);
    }
    return parts.join(";");
  }

  function materializePseudoElements(origRoot, cloneRoot) {
    var origNodes = collectSubtreeNodes(origRoot);
    var cloneNodes = collectSubtreeNodes(cloneRoot);
    for (var i = 0; i < origNodes.length && i < cloneNodes.length; i++) {
      var origEl = origNodes[i];
      var cloneEl = cloneNodes[i];
      if (!origEl || origEl.nodeType !== 1 || !cloneEl || cloneEl.nodeType !== 1) continue;
      try {
        var beforeCs = window.getComputedStyle(origEl, "::before");
        var beforeStyle = pseudoStylesToInline(beforeCs);
        if (beforeStyle) {
          var beforeEl = document.createElement("span");
          beforeEl.setAttribute("data-zeros-pseudo", "before");
          beforeEl.setAttribute("aria-hidden", "true");
          beforeEl.setAttribute("style", beforeStyle);
          cloneEl.insertBefore(beforeEl, cloneEl.firstChild);
        }
      } catch (e) { /* */ }
      try {
        var afterCs = window.getComputedStyle(origEl, "::after");
        var afterStyle = pseudoStylesToInline(afterCs);
        if (afterStyle) {
          var afterEl = document.createElement("span");
          afterEl.setAttribute("data-zeros-pseudo", "after");
          afterEl.setAttribute("aria-hidden", "true");
          afterEl.setAttribute("style", afterStyle);
          cloneEl.appendChild(afterEl);
        }
      } catch (e) { /* */ }
    }
  }

  function inlineAllComputedStyles(origRoot, cloneRoot) {
    var origNodes = collectSubtreeNodes(origRoot);
    var cloneNodes = collectSubtreeNodes(cloneRoot);
    for (var i = 0; i < origNodes.length && i < cloneNodes.length; i++) {
      var origEl = origNodes[i];
      var cloneEl = cloneNodes[i];
      if (!origEl || origEl.nodeType !== 1 || !cloneEl || cloneEl.nodeType !== 1) continue;
      try {
        var cs = window.getComputedStyle(origEl);
        var parts = [];
        for (var p = 0; p < FORK_FALLBACK_PROPS.length; p++) {
          var prop = FORK_FALLBACK_PROPS[p];
          if (i === 0 && FORK_SKIP_DIMENSION_PROPS[prop]) continue;
          var val = cs.getPropertyValue(prop);
          if (!val || val === "none" || val === "normal" || val === "auto" || val === "0px") continue;
          parts.push(prop + ":" + val);
        }
        if (parts.length === 0) continue;
        var existing = cloneEl.getAttribute("style") || "";
        cloneEl.setAttribute("style", existing ? existing + ";" + parts.join(";") : parts.join(";"));
      } catch (e) { /* */ }
    }
  }

  function dumpAllRules(rules, out, seen, budget) {
    if (!rules || budget.bytes >= FORK_CSS_COLLECT_MAX) return;
    for (var i = 0; i < rules.length && budget.bytes < FORK_CSS_COLLECT_MAX; i++) {
      var rule = rules[i];
      if (!rule) continue;
      if (rule.cssText && !seen[rule.cssText]) {
        seen[rule.cssText] = true;
        var remaining = FORK_CSS_COLLECT_MAX - budget.bytes;
        var cssText = rule.cssText.slice(0, remaining);
        out.push(cssText);
        budget.bytes += cssText.length + 1;
      }
      if (rule.cssRules) dumpAllRules(rule.cssRules, out, seen, budget);
    }
  }

  function collectFullAccessibleStylesheets() {
    var out = [];
    var seen = Object.create(null);
    var budget = { bytes: 0 };
    for (var s = 0; s < document.styleSheets.length && budget.bytes < FORK_CSS_COLLECT_MAX; s++) {
      try {
        dumpAllRules(document.styleSheets[s].cssRules, out, seen, budget);
      } catch (e) { /* cross-origin */ }
    }
    if (document.adoptedStyleSheets && document.adoptedStyleSheets.length > 0) {
      for (var a = 0; a < document.adoptedStyleSheets.length && budget.bytes < FORK_CSS_COLLECT_MAX; a++) {
        try {
          dumpAllRules(document.adoptedStyleSheets[a].cssRules, out, seen, budget);
        } catch (e) { /* */ }
      }
    }
    var styles = document.querySelectorAll("style");
    for (var t = 0; t < styles.length && budget.bytes < FORK_CSS_COLLECT_MAX; t++) {
      var text = styles[t].textContent;
      if (text && !styles[t].hasAttribute("data-Zeros-variant-css") && !seen[text]) {
        seen[text] = true;
        var remaining = FORK_CSS_COLLECT_MAX - budget.bytes;
        var cappedText = text.slice(0, remaining);
        out.push(cappedText);
        budget.bytes += cappedText.length + 1;
      }
    }
    return out.join("\\n");
  }

  function collectCssForFork(root) {
    var theme = collectRootThemeVariables();
    var body = "";
    if (isLocalDevPage()) {
      body = collectFullAccessibleStylesheets();
    } else {
      body = collectMatchedCssRules(root);
    }
    if (theme && body) return theme + "\\n" + body;
    return theme || body;
  }

  function applyComputedFallback(originalRoot, cloneRoot) {
    var origNodes = collectSubtreeNodes(originalRoot);
    var cloneNodes = collectSubtreeNodes(cloneRoot);
    var limit = Math.min(origNodes.length, cloneNodes.length);
    for (var i = 0; i < limit; i++) {
      var cloneEl = cloneNodes[i];
      var origEl = origNodes[i];
      if (!cloneEl || !origEl) continue;
      if (cloneEl.tagName !== origEl.tagName) break;
      var isRoot = i === 0;
      var hasClass = cloneEl.classList && cloneEl.classList.length > 0;
      var isLeaf = !origEl.children || origEl.children.length === 0;
      if (!isRoot && hasClass && !isLeaf) continue;
      try {
        var cs = window.getComputedStyle(origEl);
        var parts = [];
        for (var p = 0; p < FORK_FALLBACK_PROPS.length; p++) {
          var prop = FORK_FALLBACK_PROPS[p];
          if (FORK_SKIP_DIMENSION_PROPS[prop]) continue;
          var val = cs.getPropertyValue(prop);
          if (!val || val === "none" || val === "normal" || val === "auto" || val === "0px") continue;
          parts.push(prop + ":" + val);
        }
        if (parts.length === 0) continue;
        var existing = cloneEl.getAttribute("style") || "";
        cloneEl.setAttribute("style", existing ? existing + ";" + parts.join(";") : parts.join(";"));
      } catch (e) { /* */ }
    }
  }

  function capCssPayload(css, localDev) {
    var max = localDev ? FORK_CSS_MAX_BYTES_LOCAL : FORK_CSS_MAX_BYTES;
    if (css.length <= max) {
      return { css: css, truncated: false };
    }
    return {
      css: css.slice(0, max) + "\\n/* Zeros: CSS truncated at " + max + " bytes */",
      truncated: true
    };
  }

  function collectExternalStylesheetLinks() {
    var links = [];
    var els = document.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < els.length && links.length < 100; i++) {
      var href = els[i].getAttribute("href");
      if (href) {
        try {
          var absolute = new URL(href, location.href).href;
          if (absolute.length <= 8192) links.push(absolute);
        } catch (e) {
          if (href.length <= 8192) links.push(href);
        }
      }
    }
    return links;
  }

  function inlineRasterMedia(originalRoot, cloneRoot) {
    var origCanvases = originalRoot.querySelectorAll("canvas");
    var cloneCanvases = cloneRoot.querySelectorAll("canvas");
    for (var i = 0; i < origCanvases.length && i < cloneCanvases.length; i++) {
      try {
        var dataUrl = origCanvases[i].toDataURL("image/png");
        var img = document.createElement("img");
        img.src = dataUrl;
        var style = cloneCanvases[i].getAttribute("style");
        if (style) img.setAttribute("style", style);
        if (cloneCanvases[i].className) img.className = cloneCanvases[i].className;
        if (cloneCanvases[i].width) img.width = cloneCanvases[i].width;
        if (cloneCanvases[i].height) img.height = cloneCanvases[i].height;
        if (cloneCanvases[i].parentNode) {
          cloneCanvases[i].parentNode.replaceChild(img, cloneCanvases[i]);
        }
      } catch (e) { /* tainted canvas / WebGL */ }
    }
    var origVideos = originalRoot.querySelectorAll("video");
    var cloneVideos = cloneRoot.querySelectorAll("video");
    for (var v = 0; v < origVideos.length && v < cloneVideos.length; v++) {
      try {
        var video = origVideos[v];
        if (video.readyState < 2) continue;
        var c = document.createElement("canvas");
        c.width = video.videoWidth || video.clientWidth;
        c.height = video.videoHeight || video.clientHeight;
        if (c.width === 0 || c.height === 0) continue;
        c.getContext("2d").drawImage(video, 0, 0);
        cloneVideos[v].setAttribute("poster", c.toDataURL("image/png"));
        cloneVideos[v].removeAttribute("autoplay");
        cloneVideos[v].removeAttribute("loop");
      } catch (e) { /* cross-origin video */ }
    }
  }

  function inferScriptKind(url) {
    var u = url.toLowerCase();
    if (u.indexOf("gsap") >= 0) return "gsap";
    if (u.indexOf("framer") >= 0 || u.indexOf("motion") >= 0) return "framer-motion";
    if (u.indexOf("three") >= 0) return "three";
    if (u.indexOf("lottie") >= 0) return "lottie";
    if (u.indexOf("react") >= 0) return "react";
    return "unknown";
  }

  function extractBehaviorManifest(root) {
    var behaviors = [];
    var scriptRefs = [];
    var platformHints = [];
    var seenScript = Object.create(null);
    var behSeen = Object.create(null);

    if (document.querySelector("[data-framer-component-type], [data-framer-name], [data-framer-root]")) {
      platformHints.push("framer");
    }
    if (document.querySelector("[data-reactroot], [data-react-root]") || document.getElementById("__next")) {
      platformHints.push("react");
    }
    try {
      if (/framer\\.(website|app|usercontent)/.test(location.hostname)) {
        platformHints.push("framer-host");
      }
    } catch (e) { /* */ }

    var scripts = document.querySelectorAll("script[src]");
    for (var si = 0; si < scripts.length && scriptRefs.length < FORK_SCRIPT_MAX; si++) {
      var src = scripts[si].getAttribute("src");
      if (!src) continue;
      try { src = new URL(src, location.href).href; } catch (e) { /* keep raw */ }
      if (seenScript[src]) continue;
      seenScript[src] = true;
      scriptRefs.push({
        url: src,
        kind: inferScriptKind(src),
        async: scripts[si].hasAttribute("async"),
        defer: scripts[si].hasAttribute("defer")
      });
    }

    function pushBehavior(entry) {
      if (behaviors.length >= FORK_BEHAVIOR_MAX) return;
      var key = entry.kind + "|" + entry.selector;
      if (behSeen[key]) return;
      behSeen[key] = true;
      behaviors.push(entry);
    }

    var nodes = [root];
    var desc = root.querySelectorAll("*");
    for (var di = 0; di < desc.length && nodes.length < FORK_BEHAVIOR_NODE_MAX; di++) {
      nodes.push(desc[di]);
    }

    for (var ni = 0; ni < nodes.length; ni++) {
      var node = nodes[ni];
      if (!node || node.nodeType !== 1) continue;
      var tag = node.tagName.toLowerCase();
      var sel = buildSelector(node);

      if (tag === "canvas") {
        var glKind = "canvas-2d";
        try {
          var gl = node.getContext("webgl2") || node.getContext("webgl") || node.getContext("experimental-webgl");
          if (gl) glKind = "webgl";
        } catch (e) { /* */ }
        pushBehavior({
          kind: glKind === "webgl" ? "webgl-loop" : "canvas-raster",
          selector: sel,
          confidence: "high",
          detail: glKind,
          frozenSnapshot: "png"
        });
        continue;
      }

      try {
        if (node._gsap || (window.gsap && typeof window.gsap.getTweensOf === "function" && window.gsap.getTweensOf(node).length > 0)) {
          pushBehavior({
            kind: "gsap",
            selector: sel,
            confidence: "high",
            frozenSnapshot: "none"
          });
        }
      } catch (e) { /* */ }

      var framerAttr = node.getAttribute("data-framer-name") || node.getAttribute("data-framer-component-type");
      if (framerAttr || node.hasAttribute("data-projection-id")) {
        pushBehavior({
          kind: "framer-motion",
          selector: sel,
          confidence: framerAttr ? "high" : "medium",
          detail: framerAttr,
          frozenSnapshot: "none"
        });
      }

      if (tag === "lottie-player" || tag === "dotlottie-player" || (node.classList && node.classList.contains("lottie"))) {
        pushBehavior({
          kind: "lottie",
          selector: sel,
          confidence: "high",
          frozenSnapshot: "none"
        });
      }

      if (tag === "animate" || tag === "animatetransform" || tag === "animatemotion") {
        pushBehavior({
          kind: "svg-animation",
          selector: sel,
          confidence: "high",
          frozenSnapshot: "none"
        });
      }

      if (tag === "video") {
        pushBehavior({
          kind: "video-playback",
          selector: sel,
          confidence: "high",
          frozenSnapshot: "poster"
        });
      }

      if (tag === "input" || tag === "select" || tag === "textarea" || tag === "button" ||
          tag === "details" || node.getAttribute("role") === "button" ||
          node.getAttribute("role") === "combobox" || node.hasAttribute("contenteditable")) {
        pushBehavior({
          kind: "interactive-widget",
          selector: sel,
          confidence: "medium",
          detail: tag,
          frozenSnapshot: "none"
        });
      }

      var reactKey = null;
      for (var key in node) {
        if (key.indexOf("__reactFiber") === 0 || key.indexOf("__reactInternalInstance") === 0) {
          reactKey = key;
          break;
        }
      }
      if (reactKey) {
        pushBehavior({
          kind: "react-component",
          selector: sel,
          confidence: "medium",
          frozenSnapshot: "none"
        });
      }
    }

    var liveKinds = ["gsap", "framer-motion", "webgl-loop", "lottie", "svg-animation", "video-playback", "react-component"];
    var needsLive = false;
    for (var li = 0; li < behaviors.length; li++) {
      if (liveKinds.indexOf(behaviors[li].kind) >= 0) {
        needsLive = true;
        break;
      }
    }

    return {
      formatVersion: 1,
      runtimeMode: needsLive ? "static-with-live-layer" : "static",
      behaviors: behaviors,
      scriptRefs: scriptRefs,
      platformHints: platformHints,
      sourceUrl: location.href
    };
  }

  function captureComponentFork(el) {
    if (!el || !el.parentNode) return null;
    var localDev = isLocalDevPage();
    var clone = cloneNodeWithShadow(el);
    if (!clone) return null;
    inlineRasterMedia(el, clone);
    materializePseudoElements(el, clone);
    if (localDev) {
      applyComputedFallback(el, clone);
    } else {
      inlineAllComputedStyles(el, clone);
    }
    prepareResponsiveClone(clone);
    var wrapped = wrapWithAncestorContext(el, clone);
    var mockData = extractMockData(el);
    var tempDiv = document.createElement("div");
    tempDiv.appendChild(wrapped);
    var rawHtml = sanitizeSnapshotHtml(tempDiv.innerHTML);
    var baseUrl = location.href;
    var html = absolutifyUrls(rawHtml, baseUrl);
    // Prevent a single pathological component from monopolizing the renderer
    // or flooding the cross-frame message bus. The caller surfaces this as a
    // failed capture and leaves the existing variant untouched.
    if (html.length > FORK_HTML_MAX_BYTES) return null;
    var cssBody = collectCssForFork(el);
    var externalLinks = collectExternalStylesheetLinks();
    var linkTags = externalLinks.map(function(href) {
      return '@import url("' + href + '");';
    }).join("\\n");
    var cssRaw = linkTags ? linkTags + "\\n" + cssBody : cssBody;
    var capped = capCssPayload(cssRaw, localDev);
    var contentHeight = el.offsetHeight || el.scrollHeight || 0;
    var contentWidth = el.offsetWidth || el.scrollWidth || 0;
    return {
      html: html,
      css: capped.css,
      cssTruncated: capped.truncated,
      extractionMode: localDev ? "precision-local" : "matched",
      sourceSelector: buildSelector(el),
      sourceOuterHTML: (el.outerHTML || "").slice(0, 1000000),
      contentHeight: contentHeight,
      contentWidth: contentWidth,
      mockData: mockData,
      componentName: detectComponentName(el),
      behaviorManifest: extractBehaviorManifest(el)
    };
  }

  function runPrecisionForkCapture(selector, index) {
    var target = resolveForkTarget(selector, index);
    if (!target) return Promise.resolve(null);
    // Cloning and computing styles are necessarily synchronous DOM work. Reject
    // pathological subtrees before starting so the 20 s parent timeout is a
    // real safety net rather than a timer that cannot fire while JS is blocked.
    if (target.querySelectorAll("*").length > FORK_DOM_NODE_MAX) {
      return Promise.resolve(null);
    }
    return prepareForkTargetAsync(target).then(function() {
      try {
        return captureComponentFork(target);
      } catch (e) {
        return null;
      }
    }).catch(function() {
      return null;
    });
  }

  // ── Parent → picker message bus ─────────────────────────
  function onParentMessage(ev) {
    // Same-origin parent only — postMessage from any frame is
    // technically possible, but our parent IS the picker's owner
    // and the only sender we trust.
    if (ev.source !== parentWindow) return;
    var d = ev.data;
    if (!d || typeof d.type !== "string") return;
    if (d.type.indexOf(MSG_PREFIX) !== 0) return;
    var op = d.type.slice(MSG_PREFIX.length);
    if (op === "activate") activate();
    else if (op === "deactivate") deactivate();
    else if (op === "clear-selections") {
      // Chip dismissed — clear overlays AND unfreeze so picker
      // resumes accepting hover/clicks.
      clearAllSelections();
      setFrozen(false);
    }
    else if (op === "remove-selection-at" && typeof d.index === "number") {
      // markedList mirrors the parent's selectedElements[] order
      // (one entry per shift+click in insertion order). Remove
      // that element's overlay; parent already updated its state.
      var el = markedList[d.index];
      if (el) removeSelected(el);
    }
    else if (op === "flush-batch") {
      // Parent forwarded a Shift release that landed outside the
      // iframe (e.g., focus was in the React chrome when user
      // lifted Shift). Flush any pending batch we accumulated.
      flushBatch();
    }
    else if (op === "fork-request") {
      var requestId = typeof d.requestId === "string" ? d.requestId.slice(0, 128) : "";
      if (!requestId) return;
      var target = resolveForkTarget(d.selector, d.index);
      if (!target) {
        postToParent("fork-result", { requestId: requestId, ok: false, error: "element-not-found" });
        return;
      }
      runPrecisionForkCapture(d.selector, d.index).then(function(snapshot) {
        if (!snapshot) {
          postToParent("fork-result", { requestId: requestId, ok: false, error: "capture-failed" });
          return;
        }
        postToParent("fork-result", { requestId: requestId, ok: true, snapshot: snapshot });
      }).catch(function() {
        postToParent("fork-result", { requestId: requestId, ok: false, error: "capture-error" });
      });
    }
  }
  window.addEventListener("message", onParentMessage, true);

  // Always-on toggle-shortcut listener (works even when not active,
  // so user can enter design mode from a focused page).
  document.addEventListener("keydown", onToggleRequestKey, true);

  // ── Sentinel ────────────────────────────────────────────
  // Stored for idempotent re-install. \`refreshParent\` is called
  // on repeat injection to repoint window.parent in case the
  // iframe was detached/re-attached.
  window[SENTINEL] = {
    version: PICKER_VERSION,
    refreshParent: function() { parentWindow = window.parent; },
    destroy: function() {
      deactivate();
      window.removeEventListener("message", onParentMessage, true);
      document.removeEventListener("keydown", onToggleRequestKey, true);
    },
  };

  // Announce ready so the parent knows it can send activate.
  postToParent("ready");
})();
`;
