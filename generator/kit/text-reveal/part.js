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
        var parts = s.by === "char" ? text.split("") : s.by === "line" ? [text] : text.split(/(\s+)/);
        var frag = document.createDocumentFragment();
        for (var j = 0; j < parts.length; j++) {
          var p = parts[j];
          if (!p) continue;
          if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(p)); continue; }
          var outer = document.createElement("span");
          outer.style.display = "inline-block";
          if (s.style === "mask" || s.style === "rise") outer.style.overflow = s.style === "mask" ? "hidden" : "visible";
          outer.style.verticalAlign = "bottom";
          var inner = document.createElement("span");
          inner.style.display = "inline-block";
          inner.textContent = p;
          outer.appendChild(inner);
          frag.appendChild(outer);
          pieces.push(inner);
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
