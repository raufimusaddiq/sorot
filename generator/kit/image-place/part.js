// image-place: one image, centred at (x, y) of the frame, as a card, circle or cut-out; the light
// overlay and the shadow follow the key light. The image must be a file in assets/.
window.SorotKit = window.SorotKit || {};
window.SorotKit["image-place"] = {
  mount: function (host, s, ctx) {
    if (!s.asset) return;
    var W = ctx.size.width, H = ctx.size.height;
    var w = W * s.width;
    var box = document.createElement("div");
    box.setAttribute("data-kit", "image-place");
    box.style.position = "absolute";
    box.style.width = w + "px";
    box.style.left = W * s.x - w / 2 + "px";
    box.style.top = H * s.y - w / 2 + "px";
    if (s.as === "circle") { box.style.height = w + "px"; box.style.borderRadius = "50%"; box.style.overflow = "hidden"; }
    else if (s.as === "card") { box.style.borderRadius = Math.round(w * 0.04) + "px"; box.style.overflow = "hidden"; }
    var img = document.createElement("img");
    img.src = s.asset;
    img.style.display = "block"; img.style.width = "100%";
    if (s.as === "circle") { img.style.height = "100%"; img.style.objectFit = "cover"; }
    box.appendChild(img);
    if (s.light && s.as !== "cutout") {
      var lit = document.createElement("div");
      var away = (ctx.look.keyLightDeg + 180) % 360;
      lit.style.position = "absolute"; lit.style.left = "0"; lit.style.top = "0"; lit.style.right = "0"; lit.style.bottom = "0";
      lit.style.background = "linear-gradient(" + away + "deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 50%, rgba(0,0,0,0.22) 100%)";
      box.appendChild(lit);
    }
    if (s.shadow !== "none") {
      var rad = (ctx.look.keyLightDeg * Math.PI) / 180;
      var sh = document.createElement("div");
      sh.style.position = "absolute";
      var contact = s.shadow === "contact";
      sh.style.width = w * (contact ? 1.0 : 1.2) + "px";
      sh.style.height = (contact ? w * 0.12 : w * 1.2) + "px";
      sh.style.left = W * s.x - w * (contact ? 0.5 : 0.6) - Math.sin(rad) * (contact ? 0 : 30) + "px";
      sh.style.top = (contact ? H * s.y + w * 0.45 : H * s.y - w * 0.6) + Math.cos(rad) * (contact ? 0 : 30) + "px";
      sh.style.background = "radial-gradient(ellipse at 50% 50%, rgba(0,0,0," + (contact ? 0.5 : 0.35) + ") 30%, rgba(0,0,0,0) 70%)";
      host.appendChild(sh);
    }
    host.appendChild(box);
    if (s.tilt) window.gsap.set(box, { rotation: s.tilt });
  },
};
