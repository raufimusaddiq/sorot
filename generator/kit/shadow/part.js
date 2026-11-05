// shadow: an extra element behind each target, filled with a radial gradient (no blur filter).
// Placed from the target's layout on the first frame it is laid out, then it follows the target's
// GSAP x/y/scale every frame, so a moving shape keeps its shadow.
window.SorotKit = window.SorotKit || {};
window.SorotKit["shadow"] = {
  mount: function (host, s, ctx) {
    var gsap = window.gsap;
    var k = Math.max(0, Math.min(1, s.strength));
    var rad = (ctx.look.keyLightDeg * Math.PI) / 180;
    var dx = -Math.sin(rad) * s.distance;
    var dy = Math.cos(rad) * s.distance;
    var away = (ctx.look.keyLightDeg + 180) % 360;
    var targets = s.target ? host.querySelectorAll(s.target) : [host];
    var pairs = [];
    for (var i = 0; i < targets.length; i++) {
      var el = targets[i];
      if (!el.parentNode) continue;
      var sh = document.createElement("div");
      sh.setAttribute("data-kit", "shadow");
      sh.style.position = "absolute";
      sh.style.pointerEvents = "none";
      if (s.kind === "contact") sh.style.background = "radial-gradient(ellipse at 50% 50%, rgba(0,0,0," + (0.85 * k).toFixed(3) + ") 0%, rgba(0,0,0,0) 70%)";
      else if (s.kind === "long") sh.style.background = "linear-gradient(" + away + "deg, rgba(0,0,0," + (0.45 * k).toFixed(3) + ") 0%, rgba(0,0,0,0) 100%)";
      else sh.style.background = "radial-gradient(ellipse at 50% 50%, rgba(0,0,0," + (0.35 * k).toFixed(3) + ") 30%, rgba(0,0,0,0) 70%)";
      el.parentNode.insertBefore(sh, el);
      pairs.push({ el: el, sh: sh, placed: false });
    }
    function place(p) {
      var w = p.el.offsetWidth, h = p.el.offsetHeight, x = p.el.offsetLeft, y = p.el.offsetTop;
      if (!w || !h) return;
      if (s.kind === "contact") { x -= w * 0.08; y += h * 0.9; h = Math.max(16, h * 0.18); w *= 1.16; }
      else if (s.kind === "soft") { x -= w * 0.15; y -= h * 0.15; w *= 1.3; h *= 1.3; }
      else p.sh.style.borderRadius = getComputedStyle(p.el).borderRadius;
      p.sh.style.left = x + "px"; p.sh.style.top = y + "px"; p.sh.style.width = w + "px"; p.sh.style.height = h + "px";
      p.placed = true;
    }
    var off = s.kind === "contact" ? [0, 0] : s.kind === "long" ? [dx * 1.5, dy * 1.5] : [dx, dy];
    return {
      render: function () {
        for (var i = 0; i < pairs.length; i++) {
          var p = pairs[i];
          if (!p.placed) place(p);
          gsap.set(p.sh, {
            x: Number(gsap.getProperty(p.el, "x")) + off[0],
            y: Number(gsap.getProperty(p.el, "y")) + off[1],
            scale: Number(gsap.getProperty(p.el, "scale")) * (s.kind === "long" ? 1.15 : 1),
            opacity: Number(gsap.getProperty(p.el, "opacity")),
          });
        }
      },
    };
  },
};
