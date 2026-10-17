# Piano di Refactor — FC Sniper
**Obiettivi:** aumentare l'efficienza del bot e ridurre drasticamente la superficie di rilevamento anti soft-ban di EA.
**Stato:** analisi completata su `fc26.js` (5.691 righe), `content.js`, `pin-bridge.js`, `ui.js`, `index.html`, `manifest.json`, `rules.json`, `offscreen.js`, `telemetry-server.js`, log reali di `runtime-telemetry.log` e storia git.

---

## 0. Sintesi esecutiva

Il bot funziona ma è un monolite da ~5.700 righe cresciuto per fix incrementali ("461 fix", "401 fix", "soft-ban managing fix"...). I soft-ban continuano ad arrivare — il log reale mostra `BID_SOFT_BAN` ricorrenti con cooldown EA in escalazione (63 → 95 → 126 minuti il 2026-10-13) — perché **le contromisure attuali sono in gran parte inefficaci o addirittura controproducenti**:

1. **Le regole di "header spoofing" non vengono mai applicate** (rules.json punta a `fc26/v5`, il traffico reale è `fc27/v1`) → tutte le richieste di scrittura partono con `Origin: chrome-extension://<id>`, autodenunciandosi a EA come NON-Web-App.
2. **Durante le "pause di sicurezza" il bot continua a parlare con EA** (3 chiamate UTAS ogni 120s esatti) → resetta i timer di decay del ban e produce traffico a metronomo.
3. **La gestione del CAPTCHA (458) è assente nei loop lazy e nella discovery** → il bot continua a sparare ricerche mentre EA mostra il captcha.
4. **La telemetria PIN simulata è incoerente** (eventi emessi nello stesso tick, throttle che scarta eventi, richieste che partono anche senza telemetria) → sequenza telemetrica impossibile per un umano.
5. **Pattern temporali perfettamente periodici** (bid ogni ≥1600ms esatti, heartbeat ogni 120s esatti, micro-pause ogni 25 tentativi esatti, discovery a gradini di prezzo regolari).

L'efficienza soffre di: duplicazione massiva (4 engine quasi identici, ~2.000 righe ridondanti), 4 keep-alive sovrapposti, scritture storage ad ogni richiesta, fetch ridondanti dello stesso dato, e **2 bug `ReferenceError` certi che bloccano le fasi di top-up lazy**.

Il piano è diviso in 4 fasi: **Fase 0** (bug bloccanti), **Fase 1** (anti soft-ban critico), **Fase 2** (architettura/efficienza), **Fase 3** (igiene e sicurezza generale).

---

## 1. Diagnosi: perché arrivano i soft-ban

