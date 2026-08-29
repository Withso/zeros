// Live Zeros mark — canvas particle field.
// Occupancy comes from the official SVG paths. Motion is periodic so the
// 10s cycle meets itself. No video model, no bottom polar spike.
(function () {
  "use strict";

  var Model = window.ZerosLogoFieldModel;
  if (!Model) return;

  var MAP = 192;
  var LOOP_MS = Model.LOOP_SEC * 1000;
  var CELL = 64;
  var ATLAS_COLS = 8;
  var CHARS = "0123456789()";

  var GOLD = ["#fff8e6", "#f3e2b0", "#e8d9c0", "#f7f1de"];
  var GREEN = "#7dff9a";
  var RED = "#ff4a4a";
  var LINE = "rgba(255,255,255,0.14)";

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

  function buildAtlas() {
    var sheet = document.createElement("canvas");
    sheet.width = ATLAS_COLS * CELL;
    sheet.height = ATLAS_COLS * CELL;
    var g = sheet.getContext("2d");
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "600 42px ui-sans-serif, system-ui, sans-serif";
    var i;
    for (i = 0; i < CHARS.length; i++) {
      var col = i % ATLAS_COLS;
      var row = Math.floor(i / ATLAS_COLS);
      var cx = col * CELL + CELL / 2;
      var cy = row * CELL + CELL / 2;
      g.save();
      g.shadowColor = "rgba(255, 240, 200, 0.9)";
      g.shadowBlur = 10;
      g.fillStyle = GOLD[i % GOLD.length];
      g.fillText(CHARS[i], cx, cy);
      g.restore();
    }
    // red square
    g.fillStyle = RED;
    g.shadowColor = "rgba(255, 70, 70, 0.9)";
    g.shadowBlur = 8;
    roundRect(g, 4 * CELL + 22, 1 * CELL + 22, 20, 20, 3);
    g.fill();
    g.shadowBlur = 0;
    // green arcs
    g.strokeStyle = GREEN;
    g.lineWidth = 4;
    g.lineCap = "round";
    g.shadowColor = "rgba(125, 255, 154, 0.95)";
    g.shadowBlur = 8;
    g.beginPath();
    g.arc(5 * CELL + 32, 1 * CELL + 32, 16, -0.7, 1.4);
    g.stroke();
    g.beginPath();
    g.arc(6 * CELL + 32, 1 * CELL + 32, 14, 2.2, 4.4);
    g.stroke();
    atlas = sheet;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
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

    // Extra field sites in the padded frame (outside the scaled mark).
    var fx, fy;
    for (fy = 0; fy < 48; fy++) {
      for (fx = 0; fx < 48; fx++) {
        var ux = (fx + 0.5) / 48;
        var uy = (fy + 0.5) / 48;
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

    map = { cores: cores, rims: rims, field: field, cross: cross };
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
    var i = Math.floor(rng() * n);
    return i;
  }

  function spawn() {
    var rng = Model.mulberry32(20260829);
    var list = [];
    var id;

    function add(kind, count, siteFn) {
      var n;
      for (n = 0; n < count; n++) list.push(siteFn(kind, n));
    }

    function coreParticle(kind, n) {
      id = n % 4;
      var arr = map.cores[id];
      var idx = pickSite(rng, arr, 2);
      var x = arr[idx * 2] + (rng() - 0.5) * 0.01;
      var y = arr[idx * 2 + 1] + (rng() - 0.5) * 0.01;
      var hero = rng() < 0.04;
      return makeParticle(rng, {
        x: x,
        y: y,
        kind: kind,
        layer: hero ? "hero" : "core",
        glyph: id,
        rx: 0.006 + rng() * 0.018,
        ry: 0.006 + rng() * 0.016,
        ox: (rng() - 0.5) * 0.008,
        oy: (rng() - 0.5) * 0.008,
        revs: 3 + Math.floor(rng() * 3),
        size: hero ? 22 + rng() * 16 : 7 + rng() * 11,
        alpha: hero ? 0.95 : 0.55 + rng() * 0.35,
      });
    }

    function rimParticle(kind) {
      var arr = map.rims;
      var idx = pickSite(rng, arr, 3);
      return makeParticle(rng, {
        x: arr[idx * 3] + (rng() - 0.5) * 0.006,
        y: arr[idx * 3 + 1] + (rng() - 0.5) * 0.006,
        kind: kind,
        layer: "rim",
        glyph: arr[idx * 3 + 2],
        rx: 0.004 + rng() * 0.012,
        ry: 0.004 + rng() * 0.012,
        ox: (rng() - 0.5) * 0.01,
        oy: (rng() - 0.5) * 0.01,
        revs: 4 + Math.floor(rng() * 3),
        size: 6 + rng() * 9,
        alpha: 0.7 + rng() * 0.28,
      });
    }

    function fieldParticle(kind) {
      var arr = map.field;
      var idx = pickSite(rng, arr, 2);
      return makeParticle(rng, {
        x: arr[idx * 2] + (rng() - 0.5) * 0.02,
        y: arr[idx * 2 + 1] + (rng() - 0.5) * 0.02,
        kind: kind,
        layer: "field",
        glyph: -1,
        rx: 0.012 + rng() * 0.05,
        ry: 0.012 + rng() * 0.05,
        ox: (rng() - 0.5) * 0.02,
        oy: (rng() - 0.5) * 0.02,
        revs: 1 + Math.floor(rng() * 2),
        size: 4 + rng() * 8,
        alpha: 0.16 + rng() * 0.28,
      });
    }

    function crossParticle(kind) {
      var arr = map.cross;
      if (!arr.length) return fieldParticle(kind);
      var idx = pickSite(rng, arr, 2);
      return makeParticle(rng, {
        x: arr[idx * 2] + (rng() - 0.5) * 0.012,
        y: arr[idx * 2 + 1] + (rng() - 0.5) * 0.012,
        kind: kind,
        layer: "field",
        glyph: -1,
        rx: 0.01 + rng() * 0.03,
        ry: 0.01 + rng() * 0.03,
        ox: (rng() - 0.5) * 0.012,
        oy: (rng() - 0.5) * 0.012,
        revs: 2 + Math.floor(rng() * 2),
        size: 5 + rng() * 9,
        alpha: 0.22 + rng() * 0.32,
      });
    }

    add("digit", 2600, coreParticle);
    add("paren", 180, coreParticle);
    add("arc", 110, coreParticle);
    add("square", 80, coreParticle);
    add("digit", 640, rimParticle);
    add("arc", 50, rimParticle);
    add("square", 40, rimParticle);
    add("digit", 820, fieldParticle);
    add("paren", 60, fieldParticle);
    add("square", 50, fieldParticle);
    add("arc", 40, fieldParticle);
    add("digit", 220, crossParticle);
    add("paren", 24, crossParticle);

    particles = list;
    posed = new Array(list.length);

    pairs = [];
    var byGlyph = [[], [], [], []];
    list.forEach(function (p, index) {
      if (p.glyph >= 0 && p.layer !== "field") byGlyph[p.glyph].push(index);
    });
    byGlyph.forEach(function (group) {
      var k;
      for (k = 0; k < group.length - 1; k += 7) {
        pairs.push(group[k], group[k + 1]);
      }
    });
  }

  function makeParticle(rng, spec) {
    var kind = spec.kind;
    var sprite;
    if (kind === "square") sprite = 12;
    else if (kind === "arc") sprite = rng() < 0.5 ? 13 : 14;
    else if (kind === "paren") sprite = rng() < 0.5 ? 10 : 11;
    else sprite = Math.floor(rng() * 10);
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
      sprite: sprite,
      kind: kind,
      layer: spec.layer,
      glyph: spec.glyph,
      streak: spec.layer === "core" && rng() < 0.18,
    };
  }

  function spriteCell(index) {
    return {
      sx: (index % ATLAS_COLS) * CELL,
      sy: Math.floor(index / ATLAS_COLS) * CELL,
    };
  }

  function drawSprite(p, pose, glow) {
    var cell = spriteCell(p.sprite);
    var size = pose.scale * (glow ? 1.85 : 1);
    var alpha = pose.alpha * (glow ? 0.22 : 1);
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
    ctx.setTransform(Math.min(2, window.devicePixelRatio || 1), 0, 0, Math.min(2, window.devicePixelRatio || 1), 0, 0);
    ctx.clearRect(0, 0, w, h);
    var voidBg = bg === "void";
    if (voidBg) {
      ctx.fillStyle = "#121212";
      ctx.fillRect(0, 0, w, h);
    }

    var posed = posesAt(cycle);
    var i, a, b, pa, pb, dx, dy, dist;

    ctx.globalCompositeOperation = voidBg ? "lighter" : "source-over";
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 0.7;
    ctx.globalAlpha = voidBg ? 0.22 : 0.18;
    ctx.beginPath();
    for (i = 0; i < pairs.length; i += 2) {
      a = pairs[i];
      b = pairs[i + 1];
      pa = posed[a];
      pb = posed[b];
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
        drawSprite(particles[i], posed[i], glow);
      }
    }

    pass("field", false);
    if (voidBg) pass("core", true);
    pass("core", false);
    if (voidBg) pass("rim", true);
    pass("rim", false);
    pass("hero", true);
    pass("hero", false);

    for (i = 0; i < particles.length; i++) {
      if (!particles[i].streak) continue;
      pa = posed[i];
      if (pa.alpha < 0.12) continue;
      var len = 9 + pa.scale * 0.35;
      var mag = Math.hypot(pa.vx, pa.vy) || 1;
      ctx.globalAlpha = pa.alpha * 0.35;
      ctx.strokeStyle = "rgba(255,248,230,0.5)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(pa.x * w - (pa.vx / mag) * len, pa.y * h - (pa.vy / mag) * len);
      ctx.lineTo(pa.x * w + (pa.vx / mag) * len, pa.y * h + (pa.vy / mag) * len);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  function nowCycle() {
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
    if (running) return;
    running = true;
    startMs = performance.now();
    tick();
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
    ctx = canvas.getContext("2d", { alpha: true });
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
