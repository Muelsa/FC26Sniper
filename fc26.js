
// Wrapper di sicurezza per silenziare "Could not establish connection. Receiving end does not exist"
// quando vengono inviati messaggi o log di broadcast e la dashboard/scheda ricevente è momentaneamente chiusa
if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
  const _origSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = function (message, callback) {
    try {
      if (typeof callback === "function") {
        return _origSendMessage(message, (...args) => {
          const _ = chrome.runtime.lastError;
          callback(...args);
        });
      }
      const res = _origSendMessage(message, () => {
        const _ = chrome.runtime.lastError;
      });
      if (res && typeof res.catch === "function") {
        res.catch(() => { });
      }
      return res;
    } catch (e) {
      // Ignora se nessun ricevitore è presente
    }
  };
}

let xUtSid = "";
let searchUrl = "";
let searchHeaders = {};
let fodderSid = "";
let manualSearchAttempt = 0;

// Ripristino del token x-ut-sid all'avvio del Service Worker
chrome.storage.local.get(['xUtSid'], (result) => {
  if (result.xUtSid) {
    xUtSid = result.xUtSid;
    console.log("[FC Sniper] x-ut-sid ripristinato dallo storage all'avvio:", xUtSid.substring(0, 10) + "...");
  }
});

//variabili per sniping
let numeroTentativi;
let start = false;
let carteAcquistate = 0;
let carteVinteCiclo = 0;
let listaFodder = []
let ricercaFodder = false;
let targetMode = "fodder"; // "fodder" | "consumables" | "manual"
let chemStyle = "all"; // Modified to "all" to accommodate multi-style portfolio

let autoBin = true;
let manualBin = 0;
let fodderRating = "84";
let indexFodder = 0;
let idCarteAcquistate = [];
let strategyMode = "sniping"; // "sniping" | "bidding" | "lazy"
let minMargin = 200;
let maxSnipePrice = 0;
let targetTradepileSize = 50;
let lazyMarkupPercent = 10;
let lazySleepMinutes = 63;
let activeBids = new Map(); // tradeId -> { pid, sellPrice, bidAmount, expiresAt }
let consecutiveBidErrors = 0;
let consecutive470Errors = 0;
let consecutiveSnipeErrors = 0;
let consecutive512Errors = 0;
let consecutiveSearchErrors = 0;
let consecutive401Errors = 0;
let consecutive461InBidding = 0;
let lastBidTimestamp = 0;
let lastBidErrorStatus = 0;
let lastBuyNowErrorStatus = 0;
let lastListingTimestamp = 0;
let marketRestricted = false;
let listingRestrictedUntil = 0; // Timestamp ms fino a cui il listing (POST /auctionhouse) è in pausa preventiva (426)

// Telemetria in tempo reale verso server locale (http://127.0.0.1:3005/event)
function reportTelemetry(type, message, data = null) {
  try {
    fetch("http://127.0.0.1:3000/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, message, data, timestamp: Date.now() })
    }).catch(() => { });
  } catch (_) { }
}

// Mappa per tenere traccia delle carte/aste già tentate (evita di ricomprare carte fantasma già perse o fallite)
const attemptedTradeIds = new Map(); // tradeId (string) -> timestamp (ms)

function isTradeAttempted(tradeId) {
  if (!tradeId) return false;
  const idStr = String(tradeId);
  const now = Date.now();
  if (attemptedTradeIds.has(idStr)) {
    const attemptedAt = attemptedTradeIds.get(idStr);
    // Scade dopo 5 minuti (durata ottimale per il refresh della cache del server EA)
    if (now - attemptedAt < 5 * 60 * 1000) {
      return true;
    } else {
      attemptedTradeIds.delete(idStr);
    }
  }
  return false;
}

function markTradeAttempted(tradeId) {
  if (!tradeId) return;
  attemptedTradeIds.set(String(tradeId), Date.now());
  // Pulizia automatica della mappa per record più vecchi di 5 minuti
  if (attemptedTradeIds.size > 200) {
    const now = Date.now();
    for (const [id, ts] of attemptedTradeIds.entries()) {
      if (now - ts > 5 * 60 * 1000) {
        attemptedTradeIds.delete(id);
      }
    }
  }
}

// Metadati ufficiali Stili Intesa EA (PlayStyle)
const CHEM_STYLES = {
  "268": { id: 268, name: "Ombra (Shadow)", defaultGuess: 4200 },
  "266": { id: 266, name: "Cacciatore (Hunter)", defaultGuess: 3800 },
  "265": { id: 265, name: "Ancora (Anchor)", defaultGuess: 1300 },
  "260": { id: 260, name: "Motore (Engine)", defaultGuess: 800 },
  "267": { id: 267, name: "Catalizzatore (Catalyst)", defaultGuess: 800 },
  "255": { id: 255, name: "Falco (Hawk)", defaultGuess: 700 }
};

const consumableBinCache = new Map(); // playStyleId -> { price, timestamp }

// Rileva in modo affidabile lo stile intesa da qualsiasi oggetto carta (item o auction)
function detectChemistryStyle(itemOrAuction, fallbackStyle = null) {
  if (!itemOrAuction) return fallbackStyle || (chemStyle && chemStyle !== "all" ? chemStyle : "266");
  const data = itemOrAuction.itemData || itemOrAuction;

  // 1. Controlla tutti i campi possibili in cui l'API UTAS di EA memorizza lo stile intesa
  const candidateIds = [
    data.cardsubtypeid,
    data.cardSubtypeId,
    data.playStyle,
    data.playstyle,
    data.playStyleId,
    data.resourceId,
    data.assetId,
    itemOrAuction.cardsubtypeid,
    itemOrAuction.cardSubtypeId,
    itemOrAuction.playStyle,
    itemOrAuction.playstyle
  ];

  for (const c of candidateIds) {
    if (c !== undefined && c !== null) {
      const s = String(c);
      if (CHEM_STYLES[s]) {
        return s;
      }
    }
  }

  // 2. Controlla activeBids usando il tradeId o id oggetto
  const idKey = String(itemOrAuction.tradeId || data.id || "");
  if (idKey && activeBids.has(idKey)) {
    const tracked = activeBids.get(idKey);
    if (tracked?.playStyleId && CHEM_STYLES[String(tracked.playStyleId)]) {
      return String(tracked.playStyleId);
    }
  }

  // 3. Fallback: se l'utente ha configurato uno stile specifico (es. Cacciatore "266"), usa sempre quello!
  if (fallbackStyle && CHEM_STYLES[String(fallbackStyle)]) {
    return String(fallbackStyle);
  }
  if (chemStyle && chemStyle !== "all" && CHEM_STYLES[String(chemStyle)]) {
    return String(chemStyle);
  }

  return "266";
}


let isRecovering401 = false;

// Gestione centralizzata errore 401 (Sessione scaduta / Unauthorized - con tentativo di recupero token)
async function handle401Error(context = "") {
  if (isRecovering401) return false;

  const currentToken = xUtSid;
  isRecovering401 = true;
  const ctxStr = context ? ` (${context})` : "";
  console.warn(`[FC Sniper 401] Ricevuto errore 401 in ${ctxStr}. Tentativo di recupero token fresco dalla Web App...`);
  chrome.runtime.sendMessage({
    tipo: 'LOG',
    valore: `[AVVISO 401${ctxStr}] Rilevato token non valido o scaduto. Richiedo sincronizzazione token fresco alla Web App...`
  });

  // Chiede alla Web App aperta di estrarre e inviare il token aggiornato
  await triggerPinEvent("REQUEST_TOKEN_REFRESH");
  await sleep(2500);

  // Se è arrivato un nuovo token valido diverso da quello che ha fallito:
  if (xUtSid && xUtSid !== currentToken) {
    isRecovering401 = false;
    consecutive401Errors = 0;
    console.log("[FC Sniper 401] Nuovo token EA catturato con successo! Sessione ripristinata.");
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[RECUPERO 401 RIUSCITO] Nuovo token EA sincronizzato (${xUtSid.substring(0, 10)}...). Operazioni ripristinate senza interruzione!`
    });
    return true;
  }

  // Se il token è ancora lo stesso o la sessione EA è definitivamente chiusa:
  isRecovering401 = false;
  start = false;
  consecutive401Errors = 0;

  try {
    await chrome.storage.local.set({ start: false });
  } catch (_) { }

  chrome.runtime.sendMessage({ tipo: 'START', valore: false });

  console.error(`[FC Sniper ABORT 401] Errore 401 Unauthorized confermato${ctxStr}. Arresto del bot.`);
  reportTelemetry('ABORT_401', `Errore 401 Unauthorized${ctxStr}. Arresto immediato.`, { context });

  chrome.runtime.sendMessage({
    tipo: 'LOG',
    valore: `[ABORT IMMEDIATO - ERRORE 401] Ricevuto errore 401 Unauthorized${ctxStr}. Sessione Web App scaduta o non valida: bot arrestato. Ricarica la Web App (F5) per rinnovare la sessione.`
  });
  return false;
}

// Gestione centralizzata Rate Limit Ricerche (429 Too Many Requests, 426 Upgrade Required, 521, 512)
async function handleSearchRateLimit(status, context = "Ricerca") {
  consecutiveSearchErrors++;
  console.warn(`[FC Sniper ${context}] Rate limit EA (${status}). Errori consecutivi: ${consecutiveSearchErrors}/3`);

  if (strategyMode === "lazy") {
    // In modalità Lazy, deleghiamo la gestione al ciclo principale per consentire il passaggio fluido a vendita e relist
    return;
  }

  // Implementazione migliorata con circuit breaker e backoff esponenziale
  if (consecutiveSearchErrors >= 3) {
    console.warn(`[FC Sniper] Rilevati ${consecutiveSearchErrors} errori consecutivi di Rate Limit (${status}) in ${context}. Avvio pausa di sicurezza attiva 10 min...`);
    consecutiveSearchErrors = 0;
    await executeSafetyPause(600, `Soft-Ban Ricerche EA (${status}) in ${context}`);
  } else {
    // Implementazione migliore con backoff esponenziale basato su errori consecutivi
    const baseDelay = 25 + (consecutiveSearchErrors * 5); // Delay crescente per ogni errore successivo
    const jitter = getRandomGaussian(0.8, 0.15, 0.6, 1.0);
    
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[RATE LIMIT EA ${status}] Rilevato in ${context} (${consecutiveSearchErrors}/3). Raffreddamento preventivo di ${Math.round(baseDelay * jitter)}s per proteggere l'account...`
    });
    await sleep(Math.max(2000, baseDelay * 1000 * jitter));
  }
}


const watchListUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/watchlist"
const deleteSoldUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/trade/sold"

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: "index.html" }); // Apre la GUI in una nuova scheda
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      if (details.method === "GET" || details.method === "POST") {
        if (start == false) {
          chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Filtro di ricerca acquisito' });
        }
        if (details.url.includes("transfermarket?")) {
          searchUrl = details.url;
        }
      }
    } catch (err) {
      console.error('[FC26 listener error]', err);
    }
  },
  {
    urls: [
      "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket*",
    ]
  },
  ["requestBody"]
);



chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.requestHeaders) {
      details.requestHeaders.forEach(header => {
        if (header.name.toLowerCase() === "x-ut-sid" && header.value) {
          if (xUtSid !== header.value) {
            console.log("[FC Sniper] x-ut-sid aggiornato / sincronizzato:", header.value.substring(0, 10) + "...");
          }
          xUtSid = header.value;
          chrome.storage.local.set({ xUtSid: header.value });
        }
      });
    }

    if (details.url.includes("transfermarket?") && start == false) {
      searchHeaders = details.requestHeaders;
    }
    if (details.url.includes("https://www.futwiz.com/fc27/players") && start == false) {
      details.requestHeaders.forEach(header => {
        if (header.name.toLowerCase().includes("next-action")) {
          fodderSid = header.value;
        }
      });
    }
  },
  { urls: ["https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/*"] },
  ["requestHeaders"]
);

// Listener diagnostico per osservare la telemetria reale inviata dalla Web App di EA
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      if (details.url.includes("pinEvents") && details.requestBody?.raw) {
        const decoder = new TextDecoder("utf-8");
        const postedString = decoder.decode(details.requestBody.raw[0].bytes);
        const pinData = JSON.parse(postedString);
        console.log("[EA PIN Telemetry Intercettata]", pinData);
        const evCount = pinData.events?.length || 1;
        const types = (pinData.events || []).map(e => e.type || e.pgid || e.core?.en).filter(Boolean).slice(0, 3).join(", ");
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[PIN TELEMETRY] Inviati a EA ${evCount} eventi (${types || 'telemetria'}) | stepCounter: ${pinData.stepCounter || pinData.custom?.step || 'OK'}`
        });
      }
    } catch (err) {
      // Ignora errori di parsing su payload parziali
    }
  },
  { urls: ["*://*.data.ea.com/*", "*://pin-river.data.ea.com/*", "*://pin-river.ea.com/*", "https://pin-river.data.ea.com/*"] },
  ["requestBody"]
);

// Funzione helper per PIN Event: inoltra l'evento alla scheda attiva della Web App EA
// Restituisce una Promise protetta da timeout di sicurezza (max 500ms) per evitare blocchi infiniti
async function triggerPinEvent(type, payload = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    const safetyTimer = setTimeout(finish, 500);

    try {
      chrome.tabs.query({}, (tabs) => {
        const eaTabs = (tabs || []).filter(t => t.url && t.url.includes("ea.com"));
        if (chrome.runtime.lastError || !eaTabs || eaTabs.length === 0) {
          clearTimeout(safetyTimer);
          return finish();
        }
        let pending = eaTabs.length;
        for (const tab of eaTabs) {
          console.log(`[FC Sniper SW] Invio PIN ${type} a scheda ${tab.id}`);
          chrome.tabs.sendMessage(tab.id, {
            scope: "PIN_BRIDGE",
            type: type,
            payload: payload
          }, () => {
            const _ = chrome.runtime.lastError; // Consuma l'errore per prevenire Unchecked runtime.lastError
            pending--;
            if (pending <= 0) {
              clearTimeout(safetyTimer);
              finish();
            }
          });
        }
      });
    } catch (err) {
      clearTimeout(safetyTimer);
      finish();
    }
  });
}

async function ensureOffscreenDocument() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Keep service worker alive'
    });
    console.log('[FC Sniper] Offscreen document creato per Keep-Alive MV3.');
  } catch (e) {
    if (!e.message.includes('Only a single offscreen document may be created')) {
      console.warn('[FC Sniper] Errore creazione offscreen:', e);
    }
  }
}
ensureOffscreenDocument();
async function executeSafetyPause(durationSeconds = 600, reason = "Soft-Ban EA") {
  const totalMinutes = Math.round(durationSeconds / 60);
  console.warn(`[FC Sniper] Avvio Pausa di Sicurezza: ${reason}. Durata: ${totalMinutes} minuti (${durationSeconds}s).`);

  chrome.runtime.sendMessage({
    tipo: 'LOG',
    valore: `[PAUSA DI SICUREZZA] ${reason}. Pausa di ${totalMinutes} min per sbloccare l'account. Manutenzione vendite e rilist attiva in background!`
  });

  let remaining = durationSeconds;
  const heartbeatEvery = 120; // Invia ping e controlla la Tradepile ogni 2 minuti

  // Eseguiamo subito un primo controllo all'ingresso della pausa per non perdere tempo
  try {
    await clearSoldItem();
    await resolveWatchlist();
    const initCrediti = await getCrediti();
    if (typeof initCrediti === 'number') {
      crediti = initCrediti;
      chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });
    }
  } catch (e) {
    console.warn("[Pausa Iniziale Maintenance Error]", e);
  }

  while (remaining > 0 && start === true) {
    await sleep(1000);
    remaining--;

    // Keep-alive Chrome Service Worker ogni 15s per evitare standby
    if (remaining % 15 === 0) {
      try { await chrome.storage.local.get(['keepAliveCheck']); } catch (_) { }
    }

    // Countdown nei log ogni 60 secondi
    if (remaining > 0 && remaining % 60 === 0) {
      const minsLeft = Math.round(remaining / 60);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[PAUSA DI SICUREZZA] Sblocco soft-ban in corso... Mancano ${minsLeft} min alla ripresa automatica (Vendite e rilist attivi).`
      });
    }

    // Ping attivo anti-scadenza sessione EA + Manutenzione Tradepile ogni 2 minuti
    if (remaining > 0 && remaining % heartbeatEvery === 0 && start === true) {
      try {
        await triggerPinEvent("TRIGGER_PIN_WATCHLIST");
        // 1. Incassa vendite e rimette in vendita carte scadute
        await clearSoldItem();
        // 2. Risolve eventuali aste vinte in corso
        await resolveWatchlist();
        // 3. Aggiorna saldo crediti
        const currentCrediti = await getCrediti();
        if (typeof currentCrediti === 'number') {
          crediti = currentCrediti;
          chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });
        }
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[MANUTENZIONE PAUSA] Vendite incassate e carte scadute rilistate! Crediti attuali: ${crediti}`
        });
      } catch (e) {
        console.warn("[Keep-Alive & Tradepile Maintenance Error]", e);
      }
    }
  }

  if (start === true) {
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[PAUSA DI SICUREZZA TERMINATA] Account raffreddato con successo! Ripresa delle attività.`
    });
  }
}

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.tipo === 'TOKEN_SYNC' && message.valore) {
    if (xUtSid !== message.valore) {
      console.log("[FC Sniper] x-ut-sid sincronizzato via DOM bridge:", message.valore.substring(0, 10) + "...");
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[TOKEN SYNC] Nuovo token EA catturato dalla Web App: ${message.valore.substring(0, 10)}...`
      });
    }
    xUtSid = message.valore;
    chrome.storage.local.set({ xUtSid: message.valore });
    consecutive401Errors = 0;
    return;
  }

  if (message.tipo === 'START') {
    start = message.valore;

    if (start == true) {
      if (!xUtSid) {
        xUtSid = await new Promise((resolve) => {
          chrome.storage.local.get(['xUtSid'], (res) => resolve(res.xUtSid || ""));
        });
      }

      if (!xUtSid) {
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: '[ATTENZIONE] Sessione Web App non ancora sincronizzata. Clicca su qualsiasi menu nella Web App di EA (es. Trasferimenti o Club) per sincronizzare il token e poi premi Start.'
        });
        chrome.runtime.sendMessage({ tipo: 'START', valore: false });
        start = false;
        return;
      }

      // Recupera il numero di tentativi, targetMode, rating e la strategia dallo storage
      numeroTentativi = await getNumeroTentativi();
      targetMode = message.targetMode || await getTargetMode();
      chemStyle = message.chemStyle || await getChemStyle();
      autoBin = message.autoBin !== undefined ? message.autoBin : await getAutoBin();
      manualBin = message.manualBin !== undefined ? message.manualBin : await getManualBin();
      fodderRating = message.rating || await getFodderRating();
      strategyMode = message.strategyMode || await getStrategyMode();
      minMargin = message.minMargin || await getMinMargin();
      maxSnipePrice = message.maxSnipePrice !== undefined ? message.maxSnipePrice : await getMaxSnipePrice();
      targetTradepileSize = message.targetTradepileSize || await getTargetTradepileSize();
      lazyMarkupPercent = message.lazyMarkupPercent || await getLazyMarkupPercent();
      lazySleepMinutes = message.lazySleepMinutes || await getLazySleepMinutes();
      carteAcquistate = 0;
      carteVinteCiclo = 0;
      consecutive401Errors = 0;
      consecutiveBidErrors = 0;
      consecutive470Errors = 0;
      consecutiveSnipeErrors = 0;
      consecutive512Errors = 0;
      consecutiveSearchErrors = 0;
      marketRestricted = false;
      reportTelemetry('START', 'Bot avviato', { strategyMode, targetTradepileSize, chemStyle });

      chrome.runtime.sendMessage({ tipo: 'CARTA_ACQUISTATA', valore: "" });
      crediti = await getCrediti();
      chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });
      await getTradepileInfo();

      // Sincronizzazione rigorosa stato modalità
      ricercaFodder = (targetMode === "fodder");
      if (targetMode !== "fodder") {
        listaFodder = [];
        indexFodder = 0;
      }

      // Se in modalità Lazy Trading, deleghiamo la pulizia, auto-discovery prezzi e relist direttamente alla Fase 1 del ciclo
      if (strategyMode === "lazy") {
        if (targetMode === "fodder") {
          ricercaFodder = true;
          chrome.runtime.sendMessage({ tipo: 'LOG', valore: `Avvio LAZY TRADING Fodder (Rating ${fodderRating}, Target: ${targetTradepileSize}, Ricarico: +${lazyMarkupPercent}%, Pausa: ${lazySleepMinutes}m)` });
          await sendFodderLazyRequest();
        } else {
          targetMode = "consumables";
          ricercaFodder = false;
          const styleName = chemStyle === "all" ? "Rotazione (Ombra, Cacciatore, Ancora)" : (CHEM_STYLES[chemStyle]?.name || `Stile ${chemStyle}`);
          chrome.runtime.sendMessage({ tipo: 'LOG', valore: `Avvio LAZY TRADING Consumabili (${styleName}, Target: ${targetTradepileSize}, Ricarico: +${lazyMarkupPercent}%, Pausa: ${lazySleepMinutes}m)` });
          await sendConsumableLazyRequest();
        }
      } else {
        // Per le altre modalità: all'avvio puliamo la lista trasferimenti da venduti e rimettiamo in vendita eventuali invendute
        await processUnassignedItems();
        await clearSoldItem();
        await listUnlistedTradepileItems();

        if (strategyMode === "bidding") {
          await reconcileWatchlistOnStartup();
          crediti = await getCrediti();
          chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });
        }

        if (targetMode === "consumables") {
          const styleName = chemStyle === "all" ? "Rotazione (Ombra, Cacciatore, Ancora)" : (CHEM_STYLES[chemStyle]?.name || `Stile ${chemStyle}`);
          if (strategyMode === "bidding") {
            chrome.runtime.sendMessage({ tipo: 'LOG', valore: `Avvio MASS BIDDING Consumabili (${styleName}, Margine min ${minMargin})` });
            await sendConsumableBiddingRequest();
          } else {
            chrome.runtime.sendMessage({ tipo: 'LOG', valore: `Avvio SNIPING Consumabili (${styleName})` });
            await sendConsumableResearchRequest();
          }
        } else if (targetMode === "fodder") {
          if (strategyMode === "bidding") {
            chrome.runtime.sendMessage({ tipo: 'LOG', valore: `Avvio MASS BIDDING Fodder (Rating ${fodderRating}, Margine min ${minMargin})` });
            await sendFodderBiddingRequest();
          } else {
            chrome.runtime.sendMessage({ tipo: 'LOG', valore: `Avvio SNIPING Fodder (Rating ${fodderRating})` });
            await sendFodderResearchRequest();
          }
        } else {
          let i = 0;
          while (start == true && i < numeroTentativi) {
            await sendResearchRequest();
            if (start !== true) break;

            //aggiorno contatore tentativi rimasti
            chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });

            let randomValue;
            if ((i + 1) % 25 == 0) randomValue = getRandomGaussian(2.5, 0.3, 2.0, 3.2); // micro-pausa anti-limit ogni 25 tentativi
            else randomValue = getRandomGaussian(0.9, 0.12, 0.7, 1.25); // sleep rapido per competere sullo sniping

            await sleep(randomValue * 1000);

            i++;
          }

          //pulisco la lista trasferimenti dagli elementi venduti a fine ricerche
          await clearSoldItem();
        }
      }

      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Ricerca terminata\n' });
      //ho finito le ricerche, quindi termino ed invio messaggio di stop
      chrome.runtime.sendMessage({ tipo: 'START', valore: false });
      chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: "" });

      //recupero crediti residui
      crediti = await getCrediti()
      chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });

      //pulisco la lista trasferimenti dagli elementi venduti
      await clearSoldItem()

      start = false;
    } else {
      // Arresto manuale dal popup: pulizia venduti e relist automatico invenduti
      await clearSoldItem();
    }
  }
});


// Define a sleep function
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


// Funzione per ottenere numeroTentativi come Promise
const getNumeroTentativi = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['numeroTentativi'], (result) => {
      resolve(result.numeroTentativi || 0); // Default to 0 if undefined
    });
  });
};

// Funzione per ottenere fodderRating come Promise
const getFodderRating = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['fodderRating'], (result) => {
      resolve(result.fodderRating || "84"); // Default a 84 se non definito
    });
  });
};

// Funzione per ottenere strategyMode come Promise
const getStrategyMode = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['strategyMode'], (result) => {
      resolve(result.strategyMode || "sniping");
    });
  });
};

// Funzione per ottenere minMargin come Promise
const getMinMargin = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['minMargin'], (result) => {
      resolve(result.minMargin ? parseInt(result.minMargin) : 200);
    });
  });
};

// Funzione per ottenere targetMode come Promise
const getTargetMode = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['targetMode', 'fodderMode'], (result) => {
      if (result.targetMode) resolve(result.targetMode);
      else if (result.fodderMode !== undefined) resolve(result.fodderMode ? "fodder" : "manual");
      else resolve("fodder");
    });
  });
};

// Funzione per ottenere chemStyle come Promise
const getChemStyle = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['chemStyle'], (result) => {
      resolve(result.chemStyle || "268");
    });
  });
};

// Funzione per ottenere autoBin come Promise
const getAutoBin = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['autoBin'], (result) => {
      resolve(result.autoBin !== undefined ? result.autoBin : true);
    });
  });
};

// Funzione per ottenere manualBin come Promise
const getManualBin = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['manualBin'], (result) => {
      resolve(result.manualBin ? parseInt(result.manualBin) : 0);
    });
  });
};

const getMaxSnipePrice = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['maxSnipePrice'], (result) => {
      resolve(result.maxSnipePrice ? parseInt(result.maxSnipePrice) : 0);
    });
  });
};

// Funzione per ottenere targetTradepileSize come Promise
const getTargetTradepileSize = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['targetTradepileSize'], (result) => {
      resolve(result.targetTradepileSize ? parseInt(result.targetTradepileSize) : 50);
    });
  });
};

// Funzione per ottenere lazyMarkupPercent come Promise
const getLazyMarkupPercent = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['lazyMarkupPercent'], (result) => {
      resolve(result.lazyMarkupPercent ? parseInt(result.lazyMarkupPercent) : 10);
    });
  });
};

// Funzione per ottenere lazySleepMinutes come Promise
const getLazySleepMinutes = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['lazySleepMinutes'], (result) => {
      resolve(result.lazySleepMinutes ? parseInt(result.lazySleepMinutes) : 63);
    });
  });
};

// Funzione per ottenere le offerte pendenti salvate nello storage
const getStoredPendingBids = () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['pendingBids'], (result) => {
      resolve(result.pendingBids || {});
    });
  });
};

// Salva o aggiorna un'offerta pendente nello storage
async function storePendingBid(tradeId, data) {
  activeBids.set(String(tradeId), data);
  const bids = await getStoredPendingBids();
  bids[String(tradeId)] = data;
  await chrome.storage.local.set({ pendingBids: bids });
}

// Salva o aggiorna un batch di offerte/osservazioni pendenti nello storage
async function storePendingBidsBatch(itemsMap) {
  const bids = await getStoredPendingBids();
  for (const [tradeId, data] of Object.entries(itemsMap)) {
    activeBids.set(String(tradeId), data);
    bids[String(tradeId)] = data;
  }
  await chrome.storage.local.set({ pendingBids: bids });
}

// Rimuove un'offerta pendente dallo storage
async function removeStoredPendingBid(tradeId) {
  activeBids.delete(String(tradeId));
  activeBids.delete(Number(tradeId));
  const bids = await getStoredPendingBids();
  delete bids[String(tradeId)];
  await chrome.storage.local.set({ pendingBids: bids });
}

// Pulisce offerte pendenti obsolete (> 24 ore) per garantire memoria pulita
async function cleanExpiredPendingBids() {
  try {
    const bids = await getStoredPendingBids();
    const now = Date.now();
    let count = 0;
    for (const tradeId in bids) {
      if (!bids[tradeId]?.expiresAt || bids[tradeId].expiresAt < (now - 24 * 3600 * 1000)) {
        delete bids[tradeId];
        count++;
      }
    }
    if (count > 0) {
      await chrome.storage.local.set({ pendingBids: bids });
      console.log(`[FC Sniper Storage] Pulite ${count} offerte pendenti obsolete.`);
    }
  } catch (e) {
    console.error("[Storage Cleanup Error]", e);
  }
}

// Pulizia automatica offerte pendenti all'avvio del background script
cleanExpiredPendingBids();


function getRandomInRange(min, max) {
  return Math.random() * (max - min + 1) + min;
}

