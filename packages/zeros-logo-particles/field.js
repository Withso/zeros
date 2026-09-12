// Live Zeros mark — canvas particle field.
// Prebaked colored glyphs (one drawImage each) so motion stays at 60fps.
// Slow circulation + long lives match the number-sphere clip, not a strobe.
(function () {
  "use strict";

  var Model = window.ZerosLogoFieldModel;
  if (!Model) return;

  var MAP = 192;
  var LOOP_MS = Model.LOOP_SEC * 1000;
  var CELL = 64;
  var ATLAS_COLS = 10;
  var DIGITS = "0123456789";
  var SYM = "()[]{}<>/|_-=+*#;:,.";
  var CHARS = DIGITS + SYM;
  var FONT = "100 34px 'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace";
  var COLORS = [
    "#f4f5f2",
    "#e6e7e2",
    "#d9c57a",
    "#cbb56a",
    "#e4d4a0",
    "#b7c9dc",
    "#9aafc4",
    "#c5d3e2",
    "#9bb89f",
    "#86a58e",
  ];
  var SQUARE = CHARS.length * COLORS.length;
  var GLOW0 = SQUARE + 1;
  var SQUARE_GLOW = GLOW0 + COLORS.length;
  var SHINE = SQUARE_GLOW + 1;

  var host = null;
  var canvas = null;
  var ctx = null;
  var atlas = null;
  var map = null;
  var particles = null;
  var posed = [];
  var pairs = null;
  var running = false;
  var raf = 0;
  var startMs = 0;
  var reduced = false;
  var lastBg = "";
  var freezeCycle = null;
  var dprNow = 1;

  function fitCanvas() {
    if (!canvas || !host) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.max(1080, host.clientWidth || Model.FRAME_SIZE);
    var h = Math.max(1080, host.clientHeight || Model.FRAME_SIZE);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    dprNow = dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (running) {
      var stage = document.querySelector(".stage");
      var bg = stage ? stage.getAttribute("data-bg") || "void" : "void";
      draw(nowCycle(), bg);
    }
  }

  function hexRgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return (
      "rgba(" +
      ((n >> 16) & 255) +
      "," +
      ((n >> 8) & 255) +
      "," +
      (n & 255) +
      "," +
      a +
      ")"
    );
  }

  function paintGlyph(g, ch, cx, cy, color) {
    g.save();
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = FONT;
    g.lineJoin = "round";
    g.lineCap = "round";
    g.shadowColor = hexRgba(color, 0.7);
    g.shadowBlur = 5;
    g.strokeStyle = color;
    g.lineWidth = 0.7;
    g.strokeText(ch, cx, cy);
    g.shadowBlur = 0;
    g.globalAlpha = 0.16;
    g.fillStyle = color;
    g.fillText(ch, cx, cy);
    g.restore();
  }

  function paintSquare(g, cx, cy) {
    g.shadowBlur = 0;
    g.fillStyle = "#e24a4a";
    g.fillRect(cx - 4.5, cy - 4.5, 9, 9);
  }

  function paintGlowDisc(g, cx, cy, hex) {
    var r = CELL * 0.4;
    var grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    grd.addColorStop(0, hexRgba(hex, 0.55));
    grd.addColorStop(0.22, hexRgba(hex, 0.22));
    grd.addColorStop(0.55, hexRgba(hex, 0.06));
    grd.addColorStop(1, hexRgba(hex, 0));
    g.fillStyle = grd;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
  }

  function paintShine(g, cx, cy) {
    var r = CELL * 0.3;
    var grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    grd.addColorStop(0, "rgba(255,255,252,0.95)");
    grd.addColorStop(0.18, "rgba(255,248,230,0.55)");
    grd.addColorStop(0.45, "rgba(255,255,255,0.12)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grd;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
  }

  function glowIndex(sprite) {
    if (sprite === SQUARE) return SQUARE_GLOW;
    return GLOW0 + Math.floor(sprite / CHARS.length);
  }

  function buildAtlas() {
    var cells = SHINE + 1;
    var rows = Math.ceil(cells / ATLAS_COLS);
    var sheet = document.createElement("canvas");
    sheet.width = ATLAS_COLS * CELL;
    sheet.height = rows * CELL;
    var g = sheet.getContext("2d");
    var i;
    var c;
    var ch;
    var col;
    var row;
    for (c = 0; c < COLORS.length; c++) {
      for (i = 0; i < CHARS.length; i++) {
        ch = c * CHARS.length + i;
        col = ch % ATLAS_COLS;
        row = Math.floor(ch / ATLAS_COLS);
        paintGlyph(
          g,
          CHARS[i],
          col * CELL + CELL / 2,
          row * CELL + CELL / 2,
          COLORS[c],
        );
      }
    }
    col = SQUARE % ATLAS_COLS;
    row = Math.floor(SQUARE / ATLAS_COLS);
    paintSquare(g, col * CELL + CELL / 2, row * CELL + CELL / 2);
    for (c = 0; c < COLORS.length; c++) {
      col = (GLOW0 + c) % ATLAS_COLS;
      row = Math.floor((GLOW0 + c) / ATLAS_COLS);
      paintGlowDisc(g, col * CELL + CELL / 2, row * CELL + CELL / 2, COLORS[c]);
    }
    col = SQUARE_GLOW % ATLAS_COLS;
    row = Math.floor(SQUARE_GLOW / ATLAS_COLS);
    paintGlowDisc(g, col * CELL + CELL / 2, row * CELL + CELL / 2, "#e24a4a");
    col = SHINE % ATLAS_COLS;
    row = Math.floor(SHINE / ATLAS_COLS);
    paintShine(g, col * CELL + CELL / 2, row * CELL + CELL / 2);
    atlas = sheet;
  }

  function buildOccupancy() {
    var probe = document.createElement("canvas").getContext("2d");
    var paths = Model.LOGO_PATHS.map(function (d) {
      return new Path2D(d);
    });
    var inside = new Uint8Array(MAP * MAP);
    var glyph = new Int8Array(MAP * MAP);
    glyph.fill(-1);
    var x, y, i, g, sx, sy;
    for (y = 0; y < MAP; y++) {
      for (x = 0; x < MAP; x++) {
        sx = ((x + 0.5) / MAP) * 128;
        sy = ((y + 0.5) / MAP) * 128;
        for (g = 0; g < paths.length; g++) {
          if (probe.isPointInPath(paths[g], sx, sy)) {
            i = y * MAP + x;
            inside[i] = 1;
            glyph[i] = g;
            break;
          }
        }
      }
    }

    var cores = [[], [], [], []];
    var rims = [];
    var field = [];
    for (y = 0; y < MAP; y++) {
      for (x = 0; x < MAP; x++) {
        i = y * MAP + x;
        var pt = Model.logoToUnit(((x + 0.5) / MAP) * 128, ((y + 0.5) / MAP) * 128);
        var inn = inside[i];
        var border = false;
        if (inn) {
          if (x === 0 || y === 0 || x === MAP - 1 || y === MAP - 1) border = true;
          else if (
            !inside[i - 1] ||
            !inside[i + 1] ||
            !inside[i - MAP] ||
            !inside[i + MAP]
          ) {
            border = true;
          }
        } else if (x > 0 && y > 0 && x < MAP - 1 && y < MAP - 1) {
          if (inside[i - 1] || inside[i + 1] || inside[i - MAP] || inside[i + MAP]) {
            border = true;
          }
        }
        if (inn) cores[glyph[i]].push(pt.x, pt.y);
        if (border) rims.push(pt.x, pt.y, nearestGlyph(x, y, glyph));
        if (!inn && !border) field.push(pt.x, pt.y);
      }
    }

    var fx, fy;
    for (fy = 0; fy < 36; fy++) {
      for (fx = 0; fx < 36; fx++) {
        var ux = (fx + 0.5) / 36;
        var uy = (fy + 0.5) / 36;
        var logo = Model.unitToLogo(ux, uy);
        var on = logo.x >= 0 && logo.x <= 128 && logo.y >= 0 && logo.y <= 128;
        if (!on) field.push(ux, uy);
      }
    }

    var cross = [];
    for (y = 0; y < MAP; y++) {
      for (x = 0; x < MAP; x++) {
        i = y * MAP + x;
        if (inside[i]) continue;
        var lu = Model.logoToUnit(((x + 0.5) / MAP) * 128, ((y + 0.5) / MAP) * 128);
        if (lu.x > 0.34 && lu.x < 0.66 && lu.y > 0.34 && lu.y < 0.66) {
          cross.push(lu.x, lu.y);
        }
      }
    }

    var slices = [[], [], [], []];
    for (g = 0; g < 4; g++) {
      slices[g] = new Array(MAP);
      for (y = 0; y < MAP; y++) {
        var xMin = 1;
        var xMax = 0;
        var found = false;
        for (x = 0; x < MAP; x++) {
          i = y * MAP + x;
          if (glyph[i] !== g) continue;
          var su = Model.logoToUnit(((x + 0.5) / MAP) * 128, ((y + 0.5) / MAP) * 128);
          if (!found || su.x < xMin) xMin = su.x;
          if (!found || su.x > xMax) xMax = su.x;
          found = true;
        }
        slices[g][y] = found
          ? { cx: (xMin + xMax) / 2, rMax: Math.max(0.01, (xMax - xMin) / 2) }
          : null;
      }
    }

    map = { cores: cores, rims: rims, field: field, cross: cross, slices: slices };
  }

  function nearestGlyph(x, y, glyph) {
    var r, c, g;
    for (r = 1; r <= 6; r++) {
      for (c = -r; c <= r; c++) {
        g = sampleGlyph(x + c, y - r, glyph);
        if (g >= 0) return g;
        g = sampleGlyph(x + c, y + r, glyph);
        if (g >= 0) return g;
        g = sampleGlyph(x - r, y + c, glyph);
        if (g >= 0) return g;
        g = sampleGlyph(x + r, y + c, glyph);
        if (g >= 0) return g;
      }
    }
    return 0;
  }

  function sampleGlyph(x, y, glyph) {
    if (x < 0 || y < 0 || x >= MAP || y >= MAP) return -1;
    return glyph[y * MAP + x];
  }

  function pickSite(rng, triples, stride) {
    var n = triples.length / stride;
    if (n < 1) return 0;
    return Math.floor(rng() * n);
  }

  function blobCenters() {
    var out = [];
    var g;
    var i;
    var n;
    var sx;
    var sy;
    var arr;
    for (g = 0; g < 4; g++) {
      arr = map.cores[g];
      n = arr.length / 2;
      sx = 0;
      sy = 0;
      for (i = 0; i < n; i++) {
        sx += arr[i * 2];
        sy += arr[i * 2 + 1];
      }
      out.push(n ? { x: sx / n, y: sy / n } : { x: 0.5, y: 0.5 });
    }
    return out;
  }

  function pickSprite(rng, layer) {
    if (rng() < 0.03) return SQUARE;
    var ch = rng() < 0.7
      ? Math.floor(rng() * DIGITS.length)
      : DIGITS.length + Math.floor(rng() * SYM.length);
    var roll = rng();
    var colorIdx;
    if (roll < 0.44) colorIdx = rng() < 0.6 ? 0 : 1;
    else if (roll < 0.72) colorIdx = 2 + Math.floor(rng() * 3);
    else if (roll < 0.92) colorIdx = 5 + Math.floor(rng() * 3);
    else colorIdx = 8 + Math.floor(rng() * 2);
    if (layer === "rimBloom" && rng() < 0.22) colorIdx = 0;
    else if (layer === "rim" && rng() < 0.16) colorIdx = 0;
    return colorIdx * CHARS.length + ch;
  }

  function spawn() {
    var rng = Model.mulberry32(20260831);
    var list = [];
    var centers = blobCenters();
    var radii = blobRadii(centers);
    var nudge = 5 / Model.FRAME_SIZE;
    centers[0] = { x: centers[0].x - nudge, y: centers[0].y - nudge };
    centers[1] = { x: centers[1].x + nudge, y: centers[1].y + nudge };

    function blobRadii(cs) {
      var out = [];
      var g;
      var i;
      var n;
      var arr;
      var m;
      var dx;
      var dy;
      for (g = 0; g < 4; g++) {
        arr = map.cores[g];
        n = arr.length / 2;
        m = 0;
        for (i = 0; i < n; i++) {
          dx = arr[i * 2] - cs[g].x;
          dy = arr[i * 2 + 1] - cs[g].y;
          m = Math.max(m, Math.hypot(dx, dy));
        }
        out.push(g === 0 || g === 1 ? m * 1.18 : m);
      }
      return out;
    }

    function add(count, siteFn) {
      var n;
      for (n = 0; n < count; n++) list.push(siteFn(n));
    }

    function mixSize(tinyP, hugeP, tinyMin, tinySpan, midMin, midSpan, hugeMin, hugeSpan) {
      var r = rng();
      if (r < tinyP) return tinyMin + rng() * tinySpan;
      if (r < tinyP + hugeP) return hugeMin + rng() * hugeSpan;
      return midMin + rng() * midSpan;
    }

    function onSphere(rMin, rMax) {
      var R = rMin + rng() * (rMax - rMin);
      var yN = (rng() * 2 - 1) * 0.92;
      var phi = rng() * Math.PI * 2;
      var rXZ = Math.sqrt(Math.max(1e-5, 1 - yN * yN)) * R;
      return {
        x: 0.5 + rXZ * Math.cos(phi),
        y: 0.5 + yN * R,
        z0: rXZ * Math.sin(phi),
      };
    }

    function sliceAt(id, unitY) {
      var logoY = Model.unitToLogo(0.5, unitY).y;
      var row = Math.max(0, Math.min(MAP - 1, Math.floor((logoY / 128) * MAP)));
      var hit = map.slices[id][row];
      var d;
      if (hit) return hit;
      for (d = 1; d < MAP; d++) {
        if (row - d >= 0 && map.slices[id][row - d]) return map.slices[id][row - d];
        if (row + d < MAP && map.slices[id][row + d]) return map.slices[id][row + d];
      }
      var c = centers[id] || { x: 0.5, y: 0.5 };
      return { cx: c.x, rMax: 0.06 };
    }

    function globeSite(id, surface) {
      var c = centers[id] || { x: 0.5, y: 0.5 };
      var R = radii[id] || 0.08;
      var yN = (rng() * 2 - 1) * 0.9;
      var phi = rng() * Math.PI * 2;
      var rad = surface
        ? R * (0.86 + rng() * 0.14)
        : R * (0.2 + 0.8 * Math.cbrt(rng()));
      var rXZ = Math.sqrt(Math.max(1e-5, 1 - yN * yN)) * rad;
      return {
        x: c.x + rXZ * Math.cos(phi),
        y: c.y + yN * rad,
        z0: rXZ * Math.sin(phi),
        cx: c.x,
        cy: c.y,
      };
    }

    function isGlobeBlob(id) {
      return id === 0 || id === 1;
    }

    function circleEdgeParticle(id, bloom) {
      var g = globeSite(id, true);
      return makeParticle(rng, {
        x: g.x,
        y: g.y,
        z0: g.z0,
        cx: g.cx,
        cy: g.cy,
        orbit: "globe",
        revs: Model.FRAME_REVS,
        layer: bloom ? "rimBloom" : "rim",
        glyph: id,
        ox: (rng() - 0.5) * 0.003,
        oy: (rng() - 0.5) * 0.003,
        size: bloom
          ? mixSize(0.08, 0.22, 10, 8, 18, 22, 60, 10)
          : mixSize(0.12, 0.18, 8, 7, 16, 22, 60, 10),
        alpha: bloom ? 0.9 + rng() * 0.1 : 0.82 + rng() * 0.16,
      });
    }

    function coreParticle(n) {
      var id = n % 4;
      var arr = map.cores[id];
      var idx = pickSite(rng, arr, 2);
      var c = centers[id] || { x: 0.5, y: 0.5 };
      var size = mixSize(0.14, 0.16, 7, 8, 16, 24, 60, 10);
      if (isGlobeBlob(id)) {
        var g = globeSite(id, false);
        return makeParticle(rng, {
          x: g.x,
          y: g.y,
          z0: g.z0,
          cx: g.cx,
          cy: g.cy,
          orbit: "globe",
          revs: Model.FRAME_REVS,
          layer: "core",
          glyph: id,
          interior: true,
          oy: (rng() - 0.5) * 0.004,
          size: size,
          alpha: size > 30 ? 0.72 + rng() * 0.22 : 0.48 + rng() * 0.32,
        });
      }
      var x = arr[idx * 2] + (rng() - 0.5) * 0.01;
      var y = arr[idx * 2 + 1] + (rng() - 0.5) * 0.01;
      var s = sliceAt(id, y);
      var dx = x - s.cx;
      if (dx > s.rMax) dx = s.rMax;
      if (dx < -s.rMax) dx = -s.rMax;
      var zMax = Math.sqrt(Math.max(1e-6, s.rMax * s.rMax - dx * dx));
      var z0 = (rng() - 0.5) * 2 * Math.min(0.1, zMax);
      if (Math.abs(z0) < 0.03) z0 = z0 < 0 ? -0.04 : 0.04;
      return makeParticle(rng, {
        x: s.cx + dx,
        y: y,
        z0: z0,
        cx: s.cx,
        cy: c.y,
        xLo: s.cx - s.rMax,
        xHi: s.cx + s.rMax,
        contain: true,
        revs: 0.45 + rng() * 0.7,
        layer: "core",
        glyph: id,
        interior: true,
        oy: (rng() - 0.5) * 0.006,
        size: size,
        alpha: size > 30 ? 0.72 + rng() * 0.22 : 0.48 + rng() * 0.32,
      });
    }

    function rimParticle() {
      var arr = map.rims;
      var idx = pickSite(rng, arr, 3);
      var id = arr[idx * 3 + 2];
      var c = centers[id] || { x: 0.5, y: 0.5 };
      if (isGlobeBlob(id)) {
        var gr = globeSite(id, true);
        return makeParticle(rng, {
          x: gr.x,
          y: gr.y,
          z0: gr.z0,
          cx: gr.cx,
          cy: gr.cy,
          orbit: "globe",
          revs: Model.FRAME_REVS,
          layer: "rim",
          glyph: id,
          ox: (rng() - 0.5) * 0.004,
          oy: (rng() - 0.5) * 0.004,
          size: mixSize(0.12, 0.18, 8, 7, 16, 22, 60, 10),
          alpha: 0.78 + rng() * 0.2,
        });
      }
      return makeParticle(rng, {
        x: arr[idx * 3] + (rng() - 0.5) * 0.004,
        y: arr[idx * 3 + 1] + (rng() - 0.5) * 0.004,
        layer: "rim",
        glyph: id,
        orbit: "shape",
        cx: c.x,
        cy: c.y,
        rx: 0.012 + rng() * 0.016,
        ry: 0.012 + rng() * 0.016,
        ox: (rng() - 0.5) * 0.008,
        oy: (rng() - 0.5) * 0.008,
        size: mixSize(0.12, 0.18, 8, 7, 16, 22, 60, 10),
        alpha: 0.78 + rng() * 0.2,
      });
    }

    function bloomRimParticle(n) {
      var id = n % 4;
      var arr = map.rims;
      var idx = pickSite(rng, arr, 3);
      var tries = 0;
      while (arr[idx * 3 + 2] !== id && tries < 24) {
        idx = pickSite(rng, arr, 3);
        tries++;
      }
      if (isGlobeBlob(id)) {
        var gb = globeSite(id, true);
        return makeParticle(rng, {
          x: gb.x,
          y: gb.y,
          z0: gb.z0,
          cx: gb.cx,
          cy: gb.cy,
          orbit: "globe",
          revs: Model.FRAME_REVS,
          layer: "rimBloom",
          glyph: id,
          ox: (rng() - 0.5) * 0.003,
          oy: (rng() - 0.5) * 0.003,
          size: mixSize(0.08, 0.22, 10, 8, 18, 22, 60, 10),
          alpha: 0.88 + rng() * 0.12,
        });
      }
      return makeParticle(rng, {
        x: arr[idx * 3] + (rng() - 0.5) * 0.003,
        y: arr[idx * 3 + 1] + (rng() - 0.5) * 0.003,
        layer: "rimBloom",
        glyph: arr[idx * 3 + 2],
        orbit: "shape",
        cx: centers[arr[idx * 3 + 2]].x,
        cy: centers[arr[idx * 3 + 2]].y,
        rx: 0.01 + rng() * 0.016,
        ry: 0.01 + rng() * 0.016,
        ox: (rng() - 0.5) * 0.007,
        oy: (rng() - 0.5) * 0.007,
        size: mixSize(0.08, 0.22, 10, 8, 18, 22, 60, 10),
        alpha: 0.88 + rng() * 0.12,
      });
    }

    function fieldParticle() {
      var s = onSphere(0.28, 0.62);
      return makeParticle(rng, {
        x: s.x,
        y: s.y,
        z0: s.z0,
        layer: "field",
        glyph: -1,
        ox: (rng() - 0.5) * 0.012,
        oy: (rng() - 0.5) * 0.012,
        size: mixSize(0.2, 0.14, 6, 6, 12, 20, 52, 18),
        alpha: 0.16 + rng() * 0.2,
      });
    }

    function crossParticle() {
      var s = onSphere(0.36, 0.66);
      return makeParticle(rng, {
        x: s.x,
        y: s.y,
        z0: s.z0,
        layer: "field",
        glyph: -1,
        ox: (rng() - 0.5) * 0.01,
        oy: (rng() - 0.5) * 0.01,
        size: mixSize(0.2, 0.14, 6, 6, 12, 18, 50, 16),
        alpha: 0.18 + rng() * 0.22,
      });
    }

    function surroundParticle() {
      var s = rng() < 0.28 ? onSphere(0.22, 0.38) : onSphere(0.38, 0.68);
      var size = mixSize(0.16, 0.18, 6, 7, 14, 24, 60, 10);
      var near = Math.abs(s.z0) > 0.02 && s.z0 > 0;
      return makeParticle(rng, {
        x: s.x,
        y: s.y,
        z0: s.z0,
        layer: "surround",
        glyph: -1,
        ox: (rng() - 0.5) * 0.012,
        oy: (rng() - 0.5) * 0.012,
        size: size,
        alpha: near ? 0.28 + rng() * 0.42 : 0.16 + rng() * 0.3,
      });
    }
    add(170, coreParticle);
    add(50, function (n) {
      var g = globeSite(n % 2, false);
      var size = mixSize(0.14, 0.16, 7, 8, 16, 24, 60, 10);
      return makeParticle(rng, {
        x: g.x,
        y: g.y,
        z0: g.z0,
        cx: g.cx,
        cy: g.cy,
        orbit: "globe",
        revs: Model.FRAME_REVS,
        layer: "core",
        glyph: n % 2,
        interior: true,
        oy: (rng() - 0.5) * 0.004,
        size: size,
        alpha: size > 30 ? 0.72 + rng() * 0.22 : 0.48 + rng() * 0.32,
      });
    });
    add(380, rimParticle);
    add(90, function (n) {
      return circleEdgeParticle(n % 2, false);
    });
    add(160, bloomRimParticle);
    add(50, function (n) {
      return circleEdgeParticle(n % 2, true);
    });
    add(160, fieldParticle);
    add(70, crossParticle);
    add(620, surroundParticle);

    particles = list;
    posed = new Array(list.length);

    pairs = [];
    var byGlyph = [[], [], [], []];
    list.forEach(function (p, index) {
      if (p.layer === "rim" || p.layer === "rimBloom") byGlyph[p.glyph].push(index);
    });
    byGlyph.forEach(function (group) {
      var k;
      for (k = 0; k < group.length - 1; k += 10) {
        pairs.push(group[k], group[k + 1]);
      }
    });
  }

  function makeParticle(rng, spec) {
    var shape = spec.orbit === "shape";
    return {
      x: spec.x,
      y: spec.y,
      cx: spec.cx != null ? spec.cx : 0.5,
      cy: spec.cy != null ? spec.cy : 0.5,
      orbit: spec.orbit === "globe" ? "globe" : shape ? "shape" : "frame",
      rx: spec.rx || 0,
      ry: spec.ry || 0,
      ox: spec.ox,
      oy: spec.oy,
      revs: spec.revs != null ? spec.revs : shape ? Model.SHAPE_REVS : Model.FRAME_REVS,
      revsZ: spec.revs != null ? spec.revs : shape ? Model.SHAPE_REVS : Model.FRAME_REVS,
      revsW: 1,
      phase: rng(),
      phaseZ: rng(),
      phaseW: rng(),
      skew: (rng() - 0.5) * 0.6,
      z0: spec.z0 != null ? spec.z0 : 0,
      size: spec.size,
      alpha: spec.alpha,
      sprite: pickSprite(rng, spec.layer),
      layer: spec.layer,
      glyph: spec.glyph,
      interior: !!spec.interior,
      contain: !!spec.contain,
      xLo: spec.xLo,
      xHi: spec.xHi,
      births: 8 + Math.floor(rng() * 3),
      birthPhase: rng(),
      arc: spec.arc != null ? spec.arc : 0.22 + rng() * 0.12,
      pulseRevs: 1,
    };
  }

  function blit(index, x, y, size, alpha) {
    if (alpha < 0.02 || size < 1) return;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(
      atlas,
      (index % ATLAS_COLS) * CELL,
      Math.floor(index / ATLAS_COLS) * CELL,
      CELL,
      CELL,
      x - size / 2,
      y - size / 2,
      size,
      size,
    );
  }

  function drawSprite(p, pose, w, h) {
    if (pose.env < 0.02 || pose.alpha < 0.02) return;
    var px = pose.x * w;
    var py = pose.y * h;
    var size = pose.scale;
    var glow = glowIndex(p.sprite);
    var limb =
      p.orbit === "globe" ? 1 - Math.abs(pose.ndot || 0) : 1;
    limb = limb * limb;
    if (p.layer === "rimBloom") {
      blit(glow, px, py, size * (p.orbit === "globe" ? 1.7 + 0.7 * limb : 2.05), pose.alpha * (0.22 + 0.2 * limb));
      blit(SHINE, px, py, size * (0.7 + 0.35 * limb), pose.alpha * (p.orbit === "globe" ? 0.28 + 0.55 * limb : 0.58));
    } else if (p.layer === "rim") {
      blit(glow, px, py, size * (1.25 + 0.45 * limb), pose.alpha * (0.12 + 0.16 * limb));
      blit(SHINE, px, py, size * (0.42 + 0.28 * limb), pose.alpha * (p.orbit === "globe" ? 0.1 + 0.32 * limb : 0.22));
    } else {
      blit(glow, px, py, size * 1.2, pose.alpha * 0.11);
    }
    blit(p.sprite, px, py, size, pose.alpha);
  }

  function posesAt(cycle) {
    var i;
    for (i = 0; i < particles.length; i++) {
      posed[i] = Model.poseParticle(particles[i], cycle);
    }
    return posed;
  }

  function draw(cycle, bg) {
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    ctx.setTransform(dprNow, 0, 0, dprNow, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (bg === "void") {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);
    }

    var posedNow = posesAt(cycle);
    var i, a, b, pa, pb, dx, dy, dist;

    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(210, 228, 255, 0.14)";
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    for (i = 0; i < pairs.length; i += 2) {
      a = pairs[i];
      b = pairs[i + 1];
      pa = posedNow[a];
      pb = posedNow[b];
      if (pa.env < 0.25 || pb.env < 0.25) continue;
      dx = pa.x - pb.x;
      dy = pa.y - pb.y;
      dist = Math.hypot(dx, dy);
      if (dist > 0.05 || pa.alpha < 0.1 || pb.alpha < 0.1) continue;
      ctx.moveTo(pa.x * w, pa.y * h);
      ctx.lineTo(pb.x * w, pb.y * h);
    }
    ctx.stroke();

    ctx.globalCompositeOperation = bg === "void" ? "lighter" : "source-over";
    var behind = [];
    var ahead = [];
    var coreOrder = [];
    for (i = 0; i < particles.length; i++) {
      if (particles[i].layer === "core") {
        coreOrder.push(i);
        continue;
      }
      if (particles[i].orbit !== "frame") continue;
      if (posedNow[i].z < 0) behind.push(i);
      else ahead.push(i);
    }
    behind.sort(function (a, b) {
      return posedNow[a].z - posedNow[b].z;
    });
    ahead.sort(function (a, b) {
      return posedNow[a].z - posedNow[b].z;
    });
    coreOrder.sort(function (a, b) {
      return posedNow[a].z - posedNow[b].z;
    });
    for (i = 0; i < behind.length; i++) {
      drawSprite(particles[behind[i]], posedNow[behind[i]], w, h);
    }
    for (i = 0; i < coreOrder.length; i++) {
      drawSprite(particles[coreOrder[i]], posedNow[coreOrder[i]], w, h);
    }
    for (i = 0; i < particles.length; i++) {
      if (particles[i].layer === "rim") drawSprite(particles[i], posedNow[i], w, h);
    }
    for (i = 0; i < particles.length; i++) {
      if (particles[i].layer === "rimBloom") drawSprite(particles[i], posedNow[i], w, h);
    }
    for (i = 0; i < ahead.length; i++) {
      drawSprite(particles[ahead[i]], posedNow[ahead[i]], w, h);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  function nowCycle() {
    if (freezeCycle !== null) return Model.wrap01(freezeCycle);
    if (reduced) return 0;
    return Model.wrap01((performance.now() - startMs) / LOOP_MS);
  }

  function tick() {
    if (!running) return;
    var stage = document.querySelector(".stage");
    var bg = stage ? stage.getAttribute("data-bg") || "void" : "void";
    lastBg = bg;
    draw(nowCycle(), bg);
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    startMs = performance.now();
    var stage = document.querySelector(".stage");
    var bg = stage ? stage.getAttribute("data-bg") || "void" : "void";
    draw(nowCycle(), bg);
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (ctx && canvas) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  function init() {
    host = document.querySelector(".mark");
    canvas = document.getElementById("live");
    if (!host || !canvas || !canvas.getContext) return;
    ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var params = new URLSearchParams(location.search);
    if (params.get("still") === "1") reduced = true;
    if (params.has("cycle")) freezeCycle = Number(params.get("cycle")) || 0;
    buildAtlas();
    buildOccupancy();
    spawn();
    fitCanvas();
    window.addEventListener("resize", fitCanvas);
    if (window.ResizeObserver) {
      new ResizeObserver(fitCanvas).observe(host);
    }
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else if (running) {
        tick();
      }
    });
    if (document.fonts && document.fonts.load) {
      document.fonts
        .load(FONT)
        .then(function () {
          if (!atlas || running) return;
          buildAtlas();
        })
        .catch(function () {});
    }
  }

  window.ZerosLogoField = {
    init: init,
    start: start,
    stop: stop,
    isRunning: function () {
      return running;
    },
    snapshot: function (cycle) {
      if (!ctx) return null;
      draw(Model.wrap01(cycle), "void");
      return canvas.toDataURL("image/png");
    },
  };
})();
