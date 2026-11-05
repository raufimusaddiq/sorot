// text-reveal: splits the text nodes of each target into spans at run time (the words stay in the
// markup as written) and reveals them in order on the shot's timeline.
window.SorotKit = window.SorotKit || {};
window.SorotKit["text-reveal"] = {
  mount: function (host, s, ctx) {
    var targets = s.target ? host.querySelectorAll(s.target) : [host];
    var n = 0;
    function split(el) {
      var pieces = [];
      var nodes = [];
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var text = node.nodeValue;
        if (!text.trim()) continue;
        // words (and lines) stay whole; by char, each word is one unbreakable box holding its letters.
        // Spaces stay plain text between the boxes: inside an inline-block a leading or trailing
        // space collapses ("Biarkan " before a nested span showed as "Biarkanbunga").
        var edge = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
        var words = s.by === "line" ? [edge[1], edge[2], edge[3]] : text.split(/(\s+)/);
        var frag = document.createDocumentFragment();
        for (var j = 0; j < words.length; j++) {
          var w = words[j];
          if (!w) continue;
          if (/^\s+$/.test(w)) { frag.appendChild(document.createTextNode(w)); continue; }
          var box = frag;
          var letters = [w];
          if (s.by === "char") {
            box = document.createElement("span");
            box.style.display = "inline-block";
            box.style.whiteSpace = "nowrap";
            frag.appendChild(box);
            letters = w.split("");
          }
          for (var c = 0; c < letters.length; c++) {
            var outer = document.createElement("span");
            outer.style.display = "inline-block";
            if (s.style === "mask") outer.style.overflow = "hidden";
            outer.style.verticalAlign = "bottom";
            var inner = document.createElement("span");
            inner.style.display = "inline-block";
            inner.textContent = letters[c];
            outer.appendChild(inner);
            box.appendChild(outer);
            pieces.push(inner);
          }
        }
        node.parentNode.replaceChild(frag, node);
      }
      return pieces;
    }
    for (var t = 0; t < targets.length; t++) {
      var pieces = split(targets[t]);
      for (var i = 0; i < pieces.length; i++, n++) {
        var at = ctx.start + s.at + n * s.stagger;
        if (s.style === "mask") ctx.tl.fromTo(pieces[i], { yPercent: 105 }, { yPercent: 0, duration: s.length, ease: "power4.out" }, at);
        else if (s.style === "rise") ctx.tl.fromTo(pieces[i], { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: s.length, ease: "expo.out" }, at);
        else if (s.style === "type") ctx.tl.fromTo(pieces[i], { opacity: 0 }, { opacity: 1, duration: 0.01, ease: "none" }, at);
        else ctx.tl.fromTo(pieces[i], { opacity: 0 }, { opacity: 1, duration: s.length, ease: "power2.out" }, at);
      }
    }
  },
};