function getRandomGaussian(mean, stdev, min = null, max = null) {
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();

  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  let value = mean + z0 * stdev;

  if (min !== null && value < min) value = min;
  if (max !== null && value > max) value = max;

  return value;
}

// Restituisce lo scalino minimo ufficiale di rilancio EA in base al prezzo
function getEaStep(price) {
  if (price >= 100000) return 1000;
  if (price >= 50000) return 500;
  if (price >= 10000) return 250;
  if (price >= 1000) return 100;
  return 50;
}

// Calcola la prossima offerta valida rispettando lo scalino EA
function calculateNextBid(startingBid, currentBid) {
  if (!currentBid || currentBid === 0) {
    return startingBid;
  }
  return currentBid + getEaStep(currentBid);
}

// Arrotonda un prezzo per difetto al gradino valido EA più vicino
function roundDownToStep(price) {
  const step = getEaStep(price);
  return Math.floor(price / step) * step;
}

// Arrotonda un prezzo per eccesso al gradino valido EA più vicino
function roundUpToStep(price) {
  const step = getEaStep(price);
  return Math.ceil(price / step) * step;
}

// Calcola il margine di profitto netto dinamico in base al valore di mercato della carta
function calculateTargetMargin(marketPrice, minMarginBase = 200) {
  // Fascia 1: Economiche (<= 5.000 crediti) -> 250 crediti netti per massimizzare frequenza vincite su carte ad alto traffico
  if (marketPrice <= 5000) {
    return minMarginBase > 0 ? minMarginBase : 250;
  }
  // Fascia 2: Medie (5.001 - 15.000 crediti) -> 450 crediti netti (ottimo bilanciamento profitto/aggressività)
  if (marketPrice <= 15000) {
    return Math.max(450, minMarginBase);
  }
  // Fascia 3: Élite (> 15.000 crediti, es. Doué, Isak, Bremer, Alvarez) -> 5% con minimo 1.000 crediti netti
  const percentMargin = Math.floor(marketPrice * 0.05);
  return Math.max(1000, percentMargin, minMarginBase);
}

// Restituisce i millisecondi rimanenti alla scadenza dell'asta attiva più vicina che richiede azione immediata
function getUrgentAuctionTimeRemaining() {
  const now = Date.now();
  let minRemainingMs = Infinity;
  for (const [tradeId, bid] of activeBids.entries()) {
    if (bid?.expiresAt) {
      const diff = bid.expiresAt - now;
      if (diff < -15000) {
        // Asta scaduta da oltre 15 secondi ma ancora in activeBids: pulizia
        activeBids.delete(tradeId);
        continue;
      }
      // Un'offerta attiva richiede monitoraggio prioritario quando è in chiusura (<= 15s)
      const isActionable = (diff > 0 && diff <= 15000);
      if (isActionable && diff < minRemainingMs) {
        minRemainingMs = diff;
      }
    }
  }
  return minRemainingMs;
}

async function getCrediti() {
  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": xUtSid,
  });

  try {
    const response = await fetch(watchListUrl, {
      method: "GET",
      headers: headers,
    });

    if (!response.ok) {
      if (response.status === 401) {
        await handle401Error("Crediti");
      }
      return 'N/D';
    }
    consecutive401Errors = 0;

    const data = await response.json();
    const currentCredits = data?.credits ?? data?.credit ?? 0;
    if (typeof currentCredits === 'number') {
      crediti = currentCredits;
      try {
        chrome.storage.local.set({ crediti: currentCredits });
      } catch (_) { }
      chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: currentCredits });
    }
    return currentCredits;
  } catch (error) {
    console.error('[ERROR Updating credits]', error);
    return 'N/D';
  }
}

async function clearSoldItem(cachedPrices = {}) {
  if (!xUtSid) return;

  try {
    // 1. Recupera lo stato attuale della Tradepile
    const pileInfo = await getTradepileInfo();
    const auctions = pileInfo.auctions || [];

    // 2. Filtra solo le carte effettivamente vendute
    // In EA FUT: un oggetto è venduto quando l'asta è chiusa/scaduta e c'è un'offerta vincente (currentBid > 0)
    const soldItems = auctions.filter(a =>
      (a.tradeState === "closed" || a.tradeState === "expired" || a.expires <= 0) &&
      (Number(a.currentBid) > 0)
    );

    // 3. Esegue la chiamata DELETE solo ed esclusivamente se sono presenti carte vendute
    if (soldItems.length > 0) {
      console.log(`[FC Sniper] Rilevate ${soldItems.length} carte vendute in Tradepile. Procedo alla rimozione...`);
      const headers = new Headers({
        "accept": "*/*",
        "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "content-type": "application/json",
        "x-ut-sid": xUtSid,
      });

      const response = await fetch(deleteSoldUrl, {
        method: "DELETE",
        headers: headers,
      });

      if (response.ok) {
        console.log(`[FC Sniper] Lista trasferimenti pulita con successo: rimosse ${soldItems.length} carte vendute.`);
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[TRADEPILE] Incassate e rimosse ${soldItems.length} carte vendute dalla lista trasferimenti!`
        });
        reportTelemetry('SOLD_ITEMS_CLEARED', `Pulite ${soldItems.length} carte vendute dalla Tradepile`, { count: soldItems.length });
        await sleep(getRandomGaussian(0.8, 0.1, 0.6, 1.0) * 1000);
      } else if (response.status === 410) {
        console.log('[FC Sniper] Carte vendute già rimosse (410 Gone allineato).');
      } else if (response.status === 401) {
        await handle401Error("Clear Sold");
      } else {
        console.warn(`[FC Sniper] Status imprevisto pulizia venduti: ${response.status}`);
      }
    } else {
      console.log('[FC Sniper] Nessuna carta venduta presente in Tradepile. Richiesta DELETE /trade/sold evitata.');
    }

    // 4. Controlla e rimette in vendita automaticamente eventuali carte scadute/invendute
    // riutilizzando l'elenco aste già ottenuto per non inviare una seconda richiesta GET tradepile ad EA
    await checkAndRelistExpiredItems(cachedPrices, auctions);

  } catch (error) {
    console.error('[ERROR clearing sold items]', error);
  }
}

// Recupera lo stato attuale della lista trasferimenti (Tradepile)
async function getTradepileInfo() {
  if (!xUtSid) return { total: 0, active: 0, auctions: [] };

  const tradepileUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/tradepile";
  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": xUtSid
  });

  try {
    const res = await fetch(tradepileUrl, { method: "GET", headers });
    if (!res.ok) {
      if (res.status === 401) await handle401Error("Get Tradepile Info");
      return { total: 0, active: 0, auctions: [] };
    }
    consecutive401Errors = 0;
    const data = await res.json();
    const auctions = data.auctionInfo || [];
    const active = auctions.filter(a => a.tradeState === "active" || a.expires > 0).length;
    const tradepileDisplay = `${active} attive (${auctions.length} tot)`;
    chrome.runtime.sendMessage({ tipo: 'TRADEPILE_COUNT', valore: tradepileDisplay, active, total: auctions.length });
    try {
      chrome.storage.local.set({ tradepileCount: tradepileDisplay, tradepileActive: active, tradepileTotal: auctions.length });
    } catch (_) { }
    return {
      total: auctions.length,
      active: active,
      auctions: auctions
    };
  } catch (e) {
    console.error("[FC Sniper Tradepile Info Error]", e);
    return { total: 0, active: 0, auctions: [] };
  }
}

// Controlla la lista trasferimenti per rilevare oggetti scaduti/invenduti e rimetterli in vendita
// RICALCOLA IL PREZZO per ciascuna carta rilevando lo stile intesa e applicando il Floor BIN live + 10%
async function checkAndRelistExpiredItems(cachedPrices = {}, preloadedAuctions = null) {
  if (!xUtSid) return;

  try {
    let auctions = preloadedAuctions;
    if (!Array.isArray(auctions)) {
      const tradepileUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/tradepile";
      const headers = new Headers({
        "accept": "*/*",
        "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "x-ut-sid": xUtSid
      });

      const res = await fetch(tradepileUrl, { method: "GET", headers });
      if (!res.ok) {
        if (res.status === 401) await handle401Error("Tradepile Check");
        return;
      }
      consecutive401Errors = 0;
      const data = await res.json();
      auctions = data.auctionInfo || [];
    }

    // Cerchiamo le carte scadute e non vendute nella lista trasferimenti
    const expiredUnsold = auctions.filter(a =>
      (a.tradeState === "closed" || a.tradeState === "expired" || a.expires === -1 || a.expires === 0) &&
      (!a.currentBid || a.currentBid === 0) &&
      (a.buyNowPrice > 0 || a.startingBid > 0)
    );

    if (expiredUnsold.length === 0) {
      return;
    }

    console.log(`[FC Sniper Tradepile] Rilevate ${expiredUnsold.length} carte scadute/invendute. Ricalcolo Lowest BIN live e relist...`);
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[Tradepile Relist] Rilevate ${expiredUnsold.length} carte invendute. Ricalcolo prezzi live (Lowest BIN + 10%)...`
    });

    if (Date.now() < listingRestrictedUntil) {
      const remainingMin = Math.ceil((listingRestrictedUntil - Date.now()) / 60000);
      console.log(`[FC Sniper Tradepile] Relist in cooldown (${remainingMin} min rimanenti). Salto.`);
      return;
    }

    let relistedCount = 0;
    for (const a of expiredUnsold) {
      if (start !== true || Date.now() < listingRestrictedUntil) break;
      const itemId = a.itemData?.id;
      if (!itemId) continue;

      let newSellPrice = 0;
      let cardName = "Carta";
      let tierTag = "";

      if (a.itemData?.itemType === "player") {
        // Calciatore / Fodder (calcola nuovo prezzo solo se attivi in modalità Fodder)
        if (targetMode === "fodder") {
          const assetId = a.itemData?.assetId || a.itemData?.resourceId;
          const pInfo = cachedPrices?.playerPriceMap?.get(String(assetId));
          cardName = pInfo?.name || `Calciatore (${a.itemData?.rating || 'N/D'})`;
          let fodderPrice = pInfo?.basePrice;
          if (!fodderPrice && cachedPrices?.benchmarkFloor) fodderPrice = cachedPrices.benchmarkFloor;
          if (!fodderPrice) fodderPrice = await getFodderPriceForItem(a.itemData);
          if (fodderPrice > 0) {
            const tiered = getTieredSellPrice(fodderPrice, null, false);
            newSellPrice = tiered.price;
            tierTag = ` [Tier ${tiered.tier}: +${tiered.markup}%]`;
          }
        }
      } else if (a.itemData?.itemType === "training" || a.itemData?.playStyle || a.itemData?.cardsubtypeid) {
        // Consumabile / Stile Intesa
        const sId = detectChemistryStyle(a, chemStyle);
        const meta = CHEM_STYLES[sId] || { name: `Stile ${sId}` };
        cardName = meta.name;

        let floor = cachedPrices[sId]?.floorBin;
        if (!floor && consumableBinCache.has(sId)) {
          floor = consumableBinCache.get(sId).price;
        }
        if (!floor) {
          floor = await discoverConsumableLowestBin(sId, manualBin);
        }

        if (floor && floor > 0) {
          const tiered = getTieredSellPrice(floor, null, true);
          newSellPrice = tiered.price;
          tierTag = ` [Tier ${tiered.tier}: +${tiered.markup}%]`;
        }
      }

      // Fallback al prezzo precedente se non riusciamo a determinare il nuovo
      if (!newSellPrice || newSellPrice <= 0) {
        newSellPrice = a.buyNowPrice;
      }

      const success = await sellSingleItem(itemId, newSellPrice);
      if (Date.now() < listingRestrictedUntil) break;
      if (success) {
        relistedCount++;
        const prevText = a.buyNowPrice ? ` (prec: ${a.buyNowPrice})` : '';
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[RELIST SCAGLIONATO] ${cardName} rimessa in vendita a ${newSellPrice} crediti${tierTag}${prevText}`
        });
        await sleep(getRandomGaussian(1.6, 0.15, 1.5, 2.0) * 1000);
      } else {
        await sleep(getRandomGaussian(1.8, 0.2, 1.5, 2.2) * 1000);
      }
    }

    if (relistedCount > 0) {
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[Tradepile Relist] Completato: ${relistedCount}/${expiredUnsold.length} carte rimesse in vendita al prezzo di mercato aggiornato (+10%)!`
      });
    }
  } catch (err) {
    console.error("[FC Sniper Tradepile Relist Error]", err);
  }
}

// Recupera e gestisce tutte le carte presenti nella pila "Non Assegnati" (purchased/items)
// Sposta ogni carta nella lista trasferimenti e la mette in vendita con il prezzo Lazy aggiornato
async function processUnassignedItems(cachedPrices = {}) {
  if (!xUtSid) return { found: 0, moved: 0, listed: 0 };

  const unassignedUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/purchased/items";
  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": xUtSid
  });

  try {
    const res = await fetch(unassignedUrl, { method: "GET", headers });
    if (!res.ok) {
      if (res.status === 401) await handle401Error("Process Unassigned");
      return { found: 0, moved: 0, listed: 0 };
    }
    consecutive401Errors = 0;
    const data = await res.json();
    const items = data.itemData || [];

    if (items.length === 0) {
      return { found: 0, moved: 0, listed: 0 };
    }

    console.log(`[FC Sniper Non Assegnati] Rilevate ${items.length} carte bloccate nei "Non Assegnati". Spostamento in lista trasferimenti e vendita...`);
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[RECUPERO NON ASSEGNATI] Rilevate ${items.length} carte nello slot "Non Assegnati". Le sposto nella lista trasferimenti e le metto in vendita...`
    });

    let movedCount = 0;
    let listedCount = 0;

    for (const item of items) {
      if (start !== true) break;
      const itemId = item.id;
      if (!itemId) continue;

      // 1. Sposta l'oggetto da Non Assegnati alla Tradepile
      const moved = await moveSingleItemToTrade(itemId);
      if (moved) {
        movedCount++;
        // Pausa di assestamento database EA (800ms - 1200ms)
        await sleep(getRandomGaussian(1.0, 0.2, 0.8, 1.4) * 1000);

        // 2. Determina il prezzo di vendita target
        let sellPrice = 0;
        let cardName = "Carta";
        let tierTag = "";

        if (item.itemType === "player") {
          if (targetMode === "fodder") {
            const assetId = item.assetId || item.resourceId;
            cardName = `Calciatore (${item.rating || 'N/D'})`;
            let fodderPrice = cachedPrices?.playerPriceMap?.get(String(assetId))?.basePrice;
            if (!fodderPrice && cachedPrices?.benchmarkFloor) fodderPrice = cachedPrices.benchmarkFloor;
            if (!fodderPrice) fodderPrice = await getFodderPriceForItem(item);
            if (fodderPrice > 0) {
              const tiered = getTieredSellPrice(fodderPrice, null, false);
              sellPrice = tiered.price;
              tierTag = ` (Tier ${tiered.tier}: +${tiered.markup}%)`;
            }
          }
        } else if (item.itemType === "training" || item.playStyle || item.cardsubtypeid) {
          const sId = detectChemistryStyle(item, chemStyle);
          const meta = CHEM_STYLES[sId] || { name: `Stile ${sId}` };
          cardName = meta.name;

          let floor = cachedPrices[sId]?.floorBin;
          if (!floor && consumableBinCache.has(sId)) {
            floor = consumableBinCache.get(sId).price;
          }
          if (!floor) {
            floor = await discoverConsumableLowestBin(sId, manualBin);
          }

          if (floor && floor > 0) {
            const tiered = getTieredSellPrice(floor, null, true);
            sellPrice = tiered.price;
            tierTag = ` (Tier ${tiered.tier}: +${tiered.markup}%)`;
          }
        }

        // 3. Metti in vendita se abbiamo un prezzo valido
        if (sellPrice > 0) {
          const success = await sellSingleItem(itemId, sellPrice);
          if (success) {
            listedCount++;
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[VENDITA NON ASSEGNATI] ${cardName} recuperata e messa in vendita a ${sellPrice} crediti${tierTag}!`
            });
            await sleep(getRandomGaussian(1.6, 0.15, 1.5, 2.0) * 1000);
          } else {
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[NON ASSEGNATI] ${cardName} spostata in lista trasferimenti (sarà messa in vendita dal recupero Tradepile).`
            });
            await sleep(getRandomGaussian(1.8, 0.2, 1.5, 2.2) * 1000);
          }
        } else {
          await sleep(getRandomGaussian(1.0, 0.2, 0.8, 1.3) * 1000);
        }
      } else {
        console.warn(`[FC Sniper Non Assegnati] Impossibile spostare item ${itemId} a Tradepile.`);
        await sleep(1500);
      }
    }

    if (movedCount > 0) {
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[RECUPERO NON ASSEGNATI] Completato: spostate ${movedCount}/${items.length} carte in lista trasferimenti (${listedCount} messe in vendita)!`
      });
    }

    return { found: items.length, moved: movedCount, listed: listedCount };
  } catch (err) {
    console.error("[Process Unassigned Items Error]", err);
    return { found: 0, moved: 0, listed: 0 };
  }
}

