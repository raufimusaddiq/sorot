// three: a Three.js scene drawn from timeline time. Everything random comes from ctx.rand at mount;
// render(t) only reads t, so any frame can be drawn in any order. The canvas keeps its drawing
// buffer so the frame capture reads what was drawn. Free-level scenes may call
// SorotKit.three.setup(host, ctx) and build their own scene with the THREE it returns.
window.SorotKit = window.SorotKit || {};
window.SorotKit["three"] = {
  setup: function (host, ctx) {
    var THREE = window.THREE;
    if (!THREE) throw new Error("Three.js isn't loaded (kit part three)");
    var W = ctx.size.width, H = ctx.size.height;
    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    var canvas = renderer.domElement;
    canvas.setAttribute("data-kit", "three");
    canvas.style.position = "absolute"; canvas.style.left = "0"; canvas.style.top = "0";
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    host.appendChild(canvas);
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(35, W / H, 0.1, 200);
    // key light from the film's angle (0 = from the top, 90 = from the right), plus a soft fill
    var rad = (ctx.look.keyLightDeg * Math.PI) / 180;
    var key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(Math.sin(rad) * 10, Math.cos(rad) * 10, 8);
    scene.add(key);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.1));
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    return { THREE: THREE, renderer: renderer, scene: scene, camera: camera, draw: function () { renderer.render(scene, camera); } };
  },
  mount: function (host, s, ctx) {
    var kit = this.setup(host, ctx);
    var THREE = kit.THREE;
    var color = new THREE.Color(s.color || ctx.look.palette[2] || ctx.look.palette[1] || "#d4a017");
    var mat = s.material === "metal"
      ? new THREE.MeshStandardMaterial({ color: color, metalness: 0.55, roughness: 0.3 })
      : s.material === "gloss"
        ? new THREE.MeshStandardMaterial({ color: color, metalness: 0.1, roughness: 0.15 })
        : new THREE.MeshStandardMaterial({ color: color, metalness: 0, roughness: 0.85 });
    var geo = {
      cube: function () { return new THREE.BoxGeometry(1.4, 1.4, 1.4); },
      sphere: function () { return new THREE.SphereGeometry(0.9, 48, 32); },
      torus: function () { return new THREE.TorusGeometry(0.8, 0.3, 32, 96); },
      coin: function () { return new THREE.CylinderGeometry(1, 1, 0.16, 64); },
      cylinder: function () { return new THREE.CylinderGeometry(0.7, 0.7, 1.6, 48); },
    }[s.shape] || function () { return new THREE.BoxGeometry(1.4, 1.4, 1.4); };
    var g = geo();
    var items = [];
    for (var i = 0; i < s.count; i++) {
      var m = new THREE.Mesh(g, mat);
      var one = s.count === 1;
      m.position.set(one ? 0 : (ctx.rand() - 0.5) * s.spread * 2, one ? 0 : (ctx.rand() - 0.5) * s.spread * 3, one ? 0 : (ctx.rand() - 0.5) * s.spread);
      var base = { x: ctx.rand() * Math.PI * 2, y: ctx.rand() * Math.PI * 2, speed: 0.6 + ctx.rand() * 0.8 };
      if (s.shape === "coin") base.x = Math.PI / 2 - 0.4;
      kit.scene.add(m);
      items.push({ mesh: m, base: base });
    }
    var dist = s.count === 1 ? 9 : 10 + s.spread * 2;
    return {
      render: function (t) {
        var p = ctx.duration > 0 ? Math.min(1, t / ctx.duration) : 0;
        var eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          it.mesh.rotation.x = it.base.x;
          it.mesh.rotation.y = it.base.y + t * s.spin * it.base.speed;
        }
        var angle = 0, d = dist;
        if (s.camera === "orbit") angle = eased * Math.PI * 0.5 - Math.PI * 0.25;
        if (s.camera === "dolly-in") d = dist * (1 - 0.35 * eased);
        if (s.camera === "dolly-out") d = dist * (0.65 + 0.35 * eased);
        kit.camera.position.set(Math.sin(angle) * d, 0.6, Math.cos(angle) * d);
        kit.camera.lookAt(0, 0, 0);
        kit.draw();
      },
    };
  },
};
