// Live Zeros mark — canvas particle field.
// Occupancy comes from the official SVG paths. Motion is periodic so the
// 10s cycle meets itself. No video model, no bottom polar spike.
(function () {
  "use strict";

  var Model = window.ZerosLogoFieldModel;
  if (!Model) return;

  var MAP = 192;
  var LOOP_MS = Model.LOOP_SEC * 1000;
  var CELL = 96;
  var ATLAS_COLS = 8;
  var SYM = "()[]{}<>/|_-=+*#;:,.";
  var FONT = "100 52px 'JetBrains Mono', ui-monospace, monospace";

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
  var ready = false;
  var wantStart = false;

  function fitCanvas() {
    if (!canvas || !host) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.max(1, host.clientWidth);
    var h = Math.max(1, host.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function tintFor(kind) {
    if (kind === "gold") {
      return {
        fill: "rgba(236, 226, 200, 0.14)",
        rim: "#fff8ee",
        bloom: "rgba(255, 236, 210, 0.42)",
        solid: "#f3ead4",
      };
    }
    if (kind === "mint") {
      return {
        fill: "rgba(186, 245, 220, 0.14)",
        rim: "#eafff6",
        bloom: "rgba(170, 255, 220, 0.4)",
        solid: "#d8ffe9",
      };
    }
    return {
      fill: "rgba(214, 232, 250, 0.12)",
      rim: "#f4fbff",
      bloom: "rgba(210, 232, 255, 0.58)",
      solid: "#e8f2ff",
    };
  }

  function paintZero(g, cx, cy, kind) {
    var t = tintFor(kind);
    var rx = 18;
    var ry = 22;
    g.save();
    g.shadowColor = t.bloom;
    g.shadowBlur = 20;
    g.strokeStyle = t.rim;
    g.lineWidth = 1.7;
    g.lineCap = "round";
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    g.stroke();
    g.restore();

    g.strokeStyle = "#ffffff";
    g.lineWidth = 1.15;
    g.shadowColor = "rgba(255, 255, 255, 0.95)";
    g.shadowBlur = 5;
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    g.stroke();

    g.shadowBlur = 3;
    g.lineWidth = 1.55;
    g.beginPath();
    g.ellipse(cx, cy, rx, ry, -0.4, -1.05, 0.7);
    g.stroke();
    g.shadowBlur = 0;
  }

  function paintChar(g, ch, cx, cy, kind) {
    var t = tintFor(kind);
    g.save();
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = FONT;
    g.lineJoin = "round";
    g.lineCap = "round";
    g.shadowColor = t.bloom;
    g.shadowBlur = 16;
    g.strokeStyle = t.rim;
    g.lineWidth = 1.05;
    g.strokeText(ch, cx, cy);
    g.restore();

    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = FONT;
    g.fillStyle = t.fill;
    g.fillText(ch, cx, cy);
    g.strokeStyle = "#ffffff";
    g.lineWidth = 0.85;
    g.shadowColor = "rgba(255, 255, 255, 0.9)";
    g.shadowBlur = 4;
    g.strokeText(ch, cx, cy);
    g.shadowBlur = 0;
  }

  function paintSquare(g, cx, cy) {
    var s = 11;
    g.shadowColor = "rgba(255, 70, 70, 0.85)";
    g.shadowBlur = 6;
    g.fillStyle = "#ff3b3b";
    g.fillRect(cx - s / 2, cy - s / 2, s, s);
    g.shadowBlur = 0;
  }

  function cellCenter(index) {
    return {
      x: (index % ATLAS_COLS) * CELL + CELL / 2,
      y: Math.floor(index / ATLAS_COLS) * CELL + CELL / 2,
    };
  }

  function buildAtlas() {
    var sheet = document.createElement("canvas");
    sheet.width = ATLAS_COLS * CELL;
    sheet.height = 5 * CELL;
    var g = sheet.getContext("2d");
    var i;
    var c;

    paintZero(g, cellCenter(0).x, cellCenter(0).y, "ice");
    for (i = 1; i <= 9; i++) {
      c = cellCenter(i);
      paintChar(g, String(i), c.x, c.y, "ice");
    }
    for (i = 0; i < SYM.length; i++) {
      c = cellCenter(10 + i);
      paintChar(g, SYM[i], c.x, c.y, "ice");
    }
    paintZero(g, cellCenter(30).x, cellCenter(30).y, "gold");
    paintChar(g, "(", cellCenter(31).x, cellCenter(31).y, "gold");
    paintChar(g, ")", cellCenter(32).x, cellCenter(32).y, "mint");
    paintChar(g, "[", cellCenter(33).x, cellCenter(33).y, "mint");
    paintSquare(g, cellCenter(34).x, cellCenter(34).y);
    paintZero(g, cellCenter(35).x, cellCenter(35).y, "mint");
    paintChar(g, "{", cellCenter(36).x, cellCenter(36).y, "ice");
    paintChar(g, "}", cellCenter(37).x, cellCenter(37).y, "gold");
    atlas = sheet;
  }

  function inBounds(x, y) {
    return x >= 0 && y >= 0 && x < MAP && y < MAP;
  }

  function touchesOutside(x, y, inside, radius) {
    var r, c, xx, yy;
    for (r = -radius; r <= radius; r++) {
      for (c = -radius; c <= radius; c++) {
        xx = x + c;
        yy = y + r;
        if (!inBounds(xx, yy) || !inside[yy * MAP + xx]) return true;
      }
    }
    return false;
  }

  function touchesInside(x, y, inside, radius) {
    var r, c, xx, yy;
    for (r = -radius; r <= radius; r++) {
      for (c = -radius; c <= radius; c++) {
        xx = x + c;
        yy = y + r;
        if (inBounds(xx, yy) && inside[yy * MAP + xx]) return true;
      }
    }
    return false;
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

    var shells = [[], [], [], []];
    var hollows = [[], [], [], []];
    var rims = [];
    var field = [];
    for (y = 0; y < MAP; y++) {
      for (x = 0; x < MAP; x++) {
        i = y * MAP + x;
        var pt = Model.logoToUnit(((x + 0.5) / MAP) * 128, ((y + 0.5) / MAP) * 128);
        var inn = inside[i];
        var edge =
          inn &&
          (x === 0 ||
            y === 0 ||
            x === MAP - 1 ||
            y === MAP - 1 ||
            !inside[i - 1] ||
            !inside[i + 1] ||
            !inside[i - MAP] ||
            !inside[i + MAP]);
        var leak = !inn && touchesInside(x, y, inside, 3);
        var shell = inn && touchesOutside(x, y, inside, 5);
        if (inn && shell) shells[glyph[i]].push(pt.x, pt.y);
        else if (inn) hollows[glyph[i]].push(pt.x, pt.y);
        if (edge || leak) rims.push(pt.x, pt.y, nearestGlyph(x, y, glyph));
        if (!inn && !leak) field.push(pt.x, pt.y);
      }
    }

    var fx, fy;
    for (fy = 0; fy < 28; fy++) {
      for (fx = 0; fx < 28; fx++) {
        var ux = (fx + 0.5) / 28;
        var uy = (fy + 0.5) / 28;
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

    map = { shells: shells, hollows: hollows, rims: rims, field: field, cross: cross };
    if (canvas) {
      canvas.dataset.shellSites = String(
        shells.reduce(function (n, arr) {
          return n + arr.length / 2;
        }, 0),
      );
      canvas.dataset.rimSites = String(rims.length / 3);
      canvas.dataset.fieldSites = String(field.length / 2);
    }
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

  function pickSprite(rng, kind) {
    if (kind === "square") return 34;
    if (kind === "hero") {
      var h = rng();
      if (h < 0.64) return 0;
      if (h < 0.8) return 30;
      if (h < 0.9) return 35;
      return rng() < 0.5 ? 10 : 11;
    }
    if (kind === "mint") return rng() < 0.5 ? 32 : 33;
    var r = rng();
    if (r < 0.07) return 30;
    if (r < 0.11) return rng() < 0.5 ? 32 : 33;
    if (r < 0.4) return 0;
    if (r < 0.68) return 1 + Math.floor(rng() * 9);
    return 10 + Math.floor(rng() * SYM.length);
  }

  function spawn() {
    var rng = Model.mulberry32(20260829);
    var list = [];

    function add(kind, count, siteFn) {
      var n;
      for (n = 0; n < count; n++) list.push(siteFn(kind, n));
    }

    function fromPair(arr, jitter) {
      if (!arr || arr.length < 2) return { x: 0.5, y: 0.5 };
      var idx = pickSite(rng, arr, 2);
      return {
        x: arr[idx * 2] + (rng() - 0.5) * jitter,
        y: arr[idx * 2 + 1] + (rng() - 0.5) * jitter,
      };
    }

    function shellParticle(kind, n) {
      var id = n % 4;
      var pt = fromPair(map.shells[id], 0.012);
      return makeParticle(rng, {
        x: pt.x,
        y: pt.y,
        kind: kind,
        layer: "core",
        glyph: id,
        rx: 0.004 + rng() * 0.01,
        ry: 0.004 + rng() * 0.009,
        ox: (rng() - 0.5) * 0.01,
        oy: (rng() - 0.5) * 0.01,
        revs: 3 + Math.floor(rng() * 3),
        size: 36 + rng() * 16,
        alpha: 0.42 + rng() * 0.3,
      });
    }

    function hollowParticle(kind, n) {
      var id = n % 4;
      var arr = map.hollows[id];
      var pt = fromPair(arr && arr.length ? arr : map.shells[id], 0.016);
      return makeParticle(rng, {
        x: pt.x,
        y: pt.y,
        kind: kind,
        layer: "field",
        glyph: id,
        rx: 0.008 + rng() * 0.02,
        ry: 0.008 + rng() * 0.018,
        ox: (rng() - 0.5) * 0.012,
        oy: (rng() - 0.5) * 0.012,
        revs: 2 + Math.floor(rng() * 3),
        size: 26 + rng() * 12,
        alpha: 0.18 + rng() * 0.2,
      });
    }

    function rimParticle(kind) {
      var arr = map.rims;
      var idx = pickSite(rng, arr, 3);
      return makeParticle(rng, {
        x: arr[idx * 3] + (rng() - 0.5) * 0.01,
        y: arr[idx * 3 + 1] + (rng() - 0.5) * 0.01,
        kind: kind,
        layer: "rim",
        glyph: arr[idx * 3 + 2],
        rx: 0.003 + rng() * 0.008,
        ry: 0.003 + rng() * 0.008,
        ox: (rng() - 0.5) * 0.012,
        oy: (rng() - 0.5) * 0.012,
        revs: 4 + Math.floor(rng() * 3),
        size: 42 + rng() * 18,
        alpha: 0.7 + rng() * 0.28,
      });
    }

    function heroParticle(kind) {
      var arr = map.rims;
      var idx = pickSite(rng, arr, 3);
      return makeParticle(rng, {
        x: arr[idx * 3] + (rng() - 0.5) * 0.008,
        y: arr[idx * 3 + 1] + (rng() - 0.5) * 0.008,
        kind: kind,
        layer: "hero",
        glyph: arr[idx * 3 + 2],
        rx: 0.004 + rng() * 0.007,
        ry: 0.004 + rng() * 0.007,
        ox: (rng() - 0.5) * 0.008,
        oy: (rng() - 0.5) * 0.008,
        revs: 3 + Math.floor(rng() * 2),
        size: 78 + rng() * 36,
        alpha: 0.9 + rng() * 0.08,
      });
    }

    function fieldParticle(kind) {
      var arr = map.field;
      var idx = pickSite(rng, arr, 2);
      return makeParticle(rng, {
        x: arr[idx * 2] + (rng() - 0.5) * 0.03,
        y: arr[idx * 2 + 1] + (rng() - 0.5) * 0.03,
        kind: kind,
        layer: "field",
        glyph: -1,
        rx: 0.016 + rng() * 0.055,
        ry: 0.016 + rng() * 0.055,
        ox: (rng() - 0.5) * 0.022,
        oy: (rng() - 0.5) * 0.022,
        revs: 1 + Math.floor(rng() * 2),
        size: 24 + rng() * 14,
        alpha: 0.16 + rng() * 0.24,
      });
    }

    function crossParticle(kind) {
      var arr = map.cross;
      if (!arr.length) return fieldParticle(kind);
      var idx = pickSite(rng, arr, 2);
      return makeParticle(rng, {
        x: arr[idx * 2] + (rng() - 0.5) * 0.014,
        y: arr[idx * 2 + 1] + (rng() - 0.5) * 0.014,
        kind: kind,
        layer: "field",
        glyph: -1,
        rx: 0.012 + rng() * 0.03,
        ry: 0.012 + rng() * 0.03,
        ox: (rng() - 0.5) * 0.014,
        oy: (rng() - 0.5) * 0.014,
        revs: 2 + Math.floor(rng() * 2),
        size: 22 + rng() * 12,
        alpha: 0.2 + rng() * 0.26,
      });
    }

    add("glyph", 260, shellParticle);
    add("glyph", 52, hollowParticle);
    add("glyph", 460, rimParticle);
    add("hero", 26, heroParticle);
    add("mint", 22, rimParticle);
    add("square", 16, rimParticle);
    add("glyph", 140, fieldParticle);
    add("square", 8, fieldParticle);
    add("glyph", 48, crossParticle);

    particles = list;
    posed = new Array(list.length);

    pairs = [];
    var byGlyph = [[], [], [], []];
    list.forEach(function (p, index) {
      if (p.glyph >= 0 && p.layer !== "field") byGlyph[p.glyph].push(index);
    });
    byGlyph.forEach(function (group) {
      var k;
      for (k = 0; k < group.length - 1; k += 4) {
        pairs.push(group[k], group[k + 1]);
      }
    });
  }

  function makeParticle(rng, spec) {
    return {
      x: spec.x,
      y: spec.y,
      rx: spec.rx,
      ry: spec.ry,
      ox: spec.ox,
      oy: spec.oy,
      revs: spec.revs,
      revsZ: spec.revs,
      revsW: 1 + (spec.revs % 2),
      phase: rng(),
      phaseZ: rng(),
      phaseW: rng(),
      skew: (rng() - 0.5) * 0.8,
      size: spec.size,
      alpha: spec.alpha,
      sprite: pickSprite(rng, spec.kind),
      kind: spec.kind,
      layer: spec.layer,
      glyph: spec.glyph,
      births: 2 + Math.floor(rng() * 3),
      birthPhase: rng(),
      pulseRevs: 2 + Math.floor(rng() * 2),
    };
  }

  function spriteCell(index) {
    return {
      sx: (index % ATLAS_COLS) * CELL,
      sy: Math.floor(index / ATLAS_COLS) * CELL,
    };
  }

  function drawSprite(p, pose, glow) {
    if (pose.env < 0.03 || pose.alpha < 0.015) return;
    var cell = spriteCell(p.sprite);
    var size = pose.scale * (glow ? 1.7 + 0.2 * pose.pulse : 1);
    var alpha = pose.alpha * (glow ? 0.2 * pose.pulse : 1);
    if (alpha < 0.02) return;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(
      atlas,
      cell.sx,
      cell.sy,
      CELL,
      CELL,
      pose.x * canvas.clientWidth - size / 2,
      pose.y * canvas.clientHeight - size / 2,
      size,
      size,
    );
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
    ctx.setTransform(
      Math.min(2, window.devicePixelRatio || 1),
      0,
      0,
      Math.min(2, window.devicePixelRatio || 1),
      0,
      0,
    );
    ctx.clearRect(0, 0, w, h);
    var voidBg = bg === "void";
    if (voidBg) {
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, w, h);
    }

    var posedNow = posesAt(cycle);
    var i, a, b, pa, pb, dx, dy, dist;

    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(220, 235, 255, 0.16)";
    ctx.lineWidth = 0.55;
    ctx.globalAlpha = 0.22;
    ctx.beginPath();
    for (i = 0; i < pairs.length; i += 2) {
      a = pairs[i];
      b = pairs[i + 1];
      pa = posedNow[a];
      pb = posedNow[b];
      if (pa.env < 0.22 || pb.env < 0.22) continue;
      dx = pa.x - pb.x;
      dy = pa.y - pb.y;
      dist = Math.hypot(dx, dy);
      if (dist > 0.055 || pa.alpha < 0.08 || pb.alpha < 0.08) continue;
      ctx.moveTo(pa.x * w, pa.y * h);
      ctx.lineTo(pb.x * w, pb.y * h);
    }
    ctx.stroke();

    function pass(layer, glow) {
      for (i = 0; i < particles.length; i++) {
        if (particles[i].layer !== layer) continue;
        drawSprite(particles[i], posedNow[i], glow);
      }
    }

    pass("field", false);
    pass("core", false);
    if (voidBg) {
      ctx.globalCompositeOperation = "lighter";
      pass("core", true);
      pass("rim", true);
      pass("hero", true);
      ctx.globalCompositeOperation = "source-over";
    }
    pass("rim", false);
    pass("hero", false);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  var freezeCycle = null;

  function nowCycle() {
    if (freezeCycle !== null) return Model.wrap01(freezeCycle);
    if (reduced) return 0;
    var t = (performance.now() - startMs) / LOOP_MS;
    return Model.wrap01(t);
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
    if (!ready) {
      wantStart = true;
      return;
    }
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

  function boot() {
    buildAtlas();
    buildOccupancy();
    spawn();
    fitCanvas();
    ready = true;
    if (wantStart) start();
  }

  function init() {
    host = document.querySelector(".mark");
    canvas = document.getElementById("live");
    if (!host || !canvas || !canvas.getContext) return;
    ctx = canvas.getContext("2d", { alpha: true });
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var params = new URLSearchParams(location.search);
    if (params.get("still") === "1") reduced = true;
    if (params.has("cycle")) freezeCycle = Number(params.get("cycle")) || 0;
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
    boot();
    if (document.fonts && document.fonts.load) {
      document.fonts.load(FONT).then(function () {
        if (!atlas) return;
        buildAtlas();
      }).catch(function () {});
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
      if (!ctx || !ready) return null;
      draw(Model.wrap01(cycle), "void");
      return canvas.toDataURL("image/png");
    },
  };
})();