// Controlla la lista trasferimenti e mette in vendita qualsiasi carta acquistata che non è attualmente listata sul mercato
// Eseguito sia ad inizio che a fine ciclo per garantire che nessuna carta rimanga invenduta o bloccata nella Tradepile
async function listUnlistedTradepileItems(cachedPrices = {}) {
  if (!xUtSid) return { found: 0, listed: 0 };

  const tradepileUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/tradepile";
  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": xUtSid
  });

  try {
    const res = await fetch(tradepileUrl, { method: "GET", headers });
    if (!res.ok) {
      if (res.status === 401) await handle401Error("List Unlisted Tradepile");
      return { found: 0, listed: 0 };
    }
    consecutive401Errors = 0;
    const data = await res.json();
    const auctions = data.auctionInfo || [];

    // Filtra gli oggetti nella Tradepile che NON hanno un'asta attiva sul mercato
    // Un oggetto non listato ha: itemData valido, ma tradeState nullo o non "active", ed expires <= 0
    const unlisted = auctions.filter(a =>
      a.itemData?.id &&
      a.tradeState !== "active" &&
      (a.expires <= 0 || !a.buyNowPrice || a.buyNowPrice === 0) &&
      a.tradeState !== "closed" && a.tradeState !== "expired"
    );

    if (unlisted.length === 0) {
      return { found: 0, listed: 0 };
    }

    console.log(`[FC Sniper Recupero] Rilevate ${unlisted.length} carte in Tradepile non messe in vendita. Procedo al listaggio immediato...`);
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[RECUPERO LISTA] Rilevate ${unlisted.length} carte in lista trasferimenti non ancora messe in vendita. Le metto sul mercato...`
    });

    if (Date.now() < listingRestrictedUntil) {
      const remainingMin = Math.ceil((listingRestrictedUntil - Date.now()) / 60000);
      console.log(`[FC Sniper Recupero] Listing in cooldown (${remainingMin} min rimanenti). Salto il listing delle ${unlisted.length} carte non listate.`);
      return { found: unlisted.length, listed: 0 };
    }

    let listedCount = 0;
    for (const a of unlisted) {
      if (start !== true || Date.now() < listingRestrictedUntil) break;
      const item = a.itemData;
      const itemId = item.id;
      let sellPrice = 0;

      if (item.itemType === "player") {
        // 1. Caso Calciatore / Fodder (solo se targetMode === "fodder")
        if (targetMode === "fodder") {
          const assetId = item.assetId || item.resourceId;
          let fodderPrice = cachedPrices?.playerPriceMap?.get(String(assetId))?.basePrice;
          if (!fodderPrice && cachedPrices?.benchmarkFloor) fodderPrice = cachedPrices.benchmarkFloor;
          if (!fodderPrice) fodderPrice = await getFodderPriceForItem(item);
          if (fodderPrice > 0) {
            const tiered = getTieredSellPrice(fodderPrice, null, false);
            sellPrice = tiered.price;
            const success = await sellSingleItem(itemId, sellPrice);
            if (Date.now() < listingRestrictedUntil) break;
            if (success) {
              listedCount++;
              chrome.runtime.sendMessage({
                tipo: 'LOG',
                valore: `[VENDITA RECUPERATA] Calciatore (Rating ${item.rating || 'N/D'}) messo in vendita a ${sellPrice} crediti (Tier ${tiered.tier}: +${tiered.markup}%)`
              });
              await sleep(getRandomGaussian(1.6, 0.15, 1.5, 2.0) * 1000);
            } else {
              await sleep(getRandomGaussian(1.8, 0.2, 1.5, 2.2) * 1000);
            }
          }
        }
      } else if (item.itemType === "training" || item.playStyle || item.cardsubtypeid) {
        // 2. Caso Consumabile / Stile Intesa
        const sId = detectChemistryStyle(a, chemStyle);
        const meta = CHEM_STYLES[sId] || { name: `Stile ${sId}` };

        let floor = cachedPrices[sId]?.floorBin;
        if (!floor && consumableBinCache.has(sId)) {
          floor = consumableBinCache.get(sId).price;
        }
        if (!floor) {
          floor = await discoverConsumableLowestBin(sId, manualBin);
        }

        if (floor && floor > 0) {
          const tiered = getTieredSellPrice(floor, null, true);
          sellPrice = tiered.price;
          const success = await sellSingleItem(itemId, sellPrice);
          if (Date.now() < listingRestrictedUntil) break;
          if (success) {
            listedCount++;
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[VENDITA RECUPERATA] ${meta.name} messa in vendita a ${sellPrice} crediti (Tier ${tiered.tier}: +${tiered.markup}%)`
            });
            await sleep(getRandomGaussian(1.6, 0.15, 1.5, 2.0) * 1000);
          } else {
            await sleep(getRandomGaussian(1.8, 0.2, 1.5, 2.2) * 1000);
          }
        }
      }
    }

    if (listedCount > 0) {
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[RECUPERO LISTA] Completato: messe in vendita con successo ${listedCount}/${unlisted.length} carte non listate!`
      });
    }

    return { found: unlisted.length, listed: listedCount };
  } catch (err) {
    console.error("[List Unlisted Tradepile Error]", err);
    return { found: 0, listed: 0 };
  }
}

// Controlla la Watchlist prima del rabbocco Lazy:
// 1. Riscatta subito le aste già vinte (tradeState === "closed" / expires <= 0 e bidState === "highest") -> tradepile -> sell al prezzo target
// 2. Rimuove le aste perse (closed con bidState !== "highest" o outbid)
// 3. Identifica e attende brevemente (se <= 35s) le aste in dirittura d'arrivo in cui siamo vincenti
// 4. Restituisce il conteggio delle carte vinte riscattate e delle aste tuttora attive con offerta vincente
async function checkAndProcessWatchlistForLazy(cyclePrices = {}) {
  if (!xUtSid) return { recoveredWon: 0, activeWinning: 0, cleanedLost: 0 };

  await triggerPinEvent("TRIGGER_PIN_WATCHLIST");

  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache, no-store, must-revalidate",
    "pragma": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": xUtSid,
  });

  try {
    let response = await fetch(watchListUrl, { method: "GET", headers });
    if (!response.ok) {
      if (response.status === 401) await handle401Error("Lazy Watchlist Check");
      return { recoveredWon: 0, activeWinning: 0, cleanedLost: 0 };
    }
    consecutive401Errors = 0;

    let data = await response.json();
    if (data.credits !== undefined) {
      crediti = data.credits;
      chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });
    }

    let auctions = data.auctionInfo || [];
    let recoveredWon = 0;
    let cleanedLost = 0;

    // Se ci sono aste attive vincenti che scadono entro i prossimi 35 secondi, attendiamo brevemente che si chiudano
    // per poterle riscattare subito ed evitare acquisti ridondanti a Compra Ora!
    const imminentAuctions = auctions.filter(a => a.tradeState === "active" && a.bidState === "highest" && a.expires > 0 && a.expires <= 35);
    if (imminentAuctions.length > 0) {
      const maxWait = Math.max(...imminentAuctions.map(a => a.expires || 0));
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY WATCHLIST] ${imminentAuctions.length} aste vincenti in scadenza tra ${maxWait}s. Attendo la chiusura per riscattarle subito...`
      });
      await sleep((maxWait + 2) * 1000);

      // Riesegue una GET della Watchlist aggiornata
      await triggerPinEvent("TRIGGER_PIN_WATCHLIST");
      response = await fetch(watchListUrl, { method: "GET", headers });
      if (response.ok) {
        data = await response.json();
        auctions = data.auctionInfo || [];
      }
    }

    const storedBids = await getStoredPendingBids();
    let activeWinningCount = 0;

    for (const item of auctions) {
      const tradeId = item.tradeId;
      const tradeIdStr = String(tradeId);
      const tradeState = item.tradeState; // "active", "closed", "expired"
      const bidState = item.bidState;     // "highest", "outbid"
      const expires = item.expires;
      const itemId = item.itemData?.id;
      const tracked = storedBids[tradeIdStr] || activeBids.get(tradeIdStr) || activeBids.get(Number(tradeId));

      const isFinished = (tradeState === "closed" || tradeState === "expired" || expires === -1 || expires === 0);

      if (isFinished) {
        if (bidState === "highest") {
          // Asta VINTA! Riscatto immediato
          let sellPrice = 0;
          let tierTag = "";
          if (item.itemData?.itemType === "player") {
            const assetId = item.itemData?.assetId || item.itemData?.resourceId;
            let floor = cyclePrices?.playerPriceMap?.get(String(assetId))?.basePrice;
            if (!floor && tracked?.basePrice) floor = tracked.basePrice;
            if (!floor) floor = await getFodderPriceForItem(item.itemData);
            if (!floor) floor = cyclePrices?.benchmarkFloor || cyclePrices?.floorBin;
            if (floor && floor > 0) {
              const tiered = getTieredSellPrice(floor, null, false);
              sellPrice = tiered.price;
              tierTag = ` (Tier ${tiered.tier}: +${tiered.markup}%)`;
            } else if (tracked?.sellPrice) {
              sellPrice = tracked.sellPrice;
            }
          } else {
            const sId = detectChemistryStyle(item, tracked?.playStyleId || chemStyle);
            const meta = CHEM_STYLES[sId] || { name: `Stile ${sId}` };

            let floor = cyclePrices[sId]?.floorBin;
            if (!floor && consumableBinCache.has(sId)) {
              floor = consumableBinCache.get(sId).price;
            }
            if (!floor) {
              floor = await discoverConsumableLowestBin(sId, manualBin);
            }

            if (floor && floor > 0) {
              const tiered = getTieredSellPrice(floor, null, true);
              sellPrice = tiered.price;
              tierTag = ` (Tier ${tiered.tier}: +${tiered.markup}%)`;
            } else if (tracked?.sellPrice) {
              sellPrice = tracked.sellPrice;
            }
          }

          const buyPrice = item.currentBid || tracked?.bidAmount || 'N/D';
          const moved = await moveSingleItemToTrade(itemId);
          await sleep(getRandomGaussian(1.0, 0.2, 0.8, 1.4) * 1000);

          if (moved && sellPrice && sellPrice > 0) {
            await sellSingleItem(itemId, sellPrice);
            await sleep(getRandomGaussian(1.0, 0.2, 0.8, 1.4) * 1000);
            recoveredWon++;
            carteAcquistate += 1;
            chrome.runtime.sendMessage({ tipo: 'CARTA_ACQUISTATA', valore: carteAcquistate });
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[ASTA VINTA RISCATTATA] Asta vinta a ${buyPrice} crediti! Spostata in Tradepile e messa in vendita a ${sellPrice}${tierTag}.`
            });
          }

          await removeStoredPendingBid(tradeId);
          activeBids.delete(tradeIdStr);
          activeBids.delete(Number(tradeId));
        } else {
          // Asta chiusa ma NON vinta: pulizia
          await deleteFromWatchlist(tradeId);
          await removeStoredPendingBid(tradeId);
          activeBids.delete(tradeIdStr);
          activeBids.delete(Number(tradeId));
          cleanedLost++;
          await sleep(150);
        }
      } else if (tradeState === "active") {
        if (bidState === "highest") {
          // Asta ancora aperta ma siamo l'offerta PIÙ ALTA (vincente)
          activeWinningCount++;
          console.log(`[FC Sniper Watchlist] Asta Trade ${tradeId} ancora attiva con nostra offerta vincente (${item.currentBid} cr, scade in ${item.expires}s).`);
        } else if (bidState === "outbid") {
          // Siamo stati superati su asta attiva: smettiamo di tracciarla.
          // Non chiamiamo deleteFromWatchlist finché l'asta è attiva perché EA rifiuta con 401.
          await removeStoredPendingBid(tradeId);
          activeBids.delete(tradeIdStr);
          activeBids.delete(Number(tradeId));
          cleanedLost++;
        }
      }
    }

    return {
      recoveredWon,
      activeWinning: activeWinningCount,
      cleanedLost
    };
  } catch (err) {
    console.error("[checkAndProcessWatchlistForLazy Error]", err);
    return { recoveredWon: 0, activeWinning: 0, cleanedLost: 0 };
  }
}


//Funzioni per chiamate HTTP

// Funzione per inviare una richiesta GET (ricerca manuale calciatori)
async function sendResearchRequest() {
  try {
    if (!searchUrl || !xUtSid) {
      console.error("URL o Sessione non definiti");
      return;
    }

    // 1. Telemetria nativa PIN: inviata rigorosamente PRIMA della ricerca
    await triggerPinEvent("TRIGGER_PIN_SEARCH");

    // Cache buster sicuro: start SEMPRE 0, alterniamo micr solo tra 0 (non impostato) e 150
    let finalUrl = searchUrl;
    try {
      const parsedUrl = new URL(searchUrl);
      parsedUrl.searchParams.set("start", "0");
      parsedUrl.searchParams.set("num", "21");
      parsedUrl.searchParams.delete("macr");
      if (manualSearchAttempt % 2 === 0) {
        parsedUrl.searchParams.delete("micr");
      } else {
        parsedUrl.searchParams.set("micr", "150");
      }
      manualSearchAttempt++;
      finalUrl = parsedUrl.href;
    } catch {
      // fallback
    }

    // Invia la richiesta GET
    const response = await fetch(finalUrl, {
      method: "GET",
      headers: {
        "Accept": "*/*",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "X-UT-SID": xUtSid
      }
    });

    if (response.ok) {
      consecutiveSearchErrors = 0;
      consecutive401Errors = 0;
      const data = await response.json();
      if (data.auctionInfo && data.auctionInfo.length > 0) {
        idCarteAcquistate = [];

        // Ordina per freschezza decrescente escludendo carte già tentate (carte fantasma)
        const auctions = [...data.auctionInfo]
          .filter(a => !isTradeAttempted(a.tradeId))
          .sort((a, b) => (b.expires || 0) - (a.expires || 0));

        // Acquisto immediato sulla carta più recente
        for (const auction of auctions) {
          if (start !== true) break;
          const bought = await sendBuyNowRequest(auction.tradeId, auction.buyNowPrice, auction.itemData?.id);
          if (bought) {
            break; // Stop immediato al primo acquisto per gestire l'oggetto
          }
        }

        if (idCarteAcquistate.length > 0) {
          await sendToTransferList();
        }
      }
    } else {
      if (response.status === 401) {
        await handle401Error("Ricerca Sniping");
      } else if (response.status === 458) {
        console.warn("[FC Sniper Ricerca] CAPTCHA 458 rilevato!");
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: '[ATTENZIONE - CAPTCHA RILEVATO] Verifica richiesta nella Web App. Bot arrestato.'
        });
        start = false;
      } else if (response.status === 429 || response.status === 426 || response.status === 521 || response.status === 512) {
        await handleSearchRateLimit(response.status, "Ricerca Sniping");
      } else {
        console.error("Errore nella ricerca:", response.status, response.statusText);
      }
    }
  } catch (error) {
    console.error("Errore durante l'invio della richiesta:", error);
  }
}

async function sendBuyNowRequest(tradeId, buyNowPrice, itemId) {
  markTradeAttempted(tradeId);
  const buyNowUrl = 'https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/trade/' + tradeId + '/bid';

  if (!buyNowUrl || !xUtSid) {
    console.error("URL o Sessione non definiti");
    return false;
  }

  // Controllo preventivo saldo crediti: impedisce di inviare richieste destinate a fallire
  if (typeof crediti === 'number' && crediti < buyNowPrice) {
    console.warn(`[FC Sniper BuyNow] Crediti insufficienti (${crediti} cr < ${buyNowPrice} cr richiesti). Acquisto annullato su Trade ${tradeId}.`);
    return false;
  }

  // 1. Telemetria nativa PIN: inviata istantaneamente in parallelo (zero-latency) senza attendere round-trip IPC
  // così la richiesta PUT di Compra Ora parte in 0ms non appena la carta viene individuata
  triggerPinEvent("TRIGGER_PIN_BUY_NOW", { tradeId, buyNowPrice, itemId });

  // 2. Invio istantaneo della richiesta PUT di acquisto
  try {
    const response = await fetch(buyNowUrl, {
      method: "PUT",
      headers: {
        "Accept": "*/*",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "X-UT-SID": xUtSid
      },
      body: JSON.stringify({ bid: buyNowPrice })
    });
    if (response.ok) {
      lastBuyNowErrorStatus = 0;
      consecutiveSnipeErrors = 0;
      consecutive401Errors = 0;
      const data = await response.json();
      carteAcquistate += 1;
      idCarteAcquistate.push(itemId);
      chrome.runtime.sendMessage({ tipo: 'LOG', valore: `[ACQUISTO RIUSCITO] Carta acquistata al prezzo di ${buyNowPrice} crediti!` });
      chrome.runtime.sendMessage({ tipo: 'CARTA_ACQUISTATA', valore: carteAcquistate });
      return true;
    } else {
      lastBuyNowErrorStatus = response.status;
      let errorDetails = "";
      try {
        const errJson = await response.json();
        errorDetails = errJson.reason || errJson.message || JSON.stringify(errJson);
      } catch {
        try { errorDetails = await response.text(); } catch { }
      }

      if (response.status === 401) {
        await handle401Error("BuyNow");
      } else if (response.status === 458) {
        console.warn(`[FC Sniper] CAPTCHA Rilevato (458) su Buy Now!`);
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[ATTENZIONE - CAPTCHA RILEVATO] EA richiede verifica nella Web App. Bot arrestato.`
        });
        start = false;
      } else if (response.status === 429 || response.status === 426 || response.status === 512 || response.status === 521) {
        if (response.status === 512) {
          consecutive512Errors++;
          console.warn(`[Snipe Fallito 512 - Limite Acquisti EA] Trade ${tradeId}, prezzo ${buyNowPrice}. Errori 512 consecutivi: ${consecutive512Errors}/5`);
        } else {
          consecutive512Errors = 0;
          consecutiveSnipeErrors++;
        }

        console.warn(`[Snipe Fallito ${response.status} - Rate Limit EA] Trade ${tradeId}, prezzo ${buyNowPrice}. Dettagli EA: ${errorDetails}. Errori consecutivi rate limit: ${consecutiveSnipeErrors}`);

        if (strategyMode === "lazy") {
          if (consecutive512Errors >= 5) {
            console.warn(`[FC Sniper Lazy] Rilevati 5 errori 512 consecutivi su Compra Ora. Transizione al sonno vendite...`);
          } else {
            await sleep(getRandomGaussian(1.0, 0.2, 0.7, 1.4) * 1000);
          }
        } else if (consecutiveSnipeErrors >= 5 || consecutive512Errors >= 5) {
          console.warn(`[FC Sniper] Rilevati 5 errori consecutivi di Snipe Soft-Ban (${response.status}). Avvio pausa di sicurezza attiva 10 min...`);
          consecutiveSnipeErrors = 0;
          consecutive512Errors = 0;
          await executeSafetyPause(600, `Soft-Ban Compra Ora EA (${response.status})`);
        } else {
          await sleep(getRandomGaussian(3.5, 0.3, 3.0, 4.2) * 1000);
        }
      } else if (response.status === 478 || response.status === 461) {
        // Carta già acquistata da un altro utente (normale durante lo sniping se arriviamo con qualche millisecondo di ritardo)
        console.log(`[FC Sniper] Carta già acquistata da un altro utente (${response.status}) su Trade ${tradeId}`);
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[SNIPE 461] Carta a ${buyNowPrice} crediti anticipata da un altro utente (Trade: ${tradeId})`
        });
      } else {
        console.error("Errore nell'acquisto:", response.status, response.statusText, errorDetails);
      }
      return false;
    }
  } catch (error) {
    console.error("Errore durante l'invio della richiesta di acquisto:", error);
    return false;
  }

}

async function sendToTransferList() {
  let transferListUrl = 'https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/item';

  if (!transferListUrl || !searchHeaders) {
    console.error("URL o Header non definiti per la lista trasferimenti");
    return;
  }

  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    "sec-ch-ua": "\"Chromium\";v=\"142\", \"Google Chrome\";v=\"142\", \"Not_A Brand\";v=\"99\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "X-UT-SID": xUtSid
  });

  let body = { itemData: [] };
  for (const id of idCarteAcquistate) {
    body.itemData.push({
      "id": id,
      "pile": "trade"
    })
    let bodyJson = JSON.stringify(body);

    // Invio la richiesta PUT
    try {
      const response = await fetch(transferListUrl, {
        method: "PUT",
        headers: headers,
        body: bodyJson
      });
      if (response.ok) {
        consecutive401Errors = 0;
        console.log('[FC Sniper] Carte inviate alla lista trasferimenti');
      } else if (response.status === 401) {
        await handle401Error("Transfer List");
      }
    } catch (error) {
      console.error("[FC Sniper] Errore durante l'invio alla lista trasferimenti:", error);
    }
  }

}



async function sendFodderResearchRequest() {


  let i = 0
  while (start == true && i < numeroTentativi) {

    // Ad inizio e ad ogni giro completo della lista, ricarica i prezzi dal server
    if (i == 0 || indexFodder == 0 || listaFodder.length == 0) {
      if (i > 0) {
        console.log('[FC Sniper] Giro fodder completato. Ricarico lista e prezzi aggiornati...');
      }
      listaFodder = [];
      indexFodder = 0;
      await getFdderList();
    }

    if (listaFodder.length === 0) {
      console.log('[FC Sniper] Nessun fodder disponibile. Attendo 3s...');
      await sleep(3000);
      i++;
      continue;
    }

    const next = getNextFodder();

    //costruisco l'url:
    let fodderDefId = next.pid;
    let fodderPrice = Math.floor((next.price * 0.9) / 100) * 100; //calcolo il 10% ed arrotondo alla centinaia più vicina per difetto

    //Definisco l'URL di base
    const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";

    //Creo un oggetto URL
    const url = new URL(baseUrl);

    //Imposto i parametri che servono
    url.searchParams.set("num", "21");
    url.searchParams.set("start", "0");
    url.searchParams.set("type", "player");
    url.searchParams.set("maxb", fodderPrice);
    url.searchParams.set("maskedDefId", fodderDefId);

    url.searchParams.delete("macr");
    // Cache busting alternando micr solo tra 0 (nessun filtro) e 150
    if (i % 2 === 0) {
      url.searchParams.delete("micr");
    } else {
      url.searchParams.set("micr", "150");
    }

    //Ottiene l'URL finale come stringa
    const searchUrlCompleto = url.href;

    try {
      if (!searchUrlCompleto || !xUtSid) {
        console.error("URL o Sessione non definiti");
        return;
      }

      // 1. Telemetria nativa PIN: inviata rigorosamente PRIMA della ricerca
      await triggerPinEvent("TRIGGER_PIN_SEARCH");

      // Invia la richiesta GET
      const response = await fetch(searchUrlCompleto, {
        method: "GET",
        headers: {
          "Accept": "*/*",
          "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control": "no-cache",
          "Content-Type": "application/json",
          "X-UT-SID": xUtSid
        }
      });

      // Controlla la risposta
      if (response.ok) {
        consecutiveSearchErrors = 0;
        consecutive401Errors = 0;
        const data = await response.json();
        if (data.auctionInfo && data.auctionInfo.length > 0) {
          idCarteAcquistate = [];

          // Ordina per freschezza decrescente escludendo carte già tentate (carte fantasma)
          const auctions = [...data.auctionInfo]
            .filter(a => !isTradeAttempted(a.tradeId))
            .sort((a, b) => (b.expires || 0) - (a.expires || 0));

          for (const auction of auctions) {
            if (start !== true) break;
            const bought = await sendBuyNowRequest(auction.tradeId, auction.buyNowPrice, auction.itemData?.id);
            if (bought) {
              break; // Stop al primo acquisto completato
            }
          }

          if (idCarteAcquistate.length > 0) {
            await sendToTransferList();
            await sellFodder(next.price);
            crediti = await getCrediti();
            chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });
            await sleep(getRandomGaussian(1.5, 0.2, 1.2, 2.0) * 1000);
          }
        }
      } else {
        if (response.status === 401) {
          await handle401Error("Ricerca Fodder Sniping");
          break;
        } else if (response.status === 458) {
          console.warn("[FC Sniper Ricerca Fodder] CAPTCHA 458 rilevato!");
          chrome.runtime.sendMessage({
            tipo: 'LOG',
            valore: '[ATTENZIONE - CAPTCHA RILEVATO] Verifica richiesta nella Web App. Bot arrestato.'
          });
          start = false;
          break;
        } else if (response.status === 429 || response.status === 426 || response.status === 521 || response.status === 512) {
          await handleSearchRateLimit(response.status, "Ricerca Fodder Sniping");
        } else {
          console.error("Errore nella ricerca:", response.status, response.statusText);
        }
      }
    } catch (error) {
      console.error("Errore durante l'invio della richiesta:", error);
    }

    if (start !== true) break;

    // Pacing competitivo per sniping
    chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });
    if ((i + 1) % 25 === 0) {
      await clearSoldItem();
    }

    let randomValue;
    if ((i + 1) % 25 === 0) {
      randomValue = getRandomGaussian(2.5, 0.3, 2.0, 3.2);
    } else {
      randomValue = getRandomGaussian(0.9, 0.12, 0.7, 1.25);
    }

    await sleep(randomValue * 1000);
    i++;
  }

  //pulisco la lista trasferimenti dagli elementi venduti a fine tentativi
  await clearSoldItem()

}



// Converte prezzi in formato stringa ("2K", "2.1K", "11.75K", "1.2M", "2,500") o numerico in crediti interi
function parseFodderPrice(price) {
  if (typeof price === 'number') return Math.round(price);
  if (!price || typeof price !== 'string') return 0;

  const raw = price.trim().toUpperCase();
  if (raw.endsWith('M')) {
    const numStr = raw.slice(0, -1).replace(',', '.');
    const val = parseFloat(numStr);
    return isNaN(val) ? 0 : Math.round(val * 1000000);
  }
  if (raw.endsWith('K')) {
    const numStr = raw.slice(0, -1).replace(',', '.');
    const val = parseFloat(numStr);
    return isNaN(val) ? 0 : Math.round(val * 1000);
  }

  const clean = raw.replace(/[^\d.]/g, '');
  const val = parseFloat(clean);
  return isNaN(val) ? 0 : Math.round(val);
}

async function getFdderList() {
  const fodderUrl = 'http://localhost:3000/fut/fodder?rating=' + fodderRating;

  try {
    const response = await fetch(fodderUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json"
      }
    });

    if (response.ok) {
      const data = await response.json();

      // Supporta sia il nuovo formato ("players") sia il precedente ("data") o array diretto
      const rawList = Array.isArray(data.players)
        ? data.players
        : Array.isArray(data.data)
          ? data.data
          : Array.isArray(data)
            ? data
            : [];

      if (rawList.length > 0) {
        rawList.forEach(item => {
          const pid = item.id || item.pid || item.assetId || item.resourceId || item.definitionid;
          const rawPrice = item.price ?? item.prices?.console?.bin ?? item.prices?.ps?.bin ?? item.bin;
          const parsedPrice = parseFodderPrice(rawPrice);

          if (pid && parsedPrice > 0) {
            listaFodder.push({
              pid: String(pid),
              name: item.name || "",
              price: parsedPrice,
              rating: item.rating || Number(fodderRating)
            });
          }
        });

        const source = data.source || "server";
        console.log(`[FC Sniper] Ho recuperato ${listaFodder.length} fodder (rating ${fodderRating}) da ${source}`);
      } else {
        console.warn(`[FC Sniper] Nessun fodder trovato nella risposta per rating ${fodderRating}`);
      }
    } else {
      console.error(`[FC Sniper] Errore risposta server fodder: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Errore durante recupero lista dei fodder dal server' });
    console.error("Errore durante recupero lista dei fodder dal server:", error);
  }
}




chrome.runtime.onMessage.addListener(async (message) => {
  if (message.tipo === 'FODDER_MODE') {
    ricercaFodder = !!message.valore;
    if (message.targetMode) targetMode = message.targetMode;
    else targetMode = ricercaFodder ? "fodder" : "consumables";
    ricercaFodder = (targetMode === "fodder");
    if (targetMode !== "fodder") {
      listaFodder = [];
      indexFodder = 0;
    }
    if (message.chemStyle) chemStyle = message.chemStyle;
    if (message.autoBin !== undefined) autoBin = message.autoBin;
    if (message.manualBin !== undefined) manualBin = message.manualBin;
    if (message.rating) {
      fodderRating = message.rating;
    }
    if (message.strategyMode) {
      strategyMode = message.strategyMode;
    }
    if (message.minMargin) {
      minMargin = message.minMargin;
    }
  }
});

function getNextFodder() {
  const fodder = listaFodder[indexFodder];
  indexFodder = (indexFodder + 1) % listaFodder.length;
  return fodder;
}


async function sellFodder(price) {

  sellUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/auctionhouse"
  if (!xUtSid) {
    console.error("X-UT-SID non definito");
    return;
  }

  for (id of idCarteAcquistate) {

    const headers = new Headers({
      "accept": "*/*",
      "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
      "content-type": "application/json",
      "x-ut-sid": xUtSid
    });

    const step = getEaStep(price);
    const startBid = Math.max(price - step, 200);

    const body = {
      "buyNowPrice": price,
      "duration": 3600,
      "itemData": {
        "id": id
      },
      "startingBid": startBid
    };

    const bodyJson = JSON.stringify(body);

    try {
      await triggerPinEvent("TRIGGER_PIN_SELL", { itemId: id, price });

      const response = await fetch(sellUrl, {
        method: "POST",
        headers: headers,
        body: bodyJson,
        referrer: "https://www.ea.com/",
        mode: "cors",
        credentials: "omit"
      });

      if (response.ok) {
        consecutive401Errors = 0;
        const data = await response.json();

        chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Carta messa in vendita a: ' + price + ' crediti' });
      } else {
        if (response.status === 401) {
          await handle401Error("Messa in Vendita Fodder");
        }
        console.error(`[FC Sniper] Errore HTTP: ${response.status} ${response.statusText} nella messa in vendita`);
        chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Errore nella messa in vendita a ' + price + ' crediti' });
      }

    } catch (error) {
      console.error("Errore durante la richiesta all'Auction House:", error);
    }

  }

}

// Invia un'offerta (bid) su una specifica asta
async function sendBidRequest(tradeId, bidAmount, itemId, maxBidAllowed = null) {
  const bidUrl = 'https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/trade/' + tradeId + '/bid';
  if (!xUtSid) {
    console.error("X-UT-SID non definito");
    return false;
  }

  // Controllo preventivo saldo crediti: impedisce di inviare richieste destinate a fallire
  if (typeof crediti === 'number' && crediti < bidAmount) {
    console.warn(`[FC Sniper Bid] Crediti insufficienti (${crediti} cr < ${bidAmount} cr richiesti). Offerta annullata su Trade ${tradeId}.`);
    return false;
  }

  // Queue Anti-Collisione Globale (Opzione 3: portato a 1.6s per proteggere dai 512):
  // Garantisce che nessun'offerta verso EA possa partire a meno di 1.6s dalla precedente
  const elapsed = Date.now() - lastBidTimestamp;
  const MIN_BID_INTERVAL_MS = 1600;
  if (elapsed < MIN_BID_INTERVAL_MS) {
    const waitMs = MIN_BID_INTERVAL_MS - elapsed;
    await sleep(waitMs);
  }

  // Telemetria nativa PIN rigorosamente prima dell'invio offerta
  await triggerPinEvent("TRIGGER_PIN_BID", { tradeId, bidAmount, itemId });

  const headers = new Headers({
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    "X-UT-SID": xUtSid
  });

  markTradeAttempted(tradeId);
  const body = JSON.stringify({ bid: bidAmount });

  try {
    const response = await fetch(bidUrl, {
      method: "PUT",
      headers: headers,
      body: body
    });

    lastBidTimestamp = Date.now();
    lastBidErrorStatus = response.status;

    if (response.ok) {
      consecutiveBidErrors = 0;
      consecutive401Errors = 0;
      consecutive470Errors = 0;
      consecutive461InBidding = 0;
      console.log(`[FC Sniper] Offerta di ${bidAmount} crediti inviata (Trade: ${tradeId})`);
      return true;
    } else {
      let errorDetails = "";
      try {
        const errJson = await response.json();
        errorDetails = errJson.reason || errJson.message || JSON.stringify(errJson);
      } catch {
        try { errorDetails = await response.text(); } catch { }
      }

      if (response.status === 401) {
        await handle401Error("Bid");
      } else if (response.status === 429 || response.status === 426 || response.status === 512 || response.status === 521) {
        consecutiveBidErrors++;
        console.warn(`[Bid Fallito ${response.status} - Rate Limit EA] Trade ${tradeId}, offerta ${bidAmount}. Dettagli EA: ${errorDetails}. Errori consecutivi: ${consecutiveBidErrors}`);

        if (strategyMode === "lazy") {
          return false;
        }

        if (consecutiveBidErrors >= 3) {
          console.warn(`[FC Sniper] Rilevati ${consecutiveBidErrors} errori consecutivi di Bid Soft-Ban (${response.status}). Avvio pausa di sicurezza attiva 10 min...`);
          consecutiveBidErrors = 0;
          await executeSafetyPause(600, `Soft-Ban Offerte Asta EA (${response.status})`);
        } else {
          await sleep(getRandomGaussian(8.0, 1.0, 6.0, 10.0) * 1000);
        }
      } else if (response.status === 461) {
        // HTTP 461: Carta non più disponibile (già acquistata via Compra Ora da altri, asta scaduta, o Watchlist satura)
        // NON tentare rilanci: la carta non è più sul mercato.
        console.log(`[FC Sniper Bid 461] Asta non più disponibile o già conclusa su Trade ${tradeId}. Salto carta.`);
        return false;
      } else if (response.status === 470) {
        // HTTP 470: Offerta superata (un altro utente ha offerto un importo superiore su quest'asta ancora aperta)
        consecutive470Errors++;
        console.warn(`[Bid Fallito 470 - Offerta superata] Trade ${tradeId}, offerta ${bidAmount}. Dettagli EA: ${errorDetails}`);
        const step = getEaStep(bidAmount);
        const retryBid = bidAmount + step;
        if (maxBidAllowed && retryBid <= maxBidAllowed && (!crediti || crediti >= retryBid)) {
          console.log(`[FC Sniper 470 Outbid] Offerta a ${bidAmount} cr superata. Controrilancio a ${retryBid} cr (Max: ${maxBidAllowed})...`);
          await sleep(getRandomGaussian(1.0, 0.15, 0.8, 1.2) * 1000);
          return await sendBidRequest(tradeId, retryBid, itemId, maxBidAllowed);
        } else {
          console.log(`[FC Sniper 470 Outbid] Offerta a ${bidAmount} cr superata su Trade ${tradeId}. Prossimo rilancio (${retryBid}) supererebbe il limite (${maxBidAllowed || 'N/D'}). Abbandono.`);
        }
        if (consecutive470Errors >= 4) {
          console.warn(`[FC Sniper] Rilevati ${consecutive470Errors} errori 470 consecutivi. Pausa sincronizzazione aste EA di 4 secondi...`);
          consecutive470Errors = 0;
          await sleep(getRandomGaussian(4.0, 0.4, 3.5, 5.0) * 1000);
        }
        return false;
      } else {
        console.warn(`[Bid Fallito ${response.status}] Trade ${tradeId}, offerta ${bidAmount}. Dettagli EA: ${errorDetails}`);
      }
      return false;
    }
  } catch (error) {
    console.error("Errore durante l'invio dell'offerta:", error);
    return false;
  }
}

// Sposta un singolo oggetto acquistato alla lista trasferimenti
async function moveSingleItemToTrade(itemId) {
  if (!xUtSid || !itemId) return false;
  const transferListUrl = 'https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/item';
  const headers = new Headers({
    "accept": "*/*",
    "content-type": "application/json",
    "X-UT-SID": xUtSid
  });
  const body = JSON.stringify({ itemData: [{ id: Number(itemId), pile: "trade" }] });
  try {
    const res = await fetch(transferListUrl, { method: "PUT", headers, body });
    if (res.ok) {
      return true;
    }
    let errorDetails = "";
    try {
      const errJson = await res.json();
      errorDetails = errJson.reason || errJson.message || JSON.stringify(errJson);
    } catch {
      try { errorDetails = await res.text(); } catch { }
    }
    console.warn(`[FC Sniper MoveToTrade Fallito ${res.status}] Item ${itemId}. Dettagli EA: ${errorDetails}`);
    if (res.status === 401) {
      await handle401Error("MoveToTrade");
    }
    return false;
  } catch (e) {
    console.error("Errore spostamento a tradepile:", e);
    return false;
  }
}

let listingTierCounter = 0;

/**
 * Calcola il prezzo di vendita scaglionato per massimizzare le vendite verso Lazy Buyers
 * Distribuzione richiesta:
 * - Tier A: 30% delle carte -> Markup veloce per rotazione rapida e liquidità (+6%)
 * - Tier B: 50% delle carte -> Markup standard (+10% o lazyMarkupPercent)
 * - Tier C: 20% delle carte -> Markup alto per lazy buyers e micro-picchi (+15%)
 */
function getTieredSellPrice(floorBin, customMarkup = null, isConsumable = true) {
  if (!floorBin || floorBin <= 0) return { price: 0, tier: "B", markup: 10 };

  const baseMarkup = (customMarkup !== null && customMarkup > 0) ? customMarkup : (lazyMarkupPercent || 10);

  // Sequenza interallacciata su 10 carte: 3 A (30%), 5 B (50%), 2 C (20%)
  const tierPattern = [
    { tier: "A", factor: 0.6 }, // 0: Tier A (+6%)
    { tier: "B", factor: 1.0 }, // 1: Tier B (+10%)
    { tier: "B", factor: 1.0 }, // 2: Tier B (+10%)
    { tier: "C", factor: 1.5 }, // 3: Tier C (+15%)
    { tier: "A", factor: 0.6 }, // 4: Tier A (+6%)
    { tier: "B", factor: 1.0 }, // 5: Tier B (+10%)
    { tier: "B", factor: 1.0 }, // 6: Tier B (+10%)
    { tier: "A", factor: 0.6 }, // 7: Tier A (+6%)
    { tier: "B", factor: 1.0 }, // 8: Tier B (+10%)
    { tier: "C", factor: 1.5 }  // 9: Tier C (+15%)
  ];

  const currentSlot = tierPattern[listingTierCounter % tierPattern.length];
  listingTierCounter++;

  const appliedMarkup = Math.max(5, Math.round(baseMarkup * currentSlot.factor));
  let rawPrice = floorBin * (1 + (appliedMarkup / 100));
  let calculatedPrice = roundUpToStep(rawPrice);

  if (isConsumable && calculatedPrice > 5000) {
    calculatedPrice = 5000;
  }

  return {
    price: calculatedPrice,
    tier: currentSlot.tier,
    markup: appliedMarkup
  };
}

