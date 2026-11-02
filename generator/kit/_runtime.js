// Sorot kit runtime: loaded by the root composition before any kit part. It builds the `ctx` every
// part gets and mounts parts with their defaults. Deterministic by construction: a seeded random
// source, motion only on the shot's GSAP timeline, and `render(t)` driven by a timeline tween.
(function () {
  "use strict";
  window.SorotKit = window.SorotKit || {};

  // mulberry32: small, fast, and the same numbers for the same seed on every machine.
  function seeded(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // A text seed (shot id + part + layer) as a number.
  function seedOf(text) {
    var h = 2166136261;
    var s = String(text);
    for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  function look() {
    var l = window.SorotKitLook || {};
    return {
      palette: l.palette && l.palette.length ? l.palette.slice() : ["#101820", "#f2f2f2", "#ffb000"],
      keyLightDeg: typeof l.keyLightDeg === "number" ? l.keyLightDeg : 315,
      size: l.size || { width: 1080, height: 1920 },
      fps: l.fps || 30,
    };
  }

  window.SorotKitRuntime = {
    seeded: seeded,
    seedOf: seedOf,
    // opts: { tl, start?, duration, seed? } (start: where on tl the part's own time 0 is)
    ctx: function (opts) {
      var l = look();
      return {
        tl: opts.tl,
        start: opts.start || 0,
        duration: opts.duration,
        fps: l.fps,
        rand: seeded(typeof opts.seed === "number" ? opts.seed : seedOf(opts.seed || "sorot")),
        look: { palette: l.palette, keyLightDeg: l.keyLightDeg },
        size: l.size,
      };
    },
    // Mounts part `name` into `host` with its defaults under `settings`; a returned render(t) is
    // driven from the timeline, so seeking to any time draws that time.
    mount: function (name, host, settings, opts) {
      var part = window.SorotKit[name];
      if (!part || typeof part.mount !== "function") throw new Error("kit part " + name + " isn't loaded");
      var defaults = (window.SorotKitDefaults || {})[name] || {};
      var merged = {};
      var k;
      for (k in defaults) merged[k] = defaults[k];
      for (k in settings || {}) merged[k] = settings[k];
      var c = this.ctx(opts);
      var out = part.mount(host, merged, c);
      if (out && typeof out.render === "function") {
        var clock = { t: 0 };
        out.render(0);
        c.tl.fromTo(clock, { t: 0 }, {
          t: c.duration, duration: c.duration, ease: "none",
          onUpdate: function () { out.render(clock.t); },
        }, c.start);
      }
      return out;
    },
  };
})();
