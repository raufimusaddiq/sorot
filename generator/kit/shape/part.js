// shape: draws a subject from simple shapes, lit from the film's key light, in a layout, and grows them in.
// Sizes and places are fractions of the frame; scatter places come from ctx.rand (seeded).
window.SorotKit = window.SorotKit || {};
window.SorotKit["shape"] = {
  // each kind as an SVG path in a 100 x 100 box (a plain box for circle, square, bar)
  paths: {
    petal: "M50 2 C78 22 78 70 50 98 C22 70 22 22 50 2 Z",
    leaf: "M50 2 C88 30 80 78 50 98 C20 78 12 30 50 2 Z M50 10 L50 92",
    star: "M50 3 L62 37 L98 38 L69 59 L79 95 L50 74 L21 95 L31 59 L2 38 L38 37 Z",
    arrow: "M8 40 L60 40 L60 18 L94 50 L60 82 L60 60 L8 60 Z",
    drop: "M50 2 C50 2 86 46 86 66 A36 34 0 0 1 14 66 C14 46 50 2 50 2 Z",
    heart: "M50 92 C20 70 2 52 2 32 A24 24 0 0 1 50 22 A24 24 0 0 1 98 32 C98 52 80 70 50 92 Z",
  },
  mount: function (host, s, ctx) {
    var W = ctx.size.width, H = ctx.size.height, pal = ctx.look.palette;
    var color = s.color || pal[2] || pal[1] || "#f0a21e";
    var ink = pal[1] || "#222222";
    var n = s.arrange === "single" ? 1 : s.count;
    var unit = W * s.size;
    var rad = (ctx.look.keyLightDeg * Math.PI) / 180;
    var away = (ctx.look.keyLightDeg + 180) % 360;
    var cx = W * s.x, cy = H * s.y, span = W * (0.15 + 0.7 * s.spread);
    var place = [];
    for (var i = 0; i < n; i++) {
      var px = cx, py = cy, rot = s.rotate, scale = 1;
      if (s.arrange === "row") { px = cx + (n === 1 ? 0 : (i / (n - 1) - 0.5) * span); }
      else if (s.arrange === "column") { py = cy + (n === 1 ? 0 : (i / (n - 1) - 0.5) * span); }
      else if (s.arrange === "grid") {
        var cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
        px = cx + (cols === 1 ? 0 : ((i % cols) / (cols - 1) - 0.5) * span);
        py = cy + (rows === 1 ? 0 : (Math.floor(i / cols) / (rows - 1) - 0.5) * span);
      } else if (s.arrange === "radial") {
        // every shape's base sits at the centre and turns about it, so petals and leaves make a flower
        var a = (i / n) * Math.PI * 2;
        px = cx; py = cy; rot = s.rotate + (a * 180) / Math.PI;
      } else if (s.arrange === "stack") { py = cy - i * unit * 0.18; }
      else if (s.arrange === "scatter") { px = cx + (ctx.rand() - 0.5) * span; py = cy + (ctx.rand() - 0.5) * span; rot = s.rotate + (ctx.rand() - 0.5) * 60; }
      else if (s.arrange === "growth") { px = cx + (n === 1 ? 0 : (i / (n - 1) - 0.5) * span); scale = 0.35 + 0.65 * Math.pow((i + 1) / n, 1.6); }
      place.push({ x: px, y: py, rot: rot, scale: scale });
    }
    var els = [];
    for (var j = 0; j < place.length; j++) {
      var p = place[j];
      var w = unit, h = unit;
      if (s.kind === "bar") { w = unit * 0.35; h = unit * p.scale * 2; }
      else if (s.kind === "petal" || s.kind === "leaf") { w = unit * 0.45; h = unit * 0.8; }
      else if (s.kind === "coin" && s.arrange === "stack") { h = unit * 0.28; }
      var el = document.createElement("div");
      el.setAttribute("data-kit", "shape");
      el.style.position = "absolute";
      el.style.width = w + "px"; el.style.height = h + "px";
      el.style.left = p.x - w / 2 + "px";
      el.style.top = (s.kind === "bar" ? p.y + unit - h : s.arrange === "radial" ? p.y - h : p.y - h / 2) + "px";
      el.style.transformOrigin = s.kind === "bar" ? "50% 100%" : s.arrange === "radial" ? "50% 100%" : "50% 50%";
      var light = "linear-gradient(" + away + "deg, rgba(255,255,255,0.35) 0%, rgba(255,255,255,0) 48%, rgba(0,0,0,0.22) 100%)";
      var path = this.paths[s.kind];
      if (path) {
        var id = "g" + Math.floor(ctx.rand() * 1e9);
        el.innerHTML = '<svg viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none" style="overflow:visible">' +
          '<defs><linearGradient id="' + id + '" gradientTransform="rotate(' + (away - 90) + ' 0.5 0.5)"><stop offset="0" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.22"/></linearGradient></defs>' +
          '<path d="' + path + '" fill="' + color + '"/><path d="' + path + '" fill="url(#' + id + ')"' + (s.kind === "leaf" ? ' stroke="' + ink + '" stroke-opacity="0.25" stroke-width="2"' : "") + "/></svg>";
      } else {
        el.style.backgroundColor = color;
        el.style.backgroundImage = light;
        if (s.kind === "circle" || s.kind === "coin" || s.kind === "ring") el.style.borderRadius = "50%";
        if (s.kind === "rounded") el.style.borderRadius = Math.round(w * 0.18) + "px";
        if (s.kind === "bar") el.style.borderRadius = Math.round(w * 0.12) + "px " + Math.round(w * 0.12) + "px 0 0";
        if (s.kind === "ring") { el.style.backgroundColor = "transparent"; el.style.backgroundImage = "none"; el.style.border = Math.max(4, w * 0.12) + "px solid " + color; el.style.boxSizing = "border-box"; }
        if (s.kind === "coin") el.style.boxShadow = "inset " + Math.round(Math.sin(rad) * w * 0.05) + "px " + Math.round(-Math.cos(rad) * w * 0.05) + "px 0 rgba(255,255,255,0.35), inset 0 0 0 " + Math.max(3, w * 0.06) + "px rgba(0,0,0,0.12)";
      }
      host.appendChild(el);
      window.gsap.set(el, { rotation: p.rot });
      els.push({ el: el, p: p });
    }
    var t0 = ctx.start + s.at;
    for (var k = 0; k < els.length; k++) {
      var e = els[k], at = t0 + k * s.stagger, g = s.grow;
      if (g === "none") continue;
      if (g === "pop") ctx.tl.fromTo(e.el, { scale: 0 }, { scale: 1, duration: s.length, ease: "back.out(1.6)" }, at);
      else if (g === "rise") ctx.tl.fromTo(e.el, { y: unit * 0.6, opacity: 0 }, { y: 0, opacity: 1, duration: s.length, ease: "expo.out" }, at);
      else if (g === "bloom") ctx.tl.fromTo(e.el, { scale: 0.2, opacity: 0 }, { scale: 1, opacity: 1, duration: s.length, ease: "power3.out" }, at);
      else if (g === "fill") ctx.tl.fromTo(e.el, { scaleY: 0 }, { scaleY: 1, duration: s.length, ease: "power2.inOut" }, at);
    }
  },
};