| # | Evidenza | Dove | Impatto |
|---|----------|------|---------|
| 1.1 | DNR rules puntano a `utas.mob.v5.../fc26/*` ma tutto il traffico è `utas.mob.v1.../fc27/*` → ruleset mai applicato | rules.json:22,46,71,96 vs fc26.js:296-297,320,353 | **CRITICO**: header mai normalizzati |
| 1.2 | Le POST/PUT/DELETE da Service Worker portano `Origin: chrome-extension://<id>` | fc26.js:2149,2420 (sell), 1719,2218 (bid), 1834,2306 (item), 2501 (watchlist), 991,2527 (delete) | **CRITICO**: ogni scrittura si autoidentifica come estensione |
| 1.3 | UA incoerenti nelle regole (Chrome/141 + `Not?A_Brand;v=8` obsoleto vs Chrome/142 + `Not_A Brand;v=99`), `Sec-Fetch-Site` settato due volte | rules.json:10,14,34,38 vs 59,62,65,84,87,90 | Alto: fingerprint client contraddittorio |
| 1.4 | Se le regole matchassero, rimuovono `Cookie` → richieste bot distinguibili dalle XHR genuine della pagina (che i cookie li portano) | rules.json:17,41,66,91 | Alto (latente) |
| 1.5 | `executeSafetyPause` (dopo errori rate-limit) fa traffico UTAS ogni 120s: watchlist + tradepile + clearSold + relist | fc26.js:441-514, 485-505 | **CRITICO**: la "pausa" non è una pausa; resetta il decay del ban. Contraddetta dal cooldown lazy che invece tace (fc26.js:4746-4751) |
| 1.6 | CAPTCHA 458 non gestito in `discoverConsumableLowestBin` e nei loop lazy Step1/Step2: su captcha il bot **continua a cercare** | fc26.js:3300-3423, 4330-4342 (gestisce solo 401/429/426/521/512), 2451+ | **CRITICO**: escalation ban certa |
| 1.7 | Bid throttle a intervallo minimo esatto (1600ms), listing a 1500ms esatti; nessun budget cross-endpoint (POST sell + PUT bid a <100ms di distanza) | fc26.js:2196-2199, 2411-2415 | Alto: traffico a metronomo su `/trade/bid` |
| 1.8 | Micro-pause ogni **esattamente** 25 tentativi, cooldown ogni **esattamente** 50, heartbeat ogni **esattamente** 120s | fc26.js:639,1988,3853, 3195,3677, 451,485-505 | Alto: autocorrelazione rilevabile |
| 1.9 | PIN: page_view per ogni ricerca (la Web App reale ne emette una per navigazione), due page_view nello stesso tick, throttle 500ms che **scarta** eventi durante i probe, richiesta che parte anche se il PIN fallisce/tabella chiusa | pin-bridge.js:178,185-188; fc26.js:383-423 (timeout 500ms risolve sempre), 397-400 | Alto: sequenza telemetrica impossibile / richieste > eventi |
| 1.10 | Price-discovery a gradini perfettamente regolari (micr=150+stepIdx·50, max 7 ricerche consecutive a scalini EA sullo stesso playStyle entro ~10s) | fc26.js:3248-3490, 3402, 3461-3470 | Medio: firma algoritmica della discovery |
| 1.11 | Alternanza micr assente/150 deterministica (ABAB), minBidBumps [150,200,250] ciclici, tier pricing A/B/B/C a markup fisso | fc26.js:1629-1633,1898-1902,3773-3777; 3063,3547; 2328,2356-2357 | Medio |
| 1.12 | Pacing sniping ~1 req/s sostenuto per ore (~55-60 ricerche/min, media 0.9s, clamp 0.7-1.25s) | fc26.js:640,1991,3856 | Medio-Alto: profilo datacenter |
| 1.13 | Gestione 401 non centralizzata: log reale mostra **due ABORT_401 simultanei da due contesti** (Crediti + Get Tradepile); `isRecovering401` fa proseguire i loop con token vecchio | fc26.js:183-190,186-265; runtime-telemetry.log 13:32 | Alto: race su sessione |
| 1.14 | Sleep fissi (3000ms esatti tra operazioni), keep-alive EA ogni 8 min esatti | fc26.js:1872,3039; pin-bridge.js:235 | Medio |
| 1.15 | Sniper window 30s + fino a 5 controrilanci consecutivi all-in | fc26.js:3100,3583, 2942 | Medio: pattern da sniper-bot noto |
| 1.16 | Stato critico volatile: al recycle del SW MV3 si perdono `attemptedTradeIds`, `consumableBinCache`, contatori errori, `listingRestrictedUntil`, `start` → burst di ricerche e retry di carte fantasma al riavvio | fc26.js:27-131 | Medio-Alto |
| 1.17 | Token X-UT-SID riusato a freddo dopo ore/giorni → serie di 401 → refresh forzati | fc26.js:34-39 | Medio |

**Nota onesta:** nessuna modifica garantisce immunità al soft-ban. Ma la combinazione 1.1+1.2 (Origin estensione su ogni scrittura), 1.5 (traffico durante il ban), 1.6 (captcha ignorato) e 1.7-1.9 (metronomi + telemetria incoerente) è quasi certamente ciò che mantiene alta la rilevazione nonostante i cooldown già presenti.

---

## 2. FASE 0 — Bug bloccanti (da correggere per primi, sono regressioni attive)

