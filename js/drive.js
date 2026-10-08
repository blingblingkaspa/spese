/* ---------- Google sign-in (OAuth 2.0 for client-side apps) and the Drive calls the site needs ---------- */
var Drive = (function () {
  var SCOPES = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata";
  var API = "https://www.googleapis.com/drive/v3";
  var UPLOAD = "https://www.googleapis.com/upload/drive/v3";
  var TOKEN_KEY = "mm-token", SIGNED_KEY = "mm-signed-in", STATE_KEY = "mm-oauth-state", SILENT_KEY = "mm-silent-tried";
  var SETTINGS_NAME = "settings.json", IMPORT_NAME = "spese-impostazioni.json";

  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch (e) { return null; } }

  function configured() { return !!(window.CONFIG && CONFIG.clientId); }
  function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/, ""); }

  function token() {
    try { var t = JSON.parse(ls(TOKEN_KEY) || "null"); if (t && t.exp > Date.now() + 60000) return t.token; } catch (e) {}
    return null;
  }
  function wasSignedIn() { return ls(SIGNED_KEY) === "1"; }
  function forget() { ls(TOKEN_KEY, null); }

  /* Leave the page for Google's sign-in; it comes back with the token in the address */
  function signIn(silent) {
    var state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    ss(STATE_KEY, state);
    if (silent) ss(SILENT_KEY, "1");
    var p = new URLSearchParams({ client_id: CONFIG.clientId, redirect_uri: redirectUri(), response_type: "token", scope: SCOPES, include_granted_scopes: "true", state: state });
    if (silent) p.set("prompt", "none");
    location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + p.toString());
  }

  /* Read the answer Google put in the address after sign-in. null = nothing to read. */
  function handleRedirect() {
    var h = location.hash || "";
    if (h.indexOf("access_token=") < 0 && h.indexOf("error=") < 0) return null;
    var q = new URLSearchParams(h.slice(1));
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) { location.hash = ""; }
    var expected = ss(STATE_KEY); ss(STATE_KEY, null);
    var silent = ss(SILENT_KEY) === "1";
    if (!expected || q.get("state") !== expected) return { error: "state", silent: silent };
    if (q.get("error")) return { error: q.get("error"), silent: silent };
    var granted = (q.get("scope") || "").split(" ");
    if (granted.indexOf("https://www.googleapis.com/auth/drive.readonly") < 0) return { error: "scope", silent: silent };
    ls(TOKEN_KEY, JSON.stringify({ token: q.get("access_token"), exp: Date.now() + (+q.get("expires_in") || 3600) * 1000 }));
    ls(SIGNED_KEY, "1");
    ss(SILENT_KEY, null);
    return { ok: true, silent: silent };
  }
  /* A silent renewal is attempted once per browser session, so a refusal never loops */
  function canTrySilent() { return configured() && wasSignedIn() && ss(SILENT_KEY) !== "1"; }

  function signOut() {
    var t = token();
    forget(); ls(SIGNED_KEY, null);
    if (t) fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } }).catch(function () {});
  }

  function call(url, opts) {
    var t = token();
    if (!t) return Promise.reject({ code: "auth" });
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: "Bearer " + t }, opts.headers || {});
    return fetch(url, opts).catch(function () { throw { code: "offline" }; }).then(function (r) {
      if (r.status === 401) { forget(); throw { code: "auth" }; }
      if (r.ok) return r;
      return r.json().catch(function () { return {}; }).then(function (j) {
        var msg = (j.error && j.error.message) || "";
        if (r.status === 403 && /insufficient|scope/i.test(msg)) { forget(); throw { code: "auth", message: msg }; }
        if (r.status === 404) throw { code: "notfound", message: msg };
        if (r.status === 403 || r.status === 429) throw { code: "limit", message: msg };
        throw { code: "http", status: r.status, message: msg };
      });
    });
  }
  function json(url, opts) { return call(url, opts).then(function (r) { return r.json(); }); }
  function q(s) { return encodeURIComponent(s); }
  var ALL = "&supportsAllDrives=true&includeItemsFromAllDrives=true";

  function findFolders(name) {
    var query = "name = '" + String(name).replace(/'/g, "\\'") + "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    return json(API + "/files?q=" + q(query) + "&fields=" + q("files(id,name,owners(emailAddress),modifiedTime)") + "&pageSize=10" + ALL).then(function (r) { return r.files || []; });
  }
  function latestBackup(folderId) {
    var query = "'" + folderId + "' in parents and trashed = false";
    return json(API + "/files?q=" + q(query) + "&orderBy=" + q("modifiedTime desc") + "&pageSize=25&fields=" + q("files(id,name,modifiedTime,size,mimeType)") + ALL)
      .then(function (r) {
        var files = (r.files || []).filter(function (f) { return /\.mmbak$/i.test(f.name || "") || /realbyteapps\.moneymanager/.test(f.mimeType || ""); });
        files.sort(function (a, b) { return String(b.modifiedTime).localeCompare(String(a.modifiedTime)); });
        return files[0] || null;
      });
  }
  function download(id) { return call(API + "/files/" + id + "?alt=media&supportsAllDrives=true").then(function (r) { return r.arrayBuffer(); }); }

  /* Settings: one JSON file in the app's hidden folder of the user's Drive */
  var settingsId = null;
  function loadSettings() {
    return json(API + "/files?spaces=appDataFolder&q=" + q("name = '" + SETTINGS_NAME + "'") + "&fields=" + q("files(id,modifiedTime)")).then(function (r) {
      var f = (r.files || [])[0];
      if (!f) return null;
      settingsId = f.id;
      return json(API + "/files/" + f.id + "?alt=media");
    });
  }
  function saveSettings(obj) {
    var body = JSON.stringify(obj);
    if (settingsId) return json(UPLOAD + "/files/" + settingsId + "?uploadType=media&fields=id", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: body });
    var b = "mm" + Date.now().toString(36);
    var meta = { name: SETTINGS_NAME, parents: ["appDataFolder"], mimeType: "application/json" };
    var multipart = "--" + b + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) + "\r\n--" + b + "\r\nContent-Type: application/json\r\n\r\n" + body + "\r\n--" + b + "--";
    return json(UPLOAD + "/files?uploadType=multipart&fields=id", { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + b }, body: multipart })
      .then(function (r) { settingsId = r.id; return r; });
  }
  /* Patrimonio: the newest file with this name anywhere in Drive (patrimonio.json, written by the program on the PC) */
  function latestNamed(name) {
    var query = "name = '" + String(name).replace(/'/g, "\\'") + "' and trashed = false";
    return json(API + "/files?q=" + q(query) + "&orderBy=" + q("modifiedTime desc") + "&pageSize=5&fields=" + q("files(id,name,modifiedTime)") + ALL)
      .then(function (r) { return (r.files || [])[0] || null; });
  }
  /* One-time import: a settings file the user keeps anywhere in Drive */
  function findImport() {
    return json(API + "/files?q=" + q("name = '" + IMPORT_NAME + "' and trashed = false") + "&orderBy=" + q("modifiedTime desc") + "&fields=" + q("files(id,name)") + ALL).then(function (r) {
      var f = (r.files || [])[0];
      return f ? json(API + "/files/" + f.id + "?alt=media&supportsAllDrives=true") : null;
    });
  }

  return { configured: configured, token: token, wasSignedIn: wasSignedIn, signIn: signIn, signOut: signOut, handleRedirect: handleRedirect, canTrySilent: canTrySilent,
    findFolders: findFolders, latestBackup: latestBackup, download: download, loadSettings: loadSettings, saveSettings: saveSettings, findImport: findImport,
    latestNamed: latestNamed };
})();
