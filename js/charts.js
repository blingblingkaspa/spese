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
      // o.part: the top share of the bar drawn in a lighter shade (for example the trips inside Divertimento), a 2px surface gap between the two
      var pt = o.part && o.part[i];
      if (pt > 0 && !neg && pt < v) {
        p.setAttribute("d", barPath(cx - bw / 2, base, y(v - pt), bw, 0));
        var tp = svgEl("path", { d: barPath(cx - bw / 2, y(v - pt) - 2, y(v), bw, 4), style: "fill:" + o.partColor }, svg);
        if (y(v - pt) - 2 <= y(v)) tp.setAttribute("d", barPath(cx - bw / 2, y(v - pt), y(v), bw, 4));
        if (i === o.current) tp.setAttribute("fill-opacity", "0.45");
      } else if (pt > 0 && !neg) p.setAttribute("style", "fill:" + o.partColor);
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

  /* A line over time: o.points = [{ t: ms, v: value }], x placed by date. Tap or hover finds the nearest day. */
  var MON = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
  function line(host, o) {
    host.classList.add("chart");
    host.textContent = "";
    var pts = o.points.slice().sort(function (a, b) { return a.t - b.t; });
    var W = Math.max(host.clientWidth || 0, 240), H = o.height || 160;
    var padL = 46, padR = 10, padT = 10, padB = 22, plotW = W - padL - padR, plotH = H - padT - padB;
    var vs = pts.map(function (p) { return p.v; }), lo = Math.min.apply(null, vs), hi = Math.max.apply(null, vs);
    var span = hi - lo || Math.abs(hi) * 0.05 || 1;
    var sc = scale(lo - span * 0.15, hi + span * 0.15, o.ticks || 3);
    var t0 = pts[0].t, t1 = pts[pts.length - 1].t; if (t1 === t0) t1 = t0 + 86400000;
    var x = function (t) { return padL + (t - t0) / (t1 - t0) * plotW; };
    var y = function (v) { return padT + (sc.hi - v) / (sc.hi - sc.lo) * plotH; };
    var svg = svgEl("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": o.ariaLabel || "" }, host);
    if (o.desc) svgEl("desc", {}, svg).textContent = o.desc;
    sc.ticks.forEach(function (t) {
      var yy = Math.round(y(t)) + 0.5;
      svgEl("line", { x1: padL, x2: W - padR, y1: yy, y2: yy, class: "c-grid" }, svg);
      svgEl("text", { x: padL - 7, y: yy + 3.5, "text-anchor": "end", class: "c-tick" }, svg).textContent = (o.fmtAxis || String)(t);
    });
    svgEl("line", { x1: padL, x2: W - padR, y1: padT + plotH + 0.5, y2: padT + plotH + 0.5, class: "c-base" }, svg);
    // x labels: days for a short span, months otherwise
    var days = (t1 - t0) / 86400000, labels = [];
    if (days <= 75) {
      var n = Math.min(4, pts.length);
      for (var k = 0; k < n; k++) { var tt = t0 + (t1 - t0) * (n === 1 ? 0 : k / (n - 1)), d = new Date(tt); labels.push([tt, d.getDate() + " " + MON[d.getMonth()]]); }
    } else {
      var d0 = new Date(t0), m = new Date(d0.getFullYear(), d0.getMonth() + 1, 1), step = days > 400 ? 3 : days > 200 ? 2 : 1, first = true;
      for (; m.getTime() <= t1; m = new Date(m.getFullYear(), m.getMonth() + step, 1)) {
        labels.push([m.getTime(), MON[m.getMonth()] + (first || m.getMonth() === 0 ? " " + String(m.getFullYear()).slice(2) : "")]); first = false;
      }
    }
    labels.forEach(function (l, i) {
      var anchor = days <= 75 ? (i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle") : "middle";
      svgEl("text", { x: x(l[0]), y: H - 6, "text-anchor": anchor, class: "c-x" }, svg).textContent = l[1];
    });
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + x(p.t).toFixed(1) + " " + y(p.v).toFixed(1); }).join("");
    svgEl("path", { d: d + "L" + x(t1).toFixed(1) + " " + (padT + plotH) + "L" + x(t0).toFixed(1) + " " + (padT + plotH) + "Z", class: "c-area", style: "fill:" + o.color }, svg);
    svgEl("path", { d: d, class: "c-line", style: "stroke:" + o.color }, svg);
    var lastP = pts[pts.length - 1];
    svgEl("circle", { cx: x(lastP.t), cy: y(lastP.v), r: 4.5, class: "c-dot", style: "fill:" + o.color }, svg);
    var cross = svgEl("line", { x1: 0, x2: 0, y1: padT, y2: padT + plotH, class: "c-cross", opacity: 0 }, svg);
    var hot = svgEl("circle", { cx: 0, cy: 0, r: 4.5, class: "c-dot", style: "fill:" + o.color, opacity: 0 }, svg);
    if (!o.tip) return;
    var tip = document.createElement("div");
    tip.className = "tip"; tip.hidden = true; tip.setAttribute("role", "status");
    host.appendChild(tip);
    var hit = svgEl("rect", { x: padL - 6, y: 0, width: plotW + 12, height: H, fill: "transparent", class: "c-hit" }, svg);
    var sel = { setAttribute: function (k, v) { if (k === "opacity") { cross.setAttribute("opacity", v); hot.setAttribute("opacity", v); } } };
    function nearest(evt) {
      var r = svg.getBoundingClientRect(), px = (evt.clientX - r.left) * (W / r.width), best = 0;
      pts.forEach(function (p, i) { if (Math.abs(x(p.t) - px) < Math.abs(x(pts[best].t) - px)) best = i; });
      return best;
    }
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
      var px = x(pts[i].t), py = y(pts[i].v);
      cross.setAttribute("x1", px); cross.setAttribute("x2", px); hot.setAttribute("cx", px); hot.setAttribute("cy", py);
      tip.hidden = false;
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var left = px + 12 + tw <= W ? px + 12 : Math.max(0, px - tw - 12);
      tip.style.left = left + "px"; tip.style.top = Math.max(0, Math.min(py - th / 2, H - th)) + "px";
      sel.setAttribute("opacity", "1");
      openTip = { host: host, tip: tip, sel: sel, at: Date.now() };
    }
    hit.addEventListener("click", function (e) { hideTip(); show(nearest(e)); });
    if (matchMedia("(hover: hover)").matches) {
      hit.addEventListener("pointermove", function (e) { hideTip(); show(nearest(e)); });
      hit.addEventListener("pointerleave", hideTip);
    }
  }

  return { columns: columns, line: line, hideTip: hideTip };
})();