// Mette in vendita un singolo oggetto al prezzo Buy Now specificato (e startingBid opzionale)
// Include anti-collisione temporale, capping ai limiti EA, gestione retry su 461 (assestamento/lock) e 426 (rate limit)
async function sellSingleItem(itemId, price, startingBid = null) {
  if (!xUtSid || !itemId) return false;

  // Circuit Breaker: se EA ha attivato il rate limit 426 sulle vendite, non inviare alcuna richiesta
  if (Date.now() < listingRestrictedUntil) {
    const secLeft = Math.ceil((listingRestrictedUntil - Date.now()) / 1000);
    console.warn(`[FC Sniper Listing] Richiesta bloccata dal Circuit Breaker: cooldown attivo per ancora ${secLeft}s.`);
    return false;
  }

  const sellUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/auctionhouse";

  // 1. Normalizzazione prezzo e scalini EA
  let validPrice = Number(price);
  if (isNaN(validPrice) || validPrice <= 0) return false;

  const step = getEaStep(validPrice);
  let startBid = startingBid && startingBid > 0 ? Number(startingBid) : Math.max(validPrice - step, 200);
  startBid = roundDownToStep(startBid);

  const headers = new Headers({
    "accept": "*/*",
    "content-type": "application/json",
    "x-ut-sid": xUtSid
  });

  const body = JSON.stringify({
    buyNowPrice: validPrice,
    duration: 3600,
    itemData: { id: Number(itemId) },
    startingBid: startBid
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    // 2. Queue Anti-Collisione Listing (minimo 1.5s tra richieste di messa in vendita per evitare 426 da spam)
    const elapsed = Date.now() - lastListingTimestamp;
    const MIN_LISTING_INTERVAL_MS = 1500;
    if (elapsed < MIN_LISTING_INTERVAL_MS) {
      await sleep(MIN_LISTING_INTERVAL_MS - elapsed);
    }

    try {
      await triggerPinEvent("TRIGGER_PIN_SELL", { itemId: Number(itemId), price: validPrice });

      const resp = await fetch(sellUrl, {
        method: "POST",
        headers,
        body,
        referrer: "https://www.ea.com/",
        mode: "cors"
      });

      lastListingTimestamp = Date.now();

      if (resp.ok) {
        consecutive401Errors = 0;
        console.log(`[FC Sniper] Carta messa in vendita al BIN: ${validPrice} crediti (Start: ${startBid})`);
        return true;
      }

      let errorDetails = "";
      try {
        const errJson = await resp.json();
        errorDetails = errJson.reason || errJson.message || JSON.stringify(errJson);
      } catch {
        try { errorDetails = await resp.text(); } catch { }
      }

      if (resp.status === 401) {
        await handle401Error("Listing");
        return false;
      }

      // Se errore 426 (Action Rate Limit o throttle temporaneo su auctionhouse):
      // Attiviamo il Circuit Breaker per 15 minuti: stop immediato ad ogni richiesta di listing
      if (resp.status === 426) {
        listingRestrictedUntil = Date.now() + (15 * 60 * 1000);
        console.warn(`[FC Sniper Listing] Rate limit 426 su auctionhouse! Attivato stop temporaneo listing per 15 min.`);
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[RATE LIMIT VENDITA] EA ha temporaneamente limitato il listing delle carte (426). Stop immediato alle richieste di vendita per 15 min per far decadere il blocco. Le carte restano al sicuro in Tradepile.`
        });
        return false;
      }

      // Se errore 461 (Permission Denied / Item lock / Carta non ancora registrata in Tradepile):
      // Ritardo di assestamento DB + ri-spostamento esplicito a trade + retry
      if (resp.status === 461 && attempt === 1) {
        console.log(`[FC Sniper Listing] Sincronizzazione DB EA in corso su item ${itemId} (461 temporaneo). Attendo assestamento e riprovo...`);
        await sleep(1800);
        await moveSingleItemToTrade(itemId);
        await sleep(1500);
        continue;
      }

      console.warn(`[FC Sniper Listing Fallito ${resp.status}] Item ${itemId}, prezzo ${validPrice} (Tentativo ${attempt}/2). Dettagli EA: ${errorDetails}`);

      return false;
    } catch (e) {
      console.error(`[FC Sniper Listing Exception] Errore listing item ${itemId}:`, e);
      if (attempt === 1) {
        await sleep(1200);
        continue;
      }
      return false;
    }
  }

  return false;
}

// Aggiunge un'asta alla Watchlist (Lista Osservati) conforme alla Web App ufficiale di EA
async function addToWatchlist(tradeId) {
  if (!xUtSid) return false;

  const url = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/watchlist";
  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    "x-ut-sid": xUtSid
  });
  const body = JSON.stringify({ auctionInfo: [{ id: Number(tradeId) }] });

  try {
    const res = await fetch(url, { method: "PUT", headers, body });
    if (res.ok) {
      consecutive401Errors = 0;
      return true;
    } else if (res.status === 401) {
      await handle401Error("AddToWatchlist");
    } else {
      console.warn(`[FC Sniper Watchlist] Aggiunta agli osservati fallita per Trade ${tradeId} (Status: ${res.status})`);
    }
    return false;
  } catch (err) {
    console.error("[FC Sniper AddToWatchlist Error]", err);
    return false;
  }
}

// Rimuove un'asta persa/scaduta dalla Watchlist per liberare crediti o pulire slot
async function deleteFromWatchlist(tradeId) {
  if (!xUtSid) return;
  const url = `https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/watchlist?tradeId=${tradeId}`;
  const headers = new Headers({
    "accept": "*/*",
    "content-type": "application/json",
    "x-ut-sid": xUtSid
  });
  try {
    const res = await fetch(url, { method: "DELETE", headers });
    if (!res.ok) {
      console.warn(`[FC Sniper Watchlist] Cancellazione trade ${tradeId} non riuscita (Status: ${res.status})`);
    }
  } catch (e) {
    console.error("Errore cancellazione da watchlist:", e);
  }
}

// Recupera il prezzo di mercato reale di un fodder in base al pid/assetId o al rating
async function getFodderPriceForItem(itemData) {
  if (!itemData || targetMode !== "fodder") return 0;
  const assetId = itemData.assetId || itemData.resourceId;
  const rating = itemData.rating;

  // 1. Cerca in listaFodder attualmente caricata in memoria
  if (listaFodder && listaFodder.length > 0) {
    if (assetId) {
      const match = listaFodder.find(f => f.pid == assetId);
      if (match && match.price > 0) return match.price;
    }
    if (rating && String(rating) === String(fodderRating)) {
      const prices = listaFodder.map(f => f.price).filter(p => p > 0);
      if (prices.length > 0) return Math.min(...prices);
    }
  }

  // 2. Se non presente in memoria e abbiamo il rating, interroga il server locale
  if (rating) {
    try {
      const res = await fetch('http://localhost:3000/fut/fodder?rating=' + rating);
      if (res.ok) {
        const json = await res.json();
        const rawList = Array.isArray(json.players)
          ? json.players
          : Array.isArray(json.data)
            ? json.data
            : Array.isArray(json)
              ? json
              : [];
        if (rawList.length > 0) {
          if (assetId) {
            const match = rawList.find(d => (d.id || d.pid || d.assetId || d.resourceId || d.definitionid) == assetId);
            if (match) {
              const rawPrice = match.price ?? match.prices?.console?.bin ?? match.prices?.ps?.bin ?? match.bin;
              const p = parseFodderPrice(rawPrice);
              if (p > 0) return p;
            }
          }
          const bins = rawList.map(d => parseFodderPrice(d.price ?? d.prices?.console?.bin ?? d.prices?.ps?.bin ?? d.bin)).filter(p => p > 0);
          if (bins.length > 0) return Math.min(...bins);
        }
      }
    } catch (e) {
      console.error("[getFodderPriceForItem Error]", e);
    }
  }

  return 0;
}

// Riconciliazione della Watchlist all'avvio: recupera carte vinte e pulisce le perse da sessioni precedenti
async function reconcileWatchlistOnStartup() {
  if (!xUtSid) return;
  await cleanExpiredPendingBids();
  console.log('[FC Sniper] Controllo preliminare Watchlist (Reconciliation)...');
  await triggerPinEvent("TRIGGER_PIN_WATCHLIST");

  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    "x-ut-sid": xUtSid,
  });

  try {
    const response = await fetch(watchListUrl, { method: "GET", headers });
    if (!response.ok) return;

    const data = await response.json();
    const auctions = data.auctionInfo || [];
    const storedBids = await getStoredPendingBids();

    let recoveredWon = 0;
    let cleanedLost = 0;
    const auctionTradeIds = new Set();

    for (const item of auctions) {
      const tradeId = item.tradeId;
      auctionTradeIds.add(String(tradeId));
      const tradeState = item.tradeState;
      const bidState = item.bidState;
      const itemId = item.itemData?.id;
      const tradeIdStr = String(tradeId);
      const tradeIdNum = Number(tradeId);
      const tracked = storedBids[tradeIdStr] || activeBids.get(tradeIdStr) || activeBids.get(tradeIdNum);

      if (tradeState === "closed" || tradeState === "expired" || item.expires === -1 || item.expires === 0) {
        if (bidState === "highest") {
          recoveredWon++;
          let sellPrice = tracked?.sellPrice;

          let tierTag = "";
          if (!sellPrice || sellPrice <= 0) {
            const detectedStyleId = detectChemistryStyle(item, tracked?.playStyleId || chemStyle);

            if (detectedStyleId && CHEM_STYLES[String(detectedStyleId)]) {
              console.log(`[FC Sniper Reconciliation] Rilevato consumabile ${CHEM_STYLES[String(detectedStyleId)].name}. Recupero Lowest BIN...`);
              const floor = await discoverConsumableLowestBin(detectedStyleId, manualBin);
              if (floor > 0) {
                const tiered = getTieredSellPrice(floor, null, true);
                sellPrice = tiered.price;
                tierTag = ` (Tier ${tiered.tier}: +${tiered.markup}%)`;
              }
            } else if (tracked?.isConsumable || item.itemData?.itemType === "training") {
              const floor = await discoverConsumableLowestBin(detectedStyleId || chemStyle, manualBin);
              if (floor > 0) {
                const tiered = getTieredSellPrice(floor, null, true);
                sellPrice = tiered.price;
                tierTag = ` (Tier ${tiered.tier}: +${tiered.markup}%)`;
              }
            } else if (targetMode === "fodder") {
              const fFloor = await getFodderPriceForItem(item.itemData);
              if (fFloor > 0) {
                const tiered = getTieredSellPrice(fFloor, null, false);
                sellPrice = tiered.price;
                tierTag = ` (Tier ${tiered.tier}: +${tiered.markup}%)`;
              }
            }
          }

          await moveSingleItemToTrade(itemId);
          await sleep(getRandomGaussian(1.0, 0.2, 0.8, 1.3) * 1000);
          if (sellPrice > 0) {
            console.log(`[FC Sniper Reconciliation] Rilevata carta vinta (Trade: ${tradeId}). Sposto a lista trasferimenti a ${sellPrice}${tierTag}...`);
            await sellSingleItem(itemId, sellPrice);
          } else {
            console.warn(`[FC Sniper Reconciliation] Rilevata carta vinta (Trade: ${tradeId}), ma prezzo sconosciuto. Spostata a tradepile senza listare.`);
          }
          await removeStoredPendingBid(tradeId);
          delete storedBids[String(tradeId)];
          activeBids.delete(String(tradeId));
          activeBids.delete(Number(tradeId));
        } else {
          // Carta non vinta (outbid o carta solo osservata/scaduta): puliamo la watchlist per non saturarla
          cleanedLost++;
          await deleteFromWatchlist(tradeId);
          await removeStoredPendingBid(tradeId);
          delete storedBids[String(tradeId)];
          activeBids.delete(String(tradeId));
          activeBids.delete(Number(tradeId));
          await sleep(120);
        }
      }
    }

    // Pulizia delle offerte archiviate scadute che non sono più presenti nella watchlist EA
    const now = Date.now();
    let orphanCleaned = 0;
    for (const tradeId in storedBids) {
      if (!auctionTradeIds.has(String(tradeId)) && storedBids[tradeId]?.expiresAt && storedBids[tradeId].expiresAt < now) {
        delete storedBids[tradeId];
        orphanCleaned++;
      }
    }
    if (orphanCleaned > 0) {
      await chrome.storage.local.set({ pendingBids: storedBids });
      console.log(`[FC Sniper Storage] Rimosse ${orphanCleaned} offerte archiviate non più presenti nella watchlist.`);
    }

    if (recoveredWon > 0 || cleanedLost > 0) {
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[Reconciliation] Recuperate e messe in vendita ${recoveredWon} carte vinte, rimosse ${cleanedLost} aste perse.`
      });
    }
  } catch (err) {
    console.error("[Reconciliation Error]", err);
  }
}

// Risolve le aste presenti nella Watchlist (gestisce vincite, controrilanci e rimozioni)
async function resolveWatchlist() {
  if (!xUtSid) return;

  await triggerPinEvent("TRIGGER_PIN_WATCHLIST");

  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache, no-store, must-revalidate",
    "pragma": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": xUtSid,
  });

  try {
    const response = await fetch(watchListUrl, {
      method: "GET",
      headers: headers,
      cache: "no-store",
    });

    if (response.status === 401) {
      await handle401Error("Watchlist");
      return;
    }
    if (!response.ok) return;
    consecutive401Errors = 0;
    const data = await response.json();
    if (data.credits !== undefined) {
      crediti = data.credits;
      chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });
    }
    const auctions = data.auctionInfo || [];
      const storedBids = await getStoredPendingBids();

      const now = Date.now();
      for (const [tradeId, bid] of activeBids.entries()) {
        if (bid && bid.expiresAt && (now - bid.expiresAt > 15000)) {
           console.log(`[FC Sniper Watchlist] Rimozione forzata asta fantasma (Trade: ${tradeId}) scaduta da oltre 15s e bloccata dai server EA.`);
           activeBids.delete(tradeId);
           await removeStoredPendingBid(tradeId);
        }
      }

      for (const item of auctions) {
      const tradeId = item.tradeId;
      const tradeIdStr = String(tradeId);
      const tradeIdNum = Number(tradeId);
      const tradeState = item.tradeState; // "active", "closed", "expired"
      const bidState = item.bidState;     // "highest", "outbid"
      const tracked = storedBids[tradeIdStr] || activeBids.get(tradeIdStr) || activeBids.get(tradeIdNum);
      const itemId = item.itemData?.id || tracked?.itemId;

      if (tradeState === "active") {
        // Aggiorna la scadenza precisa fornita da EA per calcolare i secondi rimanenti
        if (tracked && item.expires !== undefined) {
          tracked.expiresAt = Date.now() + (item.expires * 1000);
          activeBids.set(tradeIdStr, tracked);
          activeBids.set(tradeIdNum, tracked);
        }
      }

      if (tradeState === "closed" || tradeState === "expired" || item.expires === -1 || item.expires === 0) {
        if (bidState === "highest") {
          // Incrementa subito il conteggio delle carte vinte prima di spostare
          carteAcquistate += 1;
          carteVinteCiclo += 1;
          chrome.runtime.sendMessage({ tipo: 'CARTA_ACQUISTATA', valore: carteAcquistate });

          let sellPrice = tracked?.sellPrice;
          let tierTag = "";

          if (tracked?.basePrice) {
            const tiered = getTieredSellPrice(tracked.basePrice, null, false);
            sellPrice = tiered.price;
            tierTag = ` (Tier ${tiered.tier}: +${tiered.markup}%)`;
          }

          if (!sellPrice || sellPrice <= 0) {
            const isPlayerCard = item.itemData?.itemType === "player" || (!tracked?.isConsumable && item.itemData?.itemType !== "training");
            if (isPlayerCard) {
              if (targetMode === "fodder") {
                const fFloor = await getFodderPriceForItem(item.itemData);
                if (fFloor > 0) {
                  const tiered = getTieredSellPrice(fFloor, null, false);
                  sellPrice = tiered.price;
                  tierTag = ` (Tier ${tiered.tier}: +${tiered.markup}%)`;
                }
              }
            } else {
              const detectedStyleId = detectChemistryStyle(item, tracked?.playStyleId || chemStyle);
              if (detectedStyleId && CHEM_STYLES[String(detectedStyleId)]) {
                console.log(`[FC Sniper Watchlist] Risoluzione dinamica prezzo per ${CHEM_STYLES[String(detectedStyleId)].name}...`);
                const floor = await discoverConsumableLowestBin(detectedStyleId, manualBin);
                if (floor > 0) {
                  const tiered = getTieredSellPrice(floor, null, true);
                  sellPrice = tiered.price;
                  tierTag = ` (Tier ${tiered.tier}: +${tiered.markup}%)`;
                }
              } else if (tracked?.isConsumable || item.itemData?.itemType === "training") {
                const floor = await discoverConsumableLowestBin(detectedStyleId || chemStyle, manualBin);
                if (floor > 0) {
                  const tiered = getTieredSellPrice(floor, null, true);
                  sellPrice = tiered.price;
                  tierTag = ` (Tier ${tiered.tier}: +${tiered.markup}%)`;
                }
              }
            }
          }

          const buyPrice = item.currentBid || tracked?.bidAmount || 'N/D';

          await moveSingleItemToTrade(itemId);
          await sleep(getRandomGaussian(1.0, 0.2, 0.8, 1.3) * 1000);

          if (sellPrice && sellPrice > 0) {
            const listed = await sellSingleItem(itemId, sellPrice);
            if (listed) {
              chrome.runtime.sendMessage({ tipo: 'LOG', valore: `ASTA VINTA a ${buyPrice} crediti! Messa in vendita a ${sellPrice} crediti${tierTag}.` });
            } else {
              chrome.runtime.sendMessage({ tipo: 'LOG', valore: `ASTA VINTA a ${buyPrice} crediti! Spostata in lista trasferimenti (sarà messa in vendita dal recupero Tradepile).` });
            }
          } else {
            chrome.runtime.sendMessage({ tipo: 'LOG', valore: `ASTA VINTA a ${buyPrice} crediti! Spostata in lista trasferimenti (Prezzo sconosciuto, non listata).` });
          }

          await removeStoredPendingBid(tradeId);
          activeBids.delete(String(tradeId));
          activeBids.delete(Number(tradeId));
        } else {
          await deleteFromWatchlist(tradeId);
          await removeStoredPendingBid(tradeId);
          activeBids.delete(String(tradeId));
          activeBids.delete(Number(tradeId));
          console.log(`[FC Sniper Watchlist] Asta conclusa non vinta (Trade: ${tradeId}). Rimossa dagli osservati.`);
        }
      }
    }

    // Queue Bidding & Controrilanci Watchlist:
    // Raccoglie le aste attive su cui siamo stati SUPERATI (outbid)
    const eligibleActions = [];
    for (const item of auctions) {
      if (item.tradeState === "active") {
        const tradeId = item.tradeId;
        const tracked = storedBids[String(tradeId)] || activeBids.get(tradeId) || activeBids.get(Number(tradeId));
        if (tracked && tracked.maxBidAllowed) {
          const nextBid = calculateNextBid(item.startingBid, item.currentBid);

          // Eseguiamo controlli di abbandono o controrilancio SOLO se siamo stati superati (outbid)!
          // Se siamo "highest", siamo la miglior offerta: l'asta è vincente e NON va toccata né cancellata!
          if (item.bidState === "outbid") {
            if (nextBid > tracked.maxBidAllowed) {
              console.log(`[FC Sniper Watchlist] Asta Trade ${tradeId} (${tracked.name || 'Trade ' + tradeId}) superata da altro utente a ${item.currentBid}. Il prossimo rilancio (${nextBid}) supererebbe il limite (${tracked.maxBidAllowed}). Abbandono.`);
              await removeStoredPendingBid(tradeId);
              activeBids.delete(String(tradeId));
              activeBids.delete(Number(tradeId));
              continue;
            }

            // Se abbiamo già provato ad offrire su questo identico currentBid ed è fallito (es. 470 outbid race),
            // non insistiamo alla cieca: attendiamo che la watchlist di EA si aggiorni con il vero prezzo superato
            if (tracked.failedAtCurrentBid !== undefined && tracked.failedAtCurrentBid === item.currentBid) {
              continue;
            }

            // Altrimenti se il prossimo rilancio rientra nel budget, controrilanciamo!
            eligibleActions.push({ item, tracked });
          }
        }
      }
    }

    if (eligibleActions.length > 0) {
      // Ordina per urgenza: chi scade prima riceve l'offerta per primo
      eligibleActions.sort((a, b) => (a.item.expires || 0) - (b.item.expires || 0));

      for (const { item, tracked } of eligibleActions) {
        // Circuit Breaker: se l'offerta precedente ha ricevuto un rate-limit da EA, fermiamo la coda
        if (lastBidErrorStatus === 429 || lastBidErrorStatus === 426 || lastBidErrorStatus === 512 || lastBidErrorStatus === 521) {
          console.warn(`[FC Sniper Queue] Rate limit EA attivo (${lastBidErrorStatus}). Sospendo la coda offerte Watchlist.`);
          break;
        }

        const tradeId = item.tradeId;
        const itemId = item.itemData?.id || tracked?.itemId;
        let nextBid = calculateNextBid(item.startingBid, item.currentBid);

        const nextRebidNumber = (tracked.rebidCount || 0) + 1;

        // All-In Tattico (dopo 5 controrilanci di fila, dal 6° rilancio in poi):
        if (nextRebidNumber > 5 && nextBid < tracked.maxBidAllowed) {
          console.log(`[FC Sniper All-In Tattico] Asta fortemente contesa (${nextRebidNumber}° rilancio) su Trade ${tradeId}. Salto direttamente al Max Bid (${tracked.maxBidAllowed} crediti) per risolvere subito l'asta!`);
          nextBid = tracked.maxBidAllowed;
        }

        if (nextBid <= tracked.maxBidAllowed) {
          if (typeof crediti === 'number' && crediti < nextBid) {
            console.log(`[FC Sniper Watchlist] Controrilancio annullato su Trade ${tradeId}: crediti insufficienti (${crediti} cr < ${nextBid} cr).`);
            continue;
          }

          console.log(`[FC Sniper Queue] CONTRORILANCIO #${nextRebidNumber} (Sniper a ${item.expires}s) su Trade ${tradeId}: superato a ${item.currentBid}, rilancio a ${nextBid} crediti (Max: ${tracked.maxBidAllowed})`);

          const ok = await sendBidRequest(tradeId, nextBid, itemId, tracked.maxBidAllowed);
          if (ok) {
            tracked.bidAmount = nextBid;
            tracked.rebidCount = nextRebidNumber;
            delete tracked.failedAtCurrentBid;
            tracked.expiresAt = Date.now() + (item.expires * 1000);
            await storePendingBid(tradeId, tracked);
            activeBids.set(String(tradeId), tracked);
            // Ritardo rapido tra offerte consecutive
            await sleep(getRandomGaussian(2.0, 0.25, 1.6, 2.5) * 1000);
          } else {
            // Se fallito (es. 470 outbid race), memorizziamo che su questo currentBid abbiamo già provato
            tracked.failedAtCurrentBid = item.currentBid;
            await storePendingBid(tradeId, tracked);
            activeBids.set(String(tradeId), tracked);

            // Se fallito per rate limit EA, interrompiamo subito la coda per non accumulare errori e segnaliamo la restrizione
            if (lastBidErrorStatus === 429 || lastBidErrorStatus === 426 || lastBidErrorStatus === 512 || lastBidErrorStatus === 521) {
              console.warn(`[FC Sniper Queue] Errore ${lastBidErrorStatus} su Trade ${tradeId}. Arresto coda offerte e attivo restrizione.`);
              marketRestricted = true;
              break;
            }
            if (lastBidErrorStatus === 470) {
              console.warn(`[FC Sniper Queue] Errore 470 su Trade ${tradeId} (asta desincronizzata). Sospendo la coda per permettere sincronizzazione.`);
              break;
            }
          }
        } else if (nextBid > tracked.maxBidAllowed) {
          console.log(`[FC Sniper] Asta Trade ${tradeId} superata a ${item.currentBid}. Il prossimo rilancio (${nextBid}) supererebbe il limite (${tracked.maxBidAllowed}). Abbandono.`);
          await removeStoredPendingBid(tradeId);
          activeBids.delete(String(tradeId));
          activeBids.delete(Number(tradeId));
        }
      }
    }

    const activeCount = auctions.filter(a => a.tradeState === "active").length;
    return activeCount;
  } catch (err) {
    console.error("[Error resolving watchlist]", err);
    return 0;
  }
}

// Motore principale di MASS BIDDING Fodder
async function sendFodderBiddingRequest() {
  let i = 0;
  while (start === true && i < numeroTentativi) {
    // 1. Controllo prioritario aste urgenti (<= 20s): attende e risolve senza consumare tentativi di ricerca
    while (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 20000 && start === true) {
      const secLeft = Math.max(0, Math.round(getUrgentAuctionTimeRemaining() / 1000));
      console.log(`[FC Sniper] Asta urgente in chiusura (~${secLeft}s). Controllo Watchlist per difesa/risoluzione...`);
      await sleep(getRandomGaussian(2.0, 0.2, 1.5, 2.5) * 1000);
      await resolveWatchlist();
    }

    if (start !== true) break;

    // Ad inizio e ad ogni giro completo della lista, ricarica i prezzi dal server
    if (i === 0 || indexFodder === 0 || listaFodder.length === 0) {
      if (i > 0) {
        console.log('[FC Sniper] Giro fodder completato. Ricarico lista e prezzi aggiornati dal server...');
      }
      listaFodder = [];
      indexFodder = 0;
      await getFdderList();
    }

    if (listaFodder.length === 0) {
      console.log('[FC Sniper] Nessun fodder disponibile dal server. Attendo...');
      await sleep(3000);
      i++;
      continue;
    }

    const next = getNextFodder();
    const marketPrice = next.price; // Lowest BIN live dal server
    const netIncome = Math.floor(marketPrice * 0.95);
    const targetMargin = calculateTargetMargin(marketPrice, minMargin);
    const maxBidAllowed = roundDownToStep(netIncome - targetMargin);

    // Protezione margine zero (se maxBidAllowed < 700 per un oro raro, non c'è margine)
    if (maxBidAllowed < 700) {
      console.log(`[FC Sniper] Fodder ${next.name ? next.name + ' (PID ' + next.pid + ')' : 'PID ' + next.pid} (Rating ${fodderRating}, BIN ${marketPrice}): margine insufficiente (Max Bid ${maxBidAllowed} < 700). Salto.`);
      i++;
      await sleep(600);
      continue;
    }

    // Parametri base della ricerca (sempre start=0 per vedere le aste in chiusura immediata)
    const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
    const minBidBumps = [150, 200, 250];
    let offersCount = 0;

    for (let attempt = 0; attempt < minBidBumps.length; attempt++) {
      if (start !== true) break;

      // Check rapido prima di ogni tentativo di ricerca: se un'asta è diventata urgente (<= 20s),
      // interrompiamo subito la ricerca per andare a partecipare/difendere l'asta in chiusura
      if (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 20000) {
        console.log(`[FC Sniper] Rilevata asta urgente (<= 20s) durante la ricerca. Interrompo per partecipare subito.`);
        break;
      }

      const url = new URL(baseUrl);
      url.searchParams.set("num", "21");
      url.searchParams.set("start", "0");
      url.searchParams.set("type", "player");
      url.searchParams.set("maskedDefId", next.pid);
      url.searchParams.set("macr", String(maxBidAllowed));
      url.searchParams.set("micr", String(minBidBumps[attempt]));

      triggerPinEvent("TRIGGER_PIN_SEARCH");

      const headers = new Headers({
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "X-UT-SID": xUtSid
      });

      try {
        const response = await fetch(url.href, { method: "GET", headers });
        if (response.ok) {
          consecutive401Errors = 0;
          const data = await response.json();
          const auctions = data.auctionInfo || [];

          // Offerte mirate su aste in scadenza negli ultimi 30 secondi (Sniper Bidding diretto)
          const SNIPER_WINDOW_SEC = 30;
          const MAX_WATCHLIST_CAPACITY = 48; // Limite del gioco EA (Watchlist max 50 slot)

          for (const auction of auctions) {
            if (start !== true) break;
            const tradeIdStr = String(auction.tradeId);
            if (activeBids.has(tradeIdStr) || auction.bidState === "highest") continue;

            const nextBid = calculateNextBid(auction.startingBid, auction.currentBid);
            if (nextBid > maxBidAllowed) continue;

            // Asta in scadenza negli ultimi 30 secondi con margine -> Offerta diretta immediata
            if (auction.expires > 0 && auction.expires <= SNIPER_WINDOW_SEC) {
              if (activeBids.size >= MAX_WATCHLIST_CAPACITY) {
                console.log(`[FC Sniper] Watchlist piena (${activeBids.size}/${MAX_WATCHLIST_CAPACITY}). Attendo risoluzione aste correnti.`);
                break;
              }

              console.log(`[FC Sniper] Asta in chiusura (${auction.expires}s) per ${next.name || 'PID ' + next.pid}: offro ${nextBid} crediti (Max: ${maxBidAllowed}, BIN: ${marketPrice}, Margine: ${targetMargin})`);

              const ok = await sendBidRequest(auction.tradeId, nextBid, auction.itemData?.id);
              if (ok) {
                offersCount++;
                const bidData = {
                  pid: next.pid,
                  name: next.name,
                  sellPrice: marketPrice,
                  maxBidAllowed: maxBidAllowed,
                  bidAmount: nextBid,
                  rating: fodderRating,
                  itemId: auction.itemData?.id,
                  expiresAt: Date.now() + (auction.expires * 1000),
                  rebidCount: 0
                };
                activeBids.set(tradeIdStr, bidData);
                activeBids.set(Number(auction.tradeId), bidData);
                await storePendingBid(auction.tradeId, bidData);
              } else if (lastBidErrorStatus === 429 || lastBidErrorStatus === 426 || lastBidErrorStatus === 512 || lastBidErrorStatus === 521) {
                console.warn(`[FC Sniper Queue] Rate limit EA durante offerta su ${next.name || next.pid}. Interrompo ulteriori offerte su questo calciatore.`);
                break;
              }

              // Ritardo rapido e fluido tra offerte
              await sleep(getRandomGaussian(1.1, 0.15, 0.9, 1.35) * 1000);
            }
          }

          if (offersCount > 0) {
            console.log(`[FC Sniper] ${offersCount} offerte piazzate per ${next.name || 'PID ' + next.pid}.`);
            break;
          } else {
            if (attempt < minBidBumps.length - 1) {
              await sleep(getRandomGaussian(0.50, 0.08, 0.40, 0.65) * 1000);
            }
          }
        } else if (response.status === 401) {
          await handle401Error("Ricerca Bidding");
          break;
        } else if (response.status === 458) {
          console.warn("[FC Sniper Ricerca Bidding] CAPTCHA 458 rilevato!");
          chrome.runtime.sendMessage({
            tipo: 'LOG',
            valore: '[ATTENZIONE - CAPTCHA RILEVATO] Verifica richiesta nella Web App. Bot arrestato.'
          });
          start = false;
          break;
        } else if (response.status === 429 || response.status === 426 || response.status === 521 || response.status === 512) {
          await handleSearchRateLimit(response.status, "Bidding Fodder");
          break;
        } else {
          console.warn(`[FC Sniper Ricerca Bidding] Errore HTTP ${response.status}: ${response.statusText}`);
          break;
        }
      } catch (err) {
        console.error("Errore ricerca bidding:", err);
        break;
      }
    }

    if (start !== true) break;

    // 2. Risoluzione Watchlist disaccoppiata e mirata:
    // Se abbiamo piazzato offerte o abbiamo aste in chiusura immediata (<= 20s), difendiamo fino alla conclusione
    if (offersCount > 0 && start === true) {
      await sleep(getRandomGaussian(1.2, 0.15, 1.0, 1.5) * 1000);
      await resolveWatchlist();
    }
    while (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 20000 && start === true) {
      await sleep(getRandomGaussian(1.8, 0.2, 1.4, 2.3) * 1000);
      await resolveWatchlist();
    }

    // Aggiornamento contatore tentativi rimasti
    chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });

    let randomValue;
    if ((i + 1) % 50 == 0 && i != numeroTentativi - 1) {
      randomValue = getRandomInRange(120, 180); // sleep tra 2 e 3 minuti ogni 50 tentativi (ridotto da 5-7 min)
      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Cool down di: ' + randomValue + ' sec' });
      await clearSoldItem();
    } else if ((i + 1) % 5 == 0) {
      randomValue = getRandomGaussian(4.0, 0.4, 3.4, 4.8); // breve pausa ogni 5 calciatori
    } else {
      randomValue = getRandomGaussian(2.4, 0.3, 2.0, 2.9); // 2.0-2.8 secondi tra un calciatore e l'altro
    }

    // Pausa naturale tra calciatori (o cool down ogni 50 tentativi).
    let remainingSleepMs = randomValue * 1000;
    while (remainingSleepMs > 0 && start === true) {
      if (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 20000) {
        break; // Sveglia immediata: l'asta è entrata nei 20 secondi!
      }
      const chunk = Math.min(500, remainingSleepMs);
      await sleep(chunk);
      remainingSleepMs -= chunk;
    }
    i++;
  }

  // Chiusura finale: se i tentativi sono terminati, attendiamo che le aste ancora attive scadano e si risolvano
  if (start !== true) return;
  let activeRemaining = await resolveWatchlist();
  if (activeRemaining > 0 && start === true) {
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `Tentativi terminati. In attesa della chiusura di ${activeRemaining} aste in corso...`
    });

    let waitTimer = 0;
    while (waitTimer < 130 && start === true) {
      await sleep(10000);
      waitTimer += 10;
      activeRemaining = await resolveWatchlist();
      if (activeRemaining === 0) break;
    }
  }

  // Risoluzione finale e pulizia
  await resolveWatchlist();
  chrome.runtime.sendMessage({
    tipo: 'LOG',
    valore: `[TENTATIVI COMPLETATI] Tutte le aste sono concluse! Carte vinte in questa sessione: ${carteAcquistate}`
  });
  await clearSoldItem();
}

