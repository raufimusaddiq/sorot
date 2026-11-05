// camera: one move over the whole shot on a stage element (the host, or `target` inside it).
// The isometric or perspective projection tilts flat 2D layers; a stage holding a drawn 3D picture
// (the iso or three part's canvas) keeps it upright and gets only the move, whichever part mounts
// first: the camera skips the tilt when the canvas is already there, and those parts call
// unproject() on mount to take back a tilt put on a stage around them.
window.SorotKit = window.SorotKit || {};
window.SorotKit["camera"] = {
  mount: function (host, s, ctx) {
    var gsap = window.gsap;
    var stage = s.target ? host.querySelector(s.target) || host : host;
    var EASE = { travel: "power2.inOut", arrive: "expo.out", linear: "none" };
    var a = Math.max(0, Math.min(1, s.amount));
    var w = ctx.size.width, h = ctx.size.height;
    var drawn3d = stage.querySelector('[data-kit="iso"], [data-kit="three"]');
    if (s.projection === "isometric" && !drawn3d) {
      host.style.perspective = "none";
      gsap.set(stage, { rotationX: 54.7356, rotationZ: -45, transformOrigin: "50% 50%" });
      stage.setAttribute("data-kit-projection", s.projection);
    } else if (s.projection === "perspective" && !drawn3d) {
      gsap.set(stage, { transformPerspective: 1600, rotationX: 12, transformOrigin: "50% 60%" });
      stage.setAttribute("data-kit-projection", s.projection);
    }
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
  // Takes the projection tilt off every stage around `node` (a 3D part's canvas, already drawn in
  // its own projection); the stages keep their moves.
  unproject: function (node) {
    for (var el = node.parentElement; el; el = el.parentElement) {
      if (!el.hasAttribute("data-kit-projection")) continue;
      window.gsap.set(el, { rotationX: 0, rotationZ: 0, transformPerspective: 0 });
      el.removeAttribute("data-kit-projection");
    }
  },
};
