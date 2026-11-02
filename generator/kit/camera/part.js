// camera: one move over the whole shot on a stage element (the host, or `target` inside it).
window.SorotKit = window.SorotKit || {};
window.SorotKit["camera"] = {
  mount: function (host, s, ctx) {
    var gsap = window.gsap;
    var stage = s.target ? host.querySelector(s.target) || host : host;
    var EASE = { travel: "power2.inOut", arrive: "expo.out", linear: "none" };
    var a = Math.max(0, Math.min(1, s.amount));
    var w = ctx.size.width, h = ctx.size.height;
    var base = {};
    if (s.projection === "isometric") {
      host.style.perspective = "none";
      base = { rotationX: 54.7356, rotationZ: -45, transformOrigin: "50% 50%" };
    } else if (s.projection === "perspective") {
      base = { transformPerspective: 1600, rotationX: 12, transformOrigin: "50% 60%" };
    }
    gsap.set(stage, base);
    var from = {}, to = { duration: ctx.duration, ease: EASE[s.ease] || EASE.travel };
    switch (s.move) {
      case "pan-left": from.x = w * a * 0.5; to.x = -w * a * 0.5; break;
      case "pan-right": from.x = -w * a * 0.5; to.x = w * a * 0.5; break;
      case "pan-up": from.y = h * a * 0.5; to.y = -h * a * 0.5; break;
      case "pan-down": from.y = -h * a * 0.5; to.y = h * a * 0.5; break;
      case "zoom-in": from.scale = 1; to.scale = 1 + a; break;
      case "zoom-out": from.scale = 1 + a; to.scale = 1; break;
      case "dolly-in": from.scale = 1; to.scale = 1 + a * 0.6; from.y = 0; to.y = -h * a * 0.08; break;
      case "dolly-out": from.scale = 1 + a * 0.6; to.scale = 1; from.y = -h * a * 0.08; to.y = 0; break;
      default: return;
    }
    ctx.tl.fromTo(stage, from, to, ctx.start);
  },
};