// Auto-Discovery del Lowest BIN reale sul mercato per uno Stile Intesa
// Algoritmo di scrematura progressiva: individua il prezzo di vendita istantanea
// riducendo il Buy Now finché non trova poche carte (1-3) tutte con 58-59 minuti rimanenti
async function discoverConsumableLowestBin(playStyleId, manualBinOverride = 0, forceRefresh = false) {
  if (manualBinOverride && manualBinOverride > 0) {
    console.log(`[FC Sniper Consumabili] Usato BIN manuale impostato dall'utente: ${manualBinOverride} crediti`);
    return manualBinOverride;
  }

  const styleMeta = CHEM_STYLES[String(playStyleId)] || { id: playStyleId, name: `Stile ${playStyleId}`, defaultGuess: 3000 };

  // Cache valida per 15 minuti per evitare chiamate ripetute ad ogni ciclo e preservare la quota EA
  const CACHE_TTL_MS = 15 * 60 * 1000;
  if (!forceRefresh && consumableBinCache.has(String(playStyleId))) {
    const cached = consumableBinCache.get(String(playStyleId));
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
      const minsLeft = Math.round((CACHE_TTL_MS - (Date.now() - cached.timestamp)) / 60000);
      console.log(`[FC Sniper Consumabili] Usato Floor BIN in cache (${cached.price} cr) per ${styleMeta.name} (valido ancora per ${minsLeft} min)`);
      return cached.price;
    }
  }

  // Protezione Soft-Ban: se il mercato è in restrizione (512 / 429), non effettuare chiamate di ricerca
  if (marketRestricted) {
    if (consumableBinCache.has(String(playStyleId))) {
      const cached = consumableBinCache.get(String(playStyleId));
      console.log(`[FC Sniper Consumabili] Soft-ban attivo: uso Floor BIN in cache (${cached.price} cr) per ${styleMeta.name} senza effettuare ricerche.`);
      return cached.price;
    }
    const fallbackPrice = styleMeta.defaultGuess || 3000;
    console.log(`[FC Sniper Consumabili] Soft-ban attivo: uso prezzo di sicurezza per ${styleMeta.name} (${fallbackPrice} cr) senza effettuare ricerche.`);
    return fallbackPrice;
  }

  console.log(`[FC Sniper Consumabili] Avvio rilevamento Lowest BIN istantaneo per ${styleMeta.name}...`);
  chrome.runtime.sendMessage({
    tipo: 'LOG',
    valore: `[Auto-Discovery] Analisi di mercato per ${styleMeta.name}: cerco il prezzo di vendita istantanea (58-59m)...`
  });

  const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
  const headers = new Headers({
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    "X-UT-SID": xUtSid
  });

  // FASE 1: Ricerca iniziale per determinare il tetto massimo da cui iniziare la scrematura
  let candidateBin = 0;
  const initialCache = consumableBinCache.get(String(playStyleId));
  let startingPrice = initialCache?.price ? initialCache.price + (getEaStep(initialCache.price) * 2) : 0;

  try {
    const probeUrl = new URL(baseUrl);
    probeUrl.searchParams.set("num", "21");
    probeUrl.searchParams.set("start", "0");
    probeUrl.searchParams.set("type", "training");
    probeUrl.searchParams.set("cat", "playStyle");
    probeUrl.searchParams.set("playStyle", String(playStyleId));
    if (startingPrice > 0) {
      probeUrl.searchParams.set("maxb", String(startingPrice));
    }
    probeUrl.searchParams.set("micr", "150");

    triggerPinEvent("TRIGGER_PIN_SEARCH");
    const probeResp = await fetch(probeUrl.href, { method: "GET", headers });
    if (probeResp.status === 401) {
      await handle401Error("AutoDiscovery Consumabili");
      return 0;
    } else if (probeResp.status === 429 || probeResp.status === 426 || probeResp.status === 521 || probeResp.status === 512) {
      await handleSearchRateLimit(probeResp.status, "AutoDiscovery Probe");
      return 0;
    }

    if (probeResp.ok) {
      const probeData = await probeResp.json();
      const probeAuctions = probeData.auctionInfo || [];
      const buyNows = probeAuctions.map(a => a.buyNowPrice).filter(p => p > 0);
      if (buyNows.length > 0) {
        candidateBin = Math.min(...buyNows);
      }
    }
  } catch (e) {
    console.error("[AutoDiscovery Probe Error]", e);
  }

  // Se con il filtro non abbiamo trovato carte, facciamo una ricerca libera aperta per trovare i prezzi presenti
  if (!candidateBin || candidateBin <= 0) {
    await sleep(getRandomGaussian(0.8, 0.1, 0.6, 1.0) * 1000);
    try {
      const openUrl = new URL(baseUrl);
      openUrl.searchParams.set("num", "21");
      openUrl.searchParams.set("start", "0");
      openUrl.searchParams.set("type", "training");
      openUrl.searchParams.set("cat", "playStyle");
      openUrl.searchParams.set("playStyle", String(playStyleId));
      openUrl.searchParams.set("micr", "200");

      triggerPinEvent("TRIGGER_PIN_SEARCH");
      const openResp = await fetch(openUrl.href, { method: "GET", headers });
      if (openResp.status === 401) {
        await handle401Error("AutoDiscovery Open Probe");
        return 0;
      } else if (openResp.status === 429 || openResp.status === 426 || openResp.status === 521 || openResp.status === 512) {
        await handleSearchRateLimit(openResp.status, "AutoDiscovery Open Probe");
        return 0;
      }

      if (openResp.ok) {
        const openData = await openResp.json();
        const openAuctions = openData.auctionInfo || [];
        const openBuyNows = openAuctions.map(a => a.buyNowPrice).filter(p => p > 0);
        if (openBuyNows.length > 0) {
          candidateBin = Math.min(...openBuyNows);
        }
      }
    } catch (e) {
      console.error("[AutoDiscovery Open Probe Error]", e);
    }
  }

  if (!candidateBin || candidateBin <= 0) {
    console.warn(`[FC Sniper Consumabili] Impossibile trovare carte sul mercato per ${styleMeta.name}.`);
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[BLOCCO SICUREZZA] Nessuna carta presente sul mercato per ${styleMeta.name}. Offerte sospese!`
    });
    return 0;
  }

  console.log(`[FC Sniper Consumabili] Inizio scrematura verso il basso per ${styleMeta.name} a partire da ${candidateBin} crediti.`);

  // FASE 2: Scrematura progressiva del prezzo (Downward Skimming)
  // Scendiamo gradino per gradino finché non troviamo:
  // 1) 1-3 carte con tempo rimanente 58-59 minuti (expires >= 3450s) -> VENDITA ISTANTANEA
  // 2) Oppure 0 carte a questo livello (mercato ripulito, mentre al gradino precedente c'erano carte stagnanti) -> VENDITA ISTANTANEA
  const MAX_SCREMATURA_ITERATIONS = 7;
  const MAX_INSTANT_CARDS = 3;
  let verifiedBin = 0;
  let previousPriceHadStale = false;

  for (let stepIdx = 0; stepIdx < MAX_SCREMATURA_ITERATIONS; stepIdx++) {
    if (start !== true) break;

    await sleep(getRandomGaussian(0.9, 0.12, 0.7, 1.2) * 1000);

    const testUrl = new URL(baseUrl);
    testUrl.searchParams.set("num", "21");
    testUrl.searchParams.set("start", "0");
    testUrl.searchParams.set("type", "training");
    testUrl.searchParams.set("cat", "playStyle");
    testUrl.searchParams.set("playStyle", String(playStyleId));
    testUrl.searchParams.set("maxb", String(candidateBin));
    // Variazione micr per bypassare la cache di ricerca EA
    testUrl.searchParams.set("micr", String(150 + (stepIdx * 50)));

    triggerPinEvent("TRIGGER_PIN_SEARCH");

    let auctions = [];
    try {
      const resp = await fetch(testUrl.href, { method: "GET", headers });
      if (resp.status === 401) {
        await handle401Error("AutoDiscovery Scrematura");
        return 0;
      } else if (resp.status === 429 || resp.status === 426 || resp.status === 521 || resp.status === 512) {
        await handleSearchRateLimit(resp.status, "AutoDiscovery Scrematura");
        return 0;
      }
      if (!resp.ok) break;

      const data = await resp.json();
      auctions = data.auctionInfo || [];
    } catch (err) {
      console.error("[AutoDiscovery Scrematura Error]", err);
      break;
    }

    const totalCards = auctions.length;
    // Carte fresche: listate negli ultimi 1-2.5 minuti (58-59 minuti rimanenti)
    const freshCards = auctions.filter(a => (a.expires >= 3450 && a.expires <= 3600) || (a.expires >= 10650 && a.expires <= 10800));
    const staleCards = auctions.filter(a => a.expires > 0 && a.expires < 3450);

    console.log(`[FC Sniper Scrematura] Test maxb: ${candidateBin} crediti -> ${totalCards} carte trovate (Fresche 58-59m: ${freshCards.length}, Stagnanti: ${staleCards.length})`);

    // CASO A: Trovate carte e TUTTE hanno tempo 58-59 minuti rimanenti (staleCards = 0)!
    // Significa che a questo prezzo le carte sono fresche ed è il Lowest BIN reale attivo
    if (totalCards > 0 && staleCards.length === 0) {
      verifiedBin = candidateBin;
      console.log(`[FC Sniper Consumabili] Condizione di vendita istantanea confermata a ${verifiedBin} crediti! (${totalCards} carte, tutte fresche a 58-59 min).`);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[Auto-Discovery] Lowest BIN live per ${styleMeta.name}: ${verifiedBin} crediti (${totalCards} carte fresche a 58-59m)!`
      });
      break;
    }

    // CASO B: 0 carte trovate a questo prezzo
    if (totalCards === 0) {
      // Se a candidateBin ci sono 0 carte, il Lowest BIN reale disponibile sul mercato
      // è lo scalino superiore (candidateBin + step) dove le carte sono effettivamente presenti per essere acquistate!
      const step = getEaStep(candidateBin);
      verifiedBin = candidateBin + step;
      console.log(`[FC Sniper Consumabili] 0 carte trovate a ${candidateBin}. Lowest BIN reale disponibile sul mercato: ${verifiedBin} crediti.`);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[Auto-Discovery] Lowest BIN reale per ${styleMeta.name}: ${verifiedBin} crediti (0 carte a ${candidateBin})!`
      });
      break;
    }

    // CASO C: Ci sono carte stagnanti (< 58m) OPPURE troppe carte (> 3 carte)
    // A questo prezzo le carte NON vendono all'istante. Scremiamo scendendo di un gradino.
    previousPriceHadStale = true;
    const step = getEaStep(candidateBin);
    const nextLower = candidateBin - step;

    if (nextLower < 200) {
      verifiedBin = 200;
      break;
    }

    console.log(`[FC Sniper Scrematura] A ${candidateBin} ci sono ${totalCards} carte (${staleCards.length} ferme da oltre 2 min). Scremo verso il basso a ${nextLower}...`);
    candidateBin = nextLower;
  }

  // Fallback di chiusura se il ciclo termina senza break esplicito
  if (!verifiedBin && candidateBin > 0) {
    verifiedBin = candidateBin;
  }

  // BLOCCANTE DI SICUREZZA
  if (!verifiedBin || verifiedBin <= 0) {
    console.error(`[FC Sniper Consumabili] Auto-Discovery fallita per ${styleMeta.name}: impossibile determinare il prezzo di mercato reale!`);
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[BLOCCO SICUREZZA] Lowest BIN non rilevato per ${styleMeta.name}. Nessuna offerta verrà piazzata!`
    });
    return 0;
  }

  consumableBinCache.set(String(playStyleId), { price: verifiedBin, timestamp: Date.now() });
  return verifiedBin;
}

