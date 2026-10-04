/* ---------- Pure data layer (no DOM) ---------- */
var MM = (function () {
  var MONTHS = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
  var MONTHS_LONG = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  var CONTAINERS = ["ess", "div", "inv"];

  /* Neutral defaults: personal values live in the settings file in the user's Drive, never in this public code */
  var DEFAULT_SETTINGS = {
    folderId: null,
    folderName: "MoneyManager",
    startMonth: null,
    salaryPrevMonth: true, // a salary paid between the 5th and the 15th belongs to the previous month
    estimate: 0,
    rules: [{ from: "2000-01", ess: 30, inv: 50, div: 20, etf: 60, crypto: 20, liq: 20 }],
    investOverride: {},
    targets: {},
    protected: {}
  };

  function cleanName(s) {
    if (!s) return "";
    return String(s).replace(/^[^\p{L}\p{N}]+/u, "").trim() || String(s).trim();
  }
  function ym(d) { return d.slice(0, 7); }
  function monthLabel(k, withYear) { var p = k.split("-"); var m = MONTHS[+p[1] - 1]; return withYear ? m + " " + p[0].slice(2) : m; }
  function monthLong(k) { var p = k.split("-"); return MONTHS_LONG[+p[1] - 1] + " " + p[0]; }
  function addMonths(k, n) {
    var p = k.split("-"); var y = +p[0], m = +p[1] - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return y + "-" + String(m + 1).padStart(2, "0");
  }
  function monthRange(a, b) { var out = []; for (var k = a; k <= b; k = addMonths(k, 1)) out.push(k); return out; }
  function sum(a, f) { return a.reduce(function (s, x) { return s + (f ? f(x) : x); }, 0); }
  function round2(x) { return Math.round(x * 100) / 100; }

  function containerOf(macro) {
    if (/invest/i.test(macro)) return "inv";
    if (/essenz/i.test(macro)) return "ess";
    if (/divert|sfiz/i.test(macro)) return "div";
    return null;
  }
  function isInvest(macro) { return containerOf(macro) === "inv"; }

  /* Read the SQLite backup into plain rows */
  function readDb(SQL, bytes) {
    var db = new SQL.Database(bytes);
    function all(sql) {
      var res = db.exec(sql); if (!res.length) return [];
      var cols = res[0].columns;
      return res[0].values.map(function (v) { var o = {}; cols.forEach(function (c, i) { o[c] = v[i]; }); return o; });
    }
    var rows = all(
      "select i.uid, i.WDATE as date, i.DO_TYPE as type, i.ZMONEY as money, i.AMOUNT_ACCOUNT as amt2, " +
      "i.ZCONTENT as text, i.ZDATA as memo, k.NAME as cname, p.NAME as pname, a.NIC_NAME as asset " +
      "from INOUTCOME i left join ZCATEGORY k on k.uid = i.ctgUid left join ZCATEGORY p on p.uid = k.pUid " +
      "left join ASSETS a on a.uid = i.assetUid where coalesce(i.IS_DEL, 0) = 0"
    );
    db.close();
    return { rows: rows };
  }

  /* Normalise rows: expenses, salary incomes, future-dated items */
  function normalise(raw, todayStr) {
    var expenses = [], incomes = [], future = [];
    raw.forEach(function (r) {
      var amount = parseFloat(r.money); if (!isFinite(amount)) amount = parseFloat(r.amt2);
      if (!isFinite(amount) || !r.date) return;
      var t = String(r.type);
      var macro = cleanName(r.pname || r.cname) || "Senza categoria";
      var sub = r.pname ? cleanName(r.cname) : "Generico";
      var e = { id: r.uid, date: String(r.date).slice(0, 10), amount: amount, text: (r.text || "").trim(), memo: (r.memo || "").trim(),
        macro: macro, sub: sub, asset: cleanName(r.asset) || "Altro" };
      e.month = ym(e.date);
      e.key = macro + "›" + sub;
      e.container = containerOf(macro);
      if (t === "1") { if (e.date > todayStr) future.push(e); else expenses.push(e); }
      else if (t === "0" && e.date <= todayStr && /stipend/i.test(macro + " " + sub)) incomes.push(e); // only salary counts
    });
    return { expenses: expenses, incomes: incomes, future: future };
  }

  /* Keep only what happened from the start month on: older data is ignored everywhere */
  function scope(data, startMonth) {
    var keep = function (e) { return !startMonth || e.month >= startMonth; };
    return { expenses: data.expenses.filter(keep), incomes: data.incomes.filter(keep), future: data.future.filter(keep) };
  }

  function sortedRules(rules) { return (rules || []).slice().sort(function (a, b) { return a.from < b.from ? -1 : a.from > b.from ? 1 : 0; }); }
  function ruleAt(rules, m) {
    var rs = sortedRules(rules), r = rs[0] || DEFAULT_SETTINGS.rules[0];
    rs.forEach(function (x) { if (x.from <= m) r = x; });
    return r;
  }
  function invSubOf(sub) { if (/etf|pac/i.test(sub)) return "etf"; if (/crypto|cripto/i.test(sub)) return "crypto"; if (/liquid/i.test(sub)) return "liq"; return null; }

  /* Month a salary belongs to: by default the one before it was paid */
  function salaryMonth(e, s) { return s.salaryPrevMonth === false ? e.month : addMonths(e.month, -1); }
  function hasOverride(override, m) { return override[m] !== undefined && override[m] !== null && override[m] !== "" && isFinite(+override[m]); }

  /* The ledger: income, quota, spent and carried-over availability per container, month by month.
     Investments: the container only holds the share to invest (ETF, crypto); the liquidity share stays on the account
     and is tracked apart in row.liq. */
  function ledger(data, settings, todayStr) {
    var s = settings || DEFAULT_SETTINGS;
    var cur = ym(todayStr), prev = addMonths(cur, -1);
    var firstData = data.expenses.map(function (e) { return e.month; }).sort()[0];
    var start = s.startMonth || firstData || cur;
    if (start > cur) start = cur;
    var months = monthRange(start, cur);
    var override = s.investOverride || {};
    var salaries = data.incomes.map(function (e) { return { m: salaryMonth(e, s), amount: e.amount, e: e }; })
      .filter(function (x) { return x.m >= start; });
    var firstReal = salaries.length ? salaries.map(function (x) { return x.m; }).sort()[0] : null;

    var carry = { ess: 0, div: 0, inv: 0 }, liqCarry = 0;
    var rows = months.map(function (m) {
      var mine = salaries.filter(function (x) { return x.m === m; });
      var real = sum(mine, function (x) { return x.amount; });
      var income, kind;
      if (real > 0) { income = real; kind = "real"; }
      else if (m === cur) { income = 0; kind = "waiting"; }
      else if (!firstReal || m < firstReal) { income = +s.estimate || 0; kind = "est"; }
      else if (m === prev && s.salaryPrevMonth !== false) { income = 0; kind = "waiting"; }
      else { income = 0; kind = "missing"; }
      var rule = ruleAt(s.rules, m);
      var liqPct = (+rule.liq || 0) / 100;
      var row = { month: m, income: income, kind: kind, rule: rule, salaries: mine.map(function (x) { return x.e; }), c: {} };
      var invItems = [], liqItems = [];
      data.expenses.forEach(function (e) {
        if (e.month !== m || e.container !== "inv") return;
        if (invSubOf(e.sub) === "liq") liqItems.push(e); else invItems.push(e);
      });
      CONTAINERS.forEach(function (c) {
        var all = c === "inv" ? invItems : data.expenses.filter(function (e) { return e.month === m && e.container === c; });
        var hist = c === "inv" && hasOverride(override, m);
        var spent = hist ? +override[m] : sum(all, function (e) { return e.amount; });
        var quota = income * (+rule[c] || 0) / 100;
        if (c === "inv") quota *= (1 - liqPct);
        carry[c] += quota - spent;
        row.c[c] = { quota: quota, spent: spent, avail: carry[c], hist: hist, items: all, mmSpent: sum(all, function (e) { return e.amount; }) };
      });
      var liqQuota = income * (+rule.inv || 0) / 100 * liqPct, liqUsed = sum(liqItems, function (e) { return e.amount; });
      liqCarry += liqQuota - liqUsed;
      row.liq = { quota: liqQuota, used: liqUsed, avail: liqCarry, items: liqItems };
      return row;
    });
    var other = data.expenses.filter(function (e) { return !e.container && e.month >= start; });
    return { months: months, rows: rows, cur: cur, start: start, firstReal: firstReal, other: other };
  }

  /* Subcategory detail for one container: in a month and since the start */
  function detail(data, led, c, month, settings) {
    var s = settings || DEFAULT_SETTINGS;
    var upto = led.rows.filter(function (r) { return r.month <= month; });
    var row = upto[upto.length - 1];
    var subs = {};
    function add(key, sub, field, amount) {
      if (!subs[key]) subs[key] = { key: key, sub: sub, month: 0, total: 0 };
      subs[key][field] += amount;
    }
    var HIST = "Investimenti registrati nell'altra app";
    upto.forEach(function (r) {
      var cc = r.c[c];
      if (cc.hist) { add("hist", HIST, "total", cc.spent); if (r.month === month) add("hist", HIST, "month", cc.spent); return; }
      cc.items.forEach(function (e) { add(e.key, e.sub, "total", e.amount); if (r.month === month) add(e.key, e.sub, "month", e.amount); });
    });
    var list = Object.keys(subs).map(function (k) { return subs[k]; }).sort(function (a, b) { return b.month - a.month || b.total - a.total; });
    var out = { list: list, row: row };
    if (c === "inv") {
      // ETF and crypto against their share, only on months not covered by the other app's numbers
      var tracked = upto.filter(function (r) { return !r.c.inv.hist; });
      var split = { etf: { quota: 0, done: 0 }, crypto: { quota: 0, done: 0 } };
      tracked.forEach(function (r) {
        ["etf", "crypto"].forEach(function (k) { split[k].quota += r.income * (+r.rule.inv || 0) / 100 * (+r.rule[k] || 0) / 100; });
        r.c.inv.items.forEach(function (e) { var k = invSubOf(e.sub); if (split[k]) split[k].done += e.amount; });
      });
      out.split = split;
      out.trackedFrom = tracked.length ? tracked[0].month : null;
      out.firstMM = null;
      tracked.forEach(function (r) { if (!out.firstMM && r.c.inv.items.length) out.firstMM = r.month; });
      out.liq = { avail: row.liq.avail, quota: sum(upto, function (r) { return r.liq.quota; }), used: sum(upto, function (r) { return r.liq.used; }),
        monthQuota: row.liq.quota, monthUsed: row.liq.used, items: row.liq.items };
      out.ignored = row.c.inv.hist ? row.c.inv.mmSpent : 0; // Money Manager entries replaced by the other app's number
    }
    return out;
  }

  /* Analysis for a period (categories, habits, lists) */
  function analysis(data, opts) {
    var cur = ym(opts.today);
    var all = data.expenses;
    var countInv = !!opts.countInvest;
    var firstMonth = all.length ? all.map(function (e) { return e.month; }).sort()[0] : cur;
    var start, end = cur;
    if (opts.period === "last12") start = addMonths(cur, -11);
    else if (opts.period === "all") start = firstMonth;
    else { start = opts.period + "-01"; end = opts.period + "-12"; if (end > cur) end = cur; }
    if (start < firstMonth) start = firstMonth;
    if (start > end) start = end;
    var months = monthRange(start, end);
    var closed = months.filter(function (m) { return m < cur; });
    var inPeriod = all.filter(function (e) { return e.month >= start && e.month <= end; });
    var spend = inPeriod.filter(function (e) { return countInv || !isInvest(e.macro); });
    var total = sum(spend, function (e) { return e.amount; });
    var invested = sum(inPeriod.filter(function (e) { return isInvest(e.macro); }), function (e) { return e.amount; });
    var nClosed = Math.max(closed.length, 1);
    var avgMonth = closed.length ? sum(spend.filter(function (e) { return e.month < cur; }), function (e) { return e.amount; }) / nClosed : null;

    var recentStart = addMonths(cur, -3), lastClosed = addMonths(cur, -1);
    var priorMonths = firstMonth < recentStart ? monthRange(firstMonth, addMonths(recentStart, -1)) : [];
    function trendFor(fn) {
      var rec = sum(all.filter(function (e) { return fn(e) && e.month >= recentStart && e.month <= lastClosed; }), function (e) { return e.amount; }) / 3;
      var pri = priorMonths.length ? sum(all.filter(function (e) { return fn(e) && e.month < recentStart; }), function (e) { return e.amount; }) / priorMonths.length : null;
      return { recent: rec, prior: pri, pct: pri && pri > 0 ? (rec - pri) / pri : null };
    }

    var subs = {};
    spend.forEach(function (e) {
      if (!subs[e.key]) subs[e.key] = { key: e.key, macro: e.macro, sub: e.sub, container: e.container, total: 0, n: 0 };
      subs[e.key].total += e.amount; subs[e.key].n += 1;
    });
    var prot = opts.protected || {}, tg = opts.targets || {};
    var subList = Object.keys(subs).map(function (k) { return subs[k]; }).sort(function (a, b) { return b.total - a.total; });
    subList.forEach(function (s) {
      var closedSum = sum(spend.filter(function (e) { return e.key === s.key && e.month < cur; }), function (e) { return e.amount; });
      s.avg = closed.length ? closedSum / nClosed : s.total;
      s.ticket = s.total / s.n;
      s.share = total ? s.total / total : 0;
      s.trend = trendFor(function (e) { return e.key === s.key; });
      s.protected = !!prot[s.key];
      var t = tg[s.key]; s.target = t !== undefined && t !== "" && isFinite(+t) ? +t : null;
    });
    var macros = [];
    subList.forEach(function (s) { if (macros.indexOf(s.macro) < 0) macros.push(s.macro); });
    var order = { ess: 0, div: 1, inv: 2 };
    macros.sort(function (a, b) { return (order[containerOf(a)] !== undefined ? order[containerOf(a)] : 9) - (order[containerOf(b)] !== undefined ? order[containerOf(b)] : 9); });
    var macroList = macros.map(function (m) {
      var items = subList.filter(function (s) { return s.macro === m; });
      var t = sum(items, function (s) { return s.total; });
      var closedSum = sum(spend.filter(function (e) { return e.macro === m && e.month < cur; }), function (e) { return e.amount; });
      return { macro: m, container: containerOf(m), total: t, n: sum(items, function (s) { return s.n; }), avg: closed.length ? closedSum / nClosed : t,
        share: total ? t / total : 0, items: items, trend: trendFor(function (e) { return e.macro === m; }) };
    });

    var dow = [0, 0, 0, 0, 0, 0, 0], dowN = [0, 0, 0, 0, 0, 0, 0];
    spend.forEach(function (e) {
      var p = e.date.split("-"); var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
      var i = (d + 6) % 7; dow[i] += e.amount; dowN[i] += 1;
    });
    var pay = {};
    spend.forEach(function (e) { pay[e.asset] = (pay[e.asset] || 0) + e.amount; });
    var payList = Object.keys(pay).map(function (k) { return { name: k, total: pay[k] }; }).sort(function (a, b) { return b.total - a.total; });
    var top = spend.slice().sort(function (a, b) { return b.amount - a.amount; }).slice(0, 10);
    var rec = {};
    spend.forEach(function (e) {
      if (!e.text) return;
      var k = e.text.toLowerCase().replace(/\s+/g, " ").trim();
      if (!rec[k]) rec[k] = { text: e.text, n: 0, total: 0, sub: e.sub, macro: e.macro };
      rec[k].n += 1; rec[k].total += e.amount;
    });
    var recurring = Object.keys(rec).map(function (k) { return rec[k]; }).filter(function (r) { return r.n >= 2; })
      .sort(function (a, b) { return b.total - a.total; }).slice(0, 10);
    var small = spend.filter(function (e) { return e.amount < 15; });
    var protAvg = sum(subList.filter(function (s) { return s.protected; }), function (s) { return s.avg; });
    var planned = sum(subList, function (s) { return s.target !== null ? s.target : s.avg; });

    return { start: start, end: end, months: months, closed: closed, total: total, invested: invested, avgMonth: avgMonth, count: spend.length,
      subList: subList, macroList: macroList, dow: dow, dowN: dowN, payList: payList, top: top, recurring: recurring,
      smallTotal: sum(small, function (e) { return e.amount; }), smallN: small.length,
      protAvg: protAvg, planned: planned, anyTarget: subList.some(function (s) { return s.target !== null; }) };
  }

  /* Totals per container and subcategory per calendar year */
  function yearly(data, led) {
    var years = {};
    data.expenses.forEach(function (e) { years[e.date.slice(0, 4)] = 1; });
    led.rows.forEach(function (r) { years[r.month.slice(0, 4)] = 1; });
    var ys = Object.keys(years).sort();
    var cur = led.cur;
    // totals include the month in progress; monthly averages use closed months only
    var cont = {}, closedCont = {}, subs = {};
    ys.forEach(function (y) { cont[y] = { ess: 0, div: 0, inv: 0 }; closedCont[y] = { ess: 0, div: 0, inv: 0 }; });
    var override = {};
    led.rows.forEach(function (r) { if (r.c.inv.hist) override[r.month] = r.c.inv.spent; });
    function addTo(key, macro, sub, container, m, amount) {
      var y = m.slice(0, 4);
      cont[y][container] += amount;
      if (m < cur) closedCont[y][container] += amount;
      if (!subs[key]) subs[key] = { key: key, macro: macro, sub: sub, container: container, y: {}, yClosed: {} };
      subs[key].y[y] = (subs[key].y[y] || 0) + amount;
      if (m < cur) subs[key].yClosed[y] = (subs[key].yClosed[y] || 0) + amount;
    }
    data.expenses.forEach(function (e) {
      if (!e.container) return;
      if (e.container === "inv" && override[e.month] !== undefined) return;
      addTo(e.key, e.macro, e.sub, e.container, e.month, e.amount);
    });
    Object.keys(override).forEach(function (m) { addTo("hist", "Investimenti", "Altra app", "inv", m, override[m]); });
    // closed months with data per year, for monthly averages
    var monthsPerYear = {};
    ys.forEach(function (y) {
      var ms = {};
      data.expenses.forEach(function (e) { if (e.date.slice(0, 4) === y && e.month < cur) ms[e.month] = 1; });
      Object.keys(override).forEach(function (m) { if (m.slice(0, 4) === y && m < cur) ms[m] = 1; });
      var keys = Object.keys(ms).sort();
      monthsPerYear[y] = keys.length ? monthRange(keys[0], keys[keys.length - 1]).length : 0;
    });
    return { years: ys, cont: cont, closedCont: closedCont, subs: Object.keys(subs).map(function (k) { return subs[k]; }), monthsPerYear: monthsPerYear };
  }

  function pickLatest(files) {
    var mm = (files || []).filter(function (f) {
      return /\.mmbak$/i.test(f.title || "") || f.fileExtension === "mmbak" || /realbyteapps\.moneymanager/.test(f.mimeType || "");
    });
    mm.sort(function (a, b) { return String(b.modifiedTime || b.createdTime || "").localeCompare(String(a.modifiedTime || a.createdTime || "")); });
    return mm[0] || null;
  }

  return { DEFAULT_SETTINGS: DEFAULT_SETTINGS, CONTAINERS: CONTAINERS, readDb: readDb, normalise: normalise,
    ledger: ledger, detail: detail, analysis: analysis, yearly: yearly, pickLatest: pickLatest, ruleAt: ruleAt, sortedRules: sortedRules,
    scope: scope, salaryMonth: salaryMonth, monthLabel: monthLabel, monthLong: monthLong, addMonths: addMonths, monthRange: monthRange, containerOf: containerOf, isInvest: isInvest, round2: round2 };
})();
if (typeof module !== "undefined") module.exports = MM;
