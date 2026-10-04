(function () {
  var CACHE_KEY = "mm-last-backup-v1", SETTINGS_KEY = "mm-settings-v3", VIEW_KEY = "mm-view";
  var NAMES = { ess: "Spese Essenziali", div: "Divertimento", inv: "Investimenti" };
  var $ = function (id) { return document.getElementById(id); };
  var eur = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" });
  var eur0 = new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  var pct = function (x) { return (x * 100).toLocaleString("it-IT", { maximumFractionDigits: 0 }) + "%"; };
  var fmtDate = function (d) { var p = d.split("-"); return p[2] + "/" + p[1] + "/" + p[0].slice(2); };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  function today() { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function colorOf(c) { return css("--c-" + c); }

  var state = { data: null, src: null, SQL: null, mcp: null, charts: {}, view: "mese", month: null, movFilter: "all", sheet: null };

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
  function setStatus(kind, text) { $("dot").className = "dot " + (kind || ""); $("statusText").textContent = text; }
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
      state.full = MM.normalise(raw.rows, today());
      rescope();
      state.src = src;
      $("needFile").hidden = true;
      buildSelectors();
      renderAll();
      showView(state.view);
    });
  }
  function cacheBackup(bytes, src) { if (bytes.length < 3300000) store(CACHE_KEY, JSON.stringify({ b64: bytesToB64(bytes), src: src })); }
  function rescope() { if (state.full) state.data = MM.scope(state.full, settings.startMonth); }

  function showSignIn(why) {
    $("signinWhy").textContent = why || "Accedi con Google per leggere i backup di Money Manager dal tuo Drive.";
    $("signinBox").hidden = false;
    setStatus("warn", state.data ? srcLine(state.src) + " · non collegato a Google" : "Non collegato a Google");
    renderAccount();
  }
  function hideSignIn() { $("signinBox").hidden = true; }

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
    syncing = true; $("reloadBtn").disabled = true;
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
      .then(function () { syncing = false; $("reloadBtn").disabled = false; renderAccount(); });
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
    $("acctInfo").textContent = !Drive.configured() ? "Manca il Client ID di Google in config.js." : on ? "Collegato a Google." : Drive.wasSignedIn() ? "Accesso scaduto: entra di nuovo per aggiornare." : "Non collegato a Google.";
    $("signinBtn2").hidden = on || !Drive.configured();
    $("signoutBtn").hidden = !Drive.wasSignedIn();
    $("reloadBtn").hidden = !on;
    $("folderIn").value = settings.folderName || "MoneyManager";
  }

  /* ---------- Views ---------- */
  var TITLES = { mese: "Il mese", grafici: "Grafici", analisi: "Analisi", movimenti: "Movimenti", impostazioni: "Impostazioni" };
  function showView(v) {
    state.view = v; store(VIEW_KEY, v);
    document.querySelectorAll(".view").forEach(function (el) { el.hidden = !state.data || el.id !== "v-" + v; });
    if (v === "impostazioni") $("v-impostazioni").hidden = false;
    document.querySelectorAll("nav.tabs button").forEach(function (b) { if (b.dataset.view === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    $("gear").setAttribute("aria-pressed", v === "impostazioni" ? "true" : "false");
    $("viewTitle").textContent = TITLES[v];
    if (state.data) renderView(v);
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
    sel.innerHTML = mList.map(function (m) { return '<option value="' + m + '">' + MM.monthLong(m) + "</option>"; }).join("");
    sel.value = mList.indexOf(prev) >= 0 ? prev : mList[0];
    state.month = sel.value;
    var lastData = Object.keys(months).filter(function (m) { return m < cur || (m === cur && (state.data.expenses.some(function (e) { return e.month === cur; }) || state.data.incomes.some(function (e) { return e.month === cur; }))); }).sort().pop() || cur;
    var mv = $("movMonth"), pv = state.movUserSet && mv.value ? mv.value : lastData;
    mv.innerHTML = list.map(function (m) { return '<option value="' + m + '">' + MM.monthLong(m) + "</option>"; }).join("");
    mv.value = list.indexOf(pv) >= 0 ? pv : list[0];
    var ps = $("period"), pp = ps.value || load("mm-period") || cur.slice(0, 4);
    var years = {}; state.data.expenses.forEach(function (e) { years[e.date.slice(0, 4)] = 1; }); years[cur.slice(0, 4)] = 1;
    var opts = Object.keys(years).sort().reverse().map(function (y) { return [y, "Anno " + y]; }).concat([["last12", "Ultimi 12 mesi"], ["all", "Tutto lo storico"]]);
    ps.innerHTML = opts.map(function (o) { return '<option value="' + o[0] + '">' + o[1] + "</option>"; }).join("");
    ps.value = opts.some(function (o) { return o[0] === pp; }) ? pp : opts[0][0];
  }

  function renderAll() {
    state.led = MM.ledger(state.data, settings, today());
    renderView(state.view);
    if (state.sheet) openSheet(state.sheet);
  }
  function renderView(v) {
    if (!state.led) state.led = MM.ledger(state.data, settings, today());
    if (v === "mese") renderMonth();
    else if (v === "grafici") renderCharts();
    else if (v === "analisi") renderAnalysis();
    else if (v === "movimenti") renderMoves();
    else if (v === "impostazioni") renderSettings();
  }

  /* ---------- Mese ---------- */
  function rowFor(m) { var r = null; state.led.rows.forEach(function (x) { if (x.month === m) r = x; }); return r; }
  function renderMonth() {
    var led = state.led, m = state.month, r = rowFor(m);
    if (!r) { $("envelopes").innerHTML = '<p class="empty">Nessun dato per questo mese.</p>'; return; }
    var inc = $("incomeBox"), mName = MM.monthLong(m).split(" ")[0], nextName = MM.monthLong(MM.addMonths(m, 1)).split(" ")[0];
    var prevMode = settings.salaryPrevMonth !== false;
    if (r.kind === "real") inc.innerHTML = '<span class="eyebrow">Stipendio di ' + mName + '</span><b class="num">' + eur.format(r.income) + "</b>";
    else if (r.kind === "est") inc.innerHTML = '<span class="eyebrow">Stipendio di ' + mName + ' (stima)</span><b class="num">' + eur.format(r.income) + "</b>";
    else if (r.kind === "waiting") inc.innerHTML = '<span class="eyebrow">Stipendio di ' + mName + "</span><b>" + (prevMode ? (m === state.led.cur ? "arriva a " + nextName : "in arrivo") : "non ancora registrato") + "</b>";
    else inc.innerHTML = '<span class="eyebrow">Stipendio di ' + mName + "</span><b>non registrato</b>";
    inc.className = "income" + (r.income ? "" : " waiting");
    var isCur = m === state.led.cur, lead = isCur ? "Questo mese" : "Nel mese";
    var html = "", total = 0;
    MM.CONTAINERS.forEach(function (c) {
      var cc = r.c[c]; total += cc.avail;
      var share = cc.quota > 0 ? Math.min(cc.spent / cc.quota, 1) : 0;
      var over = cc.quota > 0 && cc.spent > cc.quota ? Math.min((cc.spent - cc.quota) / cc.quota, 0.6) : 0;
      var monthTxt = lead + ": <b class=\"num\">" + eur0.format(cc.spent) + "</b>" + (cc.quota > 0 ? " su " + eur0.format(cc.quota) : " · la quota arriva con lo stipendio");
      if (cc.hist) monthTxt += " · dall'altra app";
      var pctTxt = (+r.rule[c] || 0) + "%";
      if (c === "inv" && (+r.rule.liq || 0)) pctTxt = MM.round2((+r.rule.inv || 0) * (100 - (+r.rule.liq || 0)) / 100) + "% + " + MM.round2((+r.rule.inv || 0) * (+r.rule.liq || 0) / 100) + "%";
      var liqLine = "";
      if (c === "inv") { total += r.liq.avail; liqLine = '<div class="env-liq"><span>Liquidità per discese, sul conto</span><b class="num ' + (r.liq.avail < 0 ? "neg" : "") + '">' + eur0.format(r.liq.avail) + "</b></div>"; }
      html += '<button type="button" class="env" data-c="' + c + '" style="--env-c:' + colorOf(c) + '">' +
        '<div class="env-top"><span class="env-name">' + NAMES[c] + '</span><span class="pct">' + pctTxt + '</span></div>' +
        '<div class="env-avail"><span class="big num ' + (cc.avail < 0 ? "neg" : "") + '">' + eur0.format(cc.avail) + '</span><span class="lbl">' + (cc.avail < 0 ? "sotto di questa cifra" : (c === "inv" ? "da investire" : "disponibile")) + "</span></div>" +
        '<div class="bar" aria-hidden="true"><i style="width:' + (share * (over ? 100 / (1 + over) : 100)).toFixed(1) + '%"></i>' + (over ? '<i class="over" style="width:' + (over * 100 / (1 + over)).toFixed(1) + '%"></i>' : "") + "</div>" +
        '<div class="env-month"><span>' + monthTxt + '</span><span class="chev" aria-hidden="true">Dettaglio ›</span></div>' + liqLine + "</button>";
    });
    $("envelopes").innerHTML = html;
    $("totalAvail").textContent = eur0.format(total);
    $("totalAvail").className = "num " + (total < 0 ? "neg" : "");
    var notes = [];
    if (r.kind === "waiting") {
      if (prevMode && isCur) notes.push("Lo stipendio di " + mName + " arriva a " + nextName + ": per ora il disponibile conta quello che hai già incassato. Quando lo registri in Money Manager con la categoria Stipendio, la quota di " + mName + " si aggiorna.");
      else if (prevMode) notes.push("Lo stipendio di " + mName + " non è ancora in Money Manager. Di solito arriva tra il 5 e il 15 di " + nextName + ": quando lo registri, le quote di " + mName + " si aggiornano.");
      else notes.push("Lo stipendio di " + mName + " non è ancora in Money Manager: il disponibile conta solo i mesi precedenti.");
    }
    if (r.kind === "est") notes.push("Per questo mese uso lo stipendio stimato (" + eur.format(r.income) + "), perché non hai ancora registrato stipendi in Money Manager.");
    if (r.kind === "missing") notes.push("Per " + mName + " non c'è nessuno Stipendio registrato" + (prevMode ? " (lo cerco tra le entrate di " + nextName + ")" : "") + ": la quota del mese è zero.");
    var oth = led.other.filter(function (e) { return e.month === m; });
    if (oth.length) notes.push(oth.length + " spese di questo mese sono in categorie fuori dai tre contenitori e non sono conteggiate.");
    var fut = state.data.future;
    if (fut.length && m === led.cur) notes.push("Spese con data futura, conteggiate quando arriva la data: " + fut.map(function (e) { return esc(e.text || e.sub) + " " + eur0.format(e.amount) + " il " + fmtDate(e.date); }).join(", ") + ".");
    $("monthNotes").innerHTML = notes.join("<br>");
    $("monthNotes").hidden = !notes.length;
  }

  /* ---------- Sheet ---------- */
  function openSheet(c) {
    state.sheet = c;
    var m = state.month, d = MM.detail(state.data, state.led, c, m, settings), r = d.row, cc = r.c[c];
    $("sheetEyebrow").textContent = MM.monthLong(m) + " · " + (+r.rule[c] || 0) + "% delle entrate";
    $("sheetTitle").textContent = NAMES[c];
    var body = '<div class="stat3"><div><span>Speso nel mese</span><b class="num">' + eur0.format(cc.spent) + '</b></div><div><span>Quota del mese</span><b class="num">' + (cc.quota ? eur0.format(cc.quota) : "—") +
      '</b></div><div><span>Disponibile</span><b class="num ' + (cc.avail < 0 ? "neg" : "") + '">' + eur0.format(cc.avail) + "</b></div></div>";
    if (c === "inv" && d.split) {
      var sp = d.split, lab = { etf: "PAC ETF", crypto: "Crypto" };
      var lq = d.liq;
      body += '<div style="display:grid;gap:8px"><h3>Liquidità per discese</h3>' +
        '<div class="split-row"><div class="t"><span>Sul conto, pronta da usare <span class="note">' + (+r.rule.liq || 0) + "% dell'investimento</span></span><span class=\"num " + (lq.avail < 0 ? "neg" : "") + '">' + eur0.format(lq.avail) + "</span></div>" +
        '<p class="note">Accumulata: ' + eur0.format(lq.quota) + (lq.used ? " · usata per acquisti: " + eur0.format(lq.used) : "") + ". Non va versata: per usarla registra l'acquisto in Investimenti › Liquidità.</p></div></div>";
      var note = d.trackedFrom ? (d.trackedFrom > state.led.start ? "Dal " + MM.monthLong(d.trackedFrom) + ": per i mesi prima uso solo i totali dell'altra app." : "Dal " + MM.monthLong(d.trackedFrom) + ".") : "Tutti i mesi sono coperti dai totali dell'altra app.";
      if (d.trackedFrom && !d.firstMM) note += " Non hai ancora registrato ETF o Crypto in Money Manager.";
      body += '<div style="display:grid;gap:8px"><h3>Da investire</h3><p class="note">' + note + '</p><div class="split">';
      ["etf", "crypto"].forEach(function (k) {
        var s = sp[k], ratio = s.quota > 0 ? Math.min(s.done / s.quota, 1) : 0;
        body += '<div class="split-row"><div class="t"><span>' + lab[k] + ' <span class="note">' + (+r.rule[k] || 0) + '%</span></span><span class="num">' + eur0.format(s.done) + " su " + eur0.format(s.quota) + "</span></div>" +
          '<div class="bar" style="--env-c:' + colorOf("inv") + '"><i style="width:' + (ratio * 100).toFixed(1) + '%"></i></div></div>';
      });
      body += "</div></div>";
      if (d.ignored) body += '<p class="callout">Per ' + MM.monthLong(m) + " uso il totale dell'altra app (" + eur.format(cc.spent) + "). I " + eur.format(d.ignored) + " registrati in Money Manager in questo mese non sono conteggiati: svuota il mese in Impostazioni per usarli.</p>";
    }
    var max = Math.max.apply(null, d.list.map(function (s) { return s.total; }).concat([1]));
    body += '<div style="display:grid;gap:4px"><h3>Sottocategorie</h3><div class="subhead"><span></span><span>Nel mese</span><span>Dal ' + MM.monthLabel(state.led.start, true) + "</span></div>";
    if (!d.list.length) body += '<p class="empty">Nessuna spesa registrata.</p>';
    d.list.forEach(function (s) {
      body += '<div class="subrow" style="--env-c:' + colorOf(c) + '"><span>' + esc(s.sub) + (settings.protected && settings.protected[s.key] ? '<span class="star" title="Da proteggere">★</span>' : "") +
        '</span><span class="num">' + (s.month ? eur0.format(s.month) : "—") + '</span><span class="num">' + eur0.format(s.total) + '</span><div class="meter"><i style="width:' + (s.total / max * 100).toFixed(1) + '%"></i></div></div>';
    });
    body += "</div>";
    var items = cc.items.concat(c === "inv" ? d.liq.items : []).sort(function (a, b) { return b.date.localeCompare(a.date); });
    if (items.length) {
      body += '<div style="display:grid;gap:4px"><h3>Spese del mese' + (cc.hist ? " (non conteggiate)" : "") + '</h3><div class="list">' + items.map(function (e) {
        return '<div class="li"><span class="what">' + esc(e.text || e.sub) + '</span><span class="num amt">' + eur.format(e.amount) + "</span><small>" + fmtDate(e.date) + " · " + esc(e.sub) + "</small></div>";
      }).join("") + "</div></div>";
    }
    $("sheetBody").innerHTML = body;
    var wasOpen = !$("sheet").hidden;
    $("scrim").hidden = false; $("sheet").hidden = false;
    document.body.classList.add("locked");
    if (!wasOpen) { $("sheet").scrollTop = 0; $("sheetClose").focus(); }
  }
  function closeSheet() {
    var c = state.sheet; state.sheet = null; $("scrim").hidden = true; $("sheet").hidden = true;
    document.body.classList.remove("locked");
    var card = c && document.querySelector('.env[data-c="' + c + '"]'); if (card) card.focus();
  }

  /* ---------- Charts ---------- */
  function baseOpts() {
    var ink2 = css("--ink-2"), font = { family: css("--font-body") || "system-ui", size: 11 };
    return {
      responsive: true, maintainAspectRatio: false, animation: matchMedia("(prefers-reduced-motion: reduce)").matches ? false : { duration: 300 },
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { backgroundColor: css("--raised"), titleColor: css("--ink"), bodyColor: css("--ink-2"), borderColor: css("--axis"), borderWidth: 1, padding: 10,
        titleFont: { family: font.family, weight: "600" }, bodyFont: font, boxPadding: 4, callbacks: { label: function (c) { return " " + c.dataset.label + ": " + eur.format(c.raw); } } } },
      scales: {
        x: { grid: { display: false }, border: { color: css("--axis") }, ticks: { color: ink2, font: font, maxRotation: 0, autoSkipPadding: 8 } },
        y: { grid: { color: css("--line") }, border: { display: false }, ticks: { color: ink2, font: font, maxTicksLimit: 5, callback: function (v) { return eur0.format(v); } } }
      }
    };
  }
  function chart(id, cfg) { if (state.charts[id]) state.charts[id].destroy(); state.charts[id] = new Chart($(id), cfg); }
  function legendHtml(items) { return items.map(function (it) { return '<span><i class="sw" style="background:' + it.color + '"></i>' + esc(it.label) + "</span>"; }).join(""); }

  function renderCharts() {
    var led = state.led, last = led.rows[led.rows.length - 1];
    if (last && last.kind === "waiting" && MM.CONTAINERS.every(function (c) { return !last.c[c].spent; })) led = { rows: led.rows.slice(0, -1), months: led.months.slice(0, -1), start: led.start, cur: led.cur };
    var labels = led.months.map(function (m) { return MM.monthLabel(m, true); });
    var sm = $("smallMultiples");
    if (!sm.dataset.built) {
      sm.innerHTML = MM.CONTAINERS.map(function (c) { return '<div style="display:grid;gap:4px"><span class="eyebrow" style="display:flex;align-items:center;gap:6px"><i class="sw" style="background:var(--c-' + c + ')"></i>' + NAMES[c] + '</span><div class="chart small"><canvas id="sm-' + c + '" aria-label="' + NAMES[c] + ' mese per mese"></canvas></div></div>'; }).join("");
      sm.dataset.built = "1";
    }
    MM.CONTAINERS.forEach(function (c) {
      var o = baseOpts();
      chart("sm-" + c, { type: "bar", data: { labels: labels, datasets: [
        { type: "line", label: "Quota", data: led.rows.map(function (r) { return r.kind === "waiting" ? null : MM.round2(r.c[c].quota); }), spanGaps: false, borderColor: css("--ink"), backgroundColor: css("--ink"), borderWidth: 2, pointRadius: 2, stepped: "middle", order: 0 },
        { label: "Speso", data: led.rows.map(function (r) { return MM.round2(r.c[c].spent); }), backgroundColor: led.rows.map(function (r) { return r.c[c].quota && r.c[c].spent > r.c[c].quota ? css("--bad") : colorOf(c); }), borderRadius: 3, borderSkipped: "start", maxBarThickness: 28, order: 1 }
      ] }, options: o });
    });
    var o2 = baseOpts();
    chart("availChart", { type: "line", data: { labels: labels, datasets: MM.CONTAINERS.map(function (c) {
      return { label: NAMES[c], data: led.rows.map(function (r) { return MM.round2(r.c[c].avail); }), borderColor: colorOf(c), backgroundColor: colorOf(c), borderWidth: 2, pointRadius: 2.5, pointHoverRadius: 5, tension: 0.2 };
    }) }, options: o2, plugins: [{ id: "zero", beforeDatasetsDraw: function (ch) { var y = ch.scales.y.getPixelForValue(0), a = ch.chartArea, ctx = ch.ctx; if (y < a.top || y > a.bottom) return; ctx.save(); ctx.strokeStyle = css("--axis"); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(a.left, y); ctx.lineTo(a.right, y); ctx.stroke(); ctx.restore(); } }] });
    $("availLegend").innerHTML = legendHtml(MM.CONTAINERS.map(function (c) { return { label: NAMES[c], color: colorOf(c) }; }));

    var Y = MM.yearly(state.data, led);
    var o3 = baseOpts();
    chart("yearChart", { type: "bar", data: { labels: Y.years, datasets: MM.CONTAINERS.map(function (c) {
      return { label: NAMES[c], data: Y.years.map(function (y) { return MM.round2(Y.cont[y][c]); }), backgroundColor: colorOf(c), borderRadius: 3, borderSkipped: "start", maxBarThickness: 34 };
    }) }, options: o3 });
    $("yearLegend").innerHTML = legendHtml(MM.CONTAINERS.map(function (c) { return { label: NAMES[c], color: colorOf(c) }; }));
    var h = "<thead><tr><th>Categoria</th>" + Y.years.map(function (y) { return "<th>" + y + "</th><th>Media/mese</th>"; }).join("") + "</tr></thead><tbody>";
    MM.CONTAINERS.forEach(function (c) {
      h += '<tr class="macro"><td class="cat"><i class="sw" style="background:' + colorOf(c) + '"></i>' + NAMES[c] + "</td>" + Y.years.map(function (y) {
        var n = Y.monthsPerYear[y]; return '<td class="num">' + eur0.format(Y.cont[y][c]) + '</td><td class="num">' + (n ? eur0.format(Y.closedCont[y][c] / n) : "—") + "</td>";
      }).join("") + "</tr>";
      Y.subs.filter(function (s) { return s.container === c; }).sort(function (a, b) { return (b.y[Y.years[Y.years.length - 1]] || 0) - (a.y[Y.years[Y.years.length - 1]] || 0); }).forEach(function (s) {
        h += '<tr><td class="cat">' + esc(s.sub) + "</td>" + Y.years.map(function (y) { var n = Y.monthsPerYear[y], v = s.y[y] || 0, vc = s.yClosed[y] || 0; return '<td class="num">' + (v ? eur0.format(v) : "—") + '</td><td class="num">' + (vc && n ? eur0.format(vc / n) : "—") + "</td>"; }).join("") + "</tr>";
      });
    });
    h += "</tbody>";
    $("yearTable").innerHTML = h;
  }

  /* ---------- Analisi ---------- */
  function kpi(l, v, d) { return '<div class="kpi"><span class="eyebrow">' + l + '</span><span class="v num">' + v + '</span><span class="d">' + (d || "") + "</span></div>"; }
  function trendCell(t) {
    if (t.pct === null) return '<span class="flat">nuova</span>';
    var cls = t.pct > 0.1 ? "up" : t.pct < -0.1 ? "down" : "flat", arrow = t.pct > 0.1 ? "↑" : t.pct < -0.1 ? "↓" : "→";
    return '<span class="' + cls + '">' + arrow + " " + (t.pct > 0 ? "+" : "") + pct(t.pct) + "</span>";
  }
  function avgIncome() {
    var rows = state.led.rows.filter(function (r) { return r.kind === "real" || r.kind === "est"; });
    return rows.length ? rows.reduce(function (s, r) { return s + r.income; }, 0) / rows.length : 0;
  }
  function renderAnalysis() {
    var a = MM.analysis(state.data, { today: today(), period: $("period").value, countInvest: $("inv").checked, protected: settings.protected, targets: settings.targets });
    state.an = a;
    $("kpis").innerHTML = kpi("Speso", eur0.format(a.total), a.count + " movimenti · " + MM.monthLabel(a.start, true) + " – " + MM.monthLabel(a.end, true)) +
      kpi("Media al mese", a.avgMonth === null ? "—" : eur0.format(a.avgMonth), a.closed.length ? "su " + a.closed.length + " mesi chiusi" : "si calcola quando il primo mese è chiuso") +
      kpi("Investito in Money Manager", eur0.format(a.invested), $("inv").checked ? "incluso nello speso" : "fuori dallo speso");
    // categories
    var list = a.subList, labels = list.map(function (s) { return s.sub === "Generico" ? s.macro : s.sub; });
    $("catBox").style.height = Math.max(200, list.length * 26 + 40) + "px";
    var o = baseOpts(); o.indexAxis = "y"; o.interaction = { mode: "nearest", axis: "y", intersect: false };
    o.scales.x = { grid: { color: css("--line") }, border: { display: false }, ticks: { color: css("--ink-2"), maxTicksLimit: 4, callback: function (v) { return eur0.format(v); } } };
    o.scales.y = { grid: { display: false }, border: { color: css("--axis") }, ticks: { color: css("--ink"), font: { family: css("--font-body"), size: 11 } } };
    o.plugins.tooltip.callbacks = {
      title: function (it) { var s = list[it[0].dataIndex]; return s.macro + " › " + s.sub; },
      label: function (c) { var s = list[c.dataIndex]; return " " + eur.format(s.total) + " · " + pct(s.share) + " del totale"; },
      afterLabel: function (c) { var s = list[c.dataIndex]; return " " + s.n + " movimenti · media " + eur.format(s.ticket); }
    };
    chart("catChart", { type: "bar", data: { labels: labels, datasets: [{ label: "Speso", data: list.map(function (s) { return MM.round2(s.total); }), backgroundColor: list.map(function (s) { return colorOf(s.container || "ess"); }), borderRadius: 3, borderSkipped: "start", barPercentage: 0.8, categoryPercentage: 0.9 }] },
      options: o, plugins: [{ id: "vl", afterDatasetsDraw: function (c) {
        var ctx = c.ctx, meta = c.getDatasetMeta(0); ctx.save(); ctx.font = "500 10.5px " + (css("--font-mono") || "monospace"); ctx.textBaseline = "middle";
        meta.data.forEach(function (bar, i) { var t = eur0.format(list[i].total), w = ctx.measureText(t).width, x = bar.x + 5;
          if (x + w > c.chartArea.right) { x = bar.x - w - 5; ctx.fillStyle = "#fff"; } else ctx.fillStyle = css("--ink-2"); ctx.fillText(t, x, bar.y); });
        ctx.restore(); } }] });
    $("catLegend").innerHTML = legendHtml(a.macroList.map(function (m) { return { label: m.macro, color: colorOf(m.container || "ess") }; }));
    // insights
    var out = [];
    if (!a.count) out.push(["·", "Nessuna spesa nel periodo."]);
    else {
      var top3 = list.slice(0, 3);
      out.push(["€", "<b>" + top3.map(function (s) { return esc(s.sub); }).join(", ") + "</b> valgono il <b>" + pct(top3.reduce(function (x, s) { return x + s.share; }, 0)) + "</b> di quello che hai speso (" + eur0.format(top3.reduce(function (x, s) { return x + s.total; }, 0)) + ")."]);
      a.macroList.forEach(function (m) { if (m.container === "inv") return; out.push(["◆", "<b>" + esc(m.macro) + "</b>: " + eur0.format(m.total) + " (" + pct(m.share) + "), in media " + eur0.format(m.avg) + " al mese."]); });
      var prot = list.filter(function (s) { return s.protected; });
      if (prot.length) out.push(["★", "Le spese da proteggere (" + prot.map(function (s) { return esc(s.sub); }).join(", ") + ") valgono in media <b>" + eur0.format(a.protAvg) + "</b> al mese."]);
      list.filter(function (s) { return s.trend.pct !== null && s.trend.recent - s.trend.prior > 20 && s.trend.pct > 0.25; }).sort(function (x, y) { return (y.trend.recent - y.trend.prior) - (x.trend.recent - x.trend.prior); }).slice(0, 2)
        .forEach(function (s) { out.push(["↑", "<b>" + esc(s.sub) + "</b>" + (s.protected ? " ★" : "") + " in crescita: " + eur0.format(s.trend.recent) + "/mese negli ultimi 3 mesi contro " + eur0.format(s.trend.prior) + " prima."]); });
      list.filter(function (s) { return s.trend.pct !== null && s.trend.prior - s.trend.recent > 20 && s.trend.pct < -0.25; }).sort(function (x, y) { return (x.trend.recent - x.trend.prior) - (y.trend.recent - y.trend.prior); }).slice(0, 2)
        .forEach(function (s) { out.push(["↓", "<b>" + esc(s.sub) + "</b>" + (s.protected ? " ★" : "") + " in calo: " + eur0.format(s.trend.recent) + "/mese negli ultimi 3 mesi contro " + eur0.format(s.trend.prior) + " prima."]); });
      if (a.smallN) out.push(["·", "Le spese sotto i 15 € sono <b>" + a.smallN + "</b> e sommano " + eur0.format(a.smallTotal) + " (" + pct(a.smallTotal / a.total) + ")."]);
      if (a.top[0]) out.push(["!", "La spesa singola più grande: <b>" + esc(a.top[0].text || a.top[0].sub) + "</b>, " + eur.format(a.top[0].amount) + " il " + fmtDate(a.top[0].date) + "."]);
    }
    $("insights").innerHTML = out.map(function (x) { return '<li><span class="ic">' + x[0] + "</span><span>" + x[1] + "</span></li>"; }).join("");
    // plan
    var inc = avgIncome(), cons = a.avgMonth;
    $("planSum").innerHTML = '<div><span>Spesa media al mese</span><b class="num">' + (cons === null ? "—" : eur0.format(cons)) + "</b></div>" +
      '<div><span>' + (a.anyTarget ? "Con i tuoi obiettivi" : "Prevista (scrivi gli obiettivi)") + '</span><b class="num">' + eur0.format(a.planned) + "</b></div>" +
      (inc ? '<div><span>Entrate medie al mese</span><b class="num">' + eur0.format(inc) + "</b></div>" +
        '<div><span>Quota spese (ess. + div.)</span><b class="num">' + eur0.format(inc * ((+MM.ruleAt(settings.rules, state.led.cur).ess || 0) + (+MM.ruleAt(settings.rules, state.led.cur).div || 0)) / 100) + "</b></div>" : "") +
      '<div><span>Da proteggere ★</span><b class="num">' + eur0.format(a.protAvg) + "</b></div>";
    var tg = settings.targets || {};
    var h = "<thead><tr><th>Categoria</th><th>Totale</th><th>Quota</th><th>Media/mese</th><th>Mov.</th><th>Media spesa</th><th>Tendenza</th><th>★</th><th>Obiettivo</th><th>Scarto</th></tr></thead><tbody>";
    a.macroList.forEach(function (m) {
      h += '<tr class="macro"><td class="cat"><i class="sw" style="background:' + colorOf(m.container || "ess") + '"></i>' + esc(m.macro) + '</td><td class="num">' + eur0.format(m.total) + '</td><td class="num">' + pct(m.share) + '</td><td class="num">' + eur0.format(m.avg) + '</td><td class="num">' + m.n + '</td><td></td><td class="num">' + trendCell(m.trend) + "</td><td></td><td></td><td></td></tr>";
      m.items.forEach(function (s) {
        var t = tg[s.key], gap = s.target !== null ? s.avg - s.target : null, sid = s.key.replace(/[^\p{L}\p{N}]+/gu, "_");
        h += '<tr><td class="cat">' + esc(s.sub) + (s.protected ? '<span class="star">★</span>' : "") + '</td><td class="num">' + eur0.format(s.total) + '</td><td class="num">' + pct(s.share) + '</td><td class="num">' + eur0.format(s.avg) + '</td><td class="num">' + s.n +
          '</td><td class="num">' + eur.format(s.ticket) + '</td><td class="num">' + trendCell(s.trend) + '</td><td class="prot"><input type="checkbox" id="p-' + esc(sid) + '" data-key="' + esc(s.key) + '"' + (s.protected ? " checked" : "") + ' aria-label="Proteggi ' + esc(s.sub) + '"></td>' +
          '<td><input type="number" min="0" step="5" id="t-' + esc(sid) + '" data-key="' + esc(s.key) + '" value="' + (t !== undefined ? esc(t) : "") + '" placeholder="—" aria-label="Obiettivo mensile ' + esc(s.sub) + '"></td>' +
          '<td class="num ' + (gap === null ? "" : gap > 0 ? "neg" : "pos") + '">' + (gap === null ? "" : (gap > 0 ? "+" : "") + eur0.format(gap)) + "</td></tr>";
      });
    });
    $("planTable").innerHTML = h + "</tbody>";
    // habits
    var o4 = baseOpts(); o4.plugins.tooltip.callbacks = { label: function (c) { return " " + eur.format(c.raw) + " · " + a.dowN[c.dataIndex] + " movimenti"; } };
    chart("dowChart", { type: "bar", data: { labels: ["lun", "mar", "mer", "gio", "ven", "sab", "dom"], datasets: [{ label: "Speso", data: a.dow.map(MM.round2), backgroundColor: colorOf("ess"), borderRadius: 3, borderSkipped: "start", maxBarThickness: 30 }] }, options: o4 });
    var o5 = baseOpts(); o5.indexAxis = "y";
    o5.scales.x = { grid: { color: css("--line") }, border: { display: false }, ticks: { color: css("--ink-2"), maxTicksLimit: 4, callback: function (v) { return eur0.format(v); } } };
    o5.scales.y = { grid: { display: false }, border: { color: css("--axis") }, ticks: { color: css("--ink") } };
    o5.plugins.tooltip.callbacks = { label: function (c) { return " " + eur.format(c.raw) + " · " + pct(c.raw / (a.total || 1)); } };
    chart("payChart", { type: "bar", data: { labels: a.payList.map(function (p) { return p.name; }), datasets: [{ label: "Speso", data: a.payList.map(function (p) { return MM.round2(p.total); }), backgroundColor: colorOf("ess"), borderRadius: 3, borderSkipped: "start", maxBarThickness: 26 }] }, options: o5 });
    $("topList").innerHTML = a.top.length ? a.top.map(function (e) {
      return '<div class="li"><span class="what">' + esc(e.text || e.sub) + '</span><span class="num">' + eur.format(e.amount) + "</span><small>" + fmtDate(e.date) + " · " + esc(e.macro + " › " + e.sub) + "</small></div>";
    }).join("") : '<p class="empty">Nessuna spesa nel periodo.</p>';
    $("recurList").innerHTML = a.recurring.length ? a.recurring.map(function (r) {
      return '<div class="li"><span class="what">' + esc(r.text) + '</span><span class="num">' + eur.format(r.total) + "</span><small>" + r.n + " volte · " + esc(r.macro + " › " + r.sub) + "</small></div>";
    }).join("") : '<p class="empty">Nessuna voce ripetuta.</p>';
  }

  /* ---------- Movimenti ---------- */
  function renderMoves() {
    var m = $("movMonth").value, f = state.movFilter;
    var chips = [["all", "Tutti", null], ["ess", NAMES.ess, "ess"], ["div", NAMES.div, "div"], ["inv", NAMES.inv, "inv"], ["in", "Entrate", null]];
    $("movChips").innerHTML = chips.map(function (c) { return '<button type="button" class="chip" data-f="' + c[0] + '" aria-pressed="' + (f === c[0]) + '">' + (c[2] ? '<i class="sw" style="background:var(--c-' + c[2] + ')"></i>' : "") + c[1] + "</button>"; }).join("");
    var ex = state.data.expenses.filter(function (e) { return e.month === m && (f === "all" || e.container === f); }).map(function (e) { return { e: e, inc: false }; });
    var fu = f === "in" ? [] : state.data.future.filter(function (e) { return e.month === m && (f === "all" || e.container === f); }).map(function (e) { return { e: e, inc: false, fut: true }; });
    var inc = (f === "all" || f === "in") ? state.data.incomes.filter(function (e) { return e.month === m; }).map(function (e) { return { e: e, inc: true }; }) : [];
    var items = (f === "in" ? inc : ex.concat(inc, fu)).sort(function (a, b) { return b.e.date.localeCompare(a.e.date) || b.e.amount - a.e.amount; });
    var spent = ex.reduce(function (s, x) { return s + x.e.amount; }, 0);
    $("movSum").textContent = items.length ? items.length + " movimenti" + (ex.length ? " · speso " + eur.format(spent) : "") + (fu.length ? " · " + fu.length + " con data futura, non ancora conteggiate" : "") : "";
    if (!items.length) { $("movList").innerHTML = '<p class="empty">Nessun movimento in questo mese.</p>'; return; }
    var h = "", lastDay = null;
    items.forEach(function (x) {
      var e = x.e;
      if (e.date !== lastDay) {
        var dayTot = items.filter(function (y) { return y.e.date === e.date && !y.inc && !y.fut; }).reduce(function (s, y) { return s + y.e.amount; }, 0);
        var dd = new Date(e.date + "T12:00:00").toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" });
        h += '<div class="day"><span>' + dd + '</span><span class="num">' + (dayTot ? eur.format(dayTot) : "") + "</span></div>"; lastDay = e.date;
      }
      var extra = x.inc ? " · stipendio di " + MM.monthLong(MM.salaryMonth(e, settings)) : x.fut ? " · data futura, non ancora conteggiata" : "";
      h += '<div class="li' + (x.fut ? " fut" : "") + '"><span class="what">' + (e.container ? '<i class="sw" style="background:var(--c-' + e.container + ')"></i>' : "") + esc(e.text || e.sub) + '</span><span class="num amt' + (x.inc ? " in" : "") + '">' + (x.inc ? "+" : "") + eur.format(e.amount) +
        "</span><small>" + esc(e.macro + " › " + e.sub) + " · " + esc(e.asset) + (e.memo ? " · " + esc(e.memo) : "") + extra + "</small></div>";
    });
    $("movList").innerHTML = h;
  }

  /* ---------- Impostazioni ---------- */
  function renderSettings() {
    $("srcInfo").textContent = state.src ? (state.src.name || "") + " · " + srcLine(state.src) : "Nessun backup caricato.";
    renderAccount();
    if (!$("syncInfo").textContent) syncMsg(remoteState === "ok" ? "Impostazioni salvate nel tuo Drive: sono le stesse su ogni dispositivo." : "Impostazioni salvate su questo dispositivo.");
    var rs = MM.sortedRules(settings.rules);
    var dupes = {}; rs.forEach(function (r) { dupes[r.from] = (dupes[r.from] || 0) + 1; });
    $("rules").innerHTML = rs.map(function (r, i) {
      var s1 = (+r.ess || 0) + (+r.div || 0) + (+r.inv || 0), s2 = (+r.etf || 0) + (+r.crypto || 0) + (+r.liq || 0);
      function f(k, lab) { return '<label for="r' + i + k + '">' + lab + ' %<input type="number" min="0" max="100" step="1" id="r' + i + k + '" data-i="' + i + '" data-k="' + k + '" value="' + (+r[k] || 0) + '"></label>'; }
      return '<div class="rule"><div class="row" style="justify-content:space-between"><label class="field" for="r' + i + 'from">Valida dal mese<input type="month" id="r' + i + 'from" data-i="' + i + '" data-k="from" value="' + r.from + '"></label>' +
        (rs.length > 1 ? '<button type="button" class="btn quiet" data-del="' + i + '">Elimina</button>' : "") + "</div>" +
        (dupes[r.from] > 1 ? '<p class="warn-text">Un\'altra divisione parte dallo stesso mese: cambia una delle due date, altrimenti ne vale solo una.</p>' : "") +
        '<div class="rule-grid">' + f("ess", "Essenziali") + f("div", "Divertimento") + f("inv", "Investimenti") + "</div>" +
        (s1 !== 100 ? '<p class="warn-text">Le tre percentuali sommano ' + s1 + "%, non 100%.</p>" : "") +
        '<p class="note">Divisione degli investimenti</p><div class="rule-grid">' + f("etf", "PAC ETF") + f("crypto", "Crypto") + f("liq", "Liquidità") + "</div>" +
        (s2 !== 100 ? '<p class="warn-text">La divisione degli investimenti somma ' + s2 + "%, non 100%.</p>" : "") + "</div>";
    }).join("");
    settings.rules = rs;
    $("startIn").value = settings.startMonth;
    $("estIn").value = settings.estimate;
    $("prevIn").checked = settings.salaryPrevMonth !== false;
    var ov = settings.investOverride || {};
    $("ovr").innerHTML = Object.keys(ov).sort().map(function (m) {
      return '<label for="ov-' + m + '">' + MM.monthLong(m) + '<input type="number" min="0" step="0.01" id="ov-' + m + '" data-m="' + m + '" value="' + esc(ov[m]) + '" placeholder="vuoto: uso Money Manager"></label>';
    }).join("") || '<p class="note">Nessun mese.</p>';
  }

  /* ---------- Events ---------- */
  document.querySelectorAll("nav.tabs button").forEach(function (b) { b.addEventListener("click", function () { showView(b.dataset.view); window.scrollTo(0, 0); }); });
  $("gear").addEventListener("click", function () { showView(state.view === "impostazioni" ? "mese" : "impostazioni"); window.scrollTo(0, 0); });
  $("monthSel").addEventListener("change", function () { state.month = this.value; renderMonth(); });
  $("envelopes").addEventListener("click", function (e) { var b = e.target.closest(".env"); if (b) openSheet(b.dataset.c); });
  $("scrim").addEventListener("click", closeSheet);
  $("sheetClose").addEventListener("click", closeSheet);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && state.sheet) closeSheet(); });
  $("period").addEventListener("change", function () { store("mm-period", this.value); renderAnalysis(); });
  $("inv").addEventListener("change", function () { renderAnalysis(); });
  $("movMonth").addEventListener("change", function () { state.movUserSet = true; renderMoves(); });
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
  var rerender = function () { if (state.data) renderAll(); };
  try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerender); } catch (e) {}
  new MutationObserver(rerender).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  /* ---------- Boot: this device's last copy first, then Google ---------- */
  var v0 = load(VIEW_KEY); if (v0 && TITLES[v0] && v0 !== "impostazioni") state.view = v0;
  var redirect = Drive.handleRedirect();
  var cached = null; try { cached = JSON.parse(load(CACHE_KEY) || "null"); } catch (e) {}
  var boot = cached && cached.b64 ? ingest(b64ToBytes(cached.b64), cached.src).then(function () { setStatus("", srcLine(state.src)); }) : Promise.resolve();
  boot.catch(function () {}).then(function () {
    renderAccount();
    if (!state.data) { $("needWhy").textContent = "Accedi con Google per leggere i backup dalla cartella MoneyManager, oppure scegli qui un file .mmbak."; $("needFile").hidden = false; }
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