// Motore principale di MASS BIDDING Consumabili (Stili Intesa)
async function sendConsumableBiddingRequest() {
  let i = 0;
  const targetStyles = (chemStyle === "all") ? ["268", "266", "265"] : [chemStyle];
  let styleIndex = 0;

  while (start === true && i < numeroTentativi) {
    // 1. Controllo prioritario aste urgenti (<= 20s): attende e risolve senza consumare tentativi di ricerca
    while (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 20000 && start === true) {
      const secLeft = Math.max(0, Math.round(getUrgentAuctionTimeRemaining() / 1000));
      console.log(`[FC Sniper Consumabili] Asta urgente in chiusura (~${secLeft}s). Controllo Watchlist per difesa/risoluzione...`);
      await sleep(getRandomGaussian(2.0, 0.2, 1.5, 2.5) * 1000);
      await resolveWatchlist();
    }

    if (start !== true) break;

    const currentStyleId = targetStyles[styleIndex];
    styleIndex = (styleIndex + 1) % targetStyles.length;
    const styleMeta = CHEM_STYLES[currentStyleId] || { id: currentStyleId, name: `Stile ${currentStyleId}`, defaultGuess: 3000 };

    // Recupera Lowest BIN live (aggiorna la prima volta o ogni 5 minuti)
    const marketPrice = await discoverConsumableLowestBin(currentStyleId, manualBin, i === 0);

    // BLOCCO DI SICUREZZA: se il prezzo non è verificato con certezza, salta lo stile ed evita offerte cieche
    if (!marketPrice || marketPrice <= 0) {
      console.warn(`[FC Sniper Consumabili] Prezzo non identificato per ${styleMeta.name}. Salto per sicurezza.`);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[SICUREZZA] Prezzo di mercato sconosciuto per ${styleMeta.name}. Offerte sospese su questo stile!`
      });
      i++;
      await sleep(1500);
      continue;
    }

    const netIncome = Math.floor(marketPrice * 0.95);
    // Su consumabili ad alta rotazione (Ombra e Cacciatore), sottraendo 200 con roundDownToStep
    // il tetto scendeva a 2100-2200 (margine reale 270 crediti) facendoci perdere le aste contro i bot a 2300 (Hunter) e 3200 (Shadow).
    // Calibriamo a minMargin - 50 (minimo 100) per allineare l'offerta massima esattamente alla soglia vincente (2300 su Hunter, 3100-3200 su Shadow):
    const effectiveMargin = Math.max(100, (minMargin || 200) - 50);
    const maxBidAllowed = roundDownToStep(netIncome - effectiveMargin);
    const targetMargin = netIncome - maxBidAllowed; // Margine netto reale

    if (maxBidAllowed < 200) {
      console.log(`[FC Sniper Consumabili] Margine insufficiente per ${styleMeta.name} (Max Bid ${maxBidAllowed} < 200). Salto.`);
      i++;
      await sleep(800);
      continue;
    }

    const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
    const minBidBumps = [150, 200, 250];
    let offersCount = 0;

    for (let attempt = 0; attempt < minBidBumps.length; attempt++) {
      if (start !== true) break;

      if (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 20000) {
        console.log(`[FC Sniper Consumabili] Rilevata asta urgente (<= 20s) durante la ricerca. Interrompo per partecipare subito.`);
        break;
      }

      const url = new URL(baseUrl);
      url.searchParams.set("num", "21");
      url.searchParams.set("start", "0");
      url.searchParams.set("type", "training");
      url.searchParams.set("cat", "playStyle");
      url.searchParams.set("playStyle", String(currentStyleId));
      url.searchParams.set("macr", String(maxBidAllowed));
      url.searchParams.set("micr", String(minBidBumps[attempt]));

      triggerPinEvent("TRIGGER_PIN_SEARCH");

      const headers = new Headers({
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "X-UT-SID": xUtSid
      });

      try {
        const response = await fetch(url.href, { method: "GET", headers });
        if (response.ok) {
          consecutive401Errors = 0;
          const data = await response.json();
          const auctions = data.auctionInfo || [];

          // Offerte mirate su aste in scadenza negli ultimi 30 secondi (Sniper Bidding diretto)
          const SNIPER_WINDOW_SEC = 30;
          const MAX_WATCHLIST_CAPACITY = 48; // Limite del gioco EA (Watchlist max 50 slot)

          for (const auction of auctions) {
            if (start !== true) break;
            const tradeIdStr = String(auction.tradeId);
            if (activeBids.has(tradeIdStr) || auction.bidState === "highest") continue;

            const nextBid = calculateNextBid(auction.startingBid, auction.currentBid);
            if (nextBid > maxBidAllowed) continue; // Nessun margine utile

            // Asta in scadenza negli ultimi 30 secondi con margine -> Offerta diretta immediata
            if (auction.expires > 0 && auction.expires <= SNIPER_WINDOW_SEC) {
              if (activeBids.size >= MAX_WATCHLIST_CAPACITY) {
                console.log(`[FC Sniper Consumabili] Watchlist piena (${activeBids.size}/${MAX_WATCHLIST_CAPACITY}). Attendo risoluzione aste correnti.`);
                break;
              }

              console.log(`[FC Sniper Consumabili] Asta in chiusura (${auction.expires}s) per ${styleMeta.name}: offro ${nextBid} crediti (Max: ${maxBidAllowed}, BIN: ${marketPrice}, Margine: ${targetMargin})`);

              const ok = await sendBidRequest(auction.tradeId, nextBid, auction.itemData?.id);
              if (ok) {
                offersCount++;
                const bidData = {
                  playStyleId: currentStyleId,
                  name: styleMeta.name,
                  sellPrice: marketPrice,
                  maxBidAllowed: maxBidAllowed,
                  bidAmount: nextBid,
                  itemId: auction.itemData?.id,
                  expiresAt: Date.now() + (auction.expires * 1000),
                  rebidCount: 0,
                  isConsumable: true
                };
                activeBids.set(tradeIdStr, bidData);
                activeBids.set(Number(auction.tradeId), bidData);
                await storePendingBid(auction.tradeId, bidData);
              } else if (lastBidErrorStatus === 429 || lastBidErrorStatus === 426 || lastBidErrorStatus === 512 || lastBidErrorStatus === 521) {
                console.warn(`[FC Sniper Queue] Rate limit EA durante offerta su ${styleMeta.name}. Interrompo offerte su questo stile.`);
                break;
              }

              // Ritardo rapido e fluido tra offerte
              await sleep(getRandomGaussian(1.1, 0.15, 0.9, 1.35) * 1000);
            }
          }

          if (offersCount > 0) {
            console.log(`[FC Sniper Consumabili] ${offersCount} offerte piazzate per ${styleMeta.name}.`);
            break;
          } else {
            if (attempt < minBidBumps.length - 1) {
              await sleep(getRandomGaussian(0.50, 0.08, 0.40, 0.65) * 1000);
            }
          }
        } else if (response.status === 401) {
          await handle401Error("Ricerca Bidding Consumabili");
          break;
        } else if (response.status === 458) {
          console.warn("[FC Sniper Ricerca Consumabili] CAPTCHA 458 rilevato!");
          chrome.runtime.sendMessage({
            tipo: 'LOG',
            valore: '[ATTENZIONE - CAPTCHA RILEVATO] Verifica richiesta nella Web App. Bot arrestato.'
          });
          start = false;
          break;
        } else if (response.status === 429 || response.status === 426 || response.status === 521 || response.status === 512) {
          await handleSearchRateLimit(response.status, "Bidding Consumabili");
          break;
        } else {
          console.warn(`[FC Sniper Ricerca Consumabili] Errore HTTP ${response.status}: ${response.statusText}`);
          break;
        }
      } catch (err) {
        console.error("Errore ricerca bidding consumabili:", err);
        break;
      }
    }

    if (start !== true) break;

    // 2. Risoluzione Watchlist disaccoppiata e mirata:
    // Se abbiamo piazzato offerte o abbiamo aste in chiusura immediata (<= 20s), difendiamo fino alla conclusione
    if (offersCount > 0 && start === true) {
      await sleep(getRandomGaussian(1.2, 0.15, 1.0, 1.5) * 1000);
      await resolveWatchlist();
    }
    while (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 20000 && start === true) {
      await sleep(getRandomGaussian(1.8, 0.2, 1.4, 2.3) * 1000);
      await resolveWatchlist();
    }

    chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });

    let randomValue;
    if ((i + 1) % 50 == 0 && i != numeroTentativi - 1) {
      randomValue = getRandomInRange(120, 180);
      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Cool down di: ' + randomValue + ' sec' });
      await clearSoldItem();
    } else if ((i + 1) % 5 == 0) {
      randomValue = getRandomGaussian(4.0, 0.4, 3.4, 4.8);
    } else {
      randomValue = getRandomGaussian(2.4, 0.3, 2.0, 2.9);
    }

    let remainingSleepMs = randomValue * 1000;
    while (remainingSleepMs > 0 && start === true) {
      if (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 20000) {
        break; // Sveglia immediata: l'asta è entrata nei 20 secondi!
      }
      const chunk = Math.min(500, remainingSleepMs);
      await sleep(chunk);
      remainingSleepMs -= chunk;
    }
    i++;
  }

  if (start !== true) return;
  let activeRemaining = await resolveWatchlist();
  if (activeRemaining > 0 && start === true) {
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `Tentativi terminati. In attesa della chiusura di ${activeRemaining} aste in corso...`
    });

    let waitTimer = 0;
    while (waitTimer < 130 && start === true) {
      await sleep(10000);
      waitTimer += 10;
      activeRemaining = await resolveWatchlist();
      if (activeRemaining === 0) break;
    }
  }

  await resolveWatchlist();
  chrome.runtime.sendMessage({
    tipo: 'LOG',
    valore: `[TENTATIVI COMPLETATI] Tutte le aste sono concluse! Carte vinte in questa sessione: ${carteAcquistate}`
  });
  await clearSoldItem();
}

// Motore di SNIPING Consumabili (Stili Intesa) - Ottimizzato per massima velocità e zero ritardi
async function sendConsumableResearchRequest() {
  let i = 0;
  const targetStyles = (chemStyle === "all") ? ["268", "266", "265"] : [chemStyle];
  let styleIndex = 0;

  // Pre-calcolo e fissaggio dei prezzi per tutti gli stili target PRIMA di entrare nel loop di snipe
  // Questo elimina ogni delay/blocco dovuto a scansioni secondarie durante lo sniping
  const styleConfig = {};
  for (const sId of targetStyles) {
    const meta = CHEM_STYLES[sId] || { id: sId, name: `Stile ${sId}`, defaultGuess: 3000 };
    const mPrice = await discoverConsumableLowestBin(sId, manualBin, true);
    let sPrice;
    if (maxSnipePrice && maxSnipePrice > 0) {
      sPrice = maxSnipePrice;
    } else {
      sPrice = roundDownToStep(mPrice * 0.82);
    }
    styleConfig[sId] = { meta, marketPrice: mPrice, snipePrice: sPrice };
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[SNIPING TARGET] ${meta.name} -> Mercato: ${mPrice} cr | Compra Ora Snipe: <= ${sPrice} cr`
    });
  }

  while (start === true && i < numeroTentativi) {
    const currentStyleId = targetStyles[styleIndex];
    styleIndex = (styleIndex + 1) % targetStyles.length;
    const target = styleConfig[currentStyleId];

    if (!target) {
      i++;
      continue;
    }

    if (i % 15 === 0) {
      console.log(`[FC Sniper Sniping] Tentativo ${i + 1}/${numeroTentativi}: cerca ${target.meta.name} a Compra Ora <= ${target.snipePrice}`);
    }

    const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
    const url = new URL(baseUrl);
    url.searchParams.set("num", "21");
    url.searchParams.set("start", "0");
    url.searchParams.set("type", "training");
    url.searchParams.set("cat", "playStyle");
    url.searchParams.set("playStyle", String(currentStyleId));
    url.searchParams.set("maxb", String(target.snipePrice));
    url.searchParams.delete("macr");
    // Cache busting alternando micr solo tra 0 (nessun filtro) e 150
    if (i % 2 === 0) {
      url.searchParams.delete("micr");
    } else {
      url.searchParams.set("micr", "150");
    }

    // 1. Telemetria nativa PIN: inviata rigorosamente PRIMA della ricerca
    await triggerPinEvent("TRIGGER_PIN_SEARCH");

    try {
      const response = await fetch(url.href, {
        method: "GET",
        headers: {
          "Accept": "*/*",
          "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control": "no-cache",
          "Content-Type": "application/json",
          "X-UT-SID": xUtSid
        }
      });

      if (response.ok) {
        consecutiveSearchErrors = 0;
        consecutive401Errors = 0;
        const data = await response.json();
        const auctions = data.auctionInfo || [];

        if (auctions.length > 0) {
          // Filtra le carte sotto o uguali al prezzo di snipe escludendo carte già tentate
          const matching = auctions.filter(a => a.buyNowPrice > 0 && a.buyNowPrice <= target.snipePrice && !isTradeAttempted(a.tradeId));

          if (matching.length > 0) {
            // Ordina per freschezza decrescente: expires più alto (es. 3599s = listata 1s fa) in cima!
            matching.sort((a, b) => (b.expires || 0) - (a.expires || 0));
            const targetAuction = matching[0];

            idCarteAcquistate = [];
            // Invio istantaneo della richiesta di acquisto al primo candidato più recente
            const bought = await sendBuyNowRequest(targetAuction.tradeId, targetAuction.buyNowPrice, targetAuction.itemData?.id);
            if (bought) {
              await sendToTransferList();
              await sellSingleItem(targetAuction.itemData?.id, target.marketPrice);
              crediti = await getCrediti();
              chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });
              // Breve respiro prima di riprendere le ricerche
              await sleep(getRandomGaussian(1.5, 0.2, 1.2, 2.0) * 1000);
            }
          }
        }
      } else if (response.status === 401) {
        await handle401Error("Ricerca Sniping Consumabili");
        break;
      } else if (response.status === 458) {
        console.warn("[FC Sniper Sniping Consumabili] CAPTCHA 458 rilevato!");
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: '[ATTENZIONE - CAPTCHA RILEVATO] Verifica richiesta nella Web App. Bot arrestato.'
        });
        start = false;
        break;
      } else if (response.status === 429 || response.status === 426 || response.status === 521 || response.status === 512) {
        await handleSearchRateLimit(response.status, "Sniping Consumabili");
      } else {
        console.warn(`[FC Sniper Sniping Consumabili] Errore HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      console.error("Errore ricerca sniping consumabili:", error);
    }

    if (start !== true) break;

    chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });

    // Pulizia periodica venduti ogni 25 ricerche per liberare slot
    if ((i + 1) % 25 === 0) {
      await clearSoldItem();
    }

    // Pacing sniping competitivo: 0.7s - 1.25s tra ricerche, con micro-pausa anti-limit ogni 25 ricerche
    let randomValue;
    if ((i + 1) % 25 === 0) {
      randomValue = getRandomGaussian(2.5, 0.3, 2.0, 3.2);
    } else {
      randomValue = getRandomGaussian(0.9, 0.12, 0.7, 1.25);
    }
    await sleep(randomValue * 1000);
    i++;
  }
  await clearSoldItem();
}

// Motore di LAZY TRADING Consumabili (Stili Intesa) con Bidding + Sniping ibrido
async function sendConsumableLazyRequest() {
  let cycle = 1;
  let styleIndex = 0;
  let consecutiveSoftBansInSession = 0;
  let sessionActiveStartTime = Date.now();
  let requiresSoftBanProbe = false;
  const minBidBumps = [150, 200, 250, 300];

  while (start === true) {
    try {
      let consecutive512InCycle = 0;
      let earlyExitRateLimit = false;
      marketRestricted = false;
      const targetStyles = (chemStyle === "all") ? ["268", "266", "265"] : [String(chemStyle)];

    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `=== [LAZY TRADING] Inizio Ciclo #${cycle} ===`
    });

    // FASE 1: Riconciliazione aste Watchlist, auto-discovery prezzi, riscossione vendite, relist automatico con prezzi ricalcolati e vendita carte non listate
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[LAZY TRADING] Fase 1: Riconciliazione aste vinte, rilevamento prezzi live, riscossione vendite e relist ricalcolato...`
    });

    // 1a. Recupera eventuali carte vinte tramite asta (Bidding) dai cicli precedenti
    await reconcileWatchlistOnStartup();
    if (start !== true) break;
    await sleep(1000);

    // 1b. Rilevamento dei prezzi floor per gli stili target per l'intero ciclo (eseguito PRIMA di relistare o listare!)
    const cyclePrices = {};
    for (const sId of targetStyles) {
      if (start !== true) break;
      const meta = CHEM_STYLES[sId] || { id: sId, name: `Stile ${sId}` };
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[Auto-Discovery Ciclo #${cycle}] Rilevamento Lowest BIN per ${meta.name}...`
      });

      const floor = await discoverConsumableLowestBin(sId, manualBin, false);
      if (start !== true) break;
      if (floor && floor > 0) {
        const markup = lazyMarkupPercent && lazyMarkupPercent > 0 ? lazyMarkupPercent : 10;
        const pTierA = Math.min(5000, roundUpToStep(floor * 1.06));
        const pTierB = Math.min(5000, roundUpToStep(floor * (1 + (markup / 100))));
        const pTierC = Math.min(5000, roundUpToStep(floor * 1.15));

        // Regola 2 & Cap-Awareness: calcolo del prezzo massimo di acquisto con guadagno minimo garantito
        // Ricavo netto nel caso peggiore (vendita al prezzo più basso di Tier A al netto del 5% di tassa EA):
        const minNetRevenue = Math.floor(pTierA * 0.95);
        // Richiediamo almeno 200 crediti netti di profitto garantito:
        const MIN_NET_PROFIT = 200;
        let maxBuyAllowed = roundDownToStep(minNetRevenue - MIN_NET_PROFIT);

        // Se per effetto del price cap (5.000 max sui consumabili) o del floor alto il prezzo massimo supera 4500:
        // non paghiamo mai più di 4.500 crediti (perché 5000 * 0.95 = 4750 - 200 = 4550 -> max 4500)!
        if (maxBuyAllowed > 4500) {
          maxBuyAllowed = 4500;
        }

        cyclePrices[sId] = {
          floorBin: floor,
          maxBidAllowed: maxBuyAllowed,
          maxBuyNowAllowed: maxBuyAllowed,
          sellPrice: pTierB,
          meta: meta,
          tierAPrice: pTierA,
          tierBPrice: pTierB,
          tierCPrice: pTierC
        };

        const minProfitText = (minNetRevenue - maxBuyAllowed);
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[PREZZI CICLO #${cycle}] ${meta.name} -> Floor: ${floor} | Prezzo Max Acquisto: <= ${maxBuyAllowed} (Profitto netto min: +${minProfitText} cr) | Vendite Scaglionate: A (+6%): ${pTierA}, B (+${markup}%): ${pTierB}, C (+15%): ${pTierC}`
        });
      }
      if (start !== true) break;
      await sleep(getRandomGaussian(1.5, 0.2, 1.2, 1.8) * 1000);
    }

    if (start !== true) break;

    // 1c. Rimuove le vendute e rimette in vendita quelle invendute RICALCOLANDO I PREZZI (Lowest BIN + 10%)
    await clearSoldItem(cyclePrices);
    if (start !== true) break;
    await sleep(1500);

    // 1d. Controllo inizio ciclo: Mette in vendita eventuali carte bloccate nei Non Assegnati o in Tradepile
    await processUnassignedItems(cyclePrices);
    if (start !== true) break;
    await sleep(1000);
    await listUnlistedTradepileItems(cyclePrices);
    if (start !== true) break;
    await sleep(1000);

    // 1e. Aggiornamento crediti
    crediti = await getCrediti();
    chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });

    if (start !== true) break;

    // FASE 2: Analisi capienza Tradepile e determinazione Target di Ciclo (Target fisso a 100 con ritmo scaglionato protetto)
    const pileInfo = await getTradepileInfo();
    const currentActiveCount = pileInfo.active || 0;
    const currentTotalCount = pileInfo.total || 0;
    const unlistedCount = Math.max(0, currentTotalCount - currentActiveCount);
    const MAX_TRADEPILE_LIMIT = 100;
    const targetSize = targetTradepileSize && targetTradepileSize > 0 ? Math.min(targetTradepileSize, MAX_TRADEPILE_LIMIT) : 50;

    // Spazio fisicamente libero nella Tradepile EA (max 100 totali)
    const physicalFreeSlots = Math.max(0, MAX_TRADEPILE_LIMIT - currentTotalCount);
    // Quante carte mancano per raggiungere l'obiettivo totale desiderato
    const neededToTarget = Math.max(0, targetSize - currentTotalCount);
    const rawMissing = Math.min(physicalFreeSlots, neededToTarget);

    const isListingBlocked = Date.now() < listingRestrictedUntil;
    let cycleTarget = 0;
    if (isListingBlocked && (unlistedCount >= 6 || currentTotalCount >= 85)) {
      const remainingMin = Math.ceil((listingRestrictedUntil - Date.now()) / 60000);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[COOLDOWN LISTING ATTIVO] Ci sono ${unlistedCount} carte in attesa di vendita (${currentTotalCount}/100 in Tradepile) e il listing EA è in pausa (${remainingMin} min). Sospendo acquisti per non bloccare altri crediti.`
      });
      cycleTarget = 0;
    } else {
      // Calcolo dinamico del lotto di riempimento:
      // Se la lista è molto vuota (< 50 carte), rifornisce lotti da 25 carte per riempire rapidamente la Tradepile.
      // Man mano che si riempie (50-80 carte), passa a lotti da 20 carte.
      // A regime (>= 80 carte), effettua rabbocchi da 15 carte.
      let maxBatch = 15;
      if (currentTotalCount < 50) {
        maxBatch = 25;
      } else if (currentTotalCount < 80) {
        maxBatch = 20;
      }
      cycleTarget = Math.min(rawMissing, maxBatch);
      console.log(`[LAZY TRADING] Tradepile: ${currentActiveCount} attive, ${currentTotalCount}/${MAX_TRADEPILE_LIMIT} totali (Mancanti: ${rawMissing}, Target ciclo: ${cycleTarget})`);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY TRADING] Tradepile: ${currentActiveCount} attive (${currentTotalCount}/${targetSize} tot). Mancanti: ${rawMissing}` + (rawMissing > maxBatch ? ` (Acquisti scaglionati: target ${cycleTarget} carte per questo ciclo)` : '')
      });
    }

    // FASE 3: Rifornimento 100% MASS BIDDING con Controrilanci Difensivi (Zero Compra Ora = Zero Rischio 512)
    // FASE 3: Rifornimento Ibrido Protetto (Mass Bidding mirato + eventuale Rabbocco Compra Ora Umano a basso volume)
    if (cycleTarget > 0 && start === true) {
      if (Object.keys(cyclePrices).length === 0) {
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[LAZY TRADING] Impossibile determinare i prezzi di mercato. Salto il rifornimento per questo ciclo.`
        });
      } else {
        let wonInThisCycle = 0;
        let totalBidsPlaced = 0;
        let searchCount = 0;
        let consecutiveErrorsCount = 0;
        let bidPriceOffset = 0;
        const styleSearchCounts = {};
        consecutive461InBidding = 0;
        consecutive512InCycle = 0;
        marketRestricted = false;
        const maxBiddingSearches = Math.max(30, cycleTarget * 2);
        const MAX_ACTIVE_WATCHLIST = 35; // Mantiene 15 slot liberi sui 50 max consentiti da EA

        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[LAZY BIDDING] Step 1: Offerte all'asta a sconto (Target: ${cycleTarget} carte). Finestra 1-10 min, controrilanci attivi...`
        });

        // Loop Offerte all'asta (Step 1)
        while (wonInThisCycle < cycleTarget && searchCount < maxBiddingSearches && start === true) {
          if (marketRestricted || earlyExitRateLimit) break;
          // Verifica rapida crediti (usa il saldo in memoria aggiornato, senza chiamare /watchlist a ogni ricerca!)
          const minBidRequired = Math.min(...targetStyles.map(s => (cyclePrices[s] ? cyclePrices[s].maxBidAllowed : Infinity)));
          if (typeof crediti === 'number' && crediti < minBidRequired && activeBids.size === 0) {
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[LAZY BIDDING] Crediti insufficienti (${crediti} < ${minBidRequired}). Passo al controllo completamento.`
            });
            break;
          }

          // Controllo capienza offerte: se abbiamo già offerte pendenti + vinte sufficienti a coprire il target di ciclo (+ 2 di margine) o watchlist satura
          if ((wonInThisCycle + activeBids.size) >= (cycleTarget + 2) || activeBids.size >= MAX_ACTIVE_WATCHLIST) {
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[LAZY BIDDING] Quota offerte in volo raggiunta (${activeBids.size} attive, ${wonInThisCycle}/${cycleTarget} vinte). Monitoraggio risoluzione aste...`
            });
            while ((wonInThisCycle + activeBids.size) >= (cycleTarget + 2) && activeBids.size > 0 && start === true) {
              await sleep(getRandomGaussian(2.0, 0.3, 1.5, 2.5) * 1000);
              const prevWon = carteAcquistate;
              await resolveWatchlist();
              if (carteAcquistate > prevWon) {
                wonInThisCycle += (carteAcquistate - prevWon);
                consecutive461InBidding = 0;
                chrome.runtime.sendMessage({
                  tipo: 'LOG',
                  valore: `[LAZY BIDDING] Vinta carta all'asta! Progresso ciclo: [${wonInThisCycle}/${cycleTarget}]`
                });
                if (wonInThisCycle >= cycleTarget) break;
              }
            }
            if (wonInThisCycle >= cycleTarget) break;
          }

          const currentStyleId = targetStyles[styleIndex];
          styleIndex = (styleIndex + 1) % targetStyles.length;
          const priceInfo = cyclePrices[currentStyleId];

          if (!priceInfo) {
            searchCount++;
            continue;
          }

          const styleSpecificCount = styleSearchCounts[currentStyleId] || 0;
          styleSearchCounts[currentStyleId] = styleSpecificCount + 1;

          const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
          const url = new URL(baseUrl);
          url.searchParams.set("num", "21");
          url.searchParams.set("start", "0");
          url.searchParams.set("type", "training");
          url.searchParams.set("cat", "playStyle");
          url.searchParams.set("playStyle", String(currentStyleId));
          url.searchParams.set("macr", String(priceInfo.maxBidAllowed));
          url.searchParams.set("micr", String(minBidBumps[(styleSpecificCount + bidPriceOffset) % minBidBumps.length]));

          await triggerPinEvent("TRIGGER_PIN_SEARCH");

          const headers = new Headers({
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br, zstd",
            "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
            "Cache-Control": "no-cache",
            "Content-Type": "application/json",
            "X-UT-SID": xUtSid
          });

          try {
            const res = await fetch(url.href, { method: "GET", headers });
            if (res.ok) {
              consecutiveErrorsCount = 0;
              consecutiveSearchErrors = 0;
              consecutive401Errors = 0;
              const data = await res.json();
              const auctions = data.auctionInfo || [];

              // Filtra aste mirate: in scadenza entro i prossimi 5 minuti (<= 300s) non ancora osservate né tentate
              let targetAuctions = auctions.filter(a =>
                a.expires > 0 &&
                a.expires <= 300 &&
                a.bidState !== "highest" &&
                !activeBids.has(String(a.tradeId)) &&
                !isTradeAttempted(a.tradeId)
              );
              // Se non ci sono aste imminenti, estendiamo fino a 10 minuti (<= 600s)
              if (targetAuctions.length === 0) {
                targetAuctions = auctions.filter(a =>
                  a.expires > 0 &&
                  a.expires <= 600 &&
                  a.bidState !== "highest" &&
                  !activeBids.has(String(a.tradeId)) &&
                  !isTradeAttempted(a.tradeId)
                );
              }

              // Ordina per scadenza crescente
              targetAuctions.sort((a, b) => (a.expires || 0) - (b.expires || 0));

              let bidsInThisSearch = 0;
              let consecutiveFailedBidsInSearch = 0;
              for (const auction of targetAuctions) {
                if (consecutiveFailedBidsInSearch >= 2) break;
                if (start !== true || wonInThisCycle >= cycleTarget || (wonInThisCycle + activeBids.size) >= (cycleTarget + 2) || activeBids.size >= MAX_ACTIVE_WATCHLIST) break;

                const minNextBid = calculateNextBid(auction.startingBid, auction.currentBid);
                // Strong Bid: offre subito circa il 70% del Floor BIN (se superiore a minNextBid) per eliminare la concorrenza casuale
                const strongBidTarget = roundUpToStep(priceInfo.floorBin * 0.70);
                const nextBid = Math.min(priceInfo.maxBidAllowed, Math.max(minNextBid, strongBidTarget));

                if (nextBid <= priceInfo.maxBidAllowed) {
                  // Controllo preventivo crediti per non inviare richieste a vuoto
                  if (typeof crediti === 'number' && crediti < nextBid) {
                    console.log(`[LAZY BIDDING] Saldo crediti insufficiente per offerta (${crediti} cr < ${nextBid} cr richiesti). Salto asta.`);
                    continue;
                  }

                  // Punto D: Sonda di verifica preliminare post-softban (1 sola offerta di prova)
                  if (requiresSoftBanProbe) {
                    chrome.runtime.sendMessage({
                      tipo: 'LOG',
                      valore: `[SONDA ANTI-BAN] Verifica preliminare permessi offerte dopo la pausa di riposo (1 sola offerta test)...`
                    });
                  }

                  // Ritardo umano di ispezione asta (600ms - 1100ms) prima di cliccare "Offri"
                  await sleep(getRandomGaussian(0.8, 0.15, 0.6, 1.1) * 1000);

                  const bidSuccess = await sendBidRequest(auction.tradeId, nextBid, auction.itemData?.id, priceInfo.maxBidAllowed);

                  if (requiresSoftBanProbe) {
                    if (!bidSuccess && lastBidErrorStatus === 461) {
                      chrome.runtime.sendMessage({
                        tipo: 'LOG',
                        valore: `[SONDA ANTI-BAN] L'offerta di test ha ricevuto 461 (Soft-ban EA ancora attivo). L'account necessita di ulteriore riposo: rientro in pausa senza insistere.`
                      });
                      marketRestricted = true;
                      earlyExitRateLimit = true;
                      break;
                    } else if (bidSuccess) {
                      requiresSoftBanProbe = false;
                      chrome.runtime.sendMessage({
                        tipo: 'LOG',
                        valore: `[SONDA ANTI-BAN] Test superato con successo! Permessi di offerta ripristinati da EA.`
                      });
                    }
                  }

                  if (bidSuccess) {
                    totalBidsPlaced++;
                    bidsInThisSearch++;
                    consecutiveFailedBidsInSearch = 0;
                    consecutive461InBidding = 0;
                    if (typeof crediti === 'number') crediti = Math.max(0, crediti - nextBid);
                    const bidData = {
                      playStyleId: currentStyleId,
                      name: priceInfo.meta.name,
                      sellPrice: priceInfo.sellPrice,
                      maxBidAllowed: priceInfo.maxBidAllowed,
                      bidAmount: nextBid,
                      itemId: auction.itemData?.id,
                      expiresAt: Date.now() + (auction.expires * 1000),
                      rebidCount: 0,
                      isConsumable: true
                    };
                    activeBids.set(String(auction.tradeId), bidData);
                    await storePendingBid(auction.tradeId, bidData);

                    chrome.runtime.sendMessage({
                      tipo: 'LOG',
                      valore: `[LAZY BID] Offerta di ${nextBid} crediti su ${priceInfo.meta.name} (Scade in ${Math.round(auction.expires)}s | Max: ${priceInfo.maxBidAllowed}) [Offerte ciclo: ${totalBidsPlaced}]`
                    });

                    // Offerta riuscita: reset errori consecutivi
                    consecutive512InCycle = 0;
                    consecutiveErrorsCount = 0;

                    // Punto B: Pacing umano naturale tra offerte (3.5s - 5.0s) per azzerare i picchi antispam EA
                    await sleep(getRandomGaussian(4.0, 0.4, 3.5, 5.0) * 1000);
                  } else {
                    consecutiveFailedBidsInSearch++;
                    if (lastBidErrorStatus === 461) {
                      consecutive461InBidding++;
                      bidPriceOffset++; // Varia micr per bypassare la cache EA sulla prossima ricerca
                      if (consecutive461InBidding === 3) {
                        console.log("[LAZY BIDDING] 3 aste contese o Watchlist piena (461). Eseguo pulizia Watchlist...");
                        chrome.runtime.sendMessage({
                          tipo: 'LOG',
                          valore: `[LAZY BIDDING] Aste contese o Watchlist satura (461). Eseguo pulizia Watchlist per liberare slot...`
                        });
                        await resolveWatchlist();
                      } else if (consecutive461InBidding >= 6) {
                        // Se ci sono 6 aste contese consecutive, passiamo direttamente allo Step 2 (Compra Ora) SENZA dichiarare soft-ban!
                        console.log(`[LAZY BIDDING] Rilevate ${consecutive461InBidding} aste già chiuse/contese (461). Concludo Step 1 e passo a Compra Ora per rifornire la Tradepile.`);
                        chrome.runtime.sendMessage({
                          tipo: 'LOG',
                          valore: `[LAZY BIDDING] Mercato aste molto conteso (461). Concludo le offerte all'asta e passo direttamente a Compra Ora.`
                        });
                        break;
                      }
                      // Interrompe i tentativi su questa singola pagina e passa alla prossima ricerca
                      break;
                    }
                    if (lastBidErrorStatus === 429 || lastBidErrorStatus === 426 || lastBidErrorStatus === 512 || lastBidErrorStatus === 521) {
                      earlyExitRateLimit = true;
                      console.warn(`[LAZY BIDDING] Avviso rate-limit EA (${lastBidErrorStatus}) su offerta. Attivazione Early-Exit preventiva...`);
                      reportTelemetry('EARLY_EXIT_RATE_LIMIT', `Avviso rate-limit EA (${lastBidErrorStatus}) su offerta. Uscita preventiva dagli acquisti.`, { status: lastBidErrorStatus });
                      chrome.runtime.sendMessage({
                        tipo: 'LOG',
                        valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${lastBidErrorStatus}) rilevato. Per prevenire soft-ban, interrompo gli acquisti per questo ciclo e avvio pausa preventiva di 3 minuti...`
                      });
                      await sleep(getRandomGaussian(180.0, 10.0, 160.0, 210.0) * 1000);
                      break;
                    }
                  }
                }
              }
              if (marketRestricted || earlyExitRateLimit) break;
            } else if (res.status === 401) {
              await handle401Error("Lazy Bidding Search");
              break;
            } else if (res.status === 429 || res.status === 426 || res.status === 521 || res.status === 512) {
              earlyExitRateLimit = true;
              console.warn(`[LAZY BIDDING] Avviso rate-limit EA (${res.status}) su ricerca. Attivazione Early-Exit preventiva...`);
              reportTelemetry('EARLY_EXIT_RATE_LIMIT', `Avviso rate-limit EA (${res.status}) su ricerca. Uscita preventiva dagli acquisti.`, { status: res.status });
              chrome.runtime.sendMessage({
                tipo: 'LOG',
                valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${res.status}) rilevato su ricerca. Interrompo gli acquisti per questo ciclo e avvio pausa preventiva di 3 minuti...`
              });
              await sleep(getRandomGaussian(180.0, 10.0, 160.0, 210.0) * 1000);
              break;
            }
          } catch (e) {
            console.error("[LAZY BIDDING Error]", e);
            consecutiveErrorsCount++;
            if (consecutiveErrorsCount >= 3) break;
          }

          // Risoluzione Watchlist periodica e controrilanci
          if (activeBids.size > 0) {
            const prevWon = carteAcquistate;
            await resolveWatchlist();
            if (carteAcquistate > prevWon) {
              wonInThisCycle += (carteAcquistate - prevWon);
              consecutive461InBidding = 0;
              chrome.runtime.sendMessage({
                tipo: 'LOG',
                valore: `[LAZY BIDDING] Vinta carta all'asta! Progresso ciclo: [${wonInThisCycle}/${cycleTarget}]`
              });
            }
          }

          searchCount++;
          // Pacing umano tra ricerche per evitare soft-ban 512 / 426 (10-12 ricerche/minuto)
          if ((searchCount + 1) % 6 === 0) {
            await sleep(getRandomGaussian(6.0, 0.6, 5.0, 7.5) * 1000);
          } else {
            await sleep(getRandomGaussian(3.6, 0.4, 3.0, 4.5) * 1000);
          }
        }

        // Risoluzione delle aste attive in chiusura (fino a 90 secondi) prima di procedere a Compra Ora
        if (activeBids.size > 0 && start === true && !marketRestricted) {
          while (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 90000 && start === true && !marketRestricted) {
            const secLeft = Math.max(0, Math.round(getUrgentAuctionTimeRemaining() / 1000));
            console.log(`[LAZY BIDDING] Asta in chiusura entro ${secLeft}s. Attendo esito e controrilanci...`);
            await sleep(getRandomGaussian(2.0, 0.2, 1.5, 2.5) * 1000);
            const prevWon = carteAcquistate;
            await resolveWatchlist();
            if (carteAcquistate > prevWon) {
              wonInThisCycle += (carteAcquistate - prevWon);
              consecutive461InBidding = 0;
              chrome.runtime.sendMessage({
                tipo: 'LOG',
                valore: `[LAZY BIDDING] Vinta carta all'asta! Progresso ciclo: [${wonInThisCycle}/${cycleTarget}]`
              });
            }
          }
        }

        // STEP 2: RABBOCCO PROTETTO A COMPRA ORA AL FLOOR BIN (SNIPING IMMEDIATO)
        // Se le aste non hanno coperto tutti gli slot del ciclo target, compriamo i mancanti a Compra Ora al Floor BIN
        // SALTO COMPLETO se sono stati riscontrati troppi errori rate-limit nello Step 1 per proteggere l'account dallo spam!
        if (start === true && !marketRestricted && !earlyExitRateLimit && consecutive512InCycle < 2 && consecutiveErrorsCount < 3) {
          const midPile = await getTradepileInfo();
          const missingActive = Math.max(0, targetSize - midPile.active);
          // Completiamo tutti i mancanti fino alla capienza target del ciclo (max 20 a ciclo per sicurezza anti-ban)
          const topUpTarget = Math.min(cycleTarget - wonInThisCycle, missingActive);

          if (topUpTarget > 0) {
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[LAZY TOP-UP] Step 2: Completamento di ${topUpTarget} slot mancanti in Compra Ora al Floor BIN (Pacing umano protetto)...`
            });

            let topUpBought = 0;
            let topUpSearches = 0;
            let consecutive461InTopUp = 0;
            let minPriceOffset = 0;
            const topUpStyleCounts = {};
            const maxTopUpSearches = Math.max(50, topUpTarget * 6);
            let topUpStyleIdx = 0;
            lastBidErrorStatus = 0;
            lastBuyNowErrorStatus = 0;

            while (topUpBought < topUpTarget && topUpSearches < maxTopUpSearches && start === true) {
              const currentStyleId = targetStyles[topUpStyleIdx];
              topUpStyleIdx = (topUpStyleIdx + 1) % targetStyles.length;
              const priceInfo = cyclePrices[currentStyleId];

              if (!priceInfo || !priceInfo.floorBin || !priceInfo.maxBuyNowAllowed || priceInfo.maxBuyNowAllowed <= 0) {
                topUpSearches++;
                continue;
              }

              // Verifica crediti per Compra Ora
              if (typeof crediti === 'number' && crediti < priceInfo.maxBuyNowAllowed) {
                chrome.runtime.sendMessage({
                  tipo: 'LOG',
                  valore: `[LAZY TOP-UP] Crediti insufficienti (${crediti} < ${priceInfo.maxBuyNowAllowed}) per ulteriori acquisti Compra Ora.`
                });
                break;
              }

              const styleTopUpCount = topUpStyleCounts[currentStyleId] || 0;
              topUpStyleCounts[currentStyleId] = styleTopUpCount + 1;

              const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
              const url = new URL(baseUrl);
              url.searchParams.set("num", "21");
              url.searchParams.set("start", "0");
              url.searchParams.set("type", "training");
              url.searchParams.set("cat", "playStyle");
              url.searchParams.set("playStyle", String(currentStyleId));
              url.searchParams.set("maxb", String(priceInfo.maxBuyNowAllowed));
              url.searchParams.set("micr", String(minBidBumps[(styleTopUpCount + minPriceOffset) % minBidBumps.length]));

              await triggerPinEvent("TRIGGER_PIN_SEARCH");

              const headers = new Headers({
                "Accept": "*/*",
                "Accept-Encoding": "gzip, deflate, br, zstd",
                "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
                "Cache-Control": "no-cache",
                "Content-Type": "application/json",
                "X-UT-SID": xUtSid
              });

              try {
                const res = await fetch(url.href, { method: "GET", headers });
                if (res.ok) {
                  consecutiveErrorsCount = 0;
                  const data = await res.json();
                  const auctions = data.auctionInfo || [];

                  // Esclude carte già tentate (cache anti-fantasma) e accetta solo se entro il prezzo massimo consentito per profitto garantito
                  const validAuctions = auctions.filter(a =>
                    a.buyNowPrice &&
                    a.buyNowPrice <= priceInfo.maxBuyNowAllowed &&
                    !attemptedTradeIds.has(String(a.tradeId))
                  );
                  validAuctions.sort((a, b) => (b.expires || 0) - (a.expires || 0));

                  if (validAuctions.length > 0) {
                    const candidate = validAuctions[0];
                    // Controllo preventivo crediti
                    if (typeof crediti === 'number' && crediti < candidate.buyNowPrice) {
                      chrome.runtime.sendMessage({
                        tipo: 'LOG',
                        valore: `[LAZY TOP-UP] Crediti insufficienti (${crediti} cr < ${candidate.buyNowPrice} cr richiesti) per acquistare ${priceInfo.meta.name}. Concludo Step 2.`
                      });
                      break;
                    }

                    attemptedTradeIds.set(String(candidate.tradeId), Date.now());

                    // Acquisto istantaneo (zero-delay) non appena la carta viene trovata sul mercato
                    const buySuccess = await sendBuyNowRequest(candidate.tradeId, candidate.buyNowPrice, candidate.itemData?.id);
                    if (buySuccess) {
                      topUpBought++;

                        consecutive461InTopUp = 0;
                      wonInThisCycle++;
                      carteVinteCiclo++;
                      consecutive512InCycle = 0;
                      if (typeof crediti === 'number') crediti = Math.max(0, crediti - candidate.buyNowPrice);

                      const candItemId = candidate.itemData?.id;
                      const moved = await moveSingleItemToTrade(candItemId);
                      // Pausa di assestamento database EA (800ms - 1200ms) affinché la transazione sia consolidata in Tradepile
                      await sleep(getRandomGaussian(1.0, 0.2, 0.8, 1.3) * 1000);

                      const tiered = getTieredSellPrice(priceInfo.floorBin, null, true);
                      const listed = await sellSingleItem(candItemId, tiered.price);
                      if (listed) {
                        const netEst = Math.floor(tiered.price * 0.95) - candidate.buyNowPrice;
                        chrome.runtime.sendMessage({
                          tipo: 'LOG',
                          valore: `[LAZY TOP-UP] Acquistata carta (${priceInfo.meta.name}) a ${candidate.buyNowPrice} e listata a ${tiered.price} (Tier ${tiered.tier}: +${tiered.markup}%, Profitto netto stimato: +${netEst} cr) [${topUpBought}/${topUpTarget}]`
                        });
                      } else {
                        chrome.runtime.sendMessage({
                          tipo: 'LOG',
                          valore: `[LAZY TOP-UP] Acquistata carta (${priceInfo.meta.name}) a ${candidate.buyNowPrice}. Spostata in lista trasferimenti (sarà messa in vendita dal recupero Tradepile).`
                        });
                      }

                      // Respiro naturale dopo acquisto e messa in vendita: 3.5s - 4.5s
                      await sleep(getRandomGaussian(3.5, 0.4, 2.8, 4.5) * 1000);
                    } else {
                      // Se l'acquisto fallisce per limit 512 o rate limit reale su Compra Ora
                      if (lastBuyNowErrorStatus === 512 || lastBuyNowErrorStatus === 429 || lastBuyNowErrorStatus === 426 || lastBuyNowErrorStatus === 521) {
                        earlyExitRateLimit = true;
                        console.warn(`[LAZY TOP-UP] Avviso rate-limit EA (${lastBuyNowErrorStatus}) su Compra Ora. Attivazione Early-Exit preventiva...`);
                        reportTelemetry('EARLY_EXIT_RATE_LIMIT', `Avviso rate-limit EA (${lastBuyNowErrorStatus}) su Compra Ora. Uscita preventiva dagli acquisti.`, { status: lastBuyNowErrorStatus });
                        chrome.runtime.sendMessage({
                          tipo: 'LOG',
                          valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${lastBuyNowErrorStatus}) rilevato su Compra Ora. Interrompo gli acquisti per questo ciclo e avvio pausa preventiva di 3 minuti...`
                        });
                        await sleep(getRandomGaussian(180.0, 10.0, 160.0, 210.0) * 1000);
                        break;
                      } else {
                        if (lastBuyNowErrorStatus === 461 || lastBuyNowErrorStatus === 478) {
                            consecutive461InTopUp++;
                            minPriceOffset++;
                            const nextMinBump = minBidBumps[(styleTopUpCount + minPriceOffset) % minBidBumps.length];

                            chrome.runtime.sendMessage({
                              tipo: 'LOG',
                              valore: `[LAZY TOP-UP] Carta anticipata (461). Eseguo nuova ricerca variando prezzo minimo (${nextMinBump} cr)... (${consecutive461InTopUp}/3)`
                            });

                            if (consecutive461InTopUp >= 3) {
                              chrome.runtime.sendMessage({
                                tipo: 'LOG',
                                valore: `[LAZY TOP-UP] Rilevati 3 tentativi consecutivi anticipati su Floor BIN su ricerche diverse. Concludo lo Step 2 e passo alla vendita.`
                              });
                              break;
                            }

                            // Pausa breve e passa subito a una nuova ricerca fresca con prezzo minimo variato
                            await sleep(getRandomGaussian(2.5, 0.3, 2.0, 3.2) * 1000);
                          } else {
                            await sleep(getRandomGaussian(2.5, 0.3, 2.0, 3.2) * 1000);
                          }
                      }
                    }
                  } else {
                    // Nessuna carta trovata sotto il prezzo massimo consentito in questa ricerca:
                    // attendiamo la pausa fisiologica senza alterare i prezzi né sforare i cap EA
                    await sleep(getRandomGaussian(3.8, 0.4, 3.0, 4.8) * 1000);
                  }
                } else if (res.status === 401) {
                  await handle401Error("Lazy Top-Up Search");
                  break;
                } else if (res.status === 429 || res.status === 426 || res.status === 521 || res.status === 512) {
                  earlyExitRateLimit = true;
                  console.warn(`[LAZY TOP-UP] Avviso rate-limit EA (${res.status}) su ricerca Compra Ora. Attivazione Early-Exit preventiva...`);
                  reportTelemetry('EARLY_EXIT_RATE_LIMIT', `Avviso rate-limit EA (${res.status}) su ricerca Compra Ora.`, { status: res.status });
                  chrome.runtime.sendMessage({
                    tipo: 'LOG',
                    valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${res.status}) rilevato su ricerca Compra Ora. Interrompo gli acquisti per questo ciclo e avvio pausa preventiva di 3 minuti...`
                  });
                  await sleep(getRandomGaussian(180.0, 10.0, 160.0, 210.0) * 1000);
                  break;
                }
              } catch (err) {
                console.error("[LAZY TOP-UP Error]", err);
                break;
              }

              topUpSearches++;

              // Monitoraggio attivo Watchlist durante lo Step 2:
              // Ogni 3 ricerche Compra Ora (circa 12-15s), controlla la Watchlist per difendere le aste con controrilanci tempestivi!
              if (activeBids.size > 0 && topUpSearches % 3 === 0 && start === true) {
                const prevWon = carteAcquistate;
                await resolveWatchlist();
                if (carteAcquistate > prevWon) {
                  const newlyWon = (carteAcquistate - prevWon);
                  wonInThisCycle += newlyWon;
                  topUpBought += newlyWon; // Le carte vinte all'asta riducono direttamente gli slot da comprare a BIN!
                  chrome.runtime.sendMessage({
                    tipo: 'LOG',
                    valore: `[LAZY WATCHLIST] Asta vinta durante Compra Ora! Progresso rifornimento: [${topUpBought}/${topUpTarget}]`
                  });
                  if (topUpBought >= topUpTarget) break;
                }
              }
            }
          }
        }

        // Mette in vendita qualsiasi carta vinta/acquistata rimasta non assegnata o non listata
        await processUnassignedItems(cyclePrices);
        await sleep(1000);
        await listUnlistedTradepileItems(cyclePrices);
      }
    } else if (cycleTarget === 0) {
      if (isListingBlocked) {
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[LAZY TRADING] Nessun acquisto per questo ciclo: listing EA in pausa e Tradepile a quota ${currentTotalCount}/${MAX_TRADEPILE_LIMIT} carte (${currentActiveCount} attive).`
        });
      } else {
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[LAZY TRADING] Tradepile già al completo (${currentActiveCount}/${targetSize} carte attive sul mercato, ${currentTotalCount} totali).`
        });
      }
    }

    if (start !== true) break;

    // Notifica riepilogo ciclo e capienza attuale
    let finalPile = await getTradepileInfo();
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[STATO TRADEPILE] ${finalPile.active}/${targetSize} carte attive sul mercato (${finalPile.total} totali in lista trasferimenti).`
    });

    if (start !== true) break;

    // Reset contatori errori soft-ban per il prossimo ciclo dopo il riposo
    consecutive512Errors = 0;
    consecutiveSnipeErrors = 0;

    // FASE 4: Pausa e Raffreddamento
    // Se è stato rilevato un rate limit / 512, lasciamo riposare l'account per almeno 25 min (o lazySleepMinutes)
    // Durante tutta la pausa, il heartbeat ogni 2 min gestisce vendite, incassi e rilist!
    let sleepMins;
    let isMacroPause = false;
    if (marketRestricted || consecutive512InCycle > 0) {
      marketRestricted = true;
      consecutiveSoftBansInSession++;
      // Backoff esponenziale progressivo: 1° = 60m, 2° consecutivo = 90m, 3°+ = 120-150m
      const baseMins = Math.max(45, lazySleepMinutes && lazySleepMinutes > 0 ? lazySleepMinutes : 60);
      if (consecutiveSoftBansInSession <= 1) {
        sleepMins = baseMins;
      } else if (consecutiveSoftBansInSession === 2) {
        sleepMins = Math.round(baseMins * 1.5);
      } else {
        sleepMins = Math.min(180, Math.round(baseMins * 2.0));
      }
      reportTelemetry('COOLDOWN_START', `Pausa rigenerativa soft-ban #${consecutiveSoftBansInSession} (${sleepMins} min) avviata`, { sleepMins, consecutiveSoftBans: consecutiveSoftBansInSession, marketRestricted: true });
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY TRADING] Rate limit EA attivo (Soft-ban consecutivo #${consecutiveSoftBansInSession}). Pausa rigenerativa incrementale di ${sleepMins} min per sblocco completo dell'account (Silenzio totale verso il mercato)...`
      });
    } else if ((Date.now() - sessionActiveStartTime) >= (3 * 60 * 60 * 1000)) {
      isMacroPause = true;
      consecutiveSoftBansInSession = 0;
      sleepMins = lazySleepMinutes && lazySleepMinutes > 0 ? lazySleepMinutes : 60;
      const hoursActive = ((Date.now() - sessionActiveStartTime) / (1000 * 60 * 60)).toFixed(1);
      reportTelemetry('MACRO_PAUSE_START', `Superate le 3 ore di attività continuativa (${hoursActive}h). Macro-pausa rigenerativa (${sleepMins} min) avviata`, { sleepMins, hoursActive });
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[MACRO-PAUSA RIGENERATIVA] Concluso intero ciclo dopo ${hoursActive}h di attività continuativa! Avvio macro-pausa di ${sleepMins} min per azzerare i contatori EA e favorire le vendite (Keep-alive attivo ogni 2 min)...`
      });
    } else if (earlyExitRateLimit) {
      consecutiveSoftBansInSession = 0;
      sleepMins = Math.round(getRandomGaussian(15.0, 1.2, 14.0, 18.0));
      reportTelemetry('PREVENTIVE_COOLING_PAUSE', `Pausa preventiva anti-ban post early-exit (${sleepMins} min)`, { sleepMins });
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY TRADING] Raffreddamento preventivo attivo: pausa precauzionale di ${sleepMins} min per garantire il completo azzeramento dei contatori EA (Keep-alive attivo ogni 2 min)...`
      });
    } else if (Date.now() < listingRestrictedUntil && (finalPile.total - finalPile.active) >= 6) {
      consecutiveSoftBansInSession = 0;
      sleepMins = Math.max(10, Math.ceil((listingRestrictedUntil - Date.now()) / 60000));
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY TRADING] Cooldown listing EA attivo (${sleepMins} min) con ${finalPile.total - finalPile.active} carte in attesa di vendita. Pausa distensiva con keep-alive ogni 2 min...`
      });
    } else if (finalPile.active < targetSize) {
      consecutiveSoftBansInSession = 0; // Reset contatore soft-ban se il ciclo è andato a buon fine!
      // Pacing Dinamico tra i cicli in base al riempimento attuale della Tradepile
      if (finalPile.active < 40) {
        // Quando la lista è sotto 40 carte, pausa snella (10-13 min) per accumulare carte e riempire la Tradepile
        sleepMins = Math.round(getRandomGaussian(11.5, 0.8, 10.0, 13.0));
      } else if (finalPile.active < 75) {
        sleepMins = Math.round(getRandomGaussian(18.0, 1.2, 16.0, 22.0));
      } else {
        // A regime (75-100 carte): pausa ottimale di 28 min per massimizzare le vendite mantenendo la lista piena
        sleepMins = Math.round(getRandomGaussian(28.0, 1.5, 25.0, 32.0));
      }
      reportTelemetry('PAUSE_START', `Pausa dinamica anti-spam (${sleepMins} min)`, { sleepMins, currentPile: finalPile.active, targetSize });
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY TRADING] Tradepile a quota ${finalPile.active}/${targetSize}. Pausa dinamica anti-spam di ${sleepMins} min per favorire le vendite prima del prossimo lotto...`
      });
    } else {
      consecutiveSoftBansInSession = 0; // Reset contatore soft-ban
      sleepMins = lazySleepMinutes && lazySleepMinutes > 0 ? lazySleepMinutes : 60;
      reportTelemetry('SELLING_PHASE_START', `Fase di vendita Tradepile al completo (${sleepMins} min)`, { sleepMins, currentPile: finalPile.active });
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY TRADING] Tradepile al completo (${finalPile.active}/${targetSize})! Entro in modalità vendita per ${sleepMins} minuti (Keep-alive attivo ogni 2 min)...`
      });
    }

    const totalSleepSeconds = sleepMins * 60;
    const heartbeatInterval = 120; // 2 minuti: heartbeat per mantenere viva la sessione, incassare vendite e rilistare

    let elapsed = 0;
    while (elapsed < totalSleepSeconds && start === true) {
      await sleep(1000);
      elapsed++;

      // Reset attività Chrome MV3 ogni 15 secondi per impedire lo standby del Service Worker
      if (elapsed % 15 === 0) {
        try {
          await chrome.storage.local.get(['keepAliveCheck']);
        } catch (_) { }
      }

      if (elapsed % heartbeatInterval === 0 && start === true) {
        try {
          const remainingMinutes = Math.round((totalSleepSeconds - elapsed) / 60);
          if (marketRestricted) {
            // Ogni 16 minuti (960s) eseguiamo un singolo ping leggerissimo + refresh nativo Web App per non far scadere il token X-UT-SID (Idle Timeout & 3h OAuth TTL)
            if (elapsed % 960 === 0 && remainingMinutes >= 4) {
              await triggerPinEvent("TRIGGER_PIN_WATCHLIST");
              await triggerPinEvent("REQUEST_TOKEN_REFRESH");
              await sleep(1600);
              crediti = await getCrediti();
              if (start !== true) break;
              reportTelemetry('COOLDOWN_KEEPALIVE', `Ping leggero anti-401 inviato durante cooldown silenziato`, { crediti, remainingMinutes });
              chrome.runtime.sendMessage({
                tipo: 'LOG',
                valore: `[COOLDOWN KEEP-ALIVE] Ping leggero di sessione inviato per mantenere attivo il token Web App (anti-401). Mancano ${remainingMinutes} min alla ripresa.`
              });
            } else {
              // Silenzio totale verso il mercato durante soft-ban per consentire il reset del ban a EA
              chrome.runtime.sendMessage({
                tipo: 'LOG',
                valore: `[COOLDOWN SILENZIATO] Sblocco soft-ban in corso (silenzio totale verso il mercato)... Mancano ${remainingMinutes} min alla ripresa.`
              });
            }
          } else {
            await triggerPinEvent("TRIGGER_PIN_WATCHLIST");
            // 1. Incassa le carte vendute e rimette in vendita quelle scadute con ricalcolo prezzi
            await clearSoldItem(cyclePrices);
            // 2. Risolve aste vinte e difende controrilanci anche durante la fase dormiente
            await resolveWatchlist();
            crediti = await getCrediti();
            if (typeof crediti === 'number') {
              chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });
            }
            reportTelemetry('HEARTBEAT', `Heartbeat completato: vendite incassate e carte rilistate`, { crediti, remainingMinutes });
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[LAZY HEARTBEAT] Tradepile sincronizzata: vendite incassate e carte scadute rilistate! Crediti: ${crediti}. Prossimo restock tra ${remainingMinutes} min.`
            });
          }
        } catch (hbErr) {
          console.warn("[Heartbeat Error]", hbErr);
        }
      }
    }

    if (start === true) {
      if (isMacroPause) {
        sessionActiveStartTime = Date.now();
      }
      marketRestricted = false;
      reportTelemetry('CYCLE_START', `Avvio Ciclo #${cycle + 1}`, { cycle: cycle + 1, crediti });
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY TRADING] Pausa completata! Avvio Ciclo #${cycle + 1}...`
      });
      // Warm-up naturale al risveglio prima di passare all'azione
      await sleep(getRandomGaussian(8.0, 1.0, 6.0, 11.0) * 1000);
    }
    } catch (cycleErr) {
      console.error(`[LAZY TRADING ERROR] Ciclo #${cycle}:`, cycleErr);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY TRADING ERRORE] Errore imprevisto nel Ciclo #${cycle}: ${cycleErr?.message || cycleErr}. Riavvio nuovo ciclo tra 10s...`
      });
      await sleep(10000);
    }

    cycle++;
  }

  chrome.runtime.sendMessage({
    tipo: 'LOG',
    valore: '[LAZY TRADING] Modalità arrestata. Eseguo pulizia finale...'
  });
  await clearSoldItem();
}

