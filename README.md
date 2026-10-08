# Spese MoneyManager

Sito personale che legge i backup di **Money Manager** dalla cartella `MoneyManager` di Google Drive e mostra le spese divise nei contenitori dello stipendio (Spese Essenziali, Divertimento, Investimenti).

- Funziona solo nel browser: nessun server, nessun costo.
- Nel codice non c'è nessun dato personale. I backup restano nel tuo Drive, le impostazioni stanno in una cartella nascosta del tuo Drive che solo questo sito può vedere.
- Si installa sul telefono come un'app e mostra l'ultima copia anche senza rete.

---

## Configurazione (una volta sola, circa 15 minuti)

Servono due cose: il sito pubblicato su GitHub Pages e un "Client ID" di Google, che permette al sito di chiederti l'accesso al Drive.

Usa sempre lo stesso account Google con cui entrerai nel sito (quello che vede la cartella `MoneyManager`).

### 1. Pubblicare il sito su GitHub Pages

1. Crea un repository **pubblico** chiamato `spese` e carica tutti i file di questa cartella.
2. Nel repository apri **Settings → Pages**.
3. In **Build and deployment** scegli **Source: Deploy from a branch**, branch `main`, cartella `/ (root)`, e salva.
4. Dopo un minuto il sito è su `https://TUO-UTENTE.github.io/spese/`. Annota questo indirizzo: serve al punto 2.

### 2. Creare il Client ID di Google

Vai su <https://console.cloud.google.com> con il tuo account Google.

1. **Crea un progetto**: in alto, selettore dei progetti → *Nuovo progetto* → nome `Spese` → *Crea*.
2. **Attiva l'API di Drive**: menu → *API e servizi* → *Libreria* → cerca **Google Drive API** → *Abilita*.
3. **Configura la schermata di consenso**: menu → *Google Auth Platform* (o *API e servizi → Schermata consenso OAuth*) → *Inizia*:
   - nome app `Spese`, email di assistenza la tua;
   - pubblico: **Esterno**;
   - email di contatto la tua → *Crea*.
   - Poi in *Branding* completa: **Home page dell'applicazione** `https://TUO-UTENTE.github.io/spese/`, **Norme sulla privacy** `https://TUO-UTENTE.github.io/spese/privacy.html`, **Domini autorizzati** `TUO-UTENTE.github.io` → *Salva*. Senza questi dati Google non lascia pubblicare l'app.
4. **Pubblica l'app**: in *Pubblico* (Audience) premi **Pubblica app** e conferma.
   Se resta "In test", Google ti fa ripetere il consenso ogni 7 giorni.
   Non serve la verifica di Google: l'app la usi solo tu. Al primo accesso vedrai l'avviso "Google non ha verificato questa app" (vedi punto 4).
5. **Crea il client**: *Client* → *Crea client*:
   - tipo di applicazione: **Applicazione web**;
   - nome: `Spese sito`;
   - **Origini JavaScript autorizzate**: `https://TUO-UTENTE.github.io`
   - **URI di reindirizzamento autorizzati**: `https://TUO-UTENTE.github.io/spese/` (con la barra finale)
   - *Crea* e copia l'**ID client** (finisce con `.apps.googleusercontent.com`).

### 3. Mettere il Client ID nel sito

Apri `config.js` nel repository, incolla l'ID tra le virgolette e salva:

```js
window.CONFIG = {
  clientId: "123456789-abc.apps.googleusercontent.com"
};
```

L'ID client non è un segreto: è normale che stia in un repository pubblico.

### 4. Primo accesso

