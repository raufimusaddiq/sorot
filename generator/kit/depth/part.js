// depth: parallax and haze from each layer's data-depth (0 = nearest, 1 = farthest).
window.SorotKit = window.SorotKit || {};
window.SorotKit["depth"] = {
  mount: function (host, s, ctx) {
    var layers = host.querySelectorAll("[data-depth]");
    var axis = s.direction === "left" || s.direction === "right" ? "x" : "y";
    var sign = s.direction === "left" || s.direction === "up" ? -1 : 1;
    for (var i = 0; i < layers.length; i++) {
      var el = layers[i];
      var d = Math.max(0, Math.min(1, Number(el.getAttribute("data-depth")) || 0));
      // near layers move most; far ones barely move
      var travel = s.amount * (1 - d * 0.85) * sign;
      var from = {}, to = { duration: ctx.duration, ease: "power2.inOut" };
      from[axis] = -travel / 2;
      to[axis] = travel / 2;
      ctx.tl.fromTo(el, from, to, ctx.start);
      if (s.haze > 0 && d > 0) window.gsap.set(el, { opacity: 1 - d * s.haze * 0.6 });
    }
  },
};