// Motore di LAZY TRADING Fodder (83-86+ OVR) con Benchmark Floor di categoria, Prezzi Safe e rotazione 1 Ora
async function sendFodderLazyRequest() {
  let cycle = 1;
  let consecutiveSoftBansInSession = 0;
  let sessionActiveStartTime = Date.now();
  let requiresSoftBanProbe = false;
  const minBidBumps = [150, 200, 250, 300];

  while (start === true) {
    try {
      let consecutive512InCycle = 0;
      let earlyExitRateLimit = false;
      marketRestricted = false;
      let isMacroPause = false;

      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `=== [LAZY TRADING FODDER] Inizio Ciclo #${cycle} ===`
      });

    // FASE 1: Riconciliazione aste Watchlist, caricamento lista Fut.gg, rilevamento Benchmark Floor live, riscossione vendite e relist 1 Ora
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[LAZY FODDER] Fase 1: Riconciliazione aste vinte, aggiornamento lista Fut.gg (Rating ${fodderRating}), riscossione vendite e relist 1 Ora...`
    });

    // 1a. Recupera eventuali carte vinte tramite asta dai cicli precedenti
    await reconcileWatchlistOnStartup();
    await sleep(1000);

    // 1b. Ricarica la lista dei fodder dal server locale
    listaFodder = [];
    indexFodder = 0;
    await getFdderList();

    if (listaFodder.length === 0) {
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY FODDER] Nessun giocatore trovato per Rating ${fodderRating} dal server locale. Attendo 10s prima di riprovare...`
      });
      await sleep(10000);
      continue;
    }

    // 1c. Calcolo Benchmark Floor: prezzo minimo di categoria tra tutti i giocatori validi di Fut.gg
    const validPrices = listaFodder.map(f => f.price).filter(p => typeof p === 'number' && p > 0);
    if (validPrices.length === 0) {
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY FODDER] Nessun prezzo valido disponibile per Rating ${fodderRating}. Attendo 10s...`
      });
      await sleep(10000);
      continue;
    }

    const markup = lazyMarkupPercent && lazyMarkupPercent > 0 ? lazyMarkupPercent : 10;
    const playerPriceMap = new Map();

    listaFodder.forEach(f => {
      const pPrice = Number(f.price) || 0;
      const pTierA = roundUpToStep(pPrice * 1.06); // Tier A: +6%
      const pTierB = roundUpToStep(pPrice * (1 + (markup / 100))); // Tier B: +10% o custom
      const pTierC = roundUpToStep(pPrice * 1.15); // Tier C: +15%
      const minNet = Math.floor(pTierA * 0.95);
      const MIN_NET_PROFIT = 200;
      const maxBuy = roundDownToStep(minNet - MIN_NET_PROFIT);

      const pInfo = {
        name: f.name || "",
        basePrice: pPrice,
        tierAPrice: pTierA,
        tierBPrice: pTierB,
        tierCPrice: pTierC,
        maxBuyAllowed: maxBuy
      };
      playerPriceMap.set(String(f.pid), pInfo);
      f.priceInfo = pInfo;
    });

    // Ordina i fodder dal più economico al più costoso
    listaFodder.sort((a, b) => (a.price || 999999) - (b.price || 999999));
    let fodderCycleIdx = 0;
    const getNextTargetPlayer = () => {
      const p = listaFodder[fodderCycleIdx % listaFodder.length];
      fodderCycleIdx++;
      return p;
    };

    const benchmarkFloor = listaFodder[0]?.price || 0;
    const maxPlayerPrice = listaFodder[listaFodder.length - 1]?.price || benchmarkFloor;
    const minMaxBuy = listaFodder[0]?.priceInfo?.maxBuyAllowed || 0;
    const maxMaxBuy = listaFodder[listaFodder.length - 1]?.priceInfo?.maxBuyAllowed || minMaxBuy;
    const maxBuyAllowed = minMaxBuy;

    const cyclePrices = {
      benchmarkFloor: benchmarkFloor,
      floorBin: benchmarkFloor,
      sellPrice: listaFodder[0]?.priceInfo?.tierBPrice || 0,
      tierAPrice: listaFodder[0]?.priceInfo?.tierAPrice || 0,
      tierBPrice: listaFodder[0]?.priceInfo?.tierBPrice || 0,
      tierCPrice: listaFodder[0]?.priceInfo?.tierCPrice || 0,
      maxBidAllowed: maxMaxBuy,
      maxBuyNowAllowed: maxMaxBuy,
      rating: fodderRating,
      playerPriceMap: playerPriceMap
    };

    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[PREZZI FODDER CICLO #${cycle}] Rating ${fodderRating} (${listaFodder.length} giocatori) -> Valori Fut.gg: ${benchmarkFloor} - ${maxPlayerPrice} cr | Prezzi Max Safe individuali: da ${minMaxBuy} a ${maxMaxBuy} cr (Margine netto min: +200 cr garantito) | Vendite Scaglionate 1 ORA (Tier A +6%, Tier B +${markup}%, Tier C +15%)`
    });

    // 1d. Rimuove vendite e rimette in vendita quelle invendute a 1 Ora con prezzi aggiornati
    await clearSoldItem(cyclePrices);
    if (start !== true) break;
    await sleep(1500);

    // 1e. Mette in vendita eventuali carte bloccate nei Non Assegnati o in Tradepile
    await processUnassignedItems(cyclePrices);
    if (start !== true) break;
    await sleep(1000);
    await listUnlistedTradepileItems(cyclePrices);
    if (start !== true) break;
    await sleep(1000);

    // 1f. Aggiornamento crediti
    crediti = await getCrediti();
    chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });

    if (start !== true) break;

    // FASE 2: Analisi capienza Tradepile e determinazione Target di Ciclo (Max 20 a ciclo per anti-ban)
    const pileInfo = await getTradepileInfo();
    const currentActiveCount = pileInfo.active || 0;
    const currentTotalCount = pileInfo.total || 0;
    const unlistedCount = Math.max(0, currentTotalCount - currentActiveCount);
    const MAX_TRADEPILE_LIMIT = 100;
    const targetSize = targetTradepileSize && targetTradepileSize > 0 ? Math.min(targetTradepileSize, MAX_TRADEPILE_LIMIT) : 50;

    // Spazio fisicamente libero nella Tradepile EA (max 100 totali)
    const physicalFreeSlots = Math.max(0, MAX_TRADEPILE_LIMIT - currentTotalCount);
    // Quante carte mancano per raggiungere l'obiettivo totale desiderato
    const neededToTarget = Math.max(0, targetSize - currentTotalCount);
    const rawMissing = Math.min(physicalFreeSlots, neededToTarget);

    const isListingBlocked = Date.now() < listingRestrictedUntil;
    let cycleTarget = 0;
    if (isListingBlocked && (unlistedCount >= 6 || currentTotalCount >= 85)) {
      const remainingMin = Math.ceil((listingRestrictedUntil - Date.now()) / 60000);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[COOLDOWN LISTING ATTIVO] Ci sono ${unlistedCount} carte in attesa di vendita (${currentTotalCount}/100 in Tradepile) e il listing EA è in pausa (${remainingMin} min). Sospendo acquisti per non bloccare altri crediti.`
      });
      cycleTarget = 0;
    } else {
      let maxBatch = 15;
      if (currentTotalCount < 50) {
        maxBatch = 25;
      } else if (currentTotalCount < 80) {
        maxBatch = 20;
      }
      cycleTarget = Math.min(rawMissing, maxBatch);
      console.log(`[LAZY FODDER] Tradepile: ${currentActiveCount} attive, ${currentTotalCount}/${MAX_TRADEPILE_LIMIT} totali (Mancanti: ${rawMissing}, Target ciclo: ${cycleTarget})`);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY FODDER] Tradepile: ${currentActiveCount} attive (${currentTotalCount}/${targetSize} tot). Mancanti: ${rawMissing}` + (rawMissing > maxBatch ? ` (Acquisti scaglionati: target ${cycleTarget} carte per questo ciclo)` : '')
      });
    }

    // FASE 3: Rifornimento Ibrido Protetto (Mass Bidding mirato + Top-Up Compra Ora sotto-prezzo)
    if (cycleTarget > 0 && start === true) {
      let wonInThisCycle = 0;
      let totalBidsPlaced = 0;
      let searchCount = 0;
      let consecutiveErrorsCount = 0;
      let bidPriceOffset = 0;
      consecutive461InBidding = 0;
      consecutive512InCycle = 0;
      marketRestricted = false;
      const maxBiddingSearches = Math.max(30, cycleTarget * 3);
      const MAX_ACTIVE_WATCHLIST = 35;

      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY FODDER BIDDING] Step 1: Offerte all'asta a sconto (Target: ${cycleTarget} carte, Prezzi Max: ${minMaxBuy}-${maxMaxBuy} cr). Rotazione sui giocatori Rating ${fodderRating}...`
      });

      // Loop Offerte all'asta (Step 1)
      // Loop Offerte all'asta (Step 1) - Esattamente identico al pattern vincente dei consumabili
      while (wonInThisCycle < cycleTarget && searchCount < maxBiddingSearches && start === true) {
        if (marketRestricted || earlyExitRateLimit) break;

        if (typeof crediti === 'number' && crediti < minMaxBuy && activeBids.size === 0) {
          chrome.runtime.sendMessage({
            tipo: 'LOG',
            valore: `[LAZY FODDER BIDDING] Crediti insufficienti (${crediti} < ${minMaxBuy}). Passo al controllo completamento.`
          });
          break;
        }

        // Controllo capienza offerte Watchlist (identico ai consumabili: usa resolveWatchlist)
        if ((wonInThisCycle + activeBids.size) >= (cycleTarget + 2) || activeBids.size >= MAX_ACTIVE_WATCHLIST) {
          chrome.runtime.sendMessage({
            tipo: 'LOG',
            valore: `[LAZY FODDER BIDDING] Quota offerte in volo raggiunta (${activeBids.size} attive, ${wonInThisCycle}/${cycleTarget} vinte). Monitoraggio risoluzione aste...`
          });
          while ((wonInThisCycle + activeBids.size) >= (cycleTarget + 2) && activeBids.size > 0 && start === true) {
            await sleep(getRandomGaussian(2.0, 0.3, 1.5, 2.5) * 1000);
            const prevWon = carteAcquistate;
            await resolveWatchlist();
            if (carteAcquistate > prevWon) {
              wonInThisCycle += (carteAcquistate - prevWon);
              consecutive461InBidding = 0;
              chrome.runtime.sendMessage({
                tipo: 'LOG',
                valore: `[LAZY FODDER BIDDING] Vinta carta all'asta! Progresso ciclo: [${wonInThisCycle}/${cycleTarget}]`
              });
              if (wonInThisCycle >= cycleTarget) break;
            }
          }
          if (wonInThisCycle >= cycleTarget) break;
        }

        const nextPlayer = getNextTargetPlayer();
        if (!nextPlayer || !nextPlayer.pid || !nextPlayer.priceInfo) {
          searchCount++;
          continue;
        }

        const playerMaxBuy = nextPlayer.priceInfo.maxBuyAllowed;
        const playerSellPrice = nextPlayer.priceInfo.tierBPrice;

        const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
        const url = new URL(baseUrl);
        url.searchParams.set("num", "21");
        url.searchParams.set("start", "0");
        url.searchParams.set("type", "player");
        url.searchParams.set("maskedDefId", String(nextPlayer.pid));
        url.searchParams.set("macr", String(playerMaxBuy));
        url.searchParams.set("micr", String(minBidBumps[(searchCount + bidPriceOffset) % minBidBumps.length]));

        await triggerPinEvent("TRIGGER_PIN_SEARCH");

        const headers = new Headers({
          "Accept": "*/*",
          "Accept-Encoding": "gzip, deflate, br, zstd",
          "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control": "no-cache",
          "Content-Type": "application/json",
          "X-UT-SID": xUtSid
        });

        if (searchCount % 4 === 0) {
          chrome.runtime.sendMessage({
            tipo: 'LOG',
            valore: `[LAZY FODDER BIDDING] Analisi aste: ${nextPlayer.name || 'Giocatore ' + nextPlayer.pid} (Max Bid: ${playerMaxBuy} cr) [Controllo ${searchCount + 1}/${maxBiddingSearches}]`
          });
        }

        try {
          const res = await fetch(url.href, { method: "GET", headers });
          if (res.ok) {
            consecutiveErrorsCount = 0;
            consecutiveSearchErrors = 0;
            consecutive401Errors = 0;
            const data = await res.json();
            const auctions = data.auctionInfo || [];

            // Finestra primaria: entro 5 minuti (<= 300s). Se vuota, estende fino a 10 minuti (<= 600s) come nei consumabili
            let targetAuctions = auctions.filter(a =>
              a.expires > 0 &&
              a.expires <= 300 &&
              a.bidState !== "highest" &&
              !activeBids.has(String(a.tradeId)) &&
              !isTradeAttempted(a.tradeId)
            );
            if (targetAuctions.length === 0) {
              targetAuctions = auctions.filter(a =>
                a.expires > 0 &&
                a.expires <= 600 &&
                a.bidState !== "highest" &&
                !activeBids.has(String(a.tradeId)) &&
                !isTradeAttempted(a.tradeId)
              );
            }

            targetAuctions.sort((a, b) => (a.expires || 0) - (b.expires || 0));

            let bidsInThisSearch = 0;
            let consecutiveFailedBidsInSearch = 0;
            for (const auction of targetAuctions) {
              if (consecutiveFailedBidsInSearch >= 2) break;
              if (start !== true || wonInThisCycle >= cycleTarget || (wonInThisCycle + activeBids.size) >= (cycleTarget + 2) || activeBids.size >= MAX_ACTIVE_WATCHLIST) break;

              const currentBidPrice = auction.currentBid || auction.startingBid || 0;
              const step = getEaStep(currentBidPrice);
              const nextBid = auction.currentBid > 0 ? (currentBidPrice + step) : (auction.startingBid || step);

              if (nextBid <= playerMaxBuy) {
                if (typeof crediti === 'number' && crediti < nextBid) {
                  console.log(`[LAZY FODDER BID] Crediti insufficienti (${crediti} < ${nextBid}). Salto asta.`);
                  continue;
                }

                // Punto D: Sonda di verifica preliminare post-softban (1 sola offerta di prova)
                if (requiresSoftBanProbe) {
                  chrome.runtime.sendMessage({
                    tipo: 'LOG',
                    valore: `[SONDA ANTI-BAN] Verifica preliminare permessi offerte dopo la pausa di riposo (1 sola offerta test su Fodder)...`
                  });
                }

                // Ritardo umano di ispezione asta (600ms - 1100ms) identico ai consumabili
                await sleep(getRandomGaussian(0.8, 0.15, 0.6, 1.1) * 1000);

                console.log(`[LAZY FODDER BID] Invio offerta di ${nextBid} cr su ${nextPlayer.name || 'PID ' + nextPlayer.pid} (Trade ${auction.tradeId}, scade in ${auction.expires}s)...`);
                const bidSuccess = await sendBidRequest(auction.tradeId, nextBid, auction.itemData?.id, playerMaxBuy);

                if (requiresSoftBanProbe) {
                  if (!bidSuccess && lastBidErrorStatus === 461) {
                    chrome.runtime.sendMessage({
                      tipo: 'LOG',
                      valore: `[SONDA ANTI-BAN] L'offerta di test ha ricevuto 461 (Soft-ban EA ancora attivo). L'account necessita di ulteriore riposo: rientro in pausa senza insistere.`
                    });
                    marketRestricted = true;
                    earlyExitRateLimit = true;
                    break;
                  } else if (bidSuccess) {
                    requiresSoftBanProbe = false;
                    chrome.runtime.sendMessage({
                      tipo: 'LOG',
                      valore: `[SONDA ANTI-BAN] Test superato con successo! Permessi di offerta ripristinati da EA.`
                    });
                  }
                }

                if (bidSuccess) {
                  totalBidsPlaced++;
                  bidsInThisSearch++;
                  consecutiveFailedBidsInSearch = 0;
                  consecutive461InBidding = 0;
                  if (typeof crediti === 'number') crediti = Math.max(0, crediti - nextBid);

                  const bidData = {
                    pid: nextPlayer.pid,
                    name: nextPlayer.name,
                    playStyleId: null,
                    bidAmount: nextBid,
                    sellPrice: playerSellPrice,
                    basePrice: nextPlayer.priceInfo.basePrice,
                    maxBidAllowed: playerMaxBuy,
                    itemId: auction.itemData?.id,
                    expiresAt: Date.now() + (auction.expires * 1000),
                    rebidCount: 0,
                    isConsumable: false
                  };
                  activeBids.set(String(auction.tradeId), bidData);
                  activeBids.set(Number(auction.tradeId), bidData);
                  await storePendingBid(auction.tradeId, bidData);

                  chrome.runtime.sendMessage({
                    tipo: 'LOG',
                    valore: `[LAZY FODDER BID] Offerta di ${nextBid} cr su ${nextPlayer.name || 'PID ' + nextPlayer.pid} (Scade in ${Math.round(auction.expires)}s | Max: ${playerMaxBuy} cr) [Offerte ciclo: ${totalBidsPlaced}]`
                  });

                  // Offerta riuscita: reset errori consecutivi
                  consecutive512InCycle = 0;
                  consecutiveErrorsCount = 0;

                  // Punto B: Pacing umano naturale tra offerte (3.5s - 5.0s) per azzerare i picchi antispam EA
                  await sleep(getRandomGaussian(4.0, 0.4, 3.5, 5.0) * 1000);
                } else {
                  consecutiveFailedBidsInSearch++;
                  if (lastBidErrorStatus === 461) {
                    consecutive461InBidding++;
                    bidPriceOffset++;
                    if (consecutive461InBidding === 3) {
                      console.log("[LAZY FODDER BID] 3 aste contese o Watchlist piena (461). Eseguo pulizia Watchlist...");
                      chrome.runtime.sendMessage({
                        tipo: 'LOG',
                        valore: `[LAZY FODDER BID] Aste contese o Watchlist satura (461). Eseguo pulizia Watchlist per liberare slot...`
                      });
                      await resolveWatchlist();
                    } else if (consecutive461InBidding >= 6) {
                      console.log(`[LAZY FODDER BID] Rilevate ${consecutive461InBidding} aste già chiuse/contese (461). Concludo Step 1 e passo a Compra Ora.`);
                      chrome.runtime.sendMessage({
                        tipo: 'LOG',
                        valore: `[LAZY FODDER BID] Mercato aste molto conteso (461). Concludo le offerte e passo a Compra Ora per completare la Tradepile.`
                      });
                      break;
                    }
                    // Interrompe subito i tentativi sulla stessa pagina di ricerca e passa a una ricerca fresca
                    break;
                  }
                  if (lastBidErrorStatus === 429 || lastBidErrorStatus === 426 || lastBidErrorStatus === 512 || lastBidErrorStatus === 521) {
                    earlyExitRateLimit = true;
                    console.warn(`[LAZY FODDER BID] Rate limit EA (${lastBidErrorStatus}) rilevato. Uscita preventiva...`);
                    reportTelemetry('EARLY_EXIT_RATE_LIMIT', `Avviso rate-limit EA (${lastBidErrorStatus}) su Bidding.`, { status: lastBidErrorStatus });
                    chrome.runtime.sendMessage({
                      tipo: 'LOG',
                      valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${lastBidErrorStatus}) rilevato su offerta asta. Interrompo gli acquisti per questo ciclo e avvio pausa preventiva di 3 minuti...`
                    });
                    await sleep(getRandomGaussian(180.0, 10.0, 160.0, 210.0) * 1000);
                    break;
                  }
                }
              }
            }
            if (marketRestricted || earlyExitRateLimit) break;
          } else if (res.status === 401) {
            await handle401Error("Lazy Fodder Bidding Search");
            break;
          } else if (res.status === 429 || res.status === 426 || res.status === 521 || res.status === 512) {
            earlyExitRateLimit = true;
            console.warn(`[LAZY FODDER BID] Rate limit EA (${res.status}) su ricerca transfermarket. Attivazione Early-Exit preventiva...`);
            reportTelemetry('EARLY_EXIT_RATE_LIMIT', `Avviso rate-limit EA (${res.status}) su ricerca transfermarket.`, { status: res.status });
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${res.status}) rilevato su ricerca transfermarket. Interrompo gli acquisti per questo ciclo e avvio pausa preventiva di 3 minuti...`
            });
            await sleep(getRandomGaussian(180.0, 10.0, 160.0, 210.0) * 1000);
            break;
          }
        } catch (err) {
          console.error("[LAZY FODDER BID Search Error]", err);
          consecutiveErrorsCount++;
          if (consecutiveErrorsCount >= 3) {
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[LAZY FODDER BID] Rilevati 3 errori consecutivi di ricerca. Passo allo Step 2.`
            });
            break;
          }
        }

        // Risoluzione Watchlist periodica e controrilanci (identico ai consumabili)
        if (activeBids.size > 0) {
          const prevWon = carteAcquistate;
          await resolveWatchlist();
          if (carteAcquistate > prevWon) {
            wonInThisCycle += (carteAcquistate - prevWon);
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[LAZY FODDER BIDDING] Vinta carta all'asta! Progresso ciclo: [${wonInThisCycle}/${cycleTarget}]`
            });
          }
        }

        searchCount++;
        // Pacing umano tra ricerche per evitare rate limit: 3.0s - 4.5s con micro-pausa ogni 6 ricerche (identico ai consumabili)
        if ((searchCount + 1) % 6 === 0) {
          await sleep(getRandomGaussian(6.0, 0.6, 5.0, 7.5) * 1000);
        } else {
          await sleep(getRandomGaussian(3.6, 0.4, 3.0, 4.5) * 1000);
        }
      }

      // Risoluzione delle aste attive in chiusura (fino a 90 secondi) prima di procedere a Compra Ora (identico ai consumabili)
      if (activeBids.size > 0 && start === true && !marketRestricted) {
        while (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 90000 && start === true && !marketRestricted) {
          const secLeft = Math.max(0, Math.round(getUrgentAuctionTimeRemaining() / 1000));
          console.log(`[LAZY FODDER BID] Asta in chiusura entro ${secLeft}s. Attendo esito e controrilanci...`);
          await sleep(getRandomGaussian(2.0, 0.2, 1.5, 2.5) * 1000);
          const prevWon = carteAcquistate;
          await resolveWatchlist();
          if (carteAcquistate > prevWon) {
            wonInThisCycle += (carteAcquistate - prevWon);
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[LAZY FODDER BIDDING] Vinta carta all'asta! Progresso ciclo: [${wonInThisCycle}/${cycleTarget}]`
            });
          }
        }
      }

      // Risoluzione finale offerte pendenti dello Step 1 con messa in vendita
      if (activeBids.size > 0 && start === true && !marketRestricted && !earlyExitRateLimit) {
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[LAZY FODDER BID] Risoluzione offerte inviate (${activeBids.size} attive)...`
        });
        const prevWon = carteAcquistate;
        await resolveWatchlist();
        if (carteAcquistate > prevWon) {
          wonInThisCycle += (carteAcquistate - prevWon);
        }
      }

      // Step 2: Top-Up Compra Ora Veloce (se rimangono slot da coprire)
      // SALTO se ci sono stati errori o limit nello Step 1 (esattamente come nei consumabili)
      const topUpTarget = Math.max(0, cycleTarget - wonInThisCycle);
      if (topUpTarget > 0 && start === true && !marketRestricted && !earlyExitRateLimit && consecutive512InCycle < 2 && consecutiveErrorsCount < 3) {
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[LAZY FODDER TOP-UP] Step 2: Compra Ora rapido sotto-prezzo per completare il lotto (${topUpTarget} carte mancanti, Max Buy: <= ${minMaxBuy}-${maxMaxBuy} cr)...`
        });

        let topUpBought = 0;
        let topUpSearches = 0;
        let minPriceOffset = 0;
        let consecutive461InTopUp = 0;
        const maxTopUpSearches = Math.max(40, topUpTarget * 5);
        lastBidErrorStatus = 0;
        lastBuyNowErrorStatus = 0;
        consecutiveErrorsCount = 0;

        while (topUpBought < topUpTarget && topUpSearches < maxTopUpSearches && start === true) {
          if (typeof crediti === 'number' && crediti < minMaxBuy) {
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[LAZY FODDER TOP-UP] Crediti insufficienti (${crediti} < ${minMaxBuy}) per ulteriori acquisti.`
            });
            break;
          }

          const nextPlayer = getNextTargetPlayer();
          if (!nextPlayer || !nextPlayer.pid || !nextPlayer.priceInfo) {
            topUpSearches++;
            continue;
          }

          const playerMaxBuy = nextPlayer.priceInfo.maxBuyAllowed;

          if (typeof crediti === 'number' && crediti < playerMaxBuy) {
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[LAZY FODDER TOP-UP] Crediti insufficienti (${crediti} < ${playerMaxBuy}) per acquistare ${nextPlayer.name || 'Fodder'}.`
            });
            break;
          }

          if (topUpSearches % 4 === 0) {
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[LAZY FODDER TOP-UP] Analisi Compra Ora: ${nextPlayer.name || 'Giocatore ' + nextPlayer.pid} (Max Buy: ${playerMaxBuy} cr) [Ricerca ${topUpSearches + 1}/${maxTopUpSearches}]`
            });
          }

          const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
          const url = new URL(baseUrl);
          url.searchParams.set("num", "21");
          url.searchParams.set("start", "0");
          url.searchParams.set("type", "player");
          url.searchParams.set("maskedDefId", String(nextPlayer.pid));
          url.searchParams.set("maxb", String(playerMaxBuy));
          url.searchParams.set("micr", String(minBidBumps[(topUpSearches + minPriceOffset) % minBidBumps.length]));

          await triggerPinEvent("TRIGGER_PIN_SEARCH");

          const headers = new Headers({
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br, zstd",
            "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
            "Cache-Control": "no-cache",
            "Content-Type": "application/json",
            "X-UT-SID": xUtSid
          });

          try {
            const res = await fetch(url.href, { method: "GET", headers });
            if (res.ok) {
              const data = await res.json();
              const auctions = data.auctionInfo || [];

              const validAuctions = auctions.filter(a =>
                a.buyNowPrice &&
                a.buyNowPrice <= playerMaxBuy &&
                !attemptedTradeIds.has(String(a.tradeId))
              );
              validAuctions.sort((a, b) => (b.expires || 0) - (a.expires || 0));

              if (validAuctions.length > 0) {
                const candidate = validAuctions[0];
                if (topUpBought < topUpTarget && start === true) {
                  if (typeof crediti === 'number' && crediti < candidate.buyNowPrice) {
                    chrome.runtime.sendMessage({
                      tipo: 'LOG',
                      valore: `[LAZY FODDER TOP-UP] Crediti insufficienti (${crediti} cr < ${candidate.buyNowPrice} cr richiesti). Concludo Step 2.`
                    });
                    break;
                  }

                  attemptedTradeIds.set(String(candidate.tradeId), Date.now());
                  const buyOk = await sendBuyNowRequest(candidate.tradeId, candidate.buyNowPrice, candidate.itemData?.id);
                  if (buyOk) {
                    topUpBought++;
                    consecutive461InTopUp = 0;
                    wonInThisCycle++;
                    carteVinteCiclo++;
                    consecutive512InCycle = 0;
                    if (typeof crediti === 'number') crediti = Math.max(0, crediti - candidate.buyNowPrice);

                    const candItemId = candidate.itemData?.id;
                    await moveSingleItemToTrade(candItemId);
                    await sleep(getRandomGaussian(1.0, 0.2, 0.8, 1.3) * 1000);

                    const tiered = getTieredSellPrice(nextPlayer.priceInfo.basePrice, null, false);
                    const listed = await sellSingleItem(candItemId, tiered.price);
                    if (listed) {
                      const netEst = Math.floor(tiered.price * 0.95) - candidate.buyNowPrice;
                      chrome.runtime.sendMessage({
                        tipo: 'LOG',
                        valore: `[LAZY FODDER TOP-UP] Acquistato ${nextPlayer.name || 'Fodder'} a ${candidate.buyNowPrice} e listato a 1 ORA a ${tiered.price} (Tier ${tiered.tier}: +${tiered.markup}%, Netto stimato: +${netEst} cr) [${topUpBought}/${topUpTarget}]`
                      });
                    } else {
                      chrome.runtime.sendMessage({
                        tipo: 'LOG',
                        valore: `[LAZY FODDER TOP-UP] Acquistato ${nextPlayer.name || 'Fodder'} a ${candidate.buyNowPrice}. Spostato in lista trasferimenti.`
                      });
                    }
                    await sleep(getRandomGaussian(3.5, 0.4, 2.8, 4.5) * 1000);
                  } else {
                    if (lastBuyNowErrorStatus === 512 || lastBuyNowErrorStatus === 429 || lastBuyNowErrorStatus === 426 || lastBuyNowErrorStatus === 521) {
                      earlyExitRateLimit = true;
                      console.warn(`[LAZY FODDER TOP-UP] Segnale limit Compra Ora EA (${lastBuyNowErrorStatus}). Concludo lo Step 2 e passo alla vendita...`);
                      chrome.runtime.sendMessage({
                        tipo: 'LOG',
                        valore: `[LAZY FODDER TOP-UP] Concludo Step 2 per sicurezza (limite acquisti rapidi EA ${lastBuyNowErrorStatus}). Passo alla messa in vendita.`
                      });
                      break;
                    } else if (lastBuyNowErrorStatus === 461 || lastBuyNowErrorStatus === 478) {
                      consecutive461InTopUp++;
                      minPriceOffset++;
                      const nextMinBump = minBidBumps[(topUpSearches + minPriceOffset) % minBidBumps.length];

                      chrome.runtime.sendMessage({
                        tipo: 'LOG',
                        valore: `[LAZY FODDER TOP-UP] Carta anticipata (461). Eseguo nuova ricerca variando prezzo minimo (${nextMinBump} cr)... (${consecutive461InTopUp}/3)`
                      });

                      if (consecutive461InTopUp >= 3) {
                        chrome.runtime.sendMessage({
                          tipo: 'LOG',
                          valore: `[LAZY FODDER TOP-UP] Rilevati 3 tentativi consecutivi anticipati su Floor BIN su ricerche diverse. Concludo lo Step 2 e passo alla vendita.`
                        });
                        break;
                      }

                      // Pausa breve e passa subito a una nuova ricerca fresca con prezzo minimo variato
                      await sleep(getRandomGaussian(2.5, 0.3, 2.0, 3.2) * 1000);
                    } else {
                      await sleep(getRandomGaussian(2.5, 0.3, 2.0, 3.2) * 1000);
                    }
                  }
                }
              }

              if (consecutive461InTopUp >= 3 || earlyExitRateLimit) break;

              if (validAuctions.length === 0) {
                await sleep(getRandomGaussian(3.0, 0.4, 2.4, 4.0) * 1000);
              }
            } else if (res.status === 401) {
              await handle401Error("Lazy Fodder Top-Up Search");
              break;
            } else if (res.status === 429 || res.status === 426 || res.status === 521 || res.status === 512) {
              earlyExitRateLimit = true;
              break;
            }
          } catch (err) {
            console.error("[LAZY FODDER TOP-UP Error]", err);
            consecutiveErrorsCount++;
            if (consecutiveErrorsCount >= 3) {
              chrome.runtime.sendMessage({
                tipo: 'LOG',
                valore: `[LAZY FODDER TOP-UP] Troppi errori consecutivi di ricerca Compra Ora. Concludo lo Step 2.`
              });
              break;
            }
          }

          topUpSearches++;

          if (activeBids.size > 0 && topUpSearches % 3 === 0 && start === true) {
            const prevWon = carteAcquistate;
            await resolveWatchlist();
            if (carteAcquistate > prevWon) {
              const newlyWon = (carteAcquistate - prevWon);
              wonInThisCycle += newlyWon;
              topUpBought += newlyWon;
              chrome.runtime.sendMessage({
                tipo: 'LOG',
                valore: `[LAZY FODDER WATCHLIST] Asta vinta durante Compra Ora! Progresso rifornimento: [${topUpBought}/${topUpTarget}]`
              });
              if (topUpBought >= topUpTarget) break;
            }
          }
        }
      }
    }

    // FASE 4: Sincronizzazione Tradepile finale, Incasso crediti e Calcolo Pausa del Ciclo (Aste da 1 ORA)
    await sleep(2000);
    await clearSoldItem(cyclePrices);
    await processUnassignedItems(cyclePrices);
    await listUnlistedTradepileItems(cyclePrices);
    const finalPile = await getTradepileInfo();
    crediti = await getCrediti();
    chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });

    let sleepMins = 60; // Durata naturale per far scadere e vendere le aste da 1 Ora
    if (marketRestricted) {
      consecutiveSoftBansInSession++;
      const baseMins = lazySleepMinutes && lazySleepMinutes > 0 ? lazySleepMinutes : 60;
      sleepMins = consecutiveSoftBansInSession === 1 ? baseMins : Math.round(baseMins * 1.5);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY FODDER] Rate limit EA attivo (Soft-ban consecutivo #${consecutiveSoftBansInSession}). Pausa rigenerativa di ${sleepMins} min per sblocco completo...`
      });
    } else if ((Date.now() - sessionActiveStartTime) >= (3 * 60 * 60 * 1000)) {
      isMacroPause = true;
      consecutiveSoftBansInSession = 0;
      sleepMins = lazySleepMinutes && lazySleepMinutes > 0 ? lazySleepMinutes : 60;
      const hoursActive = ((Date.now() - sessionActiveStartTime) / (1000 * 60 * 60)).toFixed(1);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[MACRO-PAUSA RIGENERATIVA] Concluso ciclo dopo ${hoursActive}h di attività! Avvio macro-pausa di ${sleepMins} min per azzerare i contatori EA e favorire le vendite delle aste da 1 Ora...`
      });
    } else if (Date.now() < listingRestrictedUntil && (finalPile.total - finalPile.active) >= 6) {
      consecutiveSoftBansInSession = 0;
      sleepMins = Math.max(10, Math.ceil((listingRestrictedUntil - Date.now()) / 60000));
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY FODDER] Cooldown listing EA attivo (${sleepMins} min) con ${finalPile.total - finalPile.active} carte in attesa di vendita. Pausa distensiva con keep-alive ogni 2 min...`
      });
    } else if (finalPile.active < targetSize) {
      consecutiveSoftBansInSession = 0;
      // Se la lista non � ancora piena, pause brevi (5-8 min) per rifornire subito la Tradepile!
      // Pacing Dinamico tra i cicli in base al riempimento attuale della Tradepile
      if (finalPile.active < 40) {
        sleepMins = Math.round(getRandomGaussian(11.5, 0.8, 10.0, 13.0));
      } else if (finalPile.active < 75) {
        sleepMins = Math.round(getRandomGaussian(18.0, 1.2, 16.0, 22.0));
      } else {
        // A regime (75-100 carte): pausa ottimale di 28 min per massimizzare le vendite mantenendo la lista piena
        sleepMins = Math.round(getRandomGaussian(28.0, 1.5, 25.0, 32.0));
      }
      reportTelemetry('PAUSE_START', `Pausa dinamica anti-spam (${sleepMins} min)`, { sleepMins, currentPile: finalPile.active, targetSize });
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY FODDER] Tradepile a quota ${finalPile.active}/${targetSize}. Pausa dinamica anti-spam di ${sleepMins} min per favorire le vendite prima del prossimo lotto...`
      });
    } else if (earlyExitRateLimit) {
      consecutiveSoftBansInSession = 0;
      sleepMins = Math.round(getRandomGaussian(10.0, 1.0, 9.0, 12.0));
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY FODDER] Raffreddamento preventivo attivo: pausa di ${sleepMins} min per azzeramento contatori EA (Keep-alive attivo ogni 2 min)...`
      });
    } else {
      consecutiveSoftBansInSession = 0;
      sleepMins = lazySleepMinutes && lazySleepMinutes > 0 ? lazySleepMinutes : 60;
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY FODDER] Tradepile al completo (${finalPile.active}/${targetSize})! Avvio modalità vendita per ${sleepMins} minuti (Aste da 1 Ora, Keep-alive attivo ogni 2 min)...`
      });
    }

    const totalSleepSeconds = sleepMins * 60;
    const heartbeatInterval = 120; // 2 minuti: heartbeat per mantenere viva la sessione, incassare vendite e rilistare

    let elapsed = 0;
    while (elapsed < totalSleepSeconds && start === true) {
      await sleep(1000);
      elapsed++;

      if (elapsed % 15 === 0) {
        try {
          await chrome.storage.local.get(['keepAliveCheck']);
        } catch (_) { }
      }

      if (elapsed % heartbeatInterval === 0 && start === true) {
        try {
          const remainingMinutes = Math.round((totalSleepSeconds - elapsed) / 60);
          if (marketRestricted) {
            if (elapsed % 960 === 0 && remainingMinutes >= 4) {
              await triggerPinEvent("TRIGGER_PIN_WATCHLIST");
              await triggerPinEvent("REQUEST_TOKEN_REFRESH");
              await sleep(1600);
              crediti = await getCrediti();
              if (start !== true) break;
              reportTelemetry('COOLDOWN_KEEPALIVE', `Ping leggero anti-401 inviato durante cooldown silenziato (Fodder)`, { crediti, remainingMinutes });
              chrome.runtime.sendMessage({
                tipo: 'LOG',
                valore: `[COOLDOWN KEEP-ALIVE] Ping leggero di sessione inviato per mantenere attivo il token Web App (anti-401). Mancano ${remainingMinutes} min alla ripresa.`
              });
            } else {
              chrome.runtime.sendMessage({
                tipo: 'LOG',
                valore: `[COOLDOWN SILENZIATO] Sblocco soft-ban in corso... Mancano ${remainingMinutes} min alla ripresa.`
              });
            }
          } else {
            await triggerPinEvent("TRIGGER_PIN_WATCHLIST");
            await clearSoldItem(cyclePrices);
            await checkAndProcessWatchlistForLazy(cyclePrices);
            crediti = await getCrediti();
            if (typeof crediti === 'number') {
              chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });
            }
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[LAZY FODDER HEARTBEAT] Tradepile sincronizzata: vendite incassate e crediti aggiornati (${crediti} cr). Prossimo ciclo tra ${remainingMinutes} min.`
            });
          }
        } catch (hbErr) {
          console.warn("[Heartbeat Error]", hbErr);
        }
      }
    }

    if (start === true) {
      if (isMacroPause) {
        sessionActiveStartTime = Date.now();
      }
      marketRestricted = false;
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY FODDER] Pausa completata! Avvio Ciclo #${cycle + 1}...`
      });
      await sleep(getRandomGaussian(8.0, 1.0, 6.0, 11.0) * 1000);
    }
    } catch (cycleErr) {
      console.error(`[LAZY FODDER ERROR] Ciclo #${cycle}:`, cycleErr);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[LAZY FODDER ERRORE] Errore imprevisto nel Ciclo #${cycle}: ${cycleErr?.message || cycleErr}. Riavvio nuovo ciclo tra 10s...`
      });
      await sleep(10000);
    }

    cycle++;
  }

  chrome.runtime.sendMessage({
    tipo: 'LOG',
    valore: '[LAZY FODDER] Modalità arrestata. Eseguo pulizia finale...'
  });
  await clearSoldItem();
}