1. Apri `https://TUO-UTENTE.github.io/spese/` e premi **Accedi con Google**.
2. Compare "Google non ha verificato questa app": premi **Avanzate** → **Vai a Spese (non sicuro)**. È l'app che hai creato tu.
3. Lascia **spuntate** tutte e due le caselle: vedere i file di Google Drive (per leggere i backup) e la cartella dati dell'app (per le impostazioni).
4. La prima volta il sito cerca nel Drive il file `spese-impostazioni.json` e importa da lì le tue impostazioni (divisione 30/50/20, investimenti dell'altra app, spese da proteggere). Poi puoi cancellarlo.

### 5. Installarlo sul telefono

Apri il sito con Chrome su Android → menu ⋮ → **Installa app** (o *Aggiungi a schermata Home*).

---

## Come funziona

| File | Cosa fa |
|---|---|
| `index.html` | La pagina e la grafica: il menu laterale e le schede Mese, Andamento, Medie, Movimenti, Patrimonio, Crypto e Impostazioni |
| `privacy.html` | L'informativa sulla privacy richiesta da Google |
| `js/core.js` | I calcoli: contenitori, giacenze, analisi, anno per anno, mese per mese |
| `js/drive.js` | L'accesso a Google e le chiamate a Drive |
| `js/patrimonio.js` | Crypto e Patrimonio: legge `patrimonio.json`, prende i prezzi da CoinGecko, calcola i conti e gli ETF |
| `js/app.js` | L'interfaccia |
| `js/charts.js` | I grafici (SVG, senza librerie esterne) |
| `config.js` | Il Client ID di Google |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installazione sul telefono e funzionamento offline |
| `vendor/` | [sql.js](https://github.com/sql-js/sql.js) per leggere i backup e il carattere [Mona Sans](https://github.com/github/mona-sans) (licenza OFL), salvati qui così il sito funziona anche offline |

- **Accesso**: il sito chiede a Google un permesso valido un'ora. Quando scade, lo rinnova da solo se sei ancora collegato a Google nel browser. Il permesso resta solo sul tuo dispositivo.
- **Permessi richiesti**: lettura dei file di Drive (`drive.readonly`) e la cartella nascosta dell'app (`drive.appdata`). Il sito non può modificare né cancellare i tuoi file.
- **Dati**: ogni volta che apri il sito prende il backup `.mmbak` più recente della cartella. I dati sono aggiornati all'ultimo backup che Money Manager ha caricato su Drive.
- **Revocare l'accesso**: nel sito, *Impostazioni → Esci da Google*. Oppure da <https://myaccount.google.com/permissions>.

## Menu

Le schede si aprono dal menu laterale: su telefono con il pulsante in alto a sinistra, su uno schermo largo il menu resta sempre aperto.

## Patrimonio

La scheda **Patrimonio** somma conti, ETF e crypto, in euro o in dollari.

- Un grafico a torta mostra come è diviso il totale tra Conti, ETF e Crypto. Toccando una fetta si apre la torta di quella parte: i conti per banca, gli ETF per fondo, le crypto per moneta.
- **Conti**: in *Impostazioni → Patrimonio* si scrivono una volta i saldi di Poste e Fineco di una sera. Da lì il sito aggiunge gli stipendi, toglie le spese dei conti di Money Manager che escono da quella banca, sposta il giroconto mensile da Poste a Fineco, toglie da Fineco gli acquisti di ETF e da Poste le ricariche di ether.fi con la loro commissione. Per ogni conto di Money Manager si sceglie da dove escono i soldi; le spese con la carta ether.fi non si tolgono, perché sono già nel suo saldo. Toccando un conto si vede il calcolo. I contanti non si contano.
- **Ricariche di ether.fi**: le trova il programma sul PC tra i versamenti in arrivo sul conto ether.fi. Se una non viene da Poste si toglie la spunta.
- **ETF**: gli ISIN stanno nel programma sul PC, che scrive il prezzo; le quote si scrivono nella scheda e si aggiornano ogni mese.

## Crypto

La scheda **Crypto** mostra le quantità di crypto su exchange, hardware wallet e app, con il valore in dollari o in euro.

- Le quantità le scrive ogni ora un **programma che gira sul tuo PC** nel file `patrimonio.json` del tuo Drive. Il programma non sta in questo repository: contiene le chiavi API degli exchange e resta solo sul PC.
- Il sito cerca nel Drive il `patrimonio.json` più recente e lo legge con lo stesso permesso dei backup.
- I prezzi in dollari arrivano da CoinGecko ogni volta che apri la scheda. A CoinGecko va solo l'elenco delle monete, mai le quantità. Senza rete il sito usa gli ultimi prezzi salvati sul dispositivo o quelli scritti dal programma.
- In alto si sceglie se vedere gli importi in dollari o in euro (il cambio è quello di USDT). La scelta resta sul dispositivo.
- Toccando una moneta si apre sotto la quantità in tutto e dove si trova; toccando un posto, i suoi conti e le sue monete.
- Si può anche aprire a mano un file `patrimonio.json` dalla scheda stessa.
- **Inseriti a mano**: per le app che non si possono leggere da sole (per esempio Kast, che tiene i soldi per conto tuo) si scrivono posto, moneta e quantità in fondo alla scheda Crypto. Le righe si salvano con le impostazioni nella cartella nascosta dell'app su Drive.
- Una quantità negativa è un debito (per esempio le spese a credito della carta ether.fi) e viene tolta dal totale.
- Il file può avere anche `etf` (ISIN, nome, simbolo, prezzo, valuta) e `ricariche` (versamenti sul conto ether.fi: id, quando, simbolo, quantita, eur).

Formato del file (versione 1):

```json
{
  "versione": 1,
  "creato": "2026-01-01T12:00:00Z",
  "posti": [ { "id": "exchange-a", "nome": "Exchange A", "tipo": "exchange", "stato": "ok",
               "conti": [ { "nome": "Spot", "stato": "ok", "aggiornato": "2026-01-01T12:00:00Z" } ] } ],
  "saldi": [ { "posto": "exchange-a", "conto": "Spot", "simbolo": "BTC", "quantita": 0.5 } ],
  "monete": { "BTC": { "cg": "bitcoin", "usd": 50000 } },
  "eur_usd": 1.08
}
```

`tipo` è `exchange`, `wallet`, `app` o `manuale`. Un conto può avere `avviso`: è stato letto, ma una parte va controllata. `stato` è `ok`, `parziale` o `errore`: un conto in errore porta `errore` e, in `aggiornato`, l'ora delle quantità che sta mostrando. `cg` è l'id della moneta su CoinGecko e `usd` è il prezzo al momento della scrittura, usato quando il prezzo aggiornato non arriva.

## Aggiornare il sito

Modifica i file nel repository: GitHub Pages pubblica la nuova versione in un minuto. Il telefono la prende alla prima apertura con la rete.