| # | Bug | Dove | Effetto |
|---|-----|------|---------|
| 0.1 | `boughtInTopUpPerStyle[...] = ...` mai dichiarato (unica occorrenza) | fc26.js:4495 | **ReferenceError** al primo acquisto Compra Ora del top-up consumabili: catch → break → compra max 1 carta/ciclo, carta non listata subito, log di errore fasullo |
| 0.2 | `topUpRatingIdx = (topUpRatingIdx + 1) % targetRatings.length` — entrambi mai dichiarati | fc26.js:5466 | **ReferenceError** dopo 3×461 consecutivi nel top-up fodder: il "cambio rating" non avviene mai, catch → break |
| 0.3 | Reset errato: `consecutive512Errors` azzerato su 429/426/521 | fc26.js:1764 | La soglia "5×512 → pausa" è eludibile da un 429 intermedio |
| 0.4 | `crediti` globale implicita (mai dichiarata); `sellUrl` e `id` globali implicite in `sellFodder` | fc26.js:459/576; 2117,2123 | Fragilità: esplode se il SW passa a modulo/st strict mode |
| 0.5 | `sendToTransferList` body accumulativo fuori dal for (invia N richieste con 1,2,..N item); non verifica `response.ok` prima di proseguire alla vendita | fc26.js:1824-1848, 1839-1844 | Spreco + vendita che fallirà con 461 "invisibile" |
| 0.6 | Loop "aste urgenti" `while` senza limite di iterazioni: se `resolveWatchlist` fallisce di rete (catch → 0) senza rimuovere l'asta, loop infinito a periodo 2-4s | fc26.js:3018-3023, 3186-3189, 3669, 4377-4391, 5290 | Burst infinito verso EA |
| 0.7 | Nessun guard anti doppio-START: due engine concorrenti, doppi bid sulla stessa asta | fc26.js:531 (START), mancanza di lock | Race + ban risk |
| 0.8 | `getRandomInRange(120,180)` restituisce 120-181 (off-by-one float) | fc26.js:847-849 | Minore |
| 0.9 | `fodderSid`: variabile morta + ramo futwiz **irraggiungibile** (filtro webRequest esclude futwiz.com) | fc26.js:30,345-351 | Dead code |
| 0.10 | `numTentativi` default 0 se storage vuoto → sniping/bidding fanno 0 iterazioni silenziose | fc26.js:681 | UX rotta |
| 0.11 | Heartbeat lazy asimmetrico: consumabili usa `resolveWatchlist` (con controrilanci), fodder usa `checkAndProcessWatchlistForLazy` (senza) | fc26.js:4763 vs 5635 | Comportamento non intenzionale |
| 0.12 | Commento porta `:3005` vs codice `:3000`; `/fut/fodder` chiamato su localhost:3000 ma `telemetry-server.js` implementa solo `/event` e `/status` | fc26.js:77-80, 2028, 2557 | 404 garantito o conflitto di porta |

---

## 3. FASE 1 — Anti soft-ban (il cuore del refactor)

### 3.1 Allineare e riscrivere rules.json — normalizzazione header REALE
**È il singolo fix a più alto impatto.**

