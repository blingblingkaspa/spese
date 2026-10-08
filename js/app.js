(function () {
  var CACHE_KEY = "mm-last-backup-v1", SETTINGS_KEY = "mm-settings-v3", VIEW_KEY = "mm-view";
  var NAMES = { ess: "Spese Essenziali", div: "Divertimento", inv: "Investimenti" };
  var $ = function (id) { return document.getElementById(id); };
  /* Money: Italian format, real minus sign, thousands always grouped */
  var eurF = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", useGrouping: "always" });
  var eur0F = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0, useGrouping: "always" });
  var n0F = new Intl.NumberFormat("it-IT", { maximumFractionDigits: 0, useGrouping: "always" });
  function minus(s) { return s.replace(/-/g, "−"); }
  function zero(x) { return Math.abs(x) < 0.5 ? 0 : x; }
  var eur = { format: function (x) { return minus(eurF.format(Math.abs(x) < 0.005 ? 0 : x)); } };
  var eur0 = { format: function (x) { return minus(eur0F.format(zero(x))); } };
  function n0(x) { return minus(n0F.format(zero(x))); }
  function signed(x) { x = zero(x); return (x > 0 ? "+" : "") + eur0.format(x); }
  var pct = function (x) { return (x * 100).toLocaleString("it-IT", { maximumFractionDigits: 0 }) + "%"; };
  /* Patrimonio: dollars, coin quantities and prices */
  var usdF0 = new Intl.NumberFormat("it-IT", { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", maximumFractionDigits: 0, useGrouping: "always" });
  var usdF2 = new Intl.NumberFormat("it-IT", { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol", minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" });
  var qtyF = [2, 4, 8].map(function (d) { return new Intl.NumberFormat("it-IT", { maximumFractionDigits: d, useGrouping: "always" }); });
  var prF = new Intl.NumberFormat("it-IT", { maximumSignificantDigits: 4 });
  function usd0(x) { return minus(usdF0.format(zero(x))); }
  function qty(x) { var a = Math.abs(x); return minus(qtyF[a >= 1000 ? 0 : a >= 1 ? 1 : 2].format(x)); }
  function share(x) { return x > 0 && x < 0.005 ? "<1%" : (x * 100).toLocaleString("it-IT", { maximumFractionDigits: x < 0.1 ? 1 : 0 }) + "%"; }
  function when(iso) {
    if (!iso) return "";
    var d = new Date(iso); if (isNaN(d)) return "";
    var t = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }), now = new Date();
    var day = function (x) { return x.getFullYear() + "-" + x.getMonth() + "-" + x.getDate(); };
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (day(d) === day(now)) return "oggi alle " + t;
    if (day(d) === day(y)) return "ieri alle " + t;
    return d.toLocaleDateString("it-IT", { day: "numeric", month: "short" }) + " alle " + t;
  }
  var fmtDate = function (d) { var p = d.split("-"); return p[2] + "/" + p[1] + "/" + p[0].slice(2); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function today() { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function cvar(c) { return c ? "var(--c-" + c + ")" : "var(--muted)"; }
  function monthName(m) { return MM.monthLong(m).split(" ")[0]; }
  function subName(s) { return s.sub === "Generico" && !s.container ? s.macro : s.sub; }
  var ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/></svg>';

  var state = { data: null, src: null, SQL: null, view: "mese", month: null, movFilter: "all", sheet: null, editPlan: false,
    pf: { doc: null, file: null, prices: null, err: null, loading: false, priceErr: null, priceLoading: false, checkedAt: 0 } };

  /* ---------- Settings: this device first, then the file in the user's Drive ---------- */
  var settings = clone(MM.DEFAULT_SETTINGS);
  try { var localSettings = JSON.parse(load(SETTINGS_KEY) || "null"); if (localSettings) settings = Object.assign(clone(MM.DEFAULT_SETTINGS), localSettings); } catch (e) {}
  var saveTimer = null, remoteState = "pending";
  function syncMsg(t) { var el = $("syncInfo"); if (el) el.textContent = t; }
  function saveSettings() {
    settings.savedAt = new Date().toISOString();
    store(SETTINGS_KEY, JSON.stringify(settings));
    if (!Drive.token()) { syncMsg("Impostazioni salvate su questo dispositivo: le copio nel tuo Drive al prossimo accesso."); return; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      Drive.saveSettings(clone(settings)).then(function () { remoteState = "ok"; syncMsg("Impostazioni salvate nel tuo Drive: sono le stesse su ogni dispositivo."); })
        .catch(function () { syncMsg("Non sono riuscito a salvarle nel Drive: le salvo qui e riprovo al prossimo aggiornamento."); });
    }, 600);
  }
  /* Newest copy wins; the first time, an import file in Drive (spese-impostazioni.json) is used if present */
  function syncSettings() {
    return Drive.loadSettings().then(function (remote) {
      if (remote) {
        if ((remote.savedAt || "") >= (settings.savedAt || "")) {
          var changed = JSON.stringify(remote) !== JSON.stringify(settings);
          settings = Object.assign(clone(MM.DEFAULT_SETTINGS), remote);
          store(SETTINGS_KEY, JSON.stringify(settings));
          return changed ? "changed" : "same";
        }
        return Drive.saveSettings(clone(settings)).then(function () { return "pushed"; });
      }
      return Drive.findImport().catch(function () { return null; }).then(function (imp) {
        if (imp && !settings.savedAt) settings = Object.assign(clone(MM.DEFAULT_SETTINGS), imp);
        if (!settings.savedAt || imp) settings.savedAt = new Date().toISOString();
        store(SETTINGS_KEY, JSON.stringify(settings));
        return Drive.saveSettings(clone(settings)).then(function () { return imp ? "changed" : "created"; });
      });
    }).then(function (r) { remoteState = "ok"; syncMsg("Impostazioni salvate nel tuo Drive: sono le stesse su ogni dispositivo."); return r; });
  }

  /* ---------- Status ---------- */
  function setStatus(kind, text) {
    $("dot").className = "dot " + (kind || ""); $("statusText").textContent = text;
    $("refresh").classList.toggle("spin", kind === "loading");
  }
  function srcLine(src) {
    if (!src) return "";
    var when = src.when ? new Date(src.when).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    return "Backup del " + when;
  }

  /* ---------- Loading ---------- */
  function sqlReady() {
    if (state.SQL) return Promise.resolve(state.SQL);
    if (typeof initSqlJs !== "function") return Promise.reject(new Error("La libreria per leggere i backup non si è caricata. Ricarica la pagina."));
    return initSqlJs({ locateFile: function (f) { return "vendor/" + f; } }).then(function (SQL) { state.SQL = SQL; return SQL; });
  }
  function b64ToBytes(b64) { var bin = atob(b64), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function bytesToB64(bytes) { var s = "", step = 0x8000; for (var i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, i + step)); return btoa(s); }
  function ingest(bytes, src) {
    return sqlReady().then(function (SQL) {
      var raw = MM.readDb(SQL, bytes);
      state.rows = raw.rows;
      state.full = MM.normalise(raw.rows, today());
      rescope();
      state.src = src;
      $("needFile").hidden = true;
      if (!$("signinBox").dataset.why) $("signinBox").hidden = true;
      else $("signinBox").hidden = false;
      buildSelectors();
      renderAll();
      showView(state.view);
    });
  }
  function cacheBackup(bytes, src) { if (bytes.length < 3300000) store(CACHE_KEY, JSON.stringify({ b64: bytesToB64(bytes), src: src })); }
  function rescope() { if (state.full) state.data = MM.scope(state.full, settings.startMonth); }

  function showSignIn(why) {
    var text = why || "Accedi con Google per leggere i backup di Money Manager dal tuo Drive.";
    $("signinWhy").textContent = text;
    $("signinBox").dataset.why = "1";
    // with no data the welcome screen already has the button: the banner shows only over real data
    $("signinBox").hidden = !state.data;
    if (!state.data && why) $("needWhy").textContent = why;
    setStatus("warn", state.data ? srcLine(state.src) + " · non collegato a Google" : "Non collegato a Google");
    renderAccount();
  }
  function hideSignIn() { $("signinBox").hidden = true; delete $("signinBox").dataset.why; }

  function errorCopy(err) {
    var c = err && err.code;
    if (c === "offline") return "Sei offline: mostro l'ultima copia.";
    if (c === "nofolder") return "Non trovo la cartella \"" + (settings.folderName || "MoneyManager") + "\" nel tuo Drive. Controlla il nome in Impostazioni.";
    if (c === "notfound") return "La cartella dei backup non è più raggiungibile. La cerco di nuovo al prossimo aggiornamento.";
    if (c === "nobackup") return "Nella cartella non c'è nessun file .mmbak.";
    if (c === "limit") return "Google ha rifiutato la richiesta per troppi accessi. Riprova tra qualche minuto.";
    if (c === "http") return "Google Drive ha risposto con un errore (" + err.status + "). Riprova tra poco.";
    return (err && err.message) || "Errore nel leggere da Drive.";
  }
  function ensureFolder() {
    if (settings.folderId) return Promise.resolve(settings.folderId);
    return Drive.findFolders(settings.folderName || "MoneyManager").then(function (fs) {
      if (!fs.length) throw { code: "nofolder" };
      fs.sort(function (a, b) { return String(b.modifiedTime).localeCompare(String(a.modifiedTime)); });
      settings.folderId = fs[0].id; saveSettings();
      return fs[0].id;
    });
  }
  var syncing = false;
  function syncFromDrive(manual) {
    if (syncing) return;
    if (!Drive.configured()) { setStatus("err", "Manca il Client ID di Google in config.js: segui il README."); return; }
    if (!Drive.token()) {
      if (!manual && Drive.canTrySilent()) { setStatus("loading", "Rinnovo l'accesso a Google…"); Drive.signIn(true); return; }
      showSignIn(Drive.wasSignedIn() ? "L'accesso a Google è scaduto: entra di nuovo per aggiornare i dati." : null);
      return;
    }
    hideSignIn();
    syncPortfolio();
    syncing = true; $("reloadBtn").disabled = true; $("refresh").disabled = true;
    setStatus("loading", "Cerco l'ultimo backup su Drive…");
    syncSettings().catch(function (e) { if (e && e.code === "auth") throw e; syncMsg("Non riesco a leggere le impostazioni dal Drive: uso quelle di questo dispositivo."); })
      .then(function (r) { if ((r === "changed") && state.full) { rescope(); buildSelectors(); renderAll(); } })
      .then(ensureFolder)
      .then(function (folderId) { return Drive.latestBackup(folderId); })
      .then(function (file) {
        if (!file) throw { code: "nobackup" };
        var src = { id: file.id, name: file.name, when: file.modifiedTime, via: "drive" };
        if (state.src && state.src.id === file.id && String(state.src.when || "") >= String(src.when || "")) { setStatus("", srcLine(state.src) + " · aggiornato"); return; }
        setStatus("loading", "Scarico il backup…");
        return Drive.download(file.id).then(function (buf) {
          var bytes = new Uint8Array(buf);
          return ingest(bytes, src).then(function () { cacheBackup(bytes, src); setStatus("", srcLine(src) + " · aggiornato"); });
        });
      })
      .catch(function (err) {
        if (err && err.code === "auth") { showSignIn("L'accesso a Google è scaduto: entra di nuovo per aggiornare i dati."); return; }
        if (err && err.code === "notfound") { settings.folderId = null; saveSettings(); }
        var msg = errorCopy(err);
        if (state.data) setStatus(err && err.code === "offline" ? "" : "warn", srcLine(state.src) + " · " + msg);
        else { setStatus("err", "Nessun dato"); $("needWhy").textContent = msg; $("needFile").hidden = false; }
      })
      .then(function () { syncing = false; $("reloadBtn").disabled = false; $("refresh").disabled = false; renderAccount(); });
  }
  function openFile(file) {
    if (!file) return;
    setStatus("loading", "Leggo " + file.name + "…");
    file.arrayBuffer().then(function (buf) {
      var bytes = new Uint8Array(buf), src = { name: file.name, when: file.lastModified ? new Date(file.lastModified).toISOString() : null, via: "file" };
      return ingest(bytes, src).then(function () { cacheBackup(bytes, src); });
    }).then(function () { setStatus("", srcLine(state.src) + " · aperto a mano"); })
      .catch(function () { setStatus("err", "Il file scelto non è un backup di Money Manager"); });
  }
  function renderAccount() {
    var on = !!Drive.token();
    $("acctInfo").textContent = !Drive.configured() ? "Manca il Client ID di Google in config.js." : on ? "Collegato a Google" : Drive.wasSignedIn() ? "Accesso scaduto: entra di nuovo per aggiornare" : "Non collegato a Google";
    $("signinBtn2").hidden = on || !Drive.configured();
    $("signoutBtn").hidden = !Drive.wasSignedIn();
    $("reloadBtn").hidden = !on;
    $("folderIn").value = settings.folderName || "MoneyManager";
  }

  /* ---------- Views ---------- */
  var TITLES = { mese: "Mese", grafici: "Andamento", analisi: "Medie", movimenti: "Movimenti", patrimonio: "Patrimonio", crypto: "Crypto", impostazioni: "Impostazioni" };
  function showView(v) {
    state.view = v; store(VIEW_KEY, v);
    Charts.hideTip();
    document.querySelectorAll(".view").forEach(function (el) { el.hidden = !state.data || el.id !== "v-" + v; });
    if (v === "impostazioni") $("v-impostazioni").hidden = false;
    document.querySelectorAll("#drawer button[data-view]").forEach(function (b) { if (b.dataset.view === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    document.title = TITLES[v] + " · Spese";
    if (state.data) renderView(v);
    else if (v === "impostazioni") renderSettings();
  }

  function buildSelectors() {
    var cur = today().slice(0, 7);
    var months = {};
    state.data.expenses.forEach(function (e) { months[e.month] = 1; });
    state.data.incomes.forEach(function (e) { months[e.month] = 1; });
    state.data.future.forEach(function (e) { months[e.month] = 1; });
    months[cur] = 1;
    var list = Object.keys(months).sort().reverse();
    var led = MM.ledger(state.data, settings, today());
    var mList = led.months.slice().reverse();
    var sel = $("monthSel"), prev = state.month || cur;
    sel.innerHTML = mList.map(function (m) { return '<option value="' + m + '">' + cap(MM.monthLong(m)) + "</option>"; }).join("");
    sel.value = mList.indexOf(prev) >= 0 ? prev : mList[0];
    state.month = sel.value;
    var lastData = Object.keys(months).filter(function (m) { return m < cur || (m === cur && (state.data.expenses.some(function (e) { return e.month === cur; }) || state.data.incomes.some(function (e) { return e.month === cur; }))); }).sort().pop() || cur;
    var mv = $("movMonth"), pv = state.movUserSet && mv.value ? mv.value : lastData;
    mv.innerHTML = list.map(function (m) { return '<option value="' + m + '">' + cap(MM.monthLong(m)) + "</option>"; }).join("");
    mv.value = list.indexOf(pv) >= 0 ? pv : list[0];
    var pp = state.period || load("mm-period") || cur.slice(0, 4);
    var years = {}; state.data.expenses.forEach(function (e) { years[e.date.slice(0, 4)] = 1; }); years[cur.slice(0, 4)] = 1;
    var opts = Object.keys(years).sort().reverse().map(function (y) { return [y, "Anno " + y]; }).concat([["last12", "Ultimi 12 mesi"], ["all", "Tutto lo storico"]]);
    var html = opts.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + "</option>"; }).join("");
    state.period = opts.some(function (o) { return o[0] === pp; }) ? pp : opts[0][0];
    ["period", "trendPeriod"].forEach(function (id) { $(id).innerHTML = html; $(id).value = state.period; });
    syncPeriodLabels();
  }
  function syncPeriodLabels() {
    var t = $("period").options[$("period").selectedIndex];
    $("periodLabel").textContent = $("trendPeriodLabel").textContent = t ? t.textContent : "";
  }
  function setPeriod(v) { state.period = v; store("mm-period", v); $("period").value = v; $("trendPeriod").value = v; syncPeriodLabels(); }

  function renderAll() {
    state.led = MM.ledger(state.data, settings, today());
    renderView(state.view);
    if (state.sheet) openSheet(state.sheet);
  }
  function renderView(v) {
    if (!state.led) state.led = MM.ledger(state.data, settings, today());
    if (v === "mese") renderMonth();
    else if (v === "grafici") renderTrends();
    else if (v === "analisi") renderAnalysis();
    else if (v === "movimenti") renderMoves();
    else if (v === "crypto") { renderCrypto(); refreshPrices(false); }
    else if (v === "patrimonio") { renderWealth(); refreshPrices(false); }
    else if (v === "impostazioni") renderSettings();
  }

  /* ---------- Mese: the three envelopes ---------- */
  function rowFor(m) { var r = null; state.led.rows.forEach(function (x) { if (x.month === m) r = x; }); return r; }
  function shareText(r, c) {
    var t = (+r.rule[c] || 0) + "%";
    if (c === "inv" && (+r.rule.liq || 0)) t = MM.round2((+r.rule.inv || 0) * (100 - (+r.rule.liq || 0)) / 100) + "% + " + MM.round2((+r.rule.inv || 0) * (+r.rule.liq || 0) / 100) + "%";
    return t;
  }
  /* What the month's quota is, or what it will be when the salary arrives */
  function quotaInfo(r, c) {
    var cc = r.c[c];
    if (cc.quota > 0) return { quota: cc.quota, expected: false };
    if (r.kind === "waiting") {
      var q = MM.expectedQuota(state.led, settings, r.month, c);
      if (q > 0) return { quota: q, expected: true };
    }
    return { quota: 0, expected: false };
  }
  function renderMonth() {
    var led = state.led, m = state.month, r = rowFor(m);
    var idx = led.months.indexOf(m);
    $("monPrev").disabled = idx <= 0; $("monNext").disabled = idx < 0 || idx >= led.months.length - 1;
    $("monthName").textContent = cap(monthName(m)); $("monthYear").textContent = m.slice(0, 4);
    if (!r) { $("envelopes").innerHTML = '<p class="empty">Nessun dato per questo mese.</p>'; return; }
    var mName = monthName(m), nextName = monthName(MM.addMonths(m, 1));
    var prevMode = settings.salaryPrevMonth !== false, isCur = m === led.cur;
    var inc = $("incomeBox");
    if (r.kind === "real") inc.innerHTML = "Stipendio di " + mName + ": <b>" + eur.format(r.income) + "</b>";
    else if (r.kind === "est") inc.innerHTML = "Stipendio di " + mName + ": <b>" + eur.format(r.income) + "</b> (stima)";
    else if (r.kind === "waiting") inc.textContent = "Stipendio di " + mName + ": " + (prevMode ? (isCur ? "arriva a " + nextName : "in arrivo") : "non ancora registrato");
    else inc.textContent = "Stipendio di " + mName + ": non registrato";
    var html = "", total = 0;
    MM.CONTAINERS.forEach(function (c) {
      var cc = r.c[c]; total += cc.avail;
      var q = quotaInfo(r, c), carry = cc.avail - cc.quota + cc.spent;
      var ratio = q.quota > 0 ? Math.min(cc.spent / q.quota, 1) : 0, over = q.quota > 0 && cc.spent > q.quota;
      var left = cap(mName) + ": <b>" + eur0.format(cc.spent) + "</b>";
      if (over && !q.expected) left += " · " + eur0.format(cc.spent - q.quota) + " oltre la quota";
      else if (q.quota > 0) left += " di " + (q.expected ? "circa " : "") + eur0.format(q.quota) + (q.expected ? " attesi" : "");
      else left += r.kind === "missing" ? " · nessuno stipendio" : " · quota con lo stipendio";
      if (cc.hist) left += " · altra app";
      var right = idx > 0 || zero(carry) ? "riporto " + signed(carry) : "";
      var state_ = cc.avail < 0 ? '<span class="alert" aria-hidden="true">!</span>Sei sotto di questa cifra' : (c === "inv" ? "Da investire" : "Disponibile");
      html += '<button type="button" class="env" data-c="' + c + '" style="--card:var(--card-' + c + ')">' +
        '<span class="env-head"><span>' + NAMES[c] + '</span><span class="env-share">' + shareText(r, c) + "</span></span>" +
        '<span class="env-big">' + eur0.format(cc.avail) + "</span>" +
        '<span class="env-state">' + state_ + "</span>" +
        '<span class="meter' + (q.expected ? " waiting" : "") + '" aria-hidden="true">' + (ratio ? '<i style="width:' + (ratio * 100).toFixed(1) + '%"></i>' : "") + "</span>" +
        '<span class="env-foot"><span>' + left + "</span><span>" + right + "</span></span>" +
        (c === "inv" ? '<span class="env-liq"><span>Liquidità per discese, sul conto</span><b>' + eur0.format(r.liq.avail) + "</b></span>" : "") +
        "</button>";
      if (c === "inv") total += r.liq.avail;
    });
    $("envelopes").innerHTML = html;
    $("totalAvail").textContent = eur0.format(total);
    $("totalAvail").className = "num " + (total < 0 ? "neg" : "");
    var notes = [];
    if (r.kind === "waiting") {
      if (prevMode && isCur) notes.push("Lo stipendio di " + mName + " arriva a " + nextName + ": per ora il disponibile conta quello che hai già incassato. Quando lo registri in Money Manager con la categoria Stipendio, la quota di " + mName + " si aggiorna.");
      else if (prevMode) notes.push("Lo stipendio di " + mName + " non è ancora in Money Manager. Di solito arriva tra il 5 e il 15 di " + nextName + ": quando lo registri, le quote di " + mName + " si aggiornano.");
      else notes.push("Lo stipendio di " + mName + " non è ancora in Money Manager: il disponibile conta solo i mesi precedenti.");
      var ex = MM.expectedIncome(led, settings);
      if (ex.income) notes.push("Le quote attese (le barre a righe) usano " + (ex.from === "real" ? "il tuo stipendio tipico, " + eur0.format(ex.income) : "lo stipendio stimato, " + eur0.format(ex.income)) + ": servono solo a capire a che punto sei, il disponibile non cambia.");
    }
    if (r.kind === "est") notes.push("Per questo mese uso lo stipendio stimato (" + eur.format(r.income) + "), perché non hai ancora registrato stipendi in Money Manager.");
    if (r.kind === "missing") notes.push("Per " + mName + " non c'è nessuno Stipendio registrato" + (prevMode ? " (lo cerco tra le entrate di " + nextName + ")" : "") + ": la quota del mese è zero.");
    var oth = led.other.filter(function (e) { return e.month === m; });
    if (oth.length) notes.push(oth.length + " spese di questo mese sono in categorie fuori dai tre contenitori e non sono conteggiate.");
    var fut = state.data.future;
    if (fut.length && m === led.cur) notes.push("Spese con data futura, conteggiate quando arriva la data: " + fut.map(function (e) { return esc(e.text || e.sub) + " " + eur0.format(e.amount) + " il " + fmtDate(e.date); }).join(", ") + ".");
    $("monthNotes").innerHTML = notes.map(function (t) { return '<p class="note-i">' + ICON_INFO + "<span>" + t + "</span></p>"; }).join("");
    $("monthNotes").hidden = !notes.length;
  }
  function stepMonth(d) {
    var list = state.led.months, i = list.indexOf(state.month) + d;
    if (i < 0 || i >= list.length) return;
    state.month = list[i]; $("monthSel").value = state.month; renderMonth();
  }

  /* ---------- Sheets: a container in a month, or a category over the period ---------- */
  function openSheet(s) {
    if (typeof s === "string") s = { c: s };
    state.sheet = s;
    Charts.hideTip();
    var wasOpen = !$("sheet").hidden;
    $("scrim").hidden = false; $("sheet").hidden = false;
    document.body.classList.add("locked");
    if (s.key) categorySheet(s.key); else containerSheet(s.c);
    if (!wasOpen) { $("sheet").scrollTop = 0; $("sheetClose").focus(); }
  }
  function sheetTitle(text, color) {
    $("sheetTitle").innerHTML = '<i class="cdot" style="--c:' + color + '"></i>' + esc(text);
  }
  function containerSheet(c) {
    var m = state.month, d = MM.detail(state.data, state.led, c, m, settings), r = d.row, cc = r.c[c];
    var idx = state.led.months.indexOf(m), q = quotaInfo(r, c), carry = cc.avail - cc.quota + cc.spent;
    $("sheetEyebrow").textContent = cap(MM.monthLong(m)) + " · " + (+r.rule[c] || 0) + "% delle entrate";
    sheetTitle(NAMES[c], cvar(c));
    var body = '<div class="card calc">' +
      "<div><span>" + (idx > 0 ? "Riporto da " + MM.monthLong(state.led.months[idx - 1]).split(" ")[0] : "Riporto") + '</span><b class="' + (carry < 0 ? "neg" : "") + '">' + signed(carry) + "</b>" + (idx > 0 ? "<small>Quello che restava a fine mese, avanzi e debiti compresi.</small>" : "") + "</div>" +
      "<div><span>Quota di " + monthName(m) + "</span><b>" + signed(cc.quota) + "</b>" +
        (q.expected ? "<small>Lo stipendio non è ancora arrivato: la quota sarà di circa " + eur0.format(q.quota) + ".</small>" : cc.quota ? "" : "<small>Nessuno stipendio per questo mese.</small>") + "</div>" +
      "<div><span>Speso a " + monthName(m) + "</span><b>" + signed(-cc.spent) + "</b>" + (cc.hist ? "<small>Totale registrato nell'altra app.</small>" : "") + "</div>" +
      '<div class="tot"><span>' + (c === "inv" ? "Da investire" : "Disponibile") + '</span><b class="' + (cc.avail < 0 ? "neg" : "") + '">' + eur0.format(cc.avail) + "</b></div></div>";

    if (c === "inv" && d.split) {
      var sp = d.split, lab = { etf: "PAC ETF", crypto: "Crypto" }, lq = d.liq;
      var note = d.trackedFrom ? (d.trackedFrom > state.led.start ? "Dal " + MM.monthLong(d.trackedFrom) + ": per i mesi prima uso solo i totali dell'altra app." : "Dal " + MM.monthLong(d.trackedFrom) + ".") : "Tutti i mesi sono coperti dai totali dell'altra app.";
      if (d.trackedFrom && !d.firstMM) note += " Non hai ancora registrato ETF o Crypto in Money Manager.";
      body += '<div class="card" style="display:grid;gap:4px"><h3 class="h">Da investire</h3><p class="small">' + note + "</p>";
      ["etf", "crypto"].forEach(function (k) {
        var s = sp[k], ratio = s.quota > 0 ? Math.min(s.done / s.quota, 1) : 0;
        body += '<div class="rowbar" style="--c:' + cvar("inv") + '"><span>' + lab[k] + ' <small>' + (+r.rule[k] || 0) + '%</small></span><span class="v">' + eur0.format(s.done) + " <small>di " + eur0.format(s.quota) + '</small></span><span class="bar"><i style="width:' + (ratio * 100).toFixed(1) + '%"></i></span></div>';
      });
      body += '<div class="rowbar"><span>Liquidità per discese <small>' + (+r.rule.liq || 0) + "%, sul conto</small></span><span class=\"v " + (lq.avail < 0 ? "neg" : "") + '">' + eur0.format(lq.avail) + "</span>" +
        "<small style=\"grid-column:1/-1\">Accumulata: " + eur0.format(lq.quota) + (lq.used ? " · usata per acquisti: " + eur0.format(lq.used) : "") + ". Non va versata: per usarla registra l'acquisto in Investimenti › Liquidità.</small></div></div>";
      if (d.ignored) body += '<div class="card note-i">' + ICON_INFO + "<span>Per " + MM.monthLong(m) + " uso il totale dell'altra app (" + eur.format(cc.spent) + "). I " + eur.format(d.ignored) + " registrati in Money Manager in questo mese non sono conteggiati: svuota il mese in Impostazioni per usarli.</span></div>";
    }

    body += '<div class="card" style="display:grid;gap:8px"><h3 class="h">' + (c === "inv" ? "Da investire" : "Disponibile") + ' a fine mese</h3><p class="small">Com\'è cambiato mese per mese. Tocca una colonna per i numeri.</p><div id="sheetChart"></div></div>';

    var list = d.list, maxM = Math.max.apply(null, list.map(function (s) { return s.month; }).concat([1]));
    body += '<div class="card" style="display:grid;gap:2px"><h3 class="h">Categorie</h3>' +
      '<div class="subhead"><span></span><span>' + cap(monthName(m)) + "</span><span>Dal " + MM.monthLabel(state.led.start, true) + "</span></div>";
    if (!list.length) body += '<p class="empty">Nessuna spesa registrata.</p>';
    list.forEach(function (s) {
      body += '<div class="subrow" style="--c:' + cvar(c) + '"><span>' + esc(s.sub) + (settings.protected && settings.protected[s.key] ? '<span class="star" title="Da proteggere">★</span>' : "") +
        '</span><span class="v">' + (s.month ? eur0.format(s.month) : "—") + '</span><span class="t">' + eur0.format(s.total) + "</span>" +
        (s.month ? '<span class="bar"><i style="width:' + (s.month / maxM * 100).toFixed(1) + '%"></i></span>' : "") + "</div>";
    });
    body += "</div>";
    var items = cc.items.concat(c === "inv" ? d.liq.items : []).sort(function (a, b) { return b.date.localeCompare(a.date); });
    if (items.length) body += '<div class="card" style="display:grid;gap:2px;padding-block:12px 6px"><h3 class="h">Spese del mese' + (cc.hist ? " (non conteggiate)" : "") + "</h3>" + mvRows(items.map(function (e) { return { e: e }; }), "compact") + "</div>";
    $("sheetBody").innerHTML = body;

    var rows = state.led.rows;
    Charts.columns($("sheetChart"), {
      labels: rows.map(function (x) { return MM.monthLabel(x.month); }),
      values: rows.map(function (x) { return MM.round2(x.c[c].avail); }),
      color: cvar(c), negColor: "var(--bad)", highlight: idx, height: 150,
      fmtAxis: n0, ariaLabel: "Disponibile a fine mese, " + NAMES[c],
      desc: rows.map(function (x) { return MM.monthLong(x.month) + ": " + eur0.format(x.c[c].avail); }).join("; "),
      tip: function (i) {
        var x = rows[i];
        return { title: cap(MM.monthLong(x.month)), rows: [
          { value: eur0.format(x.c[c].avail), label: c === "inv" ? "da investire" : "disponibile", color: x.c[c].avail < 0 ? "var(--bad)" : cvar(c) },
          { value: eur0.format(x.c[c].spent), label: "speso" },
          { value: x.c[c].quota ? eur0.format(x.c[c].quota) : "—", label: "quota" }] };
      }
    });
  }

  function categorySheet(key) {
    var A = periodData(), M = A.M, s = null;
    M.subs.forEach(function (x) { if (x.key === key) s = x; });
    var an = null; A.a.subList.forEach(function (x) { if (x.key === key) an = x; });
    var c = s ? s.container : an ? an.container : null;
    if (!s && !an) { closeSheet(); return; }
    var name = s ? subName(s) : subName(an), macro = s ? s.macro : an.macro;
    $("sheetEyebrow").textContent = macro + " · " + A.periodText;
    sheetTitle(name, cvar(c));
    var vals = A.months.map(function (m) { return s ? MM.round2(s.m[m] || 0) : 0; });
    var avg = s ? s.avg : an.avg, total = s ? s.total : an.total;
    var moves = state.data.expenses.filter(function (e) { return e.key === key && e.month >= A.a.start && e.month <= A.a.end; })
      .sort(function (x, y) { return y.date.localeCompare(x.date); });
    var n = moves.length, t = settings.targets && settings.targets[key];
    var tg = t !== undefined && t !== "" && isFinite(+t) ? +t : null;
    var body = '<div class="card stat4">' +
      '<div><span>Media al mese</span><b>' + eur0.format(avg) + "</b></div>" +
      '<div><span>Totale nel periodo</span><b>' + eur0.format(total) + "</b></div>" +
      '<div><span>Movimenti</span><b>' + (key === "hist" ? "—" : n) + "</b></div>" +
      '<div><span>Spesa media</span><b>' + (n && key !== "hist" ? eur0.format(total / n) : "—") + "</b></div></div>";
    body += '<div class="card" style="display:grid;gap:8px"><h3 class="h">Mese per mese</h3><p class="small">La riga è la media dei mesi chiusi' + (A.cur >= A.a.start && A.cur <= A.a.end ? ", il mese in corso non conta" : "") + '.</p><div id="sheetChart"></div></div>';
    if (tg !== null || (settings.protected && settings.protected[key])) {
      body += '<div class="card plan">' + (tg !== null ? "<div><span>Obiettivo al mese</span><b>" + eur0.format(tg) + "</b></div><div><span>Scarto dalla media</span><b class=\"" + (avg - tg > 0 ? "neg" : "pos") + '">' + signed(avg - tg) + "</b></div>" : "") +
        (settings.protected && settings.protected[key] ? "<div><span>Spesa da proteggere</span><b class=\"star\">★</b></div>" : "") + "</div>";
    }
    if (moves.length) body += '<div class="card" style="display:grid;gap:2px;padding-block:12px 6px"><h3 class="h">Ultimi movimenti</h3>' + mvRows(moves.slice(0, 12).map(function (e) { return { e: e }; }), "bare") + "</div>";
    $("sheetBody").innerHTML = body;
    var cur = A.months.indexOf(A.cur);
    Charts.columns($("sheetChart"), {
      labels: A.months.map(function (m) { return MM.monthLabel(m); }), values: vals, color: cvar(c), current: cur >= 0 ? cur : null,
      valueLabels: true, fmtValue: n0, fmtAxis: n0, avg: avg, avgLabel: "media " + eur0.format(avg), height: 170,
      ariaLabel: name + " mese per mese", desc: A.months.map(function (m, i) { return MM.monthLong(m) + ": " + eur0.format(vals[i]); }).join("; ")
    });
  }
  function closeSheet() {
    var s = state.sheet; state.sheet = null; $("scrim").hidden = true; $("sheet").hidden = true;
    Charts.hideTip();
    document.body.classList.remove("locked");
    var cssq = function (v) { return window.CSS && CSS.escape ? CSS.escape(v) : v; };
    var el = s && (s.key ? document.querySelector('[data-key="' + cssq(s.key) + '"]') : document.querySelector('.env[data-c="' + s.c + '"]'));
    if (el && el.focus) el.focus({ preventScroll: true });
  }

  /* ---------- Period shared by Andamento and Medie ---------- */
  function periodData() {
    var a = MM.analysis(state.data, { today: today(), period: state.period, countInvest: $("inv").checked, protected: settings.protected, targets: settings.targets });
    var cur = state.led.cur, M = MM.monthly(state.led, a.months, cur);
    var closed = a.closed, text;
    if (state.period === "last12") text = "ultimi 12 mesi"; else if (state.period === "all") text = "tutto lo storico"; else text = "anno " + state.period;
    return { a: a, M: M, months: a.months, cur: cur, periodText: text, closedText: closed.length ? MM.monthLabel(closed[0], true) + (closed.length > 1 ? " – " + MM.monthLabel(closed[closed.length - 1], true) : "") : "" };
  }

  /* ---------- Andamento ---------- */
  function renderTrends() {
    var A = periodData(), M = A.M, months = A.months, cur = months.indexOf(A.cur);
    var labels = months.map(function (m) { return MM.monthLabel(m); });
    var host = $("trendCont");
    host.innerHTML = MM.CONTAINERS.map(function (c) {
      var k = M.cont[c];
      var overN = A.M.closed.filter(function (m) { return k.quota[m] > 0 && k.spent[m] > k.quota[m]; }).length;
      var foot = (k.quotaAvg ? "Quota media " + eur0.format(k.quotaAvg) + " · " : "") + (overN ? (overN === 1 ? "1 mese sopra la quota" : overN + " mesi sopra la quota") : "nessun mese sopra la quota");
      return '<div class="card trend"><div class="trend-head"><span class="nm"><i class="cdot" style="--c:' + cvar(c) + '"></i>' + NAMES[c] + '</span><span class="avg"><b>' + eur0.format(k.avg) + "</b> al mese</span></div>" +
        '<div id="tc-' + c + '"></div><p class="trend-foot">' + foot + "</p></div>";
    }).join("");
    MM.CONTAINERS.forEach(function (c) {
      var k = M.cont[c];
      var expQ = MM.expectedQuota(state.led, settings, A.cur, c);
      var ghost = months.map(function (m) { return k.quota[m] > 0 ? MM.round2(k.quota[m]) : M.kind[m] === "waiting" && expQ ? MM.round2(expQ) : null; });
      var kinds = months.map(function (m) { return k.quota[m] > 0 ? "real" : M.kind[m] === "waiting" && expQ ? "expected" : null; });
      Charts.columns($("tc-" + c), {
        labels: labels, values: months.map(function (m) { return MM.round2(k.spent[m]); }), ghost: ghost, ghostKind: kinds,
        color: cvar(c), current: cur >= 0 ? cur : null, height: 150, fmtAxis: n0,
        ariaLabel: NAMES[c] + ": speso e quota mese per mese",
        desc: months.map(function (m) { return MM.monthLong(m) + ": speso " + eur0.format(k.spent[m]) + ", quota " + eur0.format(k.quota[m]); }).join("; "),
        tip: function (i) {
          var m = months[i], rows = [{ value: eur0.format(k.spent[m]), label: "speso" + (i === cur ? " finora" : ""), color: cvar(c) }];
          if (k.quota[m] > 0) {
            rows.push({ value: eur0.format(k.quota[m]), label: "quota" });
            rows.push({ value: eur0.format(Math.abs(k.quota[m] - k.spent[m])), label: k.quota[m] - k.spent[m] >= 0 ? "avanzati" : "oltre la quota" });
          } else if (kinds[i] === "expected") rows.push({ value: "circa " + eur0.format(expQ), label: "quota attesa" });
          else rows.push({ value: "—", label: "nessuna quota" });
          return { title: cap(MM.monthLong(m)), rows: rows };
        }
      });
    });
    renderHeat(A);
  }
  var BINS = [25, 50, 100, 250, 500];
  function level(v) { if (!(v > 0.5)) return 0; for (var i = 0; i < BINS.length; i++) if (v <= BINS[i]) return i + 1; return 6; }
  function renderHeat(A) {
    var M = A.M, months = A.months, cur = A.cur;
    $("heatScale").innerHTML = '<span>Al mese</span><div style="display:grid;gap:3px"><div class="steps">' +
      [0, 1, 2, 3, 4, 5, 6].map(function (l) { return '<i class="hc l' + l + '" style="height:10px"></i>'; }).join("") +
      '</div><div class="ticks"><span>0</span>' + BINS.map(function (b) { return "<span>" + b + "</span>"; }).join("") + "<span>+</span></div></div>";
    var head = '<div class="heat-head" aria-hidden="true"><span></span>' + months.map(function (m) { return '<span class="' + (m === cur ? "on" : "") + '">' + MM.monthLabel(m).charAt(0).toUpperCase() + "</span>"; }).join("") + "<span>media</span></div>";
    var html = "";
    MM.CONTAINERS.forEach(function (c) {
      var subs = M.subs.filter(function (s) { return s.container === c; });
      if (!subs.length) return;
      html += '<div class="heat-group"><i class="cdot" style="--c:' + cvar(c) + '"></i>' + NAMES[c] + "</div>";
      subs.forEach(function (s) {
        html += '<button type="button" class="heat-row" data-key="' + esc(s.key) + '" style="--c:' + cvar(c) + '" aria-label="' + esc(subName(s)) + ", media " + eur0.format(s.avg) + ' al mese">' +
          '<span class="heat-name">' + esc(subName(s)) + (settings.protected && settings.protected[s.key] ? '<span class="star">★</span>' : "") + "</span>" +
          months.map(function (m) { var v = s.m[m] || 0; return '<i class="hc l' + level(v) + (m === cur ? " now" : "") + '" title="' + esc(MM.monthLong(m) + ": " + eur0.format(v)) + '"></i>'; }).join("") +
          '<span class="heat-avg">' + n0(s.avg) + "</span></button>";
      });
    });
    var box = $("heat");
    box.className = "heat"; box.style.setProperty("--n", months.length);
    box.innerHTML = html ? head + html : '<p class="empty">Nessuna spesa nel periodo.</p>';
  }

  /* ---------- Medie: the monthly average, for next year's budget ---------- */
  function avgIncome() {
    var rows = state.led.rows.filter(function (r) { return r.kind === "real" || r.kind === "est"; });
    return rows.length ? rows.reduce(function (s, r) { return s + r.income; }, 0) / rows.length : 0;
  }
  function renderAnalysis() {
    var A = periodData(), a = A.a, M = A.M;
    state.an = a;
    if (a.avgMonth === null) $("avgHero").innerHTML = "La media si calcola quando il primo mese è chiuso.";
    else $("avgHero").innerHTML = "In media spendi<b>" + eur0.format(a.avgMonth) + "</b>al mese, su " + (a.closed.length === 1 ? "1 mese chiuso" : a.closed.length + " mesi chiusi") + " (" + A.closedText + ")" + ($("inv").checked ? ", investimenti compresi." : ".");
    // containers: average spent against the average quota
    var rows = a.macroList.map(function (m) { var c = m.container; return { m: m, c: c, q: c && M.cont[c] ? M.cont[c].quotaAvg : 0 }; });
    var max = Math.max.apply(null, rows.map(function (x) { return Math.max(x.m.avg, x.q); }).concat([1]));
    $("kpis").innerHTML = rows.length ? rows.map(function (x) {
      var w = function (v) { return (v / max * 100).toFixed(1) + "%"; };
      var gap = x.q ? x.m.avg - x.q : null;
      return '<div class="bl" style="--c:' + cvar(x.c) + '"><div class="bl-t"><span class="nm"><i class="cdot" style="--c:' + cvar(x.c) + '"></i>' + esc(x.m.macro) + '</span><span class="v"><b>' + eur0.format(x.m.avg) + "</b>" + (x.q ? " di " + eur0.format(x.q) : "") + "</span></div>" +
        '<div class="bl-bar">' + (x.q ? '<span class="q" style="width:' + w(x.q) + '"></span>' : "") + '<span class="s" style="width:' + w(x.m.avg) + '"></span>' + (x.q ? '<span class="m" style="left:calc(' + w(x.q) + ' - 1px)"></span>' : "") + "</div>" +
        (gap !== null ? '<p class="bl-n">' + (gap > 0 ? "In media " + eur0.format(gap) + " oltre la quota" : "In media avanzano " + eur0.format(-gap)) + "</p>" : "") + "</div>";
    }).join("") + '<p class="bl-n">Barra piena: la media al mese. Barra chiara e tacca: la quota media dello stipendio.</p>' : '<p class="empty">Nessuna spesa nel periodo.</p>';

    // categories
    var tg = settings.targets || {}, edit = state.editPlan;
    $("editPlan").textContent = edit ? "Fatto" : "Scrivi gli obiettivi";
    $("planLead").textContent = edit ? "Scrivi quanto vuoi spendere al mese per ogni categoria e segna con la stella le spese da proteggere. Si salva da solo." :
      "Media al mese di ogni categoria, sui mesi chiusi. La tacca nera è il tuo obiettivo. Tocca una categoria per vederla mese per mese.";
    var maxS = Math.max.apply(null, a.subList.map(function (s) { return Math.max(s.avg, s.target || 0); }).concat([1]));
    var h = "";
    a.macroList.forEach(function (m) {
      h += '<div class="cat-group"><span class="nm"><i class="cdot" style="--c:' + cvar(m.container) + '"></i>' + esc(m.macro) + '</span><span class="v">' + eur0.format(m.avg) + " al mese</span></div>";
      m.items.forEach(function (s) {
        var gap = s.target !== null ? s.avg - s.target : null, sid = s.key.replace(/[^\p{L}\p{N}]+/gu, "_"), t = tg[s.key];
        if (edit) {
          h += '<div class="cat-row edit"><span>' + esc(s.sub) + '<small class="muted" style="display:block;font-size:12.5px">media ' + eur0.format(s.avg) + (gap !== null ? " · scarto " + signed(gap) : "") + "</small></span>" +
            '<label class="star-t" title="Da proteggere"><input type="checkbox" id="p-' + esc(sid) + '" data-key="' + esc(s.key) + '"' + (s.protected ? " checked" : "") + ' aria-label="Proteggi ' + esc(s.sub) + '">★</label>' +
            '<input type="number" class="tg-in" min="0" step="5" inputmode="decimal" id="t-' + esc(sid) + '" data-key="' + esc(s.key) + '" value="' + (t !== undefined ? esc(t) : "") + '" placeholder="€/mese" aria-label="Obiettivo mensile ' + esc(s.sub) + '"></div>';
        } else {
          h += '<button type="button" class="cat-row" data-key="' + esc(s.key) + '" style="--c:' + cvar(m.container) + '"><span>' + esc(s.sub) + (s.protected ? '<span class="star" title="Da proteggere">★</span>' : "") + "</span>" +
            '<span class="v">' + eur0.format(s.avg) + "</span>" +
            '<span class="bar"><i style="width:' + (s.avg / maxS * 100).toFixed(1) + '%"></i>' + (s.target !== null ? '<b style="left:calc(' + (s.target / maxS * 100).toFixed(1) + '% - 1px)"></b>' : "") + "</span>" +
            (gap !== null ? '<span class="gap">Obiettivo ' + eur0.format(s.target) + " · " + (gap > 0 ? eur0.format(gap) + " sopra" : gap < 0 ? eur0.format(-gap) + " sotto" : "in linea") + "</span>" : "") + "</button>";
        }
      });
    });
    $("planTable").innerHTML = h || '<p class="empty">Nessuna spesa nel periodo.</p>';

    // budget summary
    var inc = avgIncome(), rule = MM.ruleAt(settings.rules, state.led.cur), spendPct = (+rule.ess || 0) + (+rule.div || 0);
    $("planSum").innerHTML = '<div class="hl"><span>Spesa media al mese</span><b>' + (a.avgMonth === null ? "—" : eur0.format(a.avgMonth)) + "</b></div>" +
      "<div><span>" + (a.anyTarget ? "Con i tuoi obiettivi" : "Prevista, senza obiettivi") + "</span><b>" + eur0.format(a.planned) + "</b></div>" +
      (inc ? "<div><span>Entrate medie al mese</span><b>" + eur0.format(inc) + "</b></div><div><span>Quota per le spese (" + spendPct + "%)</span><b>" + eur0.format(inc * spendPct / 100) + "</b></div>" : "") +
      '<div><span>Spese da proteggere <span class="star">★</span></span><b>' + eur0.format(a.protAvg) + "</b></div>";
  }

  /* ---------- Movimenti ---------- */
  /* mode: "full" (Movimenti), "compact" (date and category), "bare" (one category: no badge) */
  function mvRows(items, mode) {
    return items.map(function (x) {
      var e = x.e;
      var extra = x.inc ? " · stipendio di " + MM.monthLong(MM.salaryMonth(e, settings)) : x.fut ? " · data futura, non ancora conteggiata" : "";
      var sub = mode === "full" ? esc(e.sub) + " · " + esc(e.asset) + (e.memo ? " · " + esc(e.memo) : "") + extra : fmtDate(e.date) + (mode === "bare" ? " · " + esc(e.asset) : " · " + esc(e.sub));
      var letter = esc(((e.text || e.sub || "?").replace(/[^\p{L}\p{N}]/gu, "") || "?").charAt(0).toUpperCase());
      return '<div class="mv' + (x.fut ? " fut" : "") + (mode === "bare" ? " bare" : "") + '">' + (mode === "bare" ? "" : '<span class="mv-ic' + (x.inc ? " in" : "") + '" style="--c:' + cvar(e.container) + '" aria-hidden="true">' + (x.inc ? "+" : letter) + "</span>") +
        '<span class="mv-main"><span class="mv-t">' + esc(e.text || e.sub) + '</span><span class="mv-s">' + sub + "</span></span>" +
        '<span class="mv-a' + (x.inc ? " in" : "") + '">' + (x.inc ? "+" : "") + eur.format(e.amount) + "</span></div>";
    }).join("");
  }
  function renderMoves() {
    var m = $("movMonth").value, f = state.movFilter;
    var opts = $("movMonth").options, i = $("movMonth").selectedIndex;
    $("movName").textContent = cap(monthName(m)); $("movYear").textContent = m.slice(0, 4);
    $("movPrev").disabled = i >= opts.length - 1; $("movNext").disabled = i <= 0;
    var chips = [["all", "Tutti", null], ["ess", NAMES.ess, "ess"], ["div", NAMES.div, "div"], ["inv", NAMES.inv, "inv"], ["in", "Entrate", null]];
    $("movChips").innerHTML = chips.map(function (c) { return '<button type="button" class="chip" data-f="' + c[0] + '" aria-pressed="' + (f === c[0]) + '">' + (c[2] ? '<i class="cdot" style="--c:' + cvar(c[2]) + '"></i>' : "") + c[1] + "</button>"; }).join("");
    var ex = state.data.expenses.filter(function (e) { return e.month === m && (f === "all" || e.container === f); }).map(function (e) { return { e: e, inc: false }; });
    var fu = f === "in" ? [] : state.data.future.filter(function (e) { return e.month === m && (f === "all" || e.container === f); }).map(function (e) { return { e: e, inc: false, fut: true }; });
    var inc = (f === "all" || f === "in") ? state.data.incomes.filter(function (e) { return e.month === m; }).map(function (e) { return { e: e, inc: true }; }) : [];
    var items = (f === "in" ? inc : ex.concat(inc, fu)).sort(function (a, b) { return b.e.date.localeCompare(a.e.date) || b.e.amount - a.e.amount; });
    var spent = ex.reduce(function (s, x) { return s + x.e.amount; }, 0);
    $("movSum").textContent = items.length ? items.length + " movimenti" + (ex.length ? " · speso " + eur.format(spent) : "") + (fu.length ? " · " + fu.length + " con data futura, non ancora conteggiate" : "") : "";
    if (!items.length) { $("movList").innerHTML = '<p class="empty">Nessun movimento in questo mese.</p>'; return; }
    var h = "", lastDay = null, group = [];
    function flush() {
      if (!group.length) return;
      var dayTot = group.filter(function (y) { return !y.inc && !y.fut; }).reduce(function (s, y) { return s + y.e.amount; }, 0);
      var dd = new Date(lastDay + "T12:00:00").toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" });
      h += '<div class="day"><span>' + cap(dd) + '</span><span class="num">' + (dayTot ? eur.format(dayTot) : "") + "</span></div>" + mvRows(group, "full");
      group = [];
    }
    items.forEach(function (x) { if (x.e.date !== lastDay) { flush(); lastDay = x.e.date; } group.push(x); });
    flush();
    $("movList").innerHTML = h;
  }
  function stepMov(d) {
    var s = $("movMonth"), i = s.selectedIndex - d;
    if (i < 0 || i >= s.options.length) return;
    s.selectedIndex = i; state.movUserSet = true; renderMoves();
  }

  /* ---------- Patrimonio: quantities from patrimonio.json (the program on the PC), prices live from CoinGecko ---------- */
  var PF_FILE = "patrimonio.json", SMALL_KEY = "mm-pf-small", STALE_H = 2.5;
  var ICON_WARN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 16.9v.1"/></svg>';
  var PLACE_TYPE = { exchange: "Exchange", wallet: "Hardware wallet", app: "App di pagamento", manuale: "Inserito a mano" };
  /* The PC file plus what is typed on this site (for apps that cannot be read, like Kast) */
  function pfDoc() { return PF.withManual(state.pf.doc, settings.pfManual); }
  function parseQty(v) {
    var t = String(v || "").replace(/\s|'/g, "");
    if (t.indexOf(",") >= 0) t = t.replace(/\./g, "").replace(",", ".");
    var n = parseFloat(t);
    return isFinite(n) ? n : null;
  }
  function pfRender() { if (!state.data) return; if (state.view === "crypto") renderCrypto(); else if (state.view === "patrimonio") renderWealth(); }
  function hideSmall() { return load(SMALL_KEY) !== "0"; }
  function setPortfolio(doc, file) { state.pf.doc = doc; state.pf.file = file; state.pf.err = null; PF.cache(doc, file); }

  /* The newest patrimonio.json in Drive; downloaded only when it changed */
  function syncPortfolio() {
    if (!Drive.token() || state.pf.loading) return;
    state.pf.loading = true; state.pf.checkedAt = Date.now();
    Drive.latestNamed(PF_FILE).then(function (f) {
      if (!f) { if (!state.pf.doc || (state.pf.file && state.pf.file.via === "drive")) { state.pf.err = "Non trovo " + PF_FILE + " nel tuo Drive."; } return; }
      var cur = state.pf.file;
      if (cur && cur.id === f.id && String(cur.when || "") >= String(f.modifiedTime || "")) { state.pf.err = null; return; }
      return Drive.download(f.id).then(function (buf) {
        var doc = PF.parse(new TextDecoder("utf-8").decode(buf));
        setPortfolio(doc, { id: f.id, when: f.modifiedTime, via: "drive" });
        refreshPrices(true);
      });
    }).catch(function (e) {
      if (e && e.code === "offline") return;
      if (e && e.code === "auth") return; // the main sync shows the sign-in
      state.pf.err = e && e.code === "limit" ? "Google ha rifiutato la richiesta per troppi accessi: riprovo al prossimo aggiornamento." :
        e instanceof Error ? e.message : "Non riesco a leggere " + PF_FILE + " dal Drive.";
    }).then(function () { state.pf.loading = false; pfRender(); });
  }
  function refreshPrices(force) {
    var pf = state.pf;
    var doc = pfDoc();
    if (!doc || pf.priceLoading) return;
    if (!force && pf.prices && Date.now() - pf.prices.at < 60000 && !pf.priceErr && PF.ids(doc).every(function (id) { return id === "tether" || id in pf.prices.usd; })) return;
    pf.priceLoading = true;
    PF.fetchPrices(doc).then(function (p) { pf.prices = p; pf.priceErr = null; })
      .catch(function (e) { pf.priceErr = (e && e.code) || "http"; })
      .then(function () { pf.priceLoading = false; pfRender(); });
  }
  function openPfFile(file) {
    if (!file) return;
    file.text().then(function (t) {
      setPortfolio(PF.parse(t), { name: file.name, when: file.lastModified ? new Date(file.lastModified).toISOString() : null, via: "file" });
      refreshPrices(true); pfRender();
    }).catch(function (e) { state.pf.err = "Il file scelto non va bene: " + ((e && e.message) || "non è un JSON") + "."; pfRender(); });
  }

  function pfFlag(text, old) { return '<span class="pf-flag' + (old ? " old" : "") + '"><i aria-hidden="true"></i>' + text + "</span>"; }
  function accountLine(a, type) {
    if (a.status === "ok") return (type === "manuale" ? "inserito " : "letto ") + when(a.when) + (a.warn ? " · " + pfFlag(esc(a.warn), true) : "");
    return pfFlag(a.when ? "non letto: valori di " + when(a.when) : "non letto");
  }
  function placeSub(p) {
    var bad = p.accounts.filter(function (a) { return a.status !== "ok"; });
    if (bad.length) return pfFlag(bad.length === p.accounts.length ? "non letto" : (bad.length === 1 ? "1 conto non letto" : bad.length + " conti non letti"), bad.every(function (a) { return a.when; }));
    var n = p.accounts.length;
    if (p.type === "manuale") return "Inserito a mano" + (p.accounts[0] && p.accounts[0].when ? " · " + esc(when(p.accounts[0].when)) : "");
    if (p.accounts.some(function (a) { return a.warn; })) return pfFlag("da controllare", true);
    return esc(PLACE_TYPE[p.type] || "Altro") + (n > 1 ? " · " + n + " conti" : "");
  }

  /* Money in the chosen currency: the file and the prices are in dollars, euros use the USDT rate */
  var CUR_KEY = "mm-pf-cur", OPEN = {};
  var eur2F = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: "always" });
  var K = { cur: "usd", rate: null };
  function pfCur() { return load(CUR_KEY) === "eur" ? "eur" : "usd"; }
  function inCur(x) { return K.cur === "eur" ? x / K.rate : x; }
  function money(x) { x = inCur(x); if (Math.abs(x) < 0.005) x = 0; return minus((K.cur === "eur" ? (Math.abs(x) >= 1000 ? eur0F : eur2F) : (Math.abs(x) >= 1000 ? usdF0 : usdF2)).format(x)); }
  function money0(x) { x = zero(inCur(x)); return minus((K.cur === "eur" ? eur0F : usdF0).format(x)); }
  function mprice(x) {
    x = inCur(x); var a = Math.abs(x), F = K.cur === "eur" ? [eur0F, eur2F, " €"] : [usdF0, usdF2, " $"];
    return minus(a >= 1000 ? F[0].format(x) : a >= 1 ? F[1].format(x) : prF.format(x) + F[2]);
  }
  function sym1() { return K.cur === "eur" ? "€" : "$"; }
  function pctTxt(x) { return (x >= 0 ? "+" : "") + minus(x.toLocaleString("it-IT", { minimumFractionDigits: 1, maximumFractionDigits: 1 })) + "%"; }
  var CHEV = '<svg class="pf-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  function syncCurButtons() {
    document.querySelectorAll("#pfCur button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.cur === K.cur)); });
  }

  /* One expandable row: the summary on the button, the details right under it */
  function pfItem(key, rowInner, details) {
    var open = !!OPEN[key], id = "pfd-" + key.replace(/[^A-Za-z0-9_-]/g, "_");
    return '<div class="pf-item"><button type="button" class="pf-row" data-open="' + esc(key) + '" aria-expanded="' + open + '" aria-controls="' + id + '">' + rowInner + "</button>" +
      '<div class="pf-det" id="' + id + '"' + (open ? "" : " hidden") + ">" + details + "</div></div>";
  }
  function coinDetails(c) {
    var p = c.price, ch = p && p.ch !== null && p.ch !== undefined ? p.ch : null;
    var h = '<div class="pf-det-h"><span>In tutto <b>' + qty(c.qty) + " " + esc(c.sym) + "</b></span>" +
      (p ? "<span>Prezzo <b>" + mprice(p.usd) + "</b>" + (ch !== null ? ' <span class="' + (ch >= 0 ? "pos" : "neg") + '">' + pctTxt(ch) + " in 24 ore</span>" : "") + "</span>" : "") + "</div>";
    h += c.where.map(function (w) {
      var part = c.qty ? w.qty / c.qty : 0;
      return '<div class="pf-w"><span>' + esc(w.placeName) + " <small>" + esc(w.account) + '</small></span><b>' + qty(w.qty) + " " + esc(c.sym) + "</b>" +
        (part > 0 ? '<span class="bar" aria-hidden="true"><i style="width:' + (Math.min(1, part) * 100).toFixed(1) + '%"></i></span>' : "") +
        "<small>" + (p ? money(w.value) + " · " : "") + (part > 0 ? share(part) + " della quantità" : "debito") + "</small></div>";
    }).join("");
    if (!p) h += '<p class="pf-det-n">Senza prezzo: aggiungi il suo id CoinGecko in config.json sul PC (per esempio "' + esc(c.sym) + '": "id-della-moneta").</p>';
    if (c.where.some(function (w) { return w.qty < 0; })) h += '<p class="pf-det-n">Le quantità con il meno sono debito della carta: spese fatte a credito da restituire.</p>';
    return h;
  }
  function placeDetails(p) {
    var h = p.accounts.map(function (a) {
      return '<div class="pf-w"><span>' + esc(a.name) + "</span><b>" + money(a.value) + "</b>" +
        "<small>" + accountLine(a, p.type) + (a.error ? " · " + esc(a.error) : "") + "</small></div>";
    }).join("");
    h += p.coinList.map(function (c) {
      return '<div class="pf-w pf-w-c"><span>' + esc(c.sym) + " <small>" + qty(c.qty) + "</small></span><b>" + money(c.value) + "</b></div>";
    }).join("");
    if (p.type === "manuale") h += '<p class="pf-det-n">Le hai scritte tu: per cambiarle usa "Inseriti a mano" qui sotto.</p>';
    return h;
  }

  /* While a hand-typed row is being edited the list is not redrawn, so the field keeps the focus and what is typed */
  function pfEditing() { var a = document.activeElement; return !!(a && a.tagName === "INPUT" && a.type === "text" && $("pfBody").contains(a)); }
  function renderCrypto() {
    if (pfEditing()) { state.pf.dirty = true; return; }
    state.pf.dirty = false;
    var pf = state.pf, box = $("pfBody"), doc = pfDoc();
    K.cur = pfCur(); syncCurButtons();
    if (!doc) {
      $("pfFresh").textContent = "";
      var why = pf.err || (!Drive.token() ? "Accedi con Google per leggere " + PF_FILE + " dal tuo Drive." : pf.loading ? "Cerco " + PF_FILE + " nel tuo Drive…" : "Non trovo " + PF_FILE + " nel tuo Drive.");
      box.innerHTML = '<div class="card group pf-empty"><h2>Tutte le crypto in un colpo solo</h2><p>' + esc(why) + "</p>" +
        "<p>Il file lo scrive il programma che gira sul tuo PC: ogni ora legge le quantità dagli exchange e dall'hardware wallet e le salva nel tuo Drive. Qui i prezzi si aggiornano ogni volta che apri la pagina.</p>" +
        '<div class="btnrow">' + (Drive.token() ? '<button type="button" class="btn small primary" data-pf="reload">Cerca di nuovo</button>' : "") +
        '<label class="btn small" for="pfFile">Apri un file</label></div></div>' + manualCard();
      return;
    }
    var R = PF.compute(doc, pf.prices), small = hideSmall();
    K.rate = R.eurUsd || null;
    var noRate = K.cur === "eur" && !K.rate;
    if (noRate) K.cur = "usd";
    var priceAt = R.liveCount ? (pf.prices && pf.prices.at) : null;
    $("pfFresh").innerHTML = (pf.doc ? "Quantità di " + esc(when(pf.doc.creato)) : "Solo quantità inserite qui") + " · prezzi " + (priceAt ? (Date.now() - priceAt < 90000 ? "di adesso" : "di " + esc(when(new Date(priceAt).toISOString()))) : pf.priceLoading ? "in arrivo…" : "dell'ultimo aggiornamento del PC");

    // the headline in the chosen currency, the other one under it
    var other = K.rate ? (K.cur === "eur" ? usd0(R.total) : eur0.format(R.total / K.rate)) : null;
    var h = '<div class="card pf-hero"><span class="lbl">In tutto</span><b class="big">' + money0(R.total) + "</b>" +
      '<span class="sub">' + (other ? "<span>circa " + other + "</span>" : "") +
      (R.change !== null ? '<span class="' + (R.change >= 0 ? "pos" : "neg") + '"><b>' + pctTxt(R.changePct * 100) + "</b> · " + (R.change >= 0 ? "+" : "") + money0(R.change) + " in 24 ore</span>" : "") + "</span>";
    if (R.total > 0) {
      var cp = Math.max(0, Math.min(1, R.cash / R.total));
      h += '<div class="pf-cash"><div class="pf-cash-t"><span>Stablecoin e valute</span><b>' + money0(R.cash) + " · " + share(cp) + '</b></div><span class="pf-meter" aria-hidden="true"><i style="width:' + (cp * 100).toFixed(1) + '%"></i></span></div>';
    }
    h += "</div>";

    // coins, largest first; tap to see the quantity and where it is
    var shown = R.coins.filter(function (c) { return !small || !c.price || Math.abs(inCur(c.value)) >= 1; }), hidden = R.coins.length - shown.length;
    var hiddenVal = R.coins.filter(function (c) { return shown.indexOf(c) < 0; }).reduce(function (t, c) { return t + c.value; }, 0);
    h += '<div class="block" style="margin-top:4px"><div class="block-head"><h2 class="h">Monete</h2><span class="small">' + R.coins.length + (R.coins.length === 1 ? " moneta" : " monete") + "</span></div>" +
      '<p class="lead">Quanto vale ogni moneta e quanto pesa sul totale. Tocca una moneta per vedere quanta ne hai e dove.</p><div class="card pf-list">';
    h += shown.map(function (c) {
      var row = '<span class="pf-l"><b>' + esc(c.sym) + "</b><small>" + qty(c.qty) + " " + esc(c.sym) + (c.price ? " · " + mprice(c.price.usd) : "") + "</small></span>" +
        '<span class="pf-r"><b>' + (c.price ? money(c.value) : "—") + "</b><small>" + (c.price ? share(c.pct) : "senza prezzo") + "</small></span>" + CHEV +
        '<span class="bar" aria-hidden="true"><i style="width:' + (Math.max(0, c.pct) * 100).toFixed(2) + '%"></i></span>';
      return pfItem("c:" + c.sym, row, coinDetails(c));
    }).join("") || '<p class="empty">Nessuna moneta.</p>';
    if (hidden) h += '<p class="pf-more">' + (hidden === 1 ? "E un'altra moneta sotto 1 " + sym1() + " (" : "E altre " + hidden + " monete sotto 1 " + sym1() + " (") + money(hiddenVal) + (hidden === 1 ? ")." : " in tutto).") + "</p>";
    h += "</div></div>";

    // places, same behaviour
    h += '<div class="block"><h2 class="h">Dove sono</h2><div class="card pf-list">' + R.places.map(function (p) {
      var row = '<span class="pf-l"><b>' + esc(p.name) + "</b><small>" + placeSub(p) + "</small></span>" +
        '<span class="pf-r"><b>' + money(p.value) + "</b><small>" + share(p.pct) + "</small></span>" + CHEV +
        '<span class="bar" aria-hidden="true"><i style="width:' + (Math.max(0, p.pct) * 100).toFixed(2) + '%"></i></span>';
      return pfItem("p:" + p.id, row, placeDetails(p));
    }).join("") + "</div></div>";

    h += '<label class="switch card" for="pfSmall" style="padding:12px 16px">Nascondi le monete sotto 1 ' + sym1() + '<input type="checkbox" id="pfSmall"' + (small ? " checked" : "") + "></label>";
    h += manualCard();

    // what to know: old quantities, accounts not read, prices
    var notes = [], ageH = pf.doc ? (Date.now() - new Date(pf.doc.creato).getTime()) / 3600000 : 0;
    if (ageH > STALE_H) notes.push([ICON_WARN, "Le quantità sono di " + esc(when(pf.doc.creato)) + ": il programma sul PC non le aggiorna da " + (ageH < 48 ? Math.floor(ageH) + " ore" : Math.floor(ageH / 24) + " giorni") + ". Controlla che il PC sia acceso e guarda patrimonio.log."]);
    var bad = [];
    R.places.forEach(function (p) { p.accounts.forEach(function (a) { if (a.status !== "ok") bad.push(esc(p.name) + " › " + esc(a.name) + (a.when ? " (valori di " + esc(when(a.when)) + ")" : " (non incluso)")); }); });
    if (bad.length) notes.push([ICON_WARN, "Non letti all'ultimo aggiornamento: " + bad.join(", ") + ". Tocca il posto per vedere l'errore."]);
    if (R.noPrice.length) notes.push([ICON_WARN, "Senza prezzo, quindi fuori dal totale: " + R.noPrice.map(esc).join(", ") + ". Aggiungi il loro id CoinGecko in config.json sul PC."]);
    var debt = 0; R.places.forEach(function (p) { p.accounts.forEach(function (a) { if (a.value < 0) debt += a.value; }); });
    if (debt < -0.5) notes.push([ICON_INFO, "Il totale toglie " + money(-debt) + " di debito della carta (spese fatte a credito)."]);
    if (noRate) notes.push([ICON_INFO, "Il cambio euro/dollaro non è ancora disponibile: mostro i dollari finché non arrivano i prezzi."]);
    if (pf.priceErr && R.coins.length) notes.push([ICON_INFO, (pf.priceErr === "offline" ? "Sei offline" : pf.priceErr === "limit" ? "CoinGecko ha rifiutato la richiesta per troppi accessi" : "Non riesco a prendere i prezzi da CoinGecko") + ": uso " + (R.liveCount ? "gli ultimi prezzi presi su questo dispositivo" : "quelli dell'ultimo aggiornamento del PC") + "."]);
    else if (R.snapCount && R.liveCount) notes.push([ICON_INFO, R.snapCount === 1 ? "1 moneta usa il prezzo dell'ultimo aggiornamento del PC." : R.snapCount + " monete usano il prezzo dell'ultimo aggiornamento del PC."]);
    if (pf.err) notes.push([ICON_INFO, esc(pf.err) + " Mostro l'ultima copia."]);
    if (pf.file && pf.file.via === "file") notes.push([ICON_INFO, "Stai guardando un file aperto a mano (" + esc(pf.file.name || PF_FILE) + "). Al prossimo aggiornamento da Drive torna quello del PC."]);
    notes.push([ICON_INFO, "Prezzi da CoinGecko, presi ogni volta che apri questa pagina. Per gli euro uso il cambio di USDT."]);
    h += '<div class="notes">' + notes.map(function (n) { return '<p class="note-i">' + n[0] + "<span>" + n[1] + "</span></p>"; }).join("") + "</div>";
    h += '<p class="small" style="text-align:center"><label for="pfFile" style="text-decoration:underline;cursor:pointer">Apri un file ' + PF_FILE + "</label></p>";
    box.innerHTML = h;
  }

  /* Quantities typed by hand, saved with the settings in Drive: for apps that cannot be read automatically */
  function manualCard() {
    var rows = settings.pfManual || [];
    var h = '<div class="block"><div class="block-head"><h2 class="h">Inseriti a mano</h2><button type="button" class="btn small" data-pf="add">Aggiungi</button></div>' +
      '<p class="lead">Per le app che non si possono leggere da sole, come Kast. Scrivi il posto, la moneta (USD, USDC, EURC…) e la quantità: si salva nel tuo Drive.</p>';
    if (!rows.length) return h + "</div>";
    h += '<div class="card pf-man"><div class="pf-man-r pf-man-h" aria-hidden="true"><span>Posto</span><span>Moneta</span><span>Quantità</span><span></span></div>';
    rows.forEach(function (m, i) {
      h += '<div class="pf-man-r">' +
        '<input type="text" data-mi="' + i + '" data-mk="posto" value="' + esc(m.posto || "") + '" placeholder="Kast" aria-label="Posto" maxlength="30" autocomplete="off">' +
        '<input type="text" data-mi="' + i + '" data-mk="simbolo" value="' + esc(m.simbolo || "") + '" placeholder="USD" aria-label="Moneta" maxlength="12" autocomplete="off" autocapitalize="characters">' +
        '<input type="text" inputmode="decimal" data-mi="' + i + '" data-mk="quantita" value="' + (m.quantita !== undefined && m.quantita !== "" ? esc(String(m.quantita).replace(".", ",")) : "") + '" placeholder="0" aria-label="Quantità" autocomplete="off">' +
        '<button type="button" class="iconbtn" data-pf="del" data-mi="' + i + '" aria-label="Elimina la riga"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg></button></div>';
    });
    return h + "</div></div>";
  }
  function editManual(i, key, value) {
    var rows = settings.pfManual = (settings.pfManual || []).slice(), m = rows[i];
    if (!m) return;
    if (key === "quantita") { var n = parseQty(value); m.quantita = n === null ? "" : n; }
    else if (key === "simbolo") m.simbolo = PF.cleanSym(value);
    else m.posto = String(value || "").trim().slice(0, 30);
    m.aggiornato = new Date().toISOString();
    saveSettings(); refreshPrices(true); renderCrypto();
  }

  /* ---------- Patrimonio: crypto, ETFs and the bank accounts together ---------- */
  var W_CUR_KEY = "mm-w-cur", W = { level: null, dirty: false }, WK = { cur: "eur", rate: null };
  var SRC_LABEL = { poste: "Poste", fineco: "Fineco", etherfi: "Carta ether.fi (già nel saldo)", none: "Non contare" };
  function wCur() { return load(W_CUR_KEY) === "usd" ? "usd" : "eur"; }
  function wConv(x) { return WK.cur === "usd" ? x * WK.rate : x; }
  function wm(x) { var v = wConv(x); if (Math.abs(v) < 0.005) v = 0; return minus((WK.cur === "usd" ? (Math.abs(v) >= 1000 ? usdF0 : usdF2) : (Math.abs(v) >= 1000 ? eur0F : eur2F)).format(v)); }
  function wm0(x) { return minus((WK.cur === "usd" ? usdF0 : eur0F).format(zero(wConv(x)))); }
  function wm2(x) { var v = wConv(x); if (Math.abs(v) < 0.005) v = 0; return minus((WK.cur === "usd" ? usdF2 : eur2F).format(v)); }
  function wSet() { return settings.wealth || {}; }
  function saveWealth(patch) { settings.wealth = Object.assign({}, wSet(), patch); saveSettings(); }
  function editingIn(box) { var a = document.activeElement; return !!(a && a.tagName === "INPUT" && a.type === "text" && box.contains(a)); }
  function shortDate(d) { return d ? new Date(d.length > 10 ? d : d + "T12:00:00").toLocaleDateString("it-IT", { day: "numeric", month: "short" }) : ""; }

  function wealthData() {
    var pf = state.pf, doc = pfDoc(), w = wSet();
    var R = doc ? PF.compute(doc, pf.prices) : null;
    var rate = (R && R.eurUsd) || (pf.prices && pf.prices.eurUsd) || (pf.doc && pf.doc.eur_usd) || null;
    var bk = PF.banks(state.rows, w, (pf.doc && pf.doc.ricariche) || [], today());
    var et = PF.etfs(pf.doc, w.etf, rate);
    var crypto = R && rate ? R.total / rate : 0;
    var etf = et.reduce(function (t, e) { return t + e.value; }, 0);
    var P = bk.banks.poste, F = bk.banks.fineco;
    var coins = R && rate ? R.coins.filter(function (c) { return Math.abs(c.value / rate) >= 0.5; }).map(function (c) { return { label: c.sym, value: c.value / rate }; }) : [];
    return { R: R, rate: rate, bk: bk, et: et, crypto: crypto, etf: etf, coins: coins, total: crypto + etf + (bk.set ? P.value + F.value : 0) };
  }

  /* A donut: one path per slice, a 2px surface gap between them */
  function donut(slices, mid, midLabel, pickable) {
    var tot = slices.reduce(function (t, s) { return t + Math.max(0, s.value); }, 0), a = -Math.PI / 2, R0 = 98, R1 = 62, h = "";
    function pt(r, ang) { return (100 + r * Math.cos(ang)).toFixed(2) + " " + (100 + r * Math.sin(ang)).toFixed(2); }
    slices.forEach(function (s, i) {
      var f = tot > 0 ? s.value / tot : 0; if (f <= 0) return;
      var b = a + f * 2 * Math.PI, d;
      // a whole ring: two half circles outside (top to bottom and back), the same inside the other way round
      if (f > 0.9999) d = "M" + pt(R0, -Math.PI / 2) + "A" + R0 + " " + R0 + " 0 1 1 " + pt(R0, Math.PI / 2) + "A" + R0 + " " + R0 + " 0 1 1 " + pt(R0, -Math.PI / 2) + "Z" +
        "M" + pt(R1, -Math.PI / 2) + "A" + R1 + " " + R1 + " 0 1 0 " + pt(R1, Math.PI / 2) + "A" + R1 + " " + R1 + " 0 1 0 " + pt(R1, -Math.PI / 2) + "Z";
      else { var big = f > 0.5 ? 1 : 0; d = "M" + pt(R0, a) + "A" + R0 + " " + R0 + " 0 " + big + " 1 " + pt(R0, b) + "L" + pt(R1, b) + "A" + R1 + " " + R1 + " 0 " + big + " 0 " + pt(R1, a) + "Z"; }
      h += '<path d="' + d + '" fill="' + s.color + '" fill-rule="evenodd" data-i="' + i + '"' + (pickable && s.key ? ' class="pick" data-w="' + s.key + '"' : "") + "><title>" + esc(s.label) + ": " + wm(s.value) + "</title></path>";
      a = b;
    });
    if (!h) h = '<circle cx="100" cy="100" r="80" fill="none" stroke="var(--sunken)" stroke-width="36"></circle>';
    return '<div class="donut" id="wDonut"><svg viewBox="0 0 200 200" role="img" aria-label="' + esc(slices.map(function (s) { return s.label + " " + wm(s.value); }).join(", ")) + '">' + h + "</svg>" +
      '<div class="donut-mid"><b>' + mid + "</b><span>" + esc(midLabel) + "</span></div></div>";
  }
  function legend(slices, total, pickable) {
    return '<div class="w-legend">' + slices.map(function (s, i) {
      var tag = pickable && s.key ? "button" : "div", pc = total > 0 && s.value > 0 ? s.value / total : 0;
      return "<" + tag + (tag === "button" ? ' type="button" data-w="' + s.key + '"' : "") + ' class="w-leg" data-i="' + i + '" style="--c:' + s.color + '"><i></i>' +
        '<span class="nm">' + esc(s.label) + (s.note ? " <small>" + esc(s.note) + "</small>" : "") + "</span><b>" + wm(s.value) + '</b><span class="p">' + (pc > 0 ? share(pc) : "—") + "</span></" + tag + ">";
    }).join("") + "</div>";
  }
  var SLOTS = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)"];
  /* At most n slices (the tail folds into "Altre"); amounts below zero (card debt) stay in the legend without a slice */
  function topN(list, n, otherLabel) {
    var pos = list.filter(function (x) { return x.value > 0; }).sort(function (a, b) { return b.value - a.value; });
    var neg = list.filter(function (x) { return x.value < 0; }).map(function (x) { x.note = "debito"; x.color = "var(--axis)"; return x; });
    if (pos.length > n) { var rest = pos.slice(n - 1); pos = pos.slice(0, n - 1).concat([{ label: "Altre", note: rest.length + " " + otherLabel, value: rest.reduce(function (t, x) { return t + x.value; }, 0) }]); }
    pos.forEach(function (x, i) { x.color = SLOTS[i % SLOTS.length]; });
    return pos.concat(neg);
  }

  function renderWealth() {
    var box = $("wBody");
    if (editingIn(box)) { W.dirty = true; return; }
    W.dirty = false;
    var D = wealthData(), bk = D.bk, P = bk.banks.poste, F = bk.banks.fineco, w = wSet();
    WK.cur = wCur(); WK.rate = D.rate;
    var noRate = WK.cur === "usd" && !WK.rate; if (noRate) WK.cur = "eur";
    document.querySelectorAll("#wCur button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.cur === WK.cur)); });
    $("wFresh").textContent = bk.set ? "Conti calcolati dal " + shortDate(bk.from) + (state.pf.doc ? " · crypto di " + when(state.pf.doc.creato) : "") : "Mancano i saldi di partenza di Poste e Fineco";

    var other = D.rate ? (WK.cur === "eur" ? usd0(D.total * D.rate) : eur0.format(D.total)) : null;
    var h = '<div class="card pf-hero"><span class="lbl">In tutto</span><b class="big">' + wm0(D.total) + "</b>" +
      '<span class="sub">' + (other ? "<span>circa " + other + "</span>" : "") + "<span>Conti <b>" + wm0(bk.set ? P.value + F.value : 0) + "</b></span><span>Investito <b>" + wm0(D.crypto + D.etf) + "</b></span></span></div>";

    // the donut: what you have by kind, then inside one kind
    var top = [{ key: "conti", label: "Conti", value: bk.set ? P.value + F.value : 0, color: "var(--s1)", note: bk.set ? "" : "da scrivere" },
      { key: "etf", label: "ETF", value: D.etf, color: "var(--s2)" }, { key: "crypto", label: "Crypto", value: D.crypto, color: "var(--s3)" }];
    var lvl = W.level, slices, title, mid, midLabel;
    if (lvl === "conti") { slices = [{ label: "Poste", value: P.value, color: SLOTS[0] }, { label: "Fineco", value: F.value, color: SLOTS[1] }]; title = "Conti"; }
    else if (lvl === "etf") { slices = topN(D.et.map(function (e) { return { label: e.name, value: e.value }; }), 6, "ETF"); title = "ETF"; }
    else if (lvl === "crypto") { slices = topN(D.coins, 6, "monete"); title = "Crypto"; }
    else { slices = top; title = "Dove sono"; lvl = null; }
    var tot = slices.reduce(function (t, s) { return t + Math.max(0, s.value); }, 0);
    mid = wm0(lvl === "crypto" ? D.crypto : lvl ? slices.reduce(function (t, s) { return t + s.value; }, 0) : D.total); midLabel = lvl ? "in " + title.toLowerCase() : "in tutto";
    h += '<div class="card w-chart"><div class="w-chart-head">' + (lvl ? '<button type="button" class="w-back" data-w="back"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>Tutto</button>' : "") +
      '<h2 class="h">' + title + "</h2></div>" + donut(slices, mid, midLabel, !lvl) + legend(slices, tot, !lvl) +
      '<p class="small">' + (lvl ? (lvl === "crypto" ? 'Il dettaglio di ogni moneta è nella scheda <button type="button" class="linkbtn" data-w="open-crypto">Crypto</button>.' : "Tocca \"Tutto\" per tornare indietro.") : "Tocca una fetta per vedere com'è divisa.") + "</p></div>";

    // bank accounts, each with how it was calculated
    h += '<div class="block"><h2 class="h">Conti</h2>';
    if (!bk.set) h += '<div class="card group"><p>Scrivi una volta i saldi di Poste e Fineco di una sera: da lì il sito aggiunge gli stipendi, toglie le spese, sposta il giroconto del mese e toglie le ricariche di ether.fi.</p><div class="btnrow"><button type="button" class="btn small primary" data-w="setup">Scrivi i saldi</button></div></div>';
    else {
      var since = "dal " + shortDate(bk.from);
      var pRows = '<div class="w-calc"><div><span>Saldo del ' + shortDate(bk.from) + "</span><b>" + wm2(P.start) + "</b></div>" +
        (P.income ? "<div><span>Stipendi ed entrate</span><b>+" + wm2(P.income) + "</b></div>" : "") +
        "<div><span>Spese da Poste</span><b>" + wm2(-P.spent) + "</b></div>" +
        "<div><span>Giroconti a Fineco (" + P.nGiro + ")</span><b>" + wm2(-P.giroOut) + "</b></div>" +
        "<div><span>Ricariche ether.fi (" + P.nTopups + ")</span><b>" + wm2(-P.topups) + "</b></div>" +
        (P.fees ? "<div><span>Commissioni (" + P.nTopups + " × " + wm2(bk.fee) + ")</span><b>" + wm2(-P.fees) + "</b></div>" : "") +
        '<div class="tot"><span>Saldo di oggi</span><b>' + wm2(P.value) + "</b></div></div>";
      if (bk.topups.length) {
        pRows += '<p class="w-sub">Ricariche di ether.fi ' + since + "</p>" + bk.topups.slice(0, 15).map(function (t) {
          return '<div class="w-top' + (t.used ? "" : " off") + '"><span>' + esc(shortDate(t.when)) + " · " + qty(t.qty) + " " + esc(t.sym || "") + " <small>" + wm2(t.eur) + "</small></span>" +
            '<label><input type="checkbox" data-topup="' + esc(t.id) + '"' + (t.used ? " checked" : "") + ">da Poste</label></div>";
        }).join("") + '<p class="pf-det-n">Togli la spunta se una ricarica non viene da Poste (per esempio arriva da un exchange).</p>';
      } else pRows += '<p class="pf-det-n">' + (state.pf.doc && state.pf.doc.ricariche ? "Nessuna ricarica di ether.fi " + since + "." : "Le ricariche di ether.fi le legge il programma sul PC: appena aggiornato, compaiono qui.") + "</p>";
      var fRows = '<div class="w-calc"><div><span>Saldo del ' + shortDate(bk.from) + "</span><b>" + wm2(F.start) + "</b></div>" +
        "<div><span>Giroconti da Poste (" + F.nGiro + ")</span><b>+" + wm2(F.giroIn) + "</b></div>" +
        "<div><span>Acquisti di ETF</span><b>" + wm2(-F.etf) + "</b></div>" +
        (F.income ? "<div><span>Entrate</span><b>+" + wm2(F.income) + "</b></div>" : "") + (F.spent ? "<div><span>Spese da Fineco</span><b>" + wm2(-F.spent) + "</b></div>" : "") +
        '<div class="tot"><span>Saldo di oggi</span><b>' + wm2(F.value) + "</b></div></div>";
      var accRow = function (name, B) {
        return '<span class="pf-l"><b>' + name + "</b><small>Calcolato " + since + '</small></span><span class="pf-r"><b class="' + (B.value < 0 ? "neg" : "") + '">' + wm2(B.value) + "</b><small>" +
          (D.total > 0 ? share(Math.max(0, B.value) / D.total) : "") + "</small></span>" + CHEV;
      };
      h += '<div class="card pf-list">' + pfItem("w:poste", accRow("Poste", P), pRows) + pfItem("w:fineco", accRow("Fineco", F), fRows) + "</div>";
    }
    h += "</div>";

    // ETFs: shares typed once a month, price from the PC
    h += '<div class="block"><h2 class="h">ETF</h2>';
    if (!D.et.length) h += '<div class="card group"><p>Aggiungi gli ISIN dei tuoi ETF nel programma sul PC (config.json, voce "etf"): da lì arriva il prezzo. Le quote poi le scrivi qui.</p></div>';
    else {
      h += '<p class="lead">Scrivi quante quote hai: aggiornale una volta al mese. Il prezzo arriva dal programma sul PC.</p><div class="card">' + D.et.map(function (e) {
        var p = e.price !== null ? (e.cur === "EUR" ? eur2F.format(e.price) : e.price.toLocaleString("it-IT", { maximumFractionDigits: 2 }) + " " + e.cur) : null;
        return '<div class="w-etf"><span class="nm">' + esc(e.name) + "<small>" + esc(e.isin) + (e.symbol ? " · " + esc(e.symbol) : "") + "</small></span>" +
          '<label for="etf-' + esc(e.isin) + '">Quote<input type="text" inputmode="decimal" id="etf-' + esc(e.isin) + '" data-etf="' + esc(e.isin) + '" value="' + (e.qty ? esc(String(e.qty).replace(".", ",")) : "") + '" placeholder="0" autocomplete="off"></label>' +
          '<span class="v"><span>' + (p ? qty(e.qty) + " × " + p + (e.priceAt ? " · " + esc(when(e.priceAt)) : "") : (e.error ? "Prezzo non trovato: " + esc(e.error) : "Prezzo non ancora arrivato")) + "</span><b>" + (e.priceEur !== null ? wm(e.value) : "—") + "</b></span>" +
          (e.qtyAt ? '<small style="grid-column:1/-1;font-size:12px;color:var(--muted)">Quote aggiornate il ' + esc(shortDate(e.qtyAt)) + "</small>" : "") + "</div>";
      }).join("") + "</div>";
    }
    h += "</div>";

    // what to know
    var notes = [];
    if (bk.set && (P.value < 0 || F.value < 0)) notes.push([ICON_WARN, "Un saldo calcolato è sotto zero: probabilmente manca un movimento. Aggiorna i saldi di partenza in Impostazioni."]);
    if (D.R && !D.rate) notes.push([ICON_WARN, "Il cambio euro/dollaro non è disponibile: le crypto non sono nel totale finché non arrivano i prezzi."]);
    if (!state.pf.doc) notes.push([ICON_INFO, "Le crypto arrivano dal programma sul PC (patrimonio.json): finché non c'è, conto solo quelle inserite a mano."]);
    if (D.et.some(function (e) { return e.qty && e.priceEur === null; })) notes.push([ICON_INFO, "Un ETF non ha ancora un prezzo in euro: è fuori dal totale."]);
    if (noRate) notes.push([ICON_INFO, "Mostro gli euro finché non arriva il cambio con il dollaro."]);
    notes.push([ICON_INFO, "Conti e ETF sono in euro; le crypto sono convertite con il cambio di USDT. I contanti non sono contati."]);
    h += '<div class="notes">' + notes.map(function (n) { return '<p class="note-i">' + n[0] + "<span>" + n[1] + "</span></p>"; }).join("") + "</div>";
    box.innerHTML = h;
  }

  /* Patrimonio settings, in Impostazioni */
  function renderWealthSettings() {
    var w = wSet(), g = w.giro || {};
    $("wDate").value = w.date || ""; $("wPoste").value = w.date ? (+w.poste || 0) : ""; $("wFineco").value = w.date ? (+w.fineco || 0) : "";
    $("wGiro").value = g.amount !== undefined ? g.amount : ""; $("wGiroDay").value = g.day || 15; $("wFee").value = w.fee !== undefined ? w.fee : "";
    var acc = {};
    (state.rows || []).forEach(function (r) {
      var n = String(r.asset || "").replace(/^[^\p{L}\p{N}]+/u, "").trim() || "Altro", d = String(r.date || "").slice(0, 10);
      if (!acc[n]) acc[n] = { n: 0, last: "" }; acc[n].n++; if (d > acc[n].last) acc[n].last = d;
    });
    var names = Object.keys(acc).sort(function (a, b) { return acc[b].n - acc[a].n; });
    $("wAccounts").innerHTML = names.length ? names.map(function (n, i) {
      var src = PF.accountSource(w.accounts, n);
      return '<div class="w-acc"><label for="wa' + i + '">' + esc(n) + '</label><select class="field" id="wa' + i + '" data-acc="' + esc(n) + '">' +
        Object.keys(SRC_LABEL).map(function (k) { return '<option value="' + k + '"' + (k === src ? " selected" : "") + ">" + SRC_LABEL[k] + "</option>"; }).join("") +
        "</select><small>" + acc[n].n + " movimenti · ultimo il " + fmtDate(acc[n].last) + "</small></div>";
    }).join("") : '<p class="small">Carica un backup per vedere i conti.</p>';
  }

  /* ---------- Impostazioni ---------- */
  function renderSettings() {
    $("srcInfo").textContent = state.src ? (state.src.name || "") + " · " + srcLine(state.src) : "Nessun backup caricato.";
    renderAccount();
    if (!$("syncInfo").textContent) syncMsg(remoteState === "ok" ? "Impostazioni salvate nel tuo Drive: sono le stesse su ogni dispositivo." : "Impostazioni salvate su questo dispositivo.");
    renderWealthSettings();
    var rs = MM.sortedRules(settings.rules);
    var dupes = {}; rs.forEach(function (r) { dupes[r.from] = (dupes[r.from] || 0) + 1; });
    $("rules").innerHTML = rs.map(function (r, i) {
      var s1 = (+r.ess || 0) + (+r.div || 0) + (+r.inv || 0), s2 = (+r.etf || 0) + (+r.crypto || 0) + (+r.liq || 0);
      function f(k, lab, c) { return '<label for="r' + i + k + '">' + (c ? '<span><i class="cdot" style="--c:' + cvar(c) + '"></i>' + lab + "</span>" : lab) + '<input type="number" min="0" max="100" step="1" inputmode="numeric" id="r' + i + k + '" data-i="' + i + '" data-k="' + k + '" value="' + (+r[k] || 0) + '"></label>'; }
      var bar = '<div class="splitbar" aria-hidden="true">' + MM.CONTAINERS.map(function (c) { return (+r[c] || 0) ? '<i style="--c:' + cvar(c) + ";flex:" + (+r[c] || 0) + '"></i>' : ""; }).join("") + "</div>";
      return '<div class="rule"><div class="rule-top"><label class="field-l" for="r' + i + 'from">Valida dal mese<input type="month" id="r' + i + 'from" data-i="' + i + '" data-k="from" value="' + r.from + '"></label>' +
        (rs.length > 1 ? '<button type="button" class="btn small" data-del="' + i + '">Elimina</button>' : "") + "</div>" +
        (dupes[r.from] > 1 ? '<p class="warn-text">Un\'altra divisione parte dallo stesso mese: cambia una delle due date, altrimenti ne vale solo una.</p>' : "") +
        bar + '<div class="rule-grid">' + f("ess", "Essenziali", "ess") + f("div", "Divertimento", "div") + f("inv", "Investimenti", "inv") + "</div>" +
        (s1 !== 100 ? '<p class="warn-text">Le tre percentuali sommano ' + s1 + "%, non 100%.</p>" : "") +
        '<p class="rule-sub">Come dividi gli investimenti</p><div class="rule-grid">' + f("etf", "PAC ETF") + f("crypto", "Crypto") + f("liq", "Liquidità") + "</div>" +
        (s2 !== 100 ? '<p class="warn-text">La divisione degli investimenti somma ' + s2 + "%, non 100%.</p>" : "") + "</div>";
    }).join("");
    settings.rules = rs;
    $("startIn").value = settings.startMonth;
    $("estIn").value = settings.estimate;
    $("prevIn").checked = settings.salaryPrevMonth !== false;
    var ov = settings.investOverride || {};
    $("ovr").innerHTML = Object.keys(ov).sort().map(function (m) {
      return '<label for="ov-' + m + '">' + MM.monthLong(m) + '<input type="number" min="0" step="0.01" inputmode="decimal" id="ov-' + m + '" data-m="' + m + '" value="' + esc(ov[m]) + '" placeholder="vuoto: Money Manager"></label>';
    }).join("") || '<p class="small">Nessun mese.</p>';
  }

  /* ---------- Events ---------- */
  /* Side menu */
  function openDrawer() {
    $("drawer").classList.add("open"); $("drawerScrim").hidden = false; $("menuBtn").setAttribute("aria-expanded", "true");
    var cur = document.querySelector('#drawer button[aria-current="page"]') || document.querySelector("#drawer button[data-view]");
    if (cur) setTimeout(function () { cur.focus(); }, 30);
  }
  function closeDrawer(back) {
    if (!$("drawer").classList.contains("open")) return;
    $("drawer").classList.remove("open"); $("drawerScrim").hidden = true; $("menuBtn").setAttribute("aria-expanded", "false");
    if (back) $("menuBtn").focus();
  }
  $("menuBtn").addEventListener("click", openDrawer);
  var barLine = false;
  window.addEventListener("scroll", function () { var on = window.scrollY > 4; if (on !== barLine) { barLine = on; document.querySelector(".appbar").classList.toggle("scrolled", on); } }, { passive: true });
  $("drawerClose").addEventListener("click", function () { closeDrawer(true); });
  $("drawerScrim").addEventListener("click", function () { closeDrawer(true); });
  document.querySelectorAll("#drawer button[data-view]").forEach(function (b) { b.addEventListener("click", function () { closeDrawer(false); showView(b.dataset.view); window.scrollTo(0, 0); }); });
  $("refresh").addEventListener("click", function () { syncFromDrive(true); if (state.view === "crypto" || state.view === "patrimonio") refreshPrices(true); });
  $("pfBody").addEventListener("click", function (e) {
    var b = e.target.closest("[data-open],[data-pf]"); if (!b) return;
    if (b.dataset.open) {
      var open = b.getAttribute("aria-expanded") !== "true", det = document.getElementById(b.getAttribute("aria-controls"));
      b.setAttribute("aria-expanded", String(open)); if (det) det.hidden = !open;
      if (open) OPEN[b.dataset.open] = true; else delete OPEN[b.dataset.open];
    } else if (b.dataset.pf === "reload") { state.pf.err = null; syncPortfolio(); pfRender(); }
    else if (b.dataset.pf === "add") {
      var last = (settings.pfManual || []).slice(-1)[0];
      settings.pfManual = (settings.pfManual || []).concat([{ posto: last ? last.posto : "Kast", simbolo: "USD", quantita: "", aggiornato: new Date().toISOString() }]);
      saveSettings(); renderCrypto();
      var ins = document.querySelectorAll('#pfBody input[data-mk="quantita"]'); if (ins.length) ins[ins.length - 1].focus();
    } else if (b.dataset.pf === "del") {
      settings.pfManual = (settings.pfManual || []).filter(function (x, i) { return i !== +b.dataset.mi; });
      saveSettings(); renderCrypto();
    }
  });
  $("pfFile").addEventListener("change", function () { openPfFile(this.files[0]); this.value = ""; });
  $("pfBody").addEventListener("focusout", function () {
    setTimeout(function () { if (state.pf.dirty && !pfEditing() && state.view === "crypto") renderCrypto(); }, 0);
  });
  $("wCur").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-cur]"); if (!b) return;
    store(W_CUR_KEY, b.dataset.cur); renderWealth();
  });
  $("wBody").addEventListener("click", function (e) {
    var b = e.target.closest("[data-w],[data-open]"); if (!b) return;
    if (b.dataset.open) {
      var open = b.getAttribute("aria-expanded") !== "true", det = document.getElementById(b.getAttribute("aria-controls"));
      b.setAttribute("aria-expanded", String(open)); if (det) det.hidden = !open;
      if (open) OPEN[b.dataset.open] = true; else delete OPEN[b.dataset.open];
      return;
    }
    var k = b.dataset.w;
    if (k === "back") { W.level = null; renderWealth(); }
    else if (k === "conti" || k === "etf" || k === "crypto") { W.level = k; renderWealth(); }
    else if (k === "open-crypto") { showView("crypto"); window.scrollTo(0, 0); }
    else if (k === "setup") { showView("impostazioni"); var el = $("wSettings"); if (el) el.scrollIntoView({ block: "start" }); }
  });
  $("wBody").addEventListener("change", function (e) {
    var t = e.target, w = wSet();
    if (t.dataset.topup) { var skip = Object.assign({}, w.topupSkip || {}); if (t.checked) delete skip[t.dataset.topup]; else skip[t.dataset.topup] = true; saveWealth({ topupSkip: skip }); renderWealth(); }
    else if (t.dataset.etf) { var n = parseQty(t.value), etf = Object.assign({}, w.etf || {}); etf[t.dataset.etf] = { qty: n === null ? 0 : n, at: new Date().toISOString() }; saveWealth({ etf: etf }); renderWealth(); }
  });
  $("wBody").addEventListener("focusout", function () { setTimeout(function () { if (W.dirty && !editingIn($("wBody")) && state.view === "patrimonio") renderWealth(); }, 0); });
  /* Highlight a slice from its legend row, and the other way round */
  ["mouseover", "focusin"].forEach(function (ev) {
    $("wBody").addEventListener(ev, function (e) {
      var el = e.target.closest && e.target.closest("[data-i]"), d = $("wDonut"); if (!d) return;
      d.classList.toggle("focus", !!el);
      d.querySelectorAll("path").forEach(function (p) { p.classList.toggle("on", !!el && p.dataset.i === el.dataset.i); });
    });
  });
  ["wDate", "wPoste", "wFineco", "wGiro", "wGiroDay", "wFee"].forEach(function (id) {
    $(id).addEventListener("change", function () {
      var w = wSet(), g = Object.assign({}, w.giro || {});
      if (id === "wDate") { if (/^\d{4}-\d{2}-\d{2}$/.test(this.value) || this.value === "") saveWealth({ date: this.value || null }); }
      else if (id === "wPoste") saveWealth({ poste: +this.value || 0 });
      else if (id === "wFineco") saveWealth({ fineco: +this.value || 0 });
      else if (id === "wGiro") { g.amount = Math.max(0, +this.value || 0); saveWealth({ giro: g }); }
      else if (id === "wGiroDay") { g.day = Math.max(1, Math.min(31, Math.round(+this.value) || 15)); this.value = g.day; saveWealth({ giro: g }); }
      else if (id === "wFee") saveWealth({ fee: Math.max(0, +this.value || 0) });
    });
  });
  $("wAccounts").addEventListener("change", function (e) {
    var n = e.target.dataset && e.target.dataset.acc; if (!n) return;
    var acc = Object.assign({}, wSet().accounts || {}); acc[n] = e.target.value; saveWealth({ accounts: acc });
  });
  $("pfCur").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-cur]"); if (!b) return;
    store(CUR_KEY, b.dataset.cur); renderCrypto();
  });
  $("pfBody").addEventListener("change", function (e) {
    if (e.target.id === "pfSmall") { store(SMALL_KEY, e.target.checked ? "1" : "0"); renderCrypto(); }
    else if (e.target.dataset && e.target.dataset.mk) editManual(+e.target.dataset.mi, e.target.dataset.mk, e.target.value);
  });
  /* Back to the app (installed apps resume instead of reloading): fresh prices, and the file again if it is old */
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible" || (state.view !== "crypto" && state.view !== "patrimonio")) return;
    if (Date.now() - state.pf.checkedAt > 10 * 60000) syncPortfolio();
    refreshPrices(false);
  });
  $("monthSel").addEventListener("change", function () { state.month = this.value; renderMonth(); });
  $("monPrev").addEventListener("click", function () { stepMonth(-1); });
  $("monNext").addEventListener("click", function () { stepMonth(1); });
  $("envelopes").addEventListener("click", function (e) { var b = e.target.closest(".env"); if (b) openSheet({ c: b.dataset.c }); });
  $("heat").addEventListener("click", function (e) { var b = e.target.closest(".heat-row"); if (b) openSheet({ key: b.dataset.key }); });
  $("planTable").addEventListener("click", function (e) { var b = e.target.closest("button.cat-row"); if (b) openSheet({ key: b.dataset.key }); });
  $("scrim").addEventListener("click", closeSheet);
  $("sheetClose").addEventListener("click", closeSheet);
  document.addEventListener("keydown", function (e) { if (e.key !== "Escape") return; if (state.sheet) closeSheet(); else closeDrawer(true); });
  $("period").addEventListener("change", function () { setPeriod(this.value); renderAnalysis(); });
  $("trendPeriod").addEventListener("change", function () { setPeriod(this.value); renderTrends(); });
  $("inv").addEventListener("change", function () { renderAnalysis(); });
  $("editPlan").addEventListener("click", function () { state.editPlan = !state.editPlan; renderAnalysis(); });
  $("movMonth").addEventListener("change", function () { state.movUserSet = true; renderMoves(); });
  $("movPrev").addEventListener("click", function () { stepMov(-1); });
  $("movNext").addEventListener("click", function () { stepMov(1); });
  $("movChips").addEventListener("click", function (e) { var b = e.target.closest(".chip"); if (b) { state.movFilter = b.dataset.f; renderMoves(); } });
  $("planTable").addEventListener("change", function (e) {
    var k = e.target.getAttribute && e.target.getAttribute("data-key"); if (!k) return;
    if (e.target.type === "checkbox") { settings.protected = settings.protected || {}; if (e.target.checked) settings.protected[k] = true; else delete settings.protected[k]; }
    else { settings.targets = settings.targets || {}; if (e.target.value === "") delete settings.targets[k]; else settings.targets[k] = e.target.value; }
    saveSettings(); renderAnalysis();
  });
  $("rules").addEventListener("change", function (e) {
    var i = e.target.dataset.i, k = e.target.dataset.k; if (i === undefined || !k) return;
    var r = settings.rules[+i]; if (!r) return;
    if (k === "from") { if (/^\d{4}-\d{2}$/.test(e.target.value)) r.from = e.target.value; }
    else r[k] = Math.max(0, Math.min(100, +e.target.value || 0));
    saveSettings(); state.led = MM.ledger(state.data, settings, today()); buildSelectors(); renderSettings();
  });
  $("rules").addEventListener("click", function (e) {
    var d = e.target.dataset && e.target.dataset.del; if (d === undefined) return;
    settings.rules.splice(+d, 1); saveSettings(); state.led = MM.ledger(state.data, settings, today()); renderSettings();
  });
  $("addRule").addEventListener("click", function () {
    var last = MM.sortedRules(settings.rules).slice(-1)[0] || MM.DEFAULT_SETTINGS.rules[0];
    var r = clone(last), used = settings.rules.map(function (x) { return x.from; });
    r.from = MM.addMonths(today().slice(0, 7), 1);
    if (r.from <= last.from) r.from = MM.addMonths(last.from, 1);
    while (used.indexOf(r.from) >= 0) r.from = MM.addMonths(r.from, 1);
    settings.rules.push(r); saveSettings(); renderSettings();
  });
  $("startIn").addEventListener("change", function () { if (/^\d{4}-\d{2}$/.test(this.value)) { settings.startMonth = this.value; saveSettings(); rescope(); state.led = MM.ledger(state.data, settings, today()); buildSelectors(); } });
  $("prevIn").addEventListener("change", function () { settings.salaryPrevMonth = this.checked; saveSettings(); state.led = MM.ledger(state.data, settings, today()); });
  $("estIn").addEventListener("change", function () { settings.estimate = +this.value || 0; saveSettings(); state.led = MM.ledger(state.data, settings, today()); });
  $("ovr").addEventListener("change", function (e) {
    var m = e.target.dataset.m; if (!m) return;
    settings.investOverride = settings.investOverride || {};
    settings.investOverride[m] = e.target.value === "" ? "" : +e.target.value;
    saveSettings(); state.led = MM.ledger(state.data, settings, today()); renderSettings();
  });
  $("ovrAdd").addEventListener("click", function () {
    var m = $("ovrNewMonth").value; if (!/^\d{4}-\d{2}$/.test(m)) return;
    settings.investOverride = settings.investOverride || {}; if (settings.investOverride[m] === undefined) settings.investOverride[m] = "";
    saveSettings(); state.led = MM.ledger(state.data, settings, today()); renderSettings();
  });
  $("reloadBtn").addEventListener("click", function () { syncFromDrive(true); });
  [$("signinBtn"), $("signinBtn2"), $("signinBtn3")].forEach(function (b) { b.addEventListener("click", function () { if (Drive.configured()) Drive.signIn(false); else setStatus("err", "Manca il Client ID di Google in config.js: segui il README."); }); });
  $("signoutBtn").addEventListener("click", function () { Drive.signOut(); renderAccount(); showSignIn("Sei uscito da Google. I dati restano visibili su questo dispositivo fino al prossimo accesso."); });
  $("folderIn").addEventListener("change", function () { var v = this.value.trim(); if (!v) return; settings.folderName = v; settings.folderId = null; saveSettings(); syncFromDrive(true); });
  $("fileIn").addEventListener("change", function () { openFile(this.files[0]); });
  $("fileIn2").addEventListener("change", function () { openFile(this.files[0]); });
  var drop = $("drop");
  ["dragenter", "dragover"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add("over"); }); });
  ["dragleave", "drop"].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove("over"); }); });
  drop.addEventListener("drop", function (e) { openFile(e.dataTransfer.files[0]); });
  /* Charts are drawn at the screen width: redraw when it changes (rotation, desktop window) */
  var lastW = window.innerWidth, rt = null;
  window.addEventListener("resize", function () {
    if (window.innerWidth === lastW) return; lastW = window.innerWidth;
    clearTimeout(rt); rt = setTimeout(function () { if (state.data) { renderView(state.view); if (state.sheet) openSheet(state.sheet); } }, 150);
  });

  /* ---------- Boot: this device's last copy first, then Google ---------- */
  var v0 = load(VIEW_KEY); if (v0 && TITLES[v0] && v0 !== "impostazioni") state.view = v0;
  var pfc = PF.cached(); if (pfc) { state.pf.doc = pfc.doc; state.pf.file = pfc.file; }
  state.pf.prices = PF.cachedPrices();
  var redirect = Drive.handleRedirect();
  var cached = null; try { cached = JSON.parse(load(CACHE_KEY) || "null"); } catch (e) {}
  var boot = cached && cached.b64 ? ingest(b64ToBytes(cached.b64), cached.src).then(function () { setStatus("", srcLine(state.src)); }) : Promise.resolve();
  boot.catch(function () {}).then(function () {
    renderAccount();
    if (!state.data) { $("needWhy").textContent = "Accedi con Google per leggere i backup dalla cartella MoneyManager, oppure scegli qui un file .mmbak."; $("needFile").hidden = false; showView(state.view); }
    if (redirect && redirect.error) {
      if (redirect.error === "access_denied") showSignIn("Hai annullato l'accesso a Google. Senza accesso vedi solo l'ultima copia salvata su questo dispositivo.");
      else if (redirect.error === "scope") showSignIn("Per leggere i backup serve il permesso di vedere i file di Drive: entra di nuovo e lascia la casella spuntata.");
      else showSignIn(redirect.silent ? "Per aggiornare i dati entra di nuovo con Google." : "L'accesso a Google non è riuscito (" + redirect.error + "). Riprova.");
      return;
    }
    syncFromDrive(false);
  });
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(function () {});
})();
