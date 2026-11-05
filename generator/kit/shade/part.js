// shade: lights shapes from the key light with gradients only (no blur filters: they are slow on CPU).
window.SorotKit = window.SorotKit || {};
window.SorotKit["shade"] = {
  mount: function (host, s, ctx) {
    var MAT = {
      matte: { hi: 0.22, lo: 0.32, spot: 0.0, rim: 0.10 },
      paper: { hi: 0.12, lo: 0.16, spot: 0.0, rim: 0.04 },
      gloss: { hi: 0.30, lo: 0.36, spot: 0.55, rim: 0.20 },
      metal: { hi: 0.45, lo: 0.55, spot: 0.80, rim: 0.35 },
      glass: { hi: 0.25, lo: 0.10, spot: 0.70, rim: 0.50 },
    };
    var m = MAT[s.material] || MAT.matte;
    var k = Math.max(0, Math.min(1, s.strength));
    var deg = ctx.look.keyLightDeg;
    // CSS gradient angles run clockwise from "to top"; light comes FROM keyLightDeg (0 = top).
    var away = (deg + 180) % 360;
    var rad = (deg * Math.PI) / 180;
    var sx = Math.round(50 + Math.sin(rad) * 28);
    var sy = Math.round(50 - Math.cos(rad) * 28);
    var targets = s.target ? host.querySelectorAll(s.target) : [host];
    for (var i = 0; i < targets.length; i++) {
      var el = targets[i];
      if (s.color) el.style.backgroundColor = s.color;
      var layers = [];
      if (m.spot > 0) layers.push("radial-gradient(circle at " + sx + "% " + sy + "%, rgba(255,255,255," + (m.spot * k).toFixed(3) + ") 0%, rgba(255,255,255,0) 28%)");
      layers.push("linear-gradient(" + away + "deg, rgba(255,255,255," + (m.hi * k).toFixed(3) + ") 0%, rgba(255,255,255,0) 45%, rgba(0,0,0," + (m.lo * k).toFixed(3) + ") 100%)");
      el.style.backgroundImage = layers.join(", ");
      el.style.boxShadow = "inset " + Math.round(Math.sin(rad) * 6) + "px " + Math.round(-Math.cos(rad) * 6) + "px 0 rgba(255,255,255," + (m.rim * k).toFixed(3) + ")";
    }
  },
};