- [ ] Puntare le regole DNR agli URL effettivi: `utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/*` (o meglio regola unica con regex sull'host + copertura di **tutti** gli endpoint usati: transfermarket, watchlist, tradepile, purchased/items, item, auctionhouse, trade/*).
- [ ] **Rimuovere `Origin: chrome-extension://...`** sulle richieste verso UTAS e settare `Origin: https://www.ea.com` + `Referer: https://www.ea.com/`. È la firma primaria (ogni sell/bid/move/delete oggi si autodenuncia).
- [ ] **NON rimuovere `Cookie`**: le XHR genuine della pagina li portano; toglierli rende il bot *più* distinguibile. Rimuovere le regole di rimozione cookie.
- [ ] Un solo fingerprint UA coerente, aggiornato alla versione di Chrome reale dell'utente (leggerla a runtime con `navigator.userAgentData` nel bridge e sincronizzarla, oppure mantenerla allineata manualmente ad ogni major). Eliminare il drift 141/142 e il brand `Not?A_Brand;v=8` obsoleto.
- [ ] Header duplicati: una sola occorrenza per `Sec-Fetch-*` (DNR è case-insensitive ma la doppia regola è confusione).
- [ ] Rimuovere dagli handler JS gli header proibiti/inutili che fetch scarta silenziosamente (`sec-ch-ua`, `sec-fetch-*`, `Accept-Encoding` manuali: fc26.js:1815-1820, 2207, 3085) — falsa sicurezza, li gestisce DNR.
- [ ] **Verifica post-fix obbligatoria:** loggare una request di test su un echo endpoint o ispezionare in `chrome://net-export` che `Origin` sia davvero soppresso prima di riattivare le strategie.
- [ ] Valutare in alternativa/complemento: eseguire le fetch di scrittura **dal content script nel contesto della pagina ea.com** (stesso origine della Web App → Origin/Referer naturali). È la soluzione più robusta ma richiede di instradare le write attraverso `pin-bridge.js` (già presente come ponte). Raccomandata come evoluzione se i soft-ban persistono dopo il fix DNR.

### 3.2 Politica di silenzio reale durante ban e pause
- [ ] Riscrivere `executeSafetyPause`: durante il cooldown **zero richieste UTAS** (niente watchlist/tradepile/clearSold/relist ogni 120s — fc26.js:485-505). Manutenzione differita alla prima finestra utile dopo la scadenza.
- [ ] Stessa regola nel cooldown lazy: eliminare `getCrediti`/keep-alive verso EA durante il sonno (fc26.js:4738, 5614). Il keep-alive di sessione, se serve, deve usare **solo** i meccanismi interni della pagina già aperti (e con jitter, vedi 3.4).
- [ ] Unificare le due politiche contraddittorie (pausa rumorosa vs cooldown silenzioso) in un'unica `CooldownManager` condivisa.

### 3.3 Gestione centralizzata degli status code EA
Oggi gli handler 401/426/429/458/461/470/478/512/521 sono duplicati in ~12 punti con comportamenti divergenti e array letterali ripetuti (es. `[429,426,512,521]` in 16 posizioni).

- [ ] Creare un modulo `ea-status-policy.js`: tabella unica `status → {azione, sogliaConsecutivi, cooldown, backoff}`.
- [ ] **458 (FunCaptcha) gestito ovunque**, senza eccezioni: discovery (fc26.js:3300), loop lazy Step1/Step2 (fc26.js:4330+), `sellSingleItem`. Azione: stop immediato strategia + persistenza stato + notifica UI (richiede intervento umano). Oggi su captcha i lazy-loop proseguono: è la via più rapida al ban lungo.
- [ ] 478 gestito in tutti i path di acquisto, non solo nei top-up.
- [ ] Soglie riviste per essere meno tolleranti: meglio un cooldown prudente in più che un ban in più. Rendere i contatori persistenti (vedi 4.4) così un recycle del SW non azzera la "memoria" del ban.
- [ ] CAPTCHA/abort: persistere `start=false` e notificare la UI (oggi solo log → UI desincronizzata, fc26.js:1686 ecc.).

### 3.4 Rate limiter globale con jitter (eliminare i metronomi)
- [ ] Nuovo modulo `rate-limiter.js` unico per **tutte** le chiamate UTAS (ricerche, bid, sell, move, delete):
  - Budget globale cross-endpoint (oggi sell e bid hanno throttle separati → burst incrociati a <100ms).
  - Inter-arrival = base + jitter esponenziale/gaussiano **senza clamp ai bordi netti** (il clamp a 0.7/1.25s crea pile-up sugli estremi: usare clamp morbido o troncamento rigenerativo).
  - Bid: min 1600ms → media ~2.5-4s con coda lunga, mai periodicità esatta. Sniping: media 0.9s → alzare a 1.5-3s con varianza ampia; volume orario totale limitato (budget richieste/ora) oltre al solo pacing.
  - Micro-pause e cooldown: non più "ogni 25"/"ogni 50" esatti, ma soglia randomizzata (es. ogni 18-32 tentativi, durata random) e **senza traffico** durante la pausa.
- [ ] Tutti gli `sleep(N)` a costante (3000, 120000, 15000...) passano da `sleepJitter(base, spread)`.
- [ ] Keep-alive pagina EA (requestCurrencies/refreshToken ogni 8 min esatti, pin-bridge.js:235): jitter ±30% e solo se c'è stata attività recente, altrimenti silenzio.
- [ ] Eliminare il mousemove sintetico (isTrusted=false, coordinate in range fisso 100-500): inutile e rilevabile.

### 3.5 Telemetria PIN: coerenza prima della quantità
Oggi gli eventi PIN iniettati producono una sequenza *meno* credibile dell'assenza di telemetria.

- [ ] **Un page_view per cambio vista logico, non per ricerca**: emettere "Transfer Market Results" solo alla prima ricerca di una sessione di mercato e a intervalli umani (es. ogni 30-90s di attività), mai ad ogni ciclo (oggi fc26.js:1620,1914,3081,3312,3346,3404,3564,3780,4158,4452,5062,5378).
- [ ] Mai due page_view nello stesso tick (pin-bridge.js:186-188): Hub→Results con delay jittered 300-900ms.
- [ ] Il throttle 500ms deve **accodare**, non scartare: richieste HTTP senza telemetria associata (probe rapidi) sono l'incoerenza peggiore (pin-bridge.js:178).
- [ ] **Gating**: la richiesta di mercato parte solo se il bridge PIN è attivo e ha confermato l'invio (oggi `triggerPinEvent` risolve sempre dopo 500ms anche senza tab, fc26.js:397-400 → traffico muto). Se la Web App è chiusa: sospendere la strategia, non inviare richieste "cieche".
- [ ] Aggiungere gli eventi intermedi mancanti (apertura detail, modale conferma) prima di BUY/BID, con latenze umane (300ms-2s), altrimenti non inviarli affatto.
- [ ] SELL mappato sulla vista corretta (Transfer List), non "Item - Detail View".
- [ ] Ridurre la verbosità dei log del bridge e non dumpare i pinEvents EA completi in console (fc26.js:365).

### 3.6 Umanizzazione dei pattern di mercato
- [ ] Discovery BIN: eliminare la sequenza a gradini esatti (micr=150+stepIdx·50). Probe count random (3-6), step di prezzo con jitter attorno ai gradini EA (±1 gradino), pause irregolari 2-8s tra probe, ordine stili randomizzato. Cache più lunga (15min → 30-45min) e persistente.
- [ ] Alternanza micr ABAB → scelta random con probabilità (es. 40%), minBidBumps shuffled non ciclici.
- [ ] Tier pricing: markup non a sequenza A/B/B/C fissa ma campionato da distribuzione, con leggera variazione nel tempo.
- [ ] Sniper window 30s → finestra randomizzata 20-45s; controrilanci all-in da 5 consecutivi → max 1-2 con abbandono probabilistico.
- [ ] `attemptedTradeIds` persistente (TTL 5min → legato a expires dell'asta) per non ritentare carte fantasma dopo recycle SW.

### 3.7 Gestione 401 centralizzata
- [ ] Un solo `SessionManager`: richieste concorrenti che ricevono 401 si **mettono in coda** sullo stesso refresh in corso (promise condivisa), invece del flag `isRecovering401` che fa proseguire i loop con token vecchio (fc26.js:183-190). Il log reale mostra doppio ABORT_401 simultaneo da due contesti: va eradicato.
- [ ] Reload tab limitato alla sola Web App (non tutte le tab ea.com), con jitter nel polling di attesa.
- [ ] Non riusare a freddo un token vecchio di ore senza prima validarlo con una call leggera.

---

## 4. FASE 2 — Efficienza e architettura

### 4.1 Modularizzazione del monolite (fc26.js → `src/background/`)
Struttura target:

```
src/background/
  index.js              entry SW: registra listener, routing messaggi (UN listener onMessage)
  core/
    ea-client.js        fetch wrapper unico verso UTAS (header comuni, retry, status-policy hook)
    ea-status-policy.js tabella centralizzata codici EA (3.3)
    rate-limiter.js     budget globale jittered (3.4)
    session.js          token + refresh 401 centralizzato (3.7)
    state.js            stato persistito con migrazione (4.4)
    cooldown.js         unica policy ban/pausa silenziosa (3.2)
    pin.js              coda telemetria coerente + gating (3.5)
    keepalive.js        UN meccanismo keep-alive (4.5)
    telemetry.js        reporter locale (porta unificata, opzionale)
    utils.js            sleep, gauss, roundStep, ecc.
  engines/
    sniping.js          manuale + fodder + consumabili (parametrizzato)
    mass-bidding.js     UN engine per fodder/consumabili (config)
    lazy-trading.js     UN engine lazy (strategy object fodder/consumabili)
  services/
    watchlist.js        UN processore watchlist (fonde i 3 attuali)
    tradepile.js        clearSold, relist, unassigned, listUnlisted (con cache)
    pricing.js          resolveSellPriceForItem + discovery BIN
    sales.js            UN path di vendita (fonde sellFodder/sellSingleItem)
```

### 4.2 Wrapper `eaRequest` unico
- [ ] Costruzione header EA oggi duplicata ~15 volte con capitalizzazione incoerente → un solo builder.
- [ ] Un solo punto di ingresso per fetch UTAS: applica rate-limiter, status-policy, session manager, retry/backoff, contatori persistenti.
- [ ] Sostituire `getCrediti` (GET /watchlist intera per leggere 1 campo, fc26.js:927) con una call/campo più leggero e cachare i crediti con TTL breve.
- [ ] **Non** inviare `Content-Type` sulle GET (innaturale).

### 4.3 Fusione degli engine duplicati (~2.000 righe recuperate)
- [ ] `sendFodderBiddingRequest` + `sendConsumableBiddingRequest` (~210 righe quasi identiche) → `runMassBiddingEngine(cfg)`: differiscono solo per sorgente target, URL params, calcolo maxBid, bidData.
- [ ] `sendConsumableLazyRequest` (946r) + `sendFodderLazyRequest` (867r, ~85% identiche) → `LazyTradingEngine` + 2 strategy object (prezzi/rotazione).
- [ ] 3 processori watchlist sovrapposti (`resolveWatchlist`, `checkAndProcessWatchlistForLazy`, `reconcileWatchlistOnStartup`) → 1 servizio con opzioni (con/senza controrilanci); elimina il bug di asimmetria 0.11.
- [ ] Blocco pricing per-item duplicato 6+ volte → `resolveSellPriceForItem(item, ctx)`.
- [ ] `sellFodder` (legacy, senza breaker 426) + `sellSingleItem` → un solo path di vendita con tutte le protezioni.
- [ ] Heartbeat-loop duplicato 3 volte → 1 implementazione (silenziosa, vedi 3.2).

### 4.4 Storage: dedup, batching, persistenza stato critico
- [ ] Scrivere `xUtSid` **solo se cambiato** (oggi: write ad ogni richiesta UTAS intercettata, fc26.js:328-338, e ad ogni TOKEN_SYNC, che pin-bridge emette per ogni XHR di EA → decine di write/min: rischio quota `MAX_WRITE_OPERATIONS_PER_MINUTE`).
- [ ] Batching reale di `pendingBids` (esiste `storePendingBidsBatch` ma quasi inutilizzata: fc26.js:796-804); RMW per singolo bid → accumulo + flush ogni N bid/M ms.
- [ ] Persistere al recycle SW: `start`, contatori errori consecutivi, `listingRestrictedUntil`, `attemptedTradeIds` (serializzato), `consumableBinCache`, `searchUrl/searchHeaders`. Al boot: `reconcile` coerente. Elimina i burst di riscoperta e i retry su carte fantasma.
- [ ] Avvio: una sola lettura config (`chrome.storage.local.get(null)` o chiavi raggruppate) invece di 13+ get individuali.

### 4.5 Keep-alive: da 4 meccanismi a 1 (+1 condizionato)
Oggi: porta KEEP_ALIVE_PORT da content.js (ping 20s) **+ copia identica in ui.js** **+** offscreen audio muto permanente **+** storage touch ogni 15s. E **nessun `chrome.runtime.onConnect` esiste in fc26.js**: i ping cadono nel vuoto (è la porta aperta a tenere vivo il SW, i setInterval sono lavoro inutile).

- [ ] Un meccanismo primario: porta long-lived dal content script + `onConnect` gestito nel SW.
- [ ] Rimuovere la copia in ui.js (714-742), lo storage-touch ogni 15s (fc26.js:470-473) e il doppio riconnect/ping in content.js.
- [ ] Offscreen document: crearlo **solo a bot attivo**, distruggerlo allo stop; motivazione AUDIO_PLAYBACK senza audio viola le policy Chrome Web Store. Valutare `chrome.alarms` (permesso già dichiarato, mai usato: il README lo cita ma il codice no) come fallback nativo.

### 4.6 Eliminare fetch ridondanti
- [ ] Tradepile letta 3 volte per ciclo Fase1 lazy (fc26.js:966→3970/4944→4629/5530): cache per-ciclo del dato.
- [ ] `getFodderPriceForItem`: fetch localhost sequenziali per item non in cache → prefetch batch a inizio ciclo.
- [ ] `listaFodder` ri-mappata ad ogni giro: cache con invalidazione.
- [ ] Cleanup indici: chiavi `activeBids` sempre String — eliminare i `delete(Number)` morti; inserimenti diretti in `attemptedTradeIds` (fc26.js:4489,5413) passare da `markTradeAttempted`.

### 4.7 Robustezza messaggistica e ciclo di vita
- [ ] Un solo `chrome.runtime.onMessage` con dispatch (oggi 2 listener async, fc26.js:516 e 2083: ogni messaggio li attraversa entrambi, ordinamento non garantito; FODDER_MODE può cambiare config a metà engine).
- [ ] Lock anti doppio-start (0.7) + stato bot persistito: la UI deve riflettere lo stato reale dopo recycle del SW.
- [ ] UI → SW: un solo messaggio START con l'intera config (oggi START + FODDER_MODE con payload quasi identico).
- [ ] Valutare `"type": "module"` nel manifest dopo la modularizzazione (risolve anche le globali implicite 0.4).

### 4.8 UI/dashboard (efficienza minore ma concreta)
- [ ] `ui.js`: 1 listener onMessage con dispatch (oggi 3), 1 storage.set aggregato con debounce (oggi 12+1 scritture separate ai change), rimuovere il doppio getElementById di `#tentativi`.
- [ ] Log: eliminare la textarea nascosta illimitata + `allLogRecords` non bounded (cresce per ore), scroll forzato solo se l'utente è in fondo.
- [ ] Rimuovere `bootstrap.bundle.min.js` (80KB usati solo per un Collapse → ~15 righe di JS) e self-hostare il CSS (oggi da CDN: offline = UI rotta).
- [ ] Fix CSS invalido `style: 0.72rem;` (index.html:334), allineare naming/versioning FC26/FC27 (titolo, manifest, file).

---

## 5. FASE 3 — Sicurezza generale e igiene

- [ ] **postMessage**: verificare `event.origin`/`event.source` in content.js:25-40 (oggi chiunque nella pagina — incluso codice EA — può avvelenare il token o spoofare comandi TRIGGER_PIN_*); handshake con segreto condiviso tra content.js e pin-bridge, mai `targetOrigin: "*"`.
- [ ] **host_permissions** `"<all_urls>"` → solo `*.ea.com`, `*.futc-ext.gcp.ea.com`, `*.data.ea.com`, futwiz (se serve), `127.0.0.1`. Content script solo sulla web-app, non su tutto `www.ea.com/*` (il patch XHR/fetch oggi gira anche su store/news EA: superficie di rilevamento inutile).
- [ ] Token X-UT-SID in chiaro in storage + prefisso loggato in console: smettere di loggarlo (fc26.js:37,334,519; content.js:34); documentare il rischio; valutare conservazione solo in memoria + re-sync dalla pagina.
- [ ] Monkey-patch XHR/fetch rilevabile via `Function.prototype.toString` (non "[native code]"): minimizzare la superficie (intercettare una sola via, ripristinare toString) o catturare il token via `webRequest` (già disponibile) riducendo il patch al minimo indispensabile.
- [ ] `telemetry-server.js`: CORS "*" → 127.0.0.1 + Origin check; rotazione log (già 333KB); porta unificata in una costante condivisa; implementare o rimuovere `/fut/fodder`; dichiarare all'utente che la telemetria include crediti/conteggi ban.
- [ ] Eliminare `_metadata/generated_indexed_rulesets` dal pacchetto/git (artefatto Chrome).
- [ ] Rinominare `getFdderList` → `getFodderList` (refuso coerente ma da sistemare durante la modularizzazione).
- [ ] Rimuovere il wrapper globale che monkey-patcha `chrome.runtime.sendMessage` (fc26.js:4-25): maschera errori reali; gestire gli errori nei singoli punti di invio.

---

## 6. Ordine dei lavori consigliato

| Step | Contenuto | Perché in questa posizione |
|------|-----------|---------------------------|
| **S1** | Fase 0: bug 0.1-0.12 (ReferenceError top-up, loops infiniti, guard doppio-start) | Regressioni attive; fix isolati e rapidi, nessuna dipendenza |
| **S2** | Fase 1.1: riscrittura rules.json su fc27 + rimozione Origin + niente cookie-strip + verifica net-export | **Fix anti-ban a più alto impatto in assoluto**; è un file di 100 righe, non richiede refactor del motore |
| **S3** | Fase 1.2+1.6+1.7: silenzio nelle pause, 458 ovunque (anche senza tabella centralizzata: fix puntuali), jitter minimo sui metronomi peggiori (bid throttle, heartbeat) | Stop immediato ai comportamenti auto-denuncianti, prima di toccare l'architettura |
| **S4** | Fase 1.5: telemetria PIN coerente (gating, coda, page_view semantici) | Completa il profilo "umano" verso EA |
| **S5** | Fase 2: modularizzazione + `eaRequest` + fusione engine + status-policy centralizzata + persistenza stato | Il grosso del lavoro: fatto DOPO le patch critiche, così i motori fusi ereditano subito le policy corrette (altrimenti si rifattorizza gestione errori duplicata 12 volte) |
| **S6** | Fase 1.6: umanizzazione pattern (discovery, pricing, sniper window) sul motore già modulare | Più semplice su engine unici |
| **S7** | Fase 3: igiene (postMessage, permissions, telemetry server, asset) | Indipendente |
| **S8** | Validazione su telemetry: confronto incidenza soft-ban per 1-2 settimane | Misura del successo |

**Dipendenza chiave:** non fondere gli engine (S5) prima delle patch anti-ban (S2-S4), altrimenti il lavoro di gestione errori va rifatto sui moduli duplicati.

---

## 7. Metriche di validazione

Baseline dal log attuale: cooldown `COOLDOWN_START` in escalazione 63→95→126 min con `BID_SOFT_BAN` ricorrenti (461 sistematici, 4 consecutivi) e doppi `ABORT_401` simultanei.

Dopo S2-S4, attendersi:
1. Zero richieste con `Origin: chrome-extension://` verso UTAS (verifica net-export).
2. Zero traffico UTAS durante finestre di cooldown nel log.
3. Stop immediato e stato persistito al primo 458.
4. Istogramma degli inter-arrival senza spike ai bound (niente pile-up a 700/1250ms, niente multipli esatti).
5. Al massimo 1 `ABORT_401` per episodio (mai doppi contestuali).
6. Riduzione della frequenza dei `*_SOFT_BAN` e dei cooldown ricorrenti su campagna di 1-2 settimane a parità di volumi.
7. Top-up lazy che completano le quote (oggi bloccati dai bug 0.1/0.2).

---

## 8. Rischi residui e note

- Il ritmo operativo complessivo (decine di migliaia di richieste/mercato al giorno) resta il fattore di rischio strutturale: le contromisure riducono la rilevabilità *statistica e telemetrica*, non la rendono nulla. Valutare budget giornalieri globali.
- Se dopo S2-S6 i soft-ban persistono, il passo successivo è instradare **tutte** le write attraverso la pagina (fetch dal MAIN world via pin-bridge con CSRF/header nativi della Web App) anziché dal Service Worker: è l'unica via per avere Origin/Referer genuini al 100%.
- La telemetria PIN iniettata, anche se resa coerente, resta una simulazione: lo `stepCounter` del flusso reale dell'app non sarà mai perfettamente allineato. Mantenerla minimale è più sicuro che mantenerla ricca.
