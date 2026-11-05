// particles: positions come from the seeded ctx.rand at mount; render(t) draws time t from them only.
window.SorotKit = window.SorotKit || {};
window.SorotKit["particles"] = {
  mount: function (host, s, ctx) {
    var W = ctx.size.width, H = ctx.size.height;
    var canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    canvas.setAttribute("data-kit", "particles");
    canvas.style.position = "absolute"; canvas.style.left = "0"; canvas.style.top = "0";
    canvas.style.width = W + "px"; canvas.style.height = H + "px"; canvas.style.pointerEvents = "none";
    host.appendChild(canvas);
    var g = canvas.getContext("2d");
    var pal = ctx.look.palette;
    var top = s.area === "bottom" ? H * 0.5 : 0, bottom = s.area === "top" ? H * 0.5 : H;
    var ps = [];
    for (var i = 0; i < s.count; i++) {
      ps.push({
        x: ctx.rand() * W, y: top + ctx.rand() * (bottom - top), r: s.size * (0.4 + ctx.rand() * 0.8),
        v: 0.4 + ctx.rand(), phase: ctx.rand() * Math.PI * 2, spin: ctx.rand() * 2 - 1,
        color: s.color || pal[1 + Math.floor(ctx.rand() * Math.max(1, pal.length - 1))] || "#ffffff",
      });
    }
    var span = bottom - top;
    return {
      render: function (t) {
        g.clearRect(0, 0, W, H);
        for (var i = 0; i < ps.length; i++) {
          var p = ps[i];
          var x = p.x, y = p.y, a = 1;
          if (s.kind === "snow" || s.kind === "confetti") {
            y = top + (((p.y - top) + t * 120 * s.speed * p.v) % span);
            x = p.x + Math.sin(p.phase + t * 1.3 * p.v) * 24;
          } else if (s.kind === "bubbles") {
            y = bottom - (((bottom - p.y) + t * 140 * s.speed * p.v) % span);
            x = p.x + Math.sin(p.phase + t * 2 * p.v) * 12; a = 0.5;
          } else if (s.kind === "sparks") {
            a = 0.5 + 0.5 * Math.sin(p.phase + t * 6 * p.v);
          } else {
            y = p.y + Math.sin(p.phase + t * p.v) * 10 * s.speed;
          }
          g.globalAlpha = Math.max(0, Math.min(1, a));
          g.fillStyle = p.color;
          if (s.kind === "confetti") {
            g.save(); g.translate(x, y); g.rotate(p.phase + t * 3 * p.spin);
            g.fillRect(-p.r, -p.r * 0.4, p.r * 2, p.r * 0.8); g.restore();
          } else if (s.kind === "bubbles") {
            g.beginPath(); g.arc(x, y, p.r * 1.5, 0, Math.PI * 2); g.lineWidth = 2; g.strokeStyle = p.color; g.stroke();
          } else {
            g.beginPath(); g.arc(x, y, p.r, 0, Math.PI * 2); g.fill();
          }
        }
        g.globalAlpha = 1;
      },
    };
  },
};
