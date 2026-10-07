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

  var state = { data: null, src: null, SQL: null, view: "mese", month: null, movFilter: "all", sheet: null, editPlan: false };

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
  var TITLES = { mese: "Mese", grafici: "Andamento", analisi: "Medie", movimenti: "Movimenti", impostazioni: "Impostazioni" };
  function showView(v) {
    state.view = v; store(VIEW_KEY, v);
    Charts.hideTip();
    document.querySelectorAll(".view").forEach(function (el) { el.hidden = !state.data || el.id !== "v-" + v; });
    if (v === "impostazioni") $("v-impostazioni").hidden = false;
    document.querySelectorAll("nav.tabs button").forEach(function (b) { if (b.dataset.view === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
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
    var el = s && (s.key ? document.querySelector('[data-key="' + (window.CSS && CSS.escape ? CSS.escape(s.key) : s.key) + '"]') : document.querySelector('.env[data-c="' + s.c + '"]'));
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

  /* ---------- Impostazioni ---------- */
  function renderSettings() {
    $("srcInfo").textContent = state.src ? (state.src.name || "") + " · " + srcLine(state.src) : "Nessun backup caricato.";
    renderAccount();
    if (!$("syncInfo").textContent) syncMsg(remoteState === "ok" ? "Impostazioni salvate nel tuo Drive: sono le stesse su ogni dispositivo." : "Impostazioni salvate su questo dispositivo.");
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
  document.querySelectorAll("nav.tabs button").forEach(function (b) { b.addEventListener("click", function () { showView(b.dataset.view); window.scrollTo(0, 0); }); });
  $("refresh").addEventListener("click", function () { syncFromDrive(true); });
  $("monthSel").addEventListener("change", function () { state.month = this.value; renderMonth(); });
  $("monPrev").addEventListener("click", function () { stepMonth(-1); });
  $("monNext").addEventListener("click", function () { stepMonth(1); });
  $("envelopes").addEventListener("click", function (e) { var b = e.target.closest(".env"); if (b) openSheet({ c: b.dataset.c }); });
  $("heat").addEventListener("click", function (e) { var b = e.target.closest(".heat-row"); if (b) openSheet({ key: b.dataset.key }); });
  $("planTable").addEventListener("click", function (e) { var b = e.target.closest("button.cat-row"); if (b) openSheet({ key: b.dataset.key }); });
  $("scrim").addEventListener("click", closeSheet);
  $("sheetClose").addEventListener("click", closeSheet);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && state.sheet) closeSheet(); });
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
