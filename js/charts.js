/* ---------- Small SVG charts drawn at the width of the screen.
   Colors are CSS variables, so the light and dark themes apply without redrawing. ---------- */
var Charts = (function () {
  var NS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function scale(min, max, n) {
    if (max <= min) max = min + 1;
    var step = niceStep((max - min) / n);
    var lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    var t = [];
    for (var v = lo; v <= hi + step / 2; v += step) t.push(Math.round(v * 100) / 100);
    return { lo: lo, hi: hi, ticks: t };
  }
  /* A bar with rounded data end and a square end on the baseline */
  function barPath(x, base, top, w, r) {
    var h = Math.abs(top - base);
    if (h < 0.5) return "";
    r = Math.min(r, h, w / 2);
    var d = top < base ? 1 : -1; // 1 = grows up
    return "M" + x + "," + base + "V" + (top + d * r) + "Q" + x + "," + top + " " + (x + r) + "," + top +
      "H" + (x + w - r) + "Q" + (x + w) + "," + top + " " + (x + w) + "," + (top + d * r) + "V" + base + "Z";
  }

  /* One tooltip per chart; a tap elsewhere closes it */
  var openTip = null;
  function hideTip() {
    if (!openTip) return;
    openTip.tip.hidden = true;
    if (openTip.sel) openTip.sel.setAttribute("opacity", "0");
    openTip = null;
  }
  document.addEventListener("click", function (e) { if (openTip && !openTip.host.contains(e.target)) hideTip(); });
  // a scroll closes it, but not the small one a tap can cause right after opening
  document.addEventListener("scroll", function () { if (openTip && Date.now() - openTip.at > 400) hideTip(); }, { passive: true, capture: true });

  /* Columns month by month.
     o.values: the bars. o.ghost: optional reference per month (the quota), drawn as a wider pale bar behind;
     o.ghostKind[i] = "expected" draws it as an outline (a quota still to come).
     o.current: index of the month in progress (lighter bar). o.highlight: index drawn in full, the others softer.
     o.valueLabels: value above each bar. o.avg: a reference line with its label. o.tip(i): tooltip rows. */
  function columns(host, o) {
    host.classList.add("chart");
    host.textContent = "";
    var W = Math.max(host.clientWidth || 0, 240), H = o.height || 150;
    var n = o.values.length;
    var padL = 38, padR = 4, padT = o.valueLabels ? 18 : 8, padB = 22;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var vals = o.values.concat(o.ghost ? o.ghost.filter(function (x) { return x !== null && x !== undefined; }) : []);
    if (o.avg) vals.push(o.avg);
    var max = Math.max.apply(null, vals.concat([0])), min = Math.min.apply(null, vals.concat([0]));
    var sc = scale(min, max, o.ticks || 3);
    var y = function (v) { return padT + (sc.hi - v) / (sc.hi - sc.lo) * plotH; };
    var svg = svgEl("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": o.ariaLabel || "" }, host);
    if (o.desc) svgEl("desc", {}, svg).textContent = o.desc;

    sc.ticks.forEach(function (t) {
      var yy = Math.round(y(t)) + 0.5;
      svgEl("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, class: t === 0 ? "c-base" : "c-grid" }, svg);
      svgEl("text", { x: padL - 7, y: yy + 3.5, "text-anchor": "end", class: "c-tick" }, svg).textContent = (o.fmtAxis || String)(t);
    });

    var band = plotW / n;
    var sel = svgEl("rect", { x: 0, y: padT - 6, width: band, height: plotH + 6, rx: 6, class: "c-sel", opacity: 0 }, svg);
    var gw = Math.min(band * 0.8, 30), bw = o.ghost ? Math.min(band * 0.46, 15) : Math.min(band * 0.6, 22);
    var base = y(0);
    o.values.forEach(function (v, i) {
      var cx = padL + band * i + band / 2;
      var soft = o.highlight !== undefined && o.highlight !== null && o.highlight !== i;
      if (o.ghost && o.ghost[i]) {
        var g = o.ghost[i], expected = o.ghostKind && o.ghostKind[i] === "expected";
        if (expected) svgEl("rect", { x: cx - gw / 2 + 0.5, y: y(g) + 0.5, width: gw - 1, height: Math.max(base - y(g) - 1, 0), rx: 4, class: "c-ghost-exp", style: "--c:" + o.color }, svg);
        else svgEl("path", { d: barPath(cx - gw / 2, base, y(g), gw, 4), class: "c-ghost", style: "--c:" + o.color }, svg);
      }
      if (!v) return;
      var neg = v < 0;
      var p = svgEl("path", { d: barPath(cx - bw / 2, base, y(v), bw, 4), style: "fill:" + (neg ? (o.negColor || "var(--bad)") : o.color) }, svg);
      if (i === o.current) p.setAttribute("fill-opacity", "0.45");
      if (soft) p.setAttribute("fill-opacity", "0.35");
      if (o.valueLabels) {
        svgEl("text", { x: cx, y: neg ? y(v) + 12 : y(v) - 5, "text-anchor": "middle", class: "c-val" + (soft ? " soft" : "") }, svg).textContent = (o.fmtValue || String)(v);
      }
    });
    if (o.avg) {
      var ya = Math.round(y(o.avg)) + 0.5;
      svgEl("line", { x1: padL, x2: W - padR, y1: ya, y2: ya, class: "c-avg" }, svg);
      svgEl("text", { x: W - padR - 2, y: ya - 5, "text-anchor": "end", class: "c-avg-t" }, svg).textContent = o.avgLabel || "";
    }
    var every = n > 13 ? 2 : 1;
    o.labels.forEach(function (l, i) {
      if (i % every && i !== n - 1) return;
      var t = svgEl("text", { x: padL + band * i + band / 2, y: H - 6, "text-anchor": "middle", class: "c-x" + (i === o.current || i === o.highlight ? " on" : "") }, svg);
      t.textContent = l;
    });

    if (!o.tip) return;
    var tip = document.createElement("div");
    tip.className = "tip"; tip.hidden = true; tip.setAttribute("role", "status");
    host.appendChild(tip);
    var hits = svgEl("g", {}, svg);
    o.values.forEach(function (v, i) {
      svgEl("rect", { x: padL + band * i, y: 0, width: band, height: H, fill: "transparent", "data-i": i, class: "c-hit" }, hits);
    });
    function show(i) {
      var info = o.tip(i); if (!info) return;
      tip.textContent = "";
      var h = document.createElement("div"); h.className = "tip-t"; h.textContent = info.title; tip.appendChild(h);
      info.rows.forEach(function (r) {
        var row = document.createElement("div"); row.className = "tip-r";
        if (r.color) { var k = document.createElement("i"); k.style.background = r.color; row.appendChild(k); }
        var b = document.createElement("b"); b.textContent = r.value; row.appendChild(b);
        var s = document.createElement("span"); s.textContent = r.label; row.appendChild(s);
        tip.appendChild(row);
      });
      tip.hidden = false;
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var left = padL + band * i + band / 2 - tw / 2;
      left = Math.max(0, Math.min(left, W - tw));
      // above the column; if there is no room (bars going down from the top), below its end
      // above the column; if there is no room, at the top of the chart beside the column
      var top = y(Math.max(o.values[i], (o.ghost && o.ghost[i]) || 0, 0)) - th - 10;
      if (top < -padT) {
        top = 0;
        var x0 = padL + band * i;
        left = x0 + band + 4 + tw <= W ? x0 + band + 4 : Math.max(0, x0 - tw - 4);
      }
      tip.style.left = left + "px"; tip.style.top = top + "px";
      sel.setAttribute("x", padL + band * i); sel.setAttribute("opacity", "1");
      openTip = { host: host, tip: tip, sel: sel, at: Date.now() };
    }
    hits.addEventListener("click", function (e) {
      var i = e.target.getAttribute("data-i"); if (i === null) return;
      hideTip(); show(+i);
    });
    if (matchMedia("(hover: hover)").matches) {
      hits.addEventListener("pointermove", function (e) { var i = e.target.getAttribute("data-i"); if (i !== null) { hideTip(); show(+i); } });
      hits.addEventListener("pointerleave", hideTip);
    }
  }

  return { columns: columns, hideTip: hideTip };
})();
