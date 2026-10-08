/* ---------- Patrimonio: the quantities written by the program on the PC (patrimonio.json) and live prices ---------- */
var PF = (function () {
  var DOC_KEY = "mm-portfolio-v1", PRICE_KEY = "mm-prices-v1";
  var CG = "https://api.coingecko.com/api/v3/simple/price";
  /* Stablecoins and currencies: shown together as cash ready to use */
  var CASH = { USD: 1, EUR: 1, USDT: 1, USDC: 1, EURC: 1, EURE: 1, DAI: 1, FDUSD: 1, USDE: 1, PYUSD: 1, TUSD: 1, USDS: 1, RLUSD: 1, FRXUSD: 1 };
  /* CoinGecko ids for coins typed by hand that the PC file does not know yet */
  var KNOWN = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", KAS: "kaspa", USDT: "tether", USDC: "usd-coin", EURC: "euro-coin",
    DAI: "dai", ETHFI: "ether-fi", WEETH: "wrapped-eeth", BNB: "binancecoin", XRP: "ripple", DOT: "polkadot" };
  var EMPTY = { versione: 1, creato: null, posti: [], saldi: [], monete: {} };
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "posto"; }
  function cleanSym(s) { return String(s || "").trim().toUpperCase().replace(/[^A-Z0-9.]/g, "").slice(0, 12); }
  /* The quantities written on this site (settings.pfManual) join the file as places of their own */
  function withManual(doc, manual) {
    var rows = (manual || []).filter(function (m) { return m && m.posto && cleanSym(m.simbolo) && isFinite(+m.quantita) && +m.quantita; });
    if (!rows.length) return doc || null;
    var d = JSON.parse(JSON.stringify(doc || EMPTY)), seen = {};
    d.monete = d.monete || {};
    rows.forEach(function (m) {
      var id = "a-mano-" + slug(m.posto), sym = cleanSym(m.simbolo);
      if (!seen[id]) {
        seen[id] = { id: id, nome: String(m.posto).trim(), tipo: "manuale", stato: "ok", conti: [{ nome: "Inserito qui", stato: "ok", aggiornato: m.aggiornato || null }] };
        d.posti.push(seen[id]);
      } else if (m.aggiornato && String(m.aggiornato) > String(seen[id].conti[0].aggiornato || "")) seen[id].conti[0].aggiornato = m.aggiornato;
      d.saldi.push({ posto: id, conto: "Inserito qui", simbolo: sym, quantita: +m.quantita });
      if (!d.monete[sym]) d.monete[sym] = KNOWN[sym] ? { cg: KNOWN[sym] } : (sym === "USD" || sym === "EUR" ? { fiat: true } : {});
    });
    return d;
  }

  function store(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function load(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }

  /* A file is usable when it has the shape the program writes */
  function valid(doc) {
    return !!(doc && doc.versione === 1 && Array.isArray(doc.posti) && Array.isArray(doc.saldi) && doc.monete && typeof doc.monete === "object");
  }
  function parse(text) {
    var doc = JSON.parse(text);
    if (!valid(doc)) throw new Error("Il file non è un patrimonio.json scritto dal programma.");
    return doc;
  }

  /* Last copy on this device, so the view works offline */
  function cached() { var c = load(DOC_KEY); return c && valid(c.doc) ? c : null; }
  function cache(doc, file) { store(DOC_KEY, { doc: doc, file: file || null, at: Date.now() }); }
  function cachedPrices() { return load(PRICE_KEY); }

  /* The CoinGecko ids in the file, plus tether for the euro rate */
  function ids(doc) {
    var out = { tether: 1 };
    if (!doc) return Object.keys(out);
    Object.keys(doc.monete).forEach(function (s) { var id = doc.monete[s] && doc.monete[s].cg; if (id && /^[a-z0-9-]+$/.test(id)) out[id] = 1; });
    return Object.keys(out).sort();
  }
  /* One request for every coin. Only the coin names leave the device, never the quantities. */
  function fetchPrices(doc) {
    var list = ids(doc);
    var url = CG + "?ids=" + encodeURIComponent(list.join(",")) + "&vs_currencies=usd,eur&include_24hr_change=true";
    return fetch(url, { headers: { Accept: "application/json" } }).catch(function () { throw { code: "offline" }; }).then(function (r) {
      if (!r.ok) throw { code: r.status === 429 ? "limit" : "http", status: r.status };
      return r.json();
    }).then(function (j) {
      var p = { at: Date.now(), usd: {}, ch: {}, eurUsd: null };
      Object.keys(j || {}).forEach(function (id) {
        var x = j[id] || {};
        if (typeof x.usd === "number") p.usd[id] = x.usd;
        if (typeof x.usd_24h_change === "number") p.ch[id] = x.usd_24h_change;
      });
      var t = j && j.tether;
      if (t && t.usd && t.eur) p.eurUsd = t.usd / t.eur;
      store(PRICE_KEY, p);
      return p;
    });
  }

  /* Price in dollars of a symbol: live first, then the one the program saved with the quantities */
  function priceOf(doc, prices, sym) {
    var m = doc.monete[sym] || {};
    if (sym === "USD") return { usd: 1, src: "fix", ch: 0 };
    if (sym === "EUR") {
      if (prices && prices.eurUsd) return { usd: prices.eurUsd, src: "live", ch: null };
      return typeof m.usd === "number" ? { usd: m.usd, src: "snap", ch: null } : (doc.eur_usd ? { usd: doc.eur_usd, src: "snap", ch: null } : null);
    }
    if (m.cg && prices && typeof prices.usd[m.cg] === "number") return { usd: prices.usd[m.cg], src: "live", ch: typeof prices.ch[m.cg] === "number" ? prices.ch[m.cg] : null };
    if (typeof m.usd === "number") return { usd: m.usd, src: "snap", ch: null, when: m.prezzo_del || doc.creato };
    return null;
  }

  /* Everything the view needs, in dollars */
  function compute(doc, prices) {
    var placeById = {}, places = [], coins = {}, total = 0, cash = 0, changeBase = 0, change = 0, noPrice = {};
    doc.posti.forEach(function (p) {
      var x = { id: p.id, name: p.nome || p.id, type: p.tipo || "", status: p.stato || "ok", accounts: (p.conti || []).map(function (c) {
        return { name: c.nome, status: c.stato || "ok", when: c.aggiornato || null, error: c.errore || null, warn: c.avviso || null, value: 0 };
      }), value: 0, coins: {} };
      placeById[p.id] = x; places.push(x);
    });
    doc.saldi.forEach(function (s) {
      var q = +s.quantita;
      if (!isFinite(q) || !q) return;
      var sym = String(s.simbolo || "?"), pr = priceOf(doc, prices, sym), v = pr ? q * pr.usd : 0;
      var c = coins[sym] || (coins[sym] = { sym: sym, qty: 0, value: 0, price: pr, cash: !!CASH[sym], where: [] });
      c.qty += q; c.value += v;
      var pl = placeById[s.posto];
      if (!pl) { pl = placeById[s.posto] = { id: s.posto, name: s.posto, type: "", status: "ok", accounts: [], value: 0, coins: {} }; places.push(pl); }
      pl.value += v;
      var pc = pl.coins[sym] || (pl.coins[sym] = { sym: sym, qty: 0, value: 0 });
      pc.qty += q; pc.value += v;
      pl.accounts.forEach(function (a) { if (a.name === s.conto) a.value += v; });
      c.where.push({ place: pl.id, placeName: pl.name, account: s.conto, qty: q, value: v });
      if (!pr) noPrice[sym] = 1;
    });
    var list = Object.keys(coins).map(function (k) { return coins[k]; });
    list.forEach(function (c) {
      if (Math.abs(c.qty) < 1e-12) { c.qty = 0; c.value = 0; }
      total += c.value;
      if (c.cash) cash += c.value;
      if (c.price && c.price.ch !== null && c.price.ch !== undefined && c.value) {
        var before = c.value / (1 + c.price.ch / 100);
        change += c.value - before; changeBase += before;
      }
    });
    list.sort(function (a, b) { return b.value - a.value || a.sym.localeCompare(b.sym); });
    list.forEach(function (c) {
      c.pct = total > 0 ? c.value / total : 0;
      c.where.sort(function (a, b) { return b.value - a.value || b.qty - a.qty; });
    });
    places.forEach(function (p) {
      p.pct = total > 0 ? p.value / total : 0;
      p.coinList = Object.keys(p.coins).map(function (k) { return p.coins[k]; }).sort(function (a, b) { return b.value - a.value || b.qty - a.qty; });
    });
    places.sort(function (a, b) { return b.value - a.value; });
    var live = list.filter(function (c) { return c.price && c.price.src === "live"; }).length;
    var snap = list.filter(function (c) { return c.price && c.price.src === "snap"; }).length;
    return { total: total, eurUsd: (prices && prices.eurUsd) || doc.eur_usd || null, cash: cash, change: changeBase ? change : null, changePct: changeBase ? change / changeBase : null,
      coins: list, places: places, noPrice: Object.keys(noPrice).sort(), liveCount: live, snapCount: snap, created: doc.creato };
  }

  /* ---------- Currencies on an exchange counted as a bank account ----------
     settings.wealth.asBank = {"okx|EUR": true}: that balance leaves the crypto and joins the accounts on the Patrimonio page */
  function isFiat(doc, sym) { var m = doc && doc.monete && doc.monete[sym]; return !!(m && m.fiat) || sym === "EUR" || sym === "USD"; }
  function placeNames(doc) { var n = {}; ((doc && doc.posti) || []).forEach(function (p) { n[p.id] = p.nome || p.id; }); return n; }
  /* Every currency (not stablecoin) held somewhere, one row per place and currency */
  function fiatSpots(doc) {
    var out = {}, names = placeNames(doc);
    ((doc && doc.saldi) || []).forEach(function (s) {
      var sym = String(s.simbolo || ""), q = +s.quantita;
      if (!isFiat(doc, sym) || !isFinite(q)) return;
      var k = s.posto + "|" + sym, x = out[k] || (out[k] = { key: k, place: s.posto, placeName: names[s.posto] || s.posto, sym: sym, qty: 0, accounts: [] });
      x.qty += q; if (x.accounts.indexOf(s.conto) < 0) x.accounts.push(s.conto);
    });
    return Object.keys(out).map(function (k) { return out[k]; }).sort(function (a, b) { return a.placeName.localeCompare(b.placeName) || a.sym.localeCompare(b.sym); });
  }
  /* The file without the balances counted as a bank account, and those balances apart */
  function splitBank(doc, asBank) {
    var on = asBank || {};
    if (!doc || !Object.keys(on).some(function (k) { return on[k]; })) return { doc: doc, bank: [] };
    var bank = {}, rest = [], names = placeNames(doc), posti = {};
    doc.posti.forEach(function (p) { posti[p.id] = p; });
    doc.saldi.forEach(function (s) {
      var sym = String(s.simbolo || ""), k = s.posto + "|" + sym;
      if (!on[k] || !isFiat(doc, sym)) { rest.push(s); return; }
      var b = bank[k] || (bank[k] = { key: k, place: s.posto, placeName: names[s.posto] || s.posto, sym: sym, qty: 0, accounts: [] });
      var q = +s.quantita; if (isFinite(q)) b.qty += q;
      var c = ((posti[s.posto] || {}).conti || []).filter(function (x) { return x.nome === s.conto; })[0] || {};
      b.accounts.push({ name: s.conto, qty: isFinite(q) ? q : 0, status: c.stato || "ok", when: c.aggiornato || null });
    });
    var d = {}; Object.keys(doc).forEach(function (k) { d[k] = doc[k]; }); d.saldi = rest;
    return { doc: d, bank: Object.keys(bank).map(function (k) { return bank[k]; }) };
  }
  /* A currency amount in euros: euros as they are, the others with their dollar price and the euro rate */
  function fiatEur(doc, prices, sym, q, eurUsd) {
    if (sym === "EUR") return q;
    var p = priceOf(doc, prices, sym);
    return p && eurUsd ? q * p.usd / eurUsd : null;
  }

  /* ---------- Bank accounts and ETFs for the Patrimonio page ---------- */
  var BANKS = ["poste", "fineco"];
  function cleanText(x) { var t = String(x || ""); return (t.replace(/^[^\p{L}\p{N}]+/u, "").trim() || t.trim()); }
  /* Where each Money Manager account takes its money from: poste, fineco, etherfi (the card, already in its balance) or none */
  function accountSource(map, name) {
    var v = map && map[name];
    if (v === "poste" || v === "fineco" || v === "etherfi" || v === "none") return v;
    if (/contant|cash/i.test(name)) return "none";
    if (/ether/i.test(name)) return "etherfi";
    return "poste";
  }
  function isEtf(macro, sub) { return /invest/i.test(macro) && /etf|pac/i.test(sub); }
  function addDays(d, n) { var x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + n); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); }

  /* Balances of Poste and Fineco: the balances typed at a date, then what happened from the next day to today.
     rows: Money Manager rows as read from the backup; topups: deposits on ether.fi seen by the PC program. */
  function banks(rows, w, topups, todayStr) {
    w = w || {};
    var from = w.date, giro = { amount: +((w.giro || {}).amount) || 0, day: +((w.giro || {}).day) || 15 }, fee = isFinite(+w.fee) ? +w.fee : 0;
    var B = {}; BANKS.forEach(function (k) { B[k] = { start: +w[k] || 0, income: 0, spent: 0, etf: 0, giroIn: 0, giroOut: 0, topups: 0, fees: 0, nTopups: 0, nGiro: 0, value: 0, items: [] }; });
    if (!from) return { set: false, banks: B, accounts: {}, topups: [] };
    var accounts = {};
    (rows || []).forEach(function (r) {
      var t = String(r.type), date = String(r.date || "").slice(0, 10), amt = parseFloat(r.money);
      if (!isFinite(amt)) amt = parseFloat(r.amt2);
      var acc = cleanText(r.asset) || "Altro";
      if (!accounts[acc]) accounts[acc] = { name: acc, source: accountSource(w.accounts, acc), n: 0, out: 0, inc: 0 };
      if (!isFinite(amt) || !date || date <= from || date > todayStr || (t !== "0" && t !== "1")) return;
      var macro = cleanText(r.pname || r.cname), sub = r.pname ? cleanText(r.cname) : "";
      var src = accounts[acc].source;
      accounts[acc].n++;
      if (t === "1" && isEtf(macro, sub)) { B.fineco.etf += amt; B.fineco.items.push({ date: date, kind: "etf", amount: -amt, text: r.text || sub }); return; }
      if (src !== "poste" && src !== "fineco") return;
      if (t === "0") { B[src].income += amt; accounts[acc].inc += amt; B[src].items.push({ date: date, kind: "in", amount: amt, text: r.text || macro }); }
      else { B[src].spent += amt; accounts[acc].out += amt; }
    });
    if (giro.amount) {
      var d = from.slice(0, 7);
      for (var i = 0; i < 600; i++) {
        var y = +d.slice(0, 4), m = +d.slice(5, 7), last = new Date(y, m, 0).getDate();
        var day = d + "-" + String(Math.min(giro.day, last)).padStart(2, "0");
        if (day > todayStr) break;
        if (day > from) { B.poste.giroOut += giro.amount; B.fineco.giroIn += giro.amount; B.poste.nGiro++; B.fineco.nGiro++; }
        m++; if (m > 12) { m = 1; y++; } d = y + "-" + String(m).padStart(2, "0");
      }
    }
    var skip = w.topupSkip || {}, cut = new Date(addDays(from, 1) + "T00:00:00").getTime(), list = [];
    (topups || []).forEach(function (x) {
      var at = new Date(x.quando).getTime(), eur = +x.eur;
      if (!isFinite(at) || !isFinite(eur) || at < cut) return;
      var used = !skip[x.id];
      list.push({ id: x.id, when: x.quando, sym: x.simbolo, qty: +x.quantita, eur: eur, used: used });
      if (used) { B.poste.topups += eur; B.poste.fees += fee; B.poste.nTopups++; }
    });
    list.sort(function (a, b) { return String(b.when).localeCompare(String(a.when)); });
    B.poste.value = B.poste.start + B.poste.income - B.poste.spent - B.poste.giroOut - B.poste.topups - B.poste.fees;
    B.fineco.value = B.fineco.start + B.fineco.income - B.fineco.spent + B.fineco.giroIn - B.fineco.etf;
    return { set: true, from: from, banks: B, accounts: accounts, topups: list, fee: fee, giro: giro };
  }

  /* ETFs: the ISINs and prices come from the PC file, the number of shares is typed on the site */
  function etfs(doc, held, eurUsd) {
    var out = [];
    ((doc && doc.etf) || []).forEach(function (e) {
      if (!e || !e.isin) return;
      var h = (held || {})[e.isin] || {}, q = +h.qty || 0, p = +e.prezzo, cur = String(e.valuta || "EUR").toUpperCase(), eur = null;
      if (isFinite(p) && p > 0) { if (cur === "EUR") eur = p; else if (cur === "USD" && eurUsd) eur = p / eurUsd; }
      out.push({ isin: e.isin, name: e.nome || e.isin, symbol: e.simbolo || "", qty: q, qtyAt: h.at || null, price: isFinite(p) ? p : null, cur: cur,
        priceEur: eur, priceAt: e.quando || null, error: e.errore || null, value: eur !== null ? q * eur : 0 });
    });
    return out;
  }

  return { valid: valid, parse: parse, cached: cached, cache: cache, cachedPrices: cachedPrices, fetchPrices: fetchPrices, compute: compute, ids: ids,
    withManual: withManual, cleanSym: cleanSym, KNOWN: KNOWN, banks: banks, etfs: etfs, accountSource: accountSource,
    fiatSpots: fiatSpots, splitBank: splitBank, fiatEur: fiatEur };
})();
