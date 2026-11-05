// iso: an isometric diorama in real 3D. Orthographic camera at the classic isometric angle (45° around,
// 35.26° down), a key light from the film's angle casting soft shadows on the floor, palette colours.
// Items rise in one by one; everything is a pure function of timeline time (render(t)).
window.SorotKit = window.SorotKit || {};
window.SorotKit["iso"] = {
  mount: function (host, s, ctx) {
    var THREE = window.THREE;
    if (!THREE) throw new Error("Three.js isn't loaded (kit part iso)");
    var W = ctx.size.width, H = ctx.size.height, pal = ctx.look.palette;
    var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    var canvas = renderer.domElement;
    canvas.setAttribute("data-kit", "iso");
    canvas.style.position = "absolute"; canvas.style.left = "0"; canvas.style.top = "0";
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    host.appendChild(canvas);
    // already drawn in 3D: a camera tilt on a stage around it would tilt the picture twice
    if (window.SorotKit.camera) window.SorotKit.camera.unproject(canvas);

    var scene = new THREE.Scene();
    // frame the items: centre on them and size the view to their extent (zoom scales it)
    var xs = s.items.map(function (it) { return it.x || 0; }), zs = s.items.map(function (it) { return it.z || 0; });
    var tops = s.items.map(function (it) { return it.kind === "tile" ? 0.2 : it.kind === "sphere" ? it.size || 1 : (it.height || 1) + (it.kind === "house" ? (it.size || 1) * 0.6 : 0); });
    var reach = s.items.map(function (it) { return (it.size || 1) * (it.kind === "tile" ? 0.5 : 0.6); });
    var mid = function (a) { return (Math.min.apply(null, a) + Math.max.apply(null, a)) / 2; };
    var cx = mid(xs), cz = mid(zs), topY = Math.max.apply(null, tops);
    var extent = Math.max(Math.max.apply(null, xs) - Math.min.apply(null, xs) + 2 * Math.max.apply(null, reach), Math.max.apply(null, zs) - Math.min.apply(null, zs) + 2 * Math.max.apply(null, reach), topY * 1.2, 2);
    var aspect = W / H, view = (extent * 0.62) / Math.min(1, aspect * 1.6) / s.zoom;
    var camera = new THREE.OrthographicCamera(-view * aspect, view * aspect, view, -view, 0.1, 200);
    // where the diorama sits on screen: y 0.5 = centred, larger = lower
    var shiftY = (s.y - 0.5) * 2 * view;
    var rad = (ctx.look.keyLightDeg * Math.PI) / 180;
    var key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(Math.sin(rad) * 12 - 6, 18, Math.cos(rad) * 6 + 10);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -14; key.shadow.camera.right = 14; key.shadow.camera.top = 14; key.shadow.camera.bottom = -14;
    key.shadow.radius = 6; key.shadow.bias = -0.0005;
    scene.add(key);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7a66, 1.0));

    var c = function (v, fallback) { return new THREE.Color(v || fallback); };
    var accent = pal[2] || "#f0a21e", ink = pal[1] || "#333333", ground = pal[0] || "#eeeeee", extra = pal[3] || accent;
    var mat = function (col, metal) { return new THREE.MeshStandardMaterial({ color: c(col, accent), roughness: metal ? 0.32 : 0.8, metalness: metal ? 0.25 : 0 }); };

    if (s.floor !== "none") {
      var floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: c(ground).offsetHSL(0, 0, -0.05), roughness: 1 }));
      floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
      if (s.floor === "grid") {
        var grid = new THREE.GridHelper(14, 14, c(ink), c(ink));
        grid.material.opacity = 0.12; grid.material.transparent = true; grid.position.y = 0.005; scene.add(grid);
      }
    }

    var built = [];
    var add = function (group, mesh) { mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); };
    for (var i = 0; i < s.items.length; i++) {
      var it = s.items[i], g = new THREE.Group();
      var size = it.size || 1, h = it.height || 1;
      var col = it.color || (it.kind === "coins" ? accent : i % 2 ? extra : accent);
      if (it.kind === "coins") {
        var n = Math.max(1, Math.round(h / 0.22));
        for (var k = 0; k < n; k++) {
          var coin = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * size, 0.5 * size, 0.18, 40), mat(col, true));
          coin.position.y = 0.09 + k * 0.22; coin.position.x = (ctx.rand() - 0.5) * 0.04; add(g, coin);
        }
      } else if (it.kind === "bar") {
        var bar = new THREE.Mesh(new THREE.BoxGeometry(0.8 * size, h, 0.8 * size), mat(col)); bar.position.y = h / 2; add(g, bar);
      } else if (it.kind === "cylinder") {
        var cy = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * size, 0.5 * size, h, 40), mat(col)); cy.position.y = h / 2; add(g, cy);
      } else if (it.kind === "sphere") {
        var sp = new THREE.Mesh(new THREE.SphereGeometry(0.5 * size, 40, 24), mat(col)); sp.position.y = 0.5 * size; add(g, sp);
      } else if (it.kind === "cone") {
        var co = new THREE.Mesh(new THREE.ConeGeometry(0.5 * size, h, 40), mat(col)); co.position.y = h / 2; add(g, co);
      } else if (it.kind === "tile") {
        var ti = new THREE.Mesh(new THREE.BoxGeometry(size, 0.12, size), mat(col)); ti.position.y = 0.06; add(g, ti);
      } else if (it.kind === "house") {
        var body = new THREE.Mesh(new THREE.BoxGeometry(size, size * 0.8, size), mat(it.color || ground)); body.position.y = size * 0.4; add(g, body);
        var roof = new THREE.Mesh(new THREE.ConeGeometry(size * 0.78, size * 0.6, 4), mat(col)); roof.position.y = size * 1.1; roof.rotation.y = Math.PI / 4; add(g, roof);
      } else if (it.kind === "tree") {
        var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08 * size, 0.1 * size, h * 0.4, 12), mat("#8a5a3a")); trunk.position.y = h * 0.2; add(g, trunk);
        var crown = new THREE.Mesh(new THREE.SphereGeometry(0.45 * size, 24, 16), mat(it.color || extra)); crown.position.y = h * 0.4 + 0.35 * size; add(g, crown);
      } else {
        var bl = new THREE.Mesh(new THREE.BoxGeometry(size, h, size), mat(col)); bl.position.y = h / 2; add(g, bl);
      }
      g.position.set(it.x || 0, 0, it.z || 0);
      scene.add(g);
      built.push(g);
    }

    var ease = function (p) { return 1 - Math.pow(1 - Math.max(0, Math.min(1, p)), 3); };
    var back = function (p) { p = Math.max(0, Math.min(1, p)); var c1 = 1.7, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
    return {
      render: function (t) {
        for (var i = 0; i < built.length; i++) {
          var p = (t - i * s.stagger) / 0.7;
          var g = built[i];
          if (s.grow === "rise") { g.scale.set(1, Math.max(0.001, ease(p)), 1); }
          else if (s.grow === "pop") { var b = Math.max(0.001, back(p)); g.scale.set(b, b, b); }
          else g.scale.set(1, 1, 1);
        }
        var turn = s.camera === "turn" ? (t / Math.max(0.1, ctx.duration)) * 0.35 : 0;
        var a = Math.PI / 4 + turn, d = 30;
        var ty = topY * 0.4 + shiftY;
        camera.position.set(cx + Math.sin(a) * d, ty + d * Math.tan(Math.PI / 6.5), cz + Math.cos(a) * d);
        camera.lookAt(cx, ty, cz);
        var z = s.camera === "zoom-in" ? 1 + 0.25 * ease(t / Math.max(0.1, ctx.duration)) : 1;
        camera.zoom = z; camera.updateProjectionMatrix();
        renderer.render(scene, camera);
      },
    };
  },
};
