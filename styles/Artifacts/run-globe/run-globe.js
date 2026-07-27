// ── Run loader — Vector Globe ──────────────────────────────────────────────
//
// A pure-vector (SVG) rotating globe drawn as clean line-art: a rim circle plus
// continent coastlines, all in ONE uniform stroke — no fill, no country borders,
// no graticule, no shimmer. Every mark is an SVG path, so it stays razor-crisp at
// any size or DPI.
//
// How it works:
//   • d3-geo's orthographic projection maps [lon, lat] → screen and clips the
//     back hemisphere for us (clipAngle 90°), so coastlines wrap and vanish around
//     the limb correctly as the globe turns — the hard part, delegated to a
//     battle-tested projection instead of hand-rolled spherical clipping.
//   • The land shape (a MultiPolygon) is STROKED, not filled: stroking a polygon
//     traces its outline, i.e. the coastline. Where a continent crosses the limb
//     the clip closes it along the sphere edge — which coincides with the rim, so
//     it just reinforces the rim, no stray marks.
//   • The rim is a plain <circle>: an orthographic sphere's outline never changes
//     under rotation, so it's drawn ONCE. Only the coastline is re-projected each
//     frame.
//   • One uniform stroke width is set on the <svg> and inherited by both the rim
//     and the coastline, so "all strokes the same size" holds at every scale.
//   • Colour is pure CSS — everything rides `currentColor`. A light/dark theme
//     flip needs zero JS here; only the coastline `d` is script-driven.
//   • Instances are grouped by pixel size so each frame's path is computed once
//     and fanned out to every globe of that size.
//
// Markup: give any element `data-run-globe` and `data-globe-size="16"`; the
// script injects a sized <svg> inside it. Colour comes from the host's `color`.
// Depends on run-globe-d3.min.js + run-globe-geo.js being loaded first.
(function () {
  "use strict";

  var d3 = window.d3;
  var GEO = window.RUN_GLOBE_GEO;
  if (!d3 || !d3.geoOrthographic || !d3.geoPath || !GEO) {
    if (window.console && console.warn) {
      console.warn(
        "[run-globe] d3-geo and/or RUN_GLOBE_GEO not loaded — globe disabled.",
      );
    }
    return;
  }

  var SVG_NS = "http://www.w3.org/2000/svg";

  // ── Tunables ──────────────────────────────────────────────────────────────
  var PERIOD_MS = 9000; // one full revolution
  var TILT_DEG = -16; // camera latitude: look slightly down onto the north pole
  var RADIUS_RATIO = 0.44; // sphere radius as a fraction of the box (rim needs room)
  var STROKE_RATIO = 0.05; // uniform stroke width as a fraction of the box…
  var STROKE_MIN = 1; // …with a floor so it never disappears at 14–16 px
  var REST_LON = 18; // static longitude when motion is reduced (Atlantic view)

  function strokeWidth(size) {
    return Math.max(STROKE_MIN, size * STROKE_RATIO);
  }

  var LAND = GEO.land;

  var reduceMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // One injected stylesheet: every mark is a currentColor stroke, no fill. Theme
  // flips are free (currentColor re-resolves with no JS).
  var STYLE_ID = "run-globe-style";
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      ".run-globe-svg{display:block;overflow:visible}",
      ".run-globe-svg circle,.run-globe-svg path{",
      "fill:none;stroke:currentColor;stroke-linejoin:round;stroke-linecap:round}",
    ].join("");
    (document.head || document.documentElement).appendChild(style);
  }

  // size → shared projection/path + the coastline nodes to fill.
  var groups = new Map();

  function mount(host) {
    var size =
      parseInt(host.getAttribute("data-globe-size"), 10) ||
      host.clientWidth ||
      16;
    var center = size / 2;
    var radius = size * RADIUS_RATIO;

    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "run-globe-svg");
    svg.setAttribute("viewBox", "0 0 " + size + " " + size);
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    svg.setAttribute("aria-hidden", "true");
    // One uniform width, inherited by both the rim and the coastline.
    svg.setAttribute("stroke-width", strokeWidth(size));

    // Rim — drawn once; an orthographic sphere's outline is rotation-invariant.
    var rim = document.createElementNS(SVG_NS, "circle");
    rim.setAttribute("cx", center);
    rim.setAttribute("cy", center);
    rim.setAttribute("r", radius);

    // Coastline — the land outline, re-projected each frame.
    var coast = document.createElementNS(SVG_NS, "path");

    svg.appendChild(rim);
    svg.appendChild(coast);
    host.appendChild(svg);

    var group = groups.get(size);
    if (!group) {
      var projection = d3
        .geoOrthographic()
        .translate([center, center])
        .scale(radius)
        .clipAngle(90);
      group = { projection: projection, path: d3.geoPath(projection), coasts: [] };
      groups.set(size, group);
    }
    group.coasts.push(coast);
  }

  // Project every size-group at the given longitude and push fresh coastline `d`.
  function render(lonDeg) {
    groups.forEach(function (group) {
      group.projection.rotate([lonDeg, TILT_DEG]);
      var d = group.path(LAND);
      for (var i = 0; i < group.coasts.length; i++) {
        group.coasts[i].setAttribute("d", d);
      }
    });
  }

  var startedAt = null;
  function frame(now) {
    if (startedAt == null) startedAt = now;
    var progress = ((now - startedAt) % PERIOD_MS) / PERIOD_MS;
    // Negative longitude drift spins the surface left→west (new land enters from
    // the right), matching the retired pixel globe's direction.
    render(-progress * 360);
    window.requestAnimationFrame(frame);
  }

  function mountAll() {
    injectStyles();
    var hosts = document.querySelectorAll("[data-run-globe]");
    for (var i = 0; i < hosts.length; i++) {
      if (!hosts[i].querySelector(".run-globe-svg")) mount(hosts[i]);
    }
    if (!groups.size) return;
    if (reduceMotion) render(REST_LON);
    else window.requestAnimationFrame(frame);
  }

  window.RunGlobe = { mountAll: mountAll };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountAll);
  } else {
    mountAll();
  }
})();
