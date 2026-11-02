// motion: role-based eases (arrive expo.out, travel power2.inOut, leave power3.in; a leave is 45%
// shorter than an arrival), an optional precomputed spring and an arc path. Pure functions of time.
window.SorotKit = window.SorotKit || {};
window.SorotKit["motion"] = {
  // A damped spring as an ease: simulated once until it settles, then that time is stretched over the
  // move, so the overshoot and settle fill the whole move (an earlier table ran 4 s of simulation into
  // the move and popped in its first two frames).
  spring: function (damping, stiffness) {
    var x = 0, v = 0, dt = 1 / 240, table = [0];
    for (var i = 0; i < 4800; i++) {
      var a = stiffness * (1 - x) - damping * v;
      v += a * dt; x += v * dt;
      table.push(x);
      if (i > 24 && Math.abs(1 - x) < 0.001 && Math.abs(v) < 0.01) break;
    }
    var steps = table.length - 1;
    return function (p) {
      if (p >= 1) return 1;
      var f = Math.max(0, p) * steps, k = Math.floor(f), r = f - k;
      return table[k] + (table[k + 1] - table[k]) * r;
    };
  },
  mount: function (host, s, ctx) {
    var EASE = { arrive: "expo.out", travel: "power2.inOut", leave: "power3.in" };
    var targets = s.target ? host.querySelectorAll(s.target) : host.children;
    var length = s.role === "leave" ? s.length * 0.55 : s.length;
    var ease = s.spring && s.role !== "leave" ? this.spring(12, 170) : EASE[s.role] || EASE.arrive;
    var d = s.distance;
    var off = { below: { y: d }, above: { y: -d }, left: { x: -d }, right: { x: d }, scale: { scale: 0.6 }, fade: {} }[s.from] || { y: d };
    for (var i = 0; i < targets.length; i++) {
      var el = targets[i];
      var at = ctx.start + s.at + i * s.stagger;
      var rest = { x: 0, y: 0, scale: 1, opacity: 1 };
      var away = { x: off.x || 0, y: off.y || 0, scale: off.scale || 1, opacity: 0 };
      var from = s.role === "leave" ? rest : away;
      var to = s.role === "leave" ? away : rest;
      if (s.role === "travel") { from = { x: -(off.x || 0), y: -(off.y || 0) }; to = { x: off.x || 0, y: off.y || 0 }; }
      if (s.path === "arc" && (off.x || off.y)) {
        // x and y on different eases bend the path into an arc
        ctx.tl.fromTo(el, { x: from.x, opacity: from.opacity === undefined ? 1 : from.opacity, scale: from.scale === undefined ? 1 : from.scale },
          { x: to.x, opacity: to.opacity === undefined ? 1 : to.opacity, scale: to.scale === undefined ? 1 : to.scale, duration: length, ease: "none" }, at);
        ctx.tl.fromTo(el, { y: from.y }, { y: to.y, duration: length, ease: s.role === "leave" ? "power2.in" : "power2.out" }, at);
      } else {
        var t = { duration: length, ease: ease };
        for (var k in to) t[k] = to[k];
        ctx.tl.fromTo(el, from, t, at);
      }
    }
  },
};
