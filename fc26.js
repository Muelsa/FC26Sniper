
let xUtSid = "";
let searchUrl = "";
let searchHeaders = {};
let fodderSid = ""

//variabili per sniping
let numeroTentativi;
let start = false;
let carteAcquistate = 0;
let carteVinteCiclo = 0;
let listaFodder = []
let ricercaFodder = false;
let targetMode = "fodder"; // "fodder" | "consumables" | "manual"
let chemStyle = "268";
let autoBin = true;
let manualBin = 0;
let fodderRating = "84";
let indexFodder = 0;
let idCarteAcquistate = [];
let strategyMode = "sniping"; // "sniping" | "bidding"
let minMargin = 200;
let maxSnipePrice = 0;
let activeBids = new Map(); // tradeId -> { pid, sellPrice, bidAmount, expiresAt }
let consecutiveBidErrors = 0;
let consecutiveSnipeErrors = 0;
let consecutiveSearchErrors = 0;
let consecutive401Errors = 0;
let lastBidTimestamp = 0;
let lastBidErrorStatus = 0;

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

// Gestione centralizzata errore 401 (Sessione scaduta / token non valido)
async function handle401Error(context = "") {
  consecutive401Errors++;
  console.warn(`[FC Sniper ${context}] Errore 401 (Sessione scaduta). Consecutivi: ${consecutive401Errors}/5`);
  if (consecutive401Errors >= 5) {
    console.error(`[FC Sniper] Rilevati 5 errori 401 consecutivi. Arresto di sicurezza.`);
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[BLOCCO - SESSIONE SCADUTA] Ricevuti 5 errori 401 di fila. La sessione della Web App è scaduta o disconnessa. Bot arrestato. Effettua nuovamente il login nella Web App.`
    });
    chrome.runtime.sendMessage({ tipo: 'START', valore: false });
    start = false;
    consecutive401Errors = 0;
  } else {
    console.warn(`[FC Sniper] In attesa di token aggiornato da Web App (3s)...`);
    await sleep(3000);
  }
}

// Gestione centralizzata Rate Limit Ricerche (429 Too Many Requests, 426 Upgrade Required, 521, 512)
async function handleSearchRateLimit(status, context = "Ricerca") {
  consecutiveSearchErrors++;
  console.warn(`[FC Sniper ${context}] Rate limit EA (${status}). Errori consecutivi: ${consecutiveSearchErrors}/3`);
  
  if (consecutiveSearchErrors >= 3) {
    console.warn(`[FC Sniper] Rilevati ${consecutiveSearchErrors} errori consecutivi di Rate Limit (${status}) in ${context}. Pausa di sicurezza 10 min...`);
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[SOFT-BAN RICERCHE RILEVATO] Limite ricerche EA (${status}) in ${context}. Pausa di sicurezza di 10 min per sbloccare l'account...`
    });
    consecutiveSearchErrors = 0;
    await sleep(600 * 1000);
  } else {
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[RATE LIMIT EA ${status}] Rilevato in ${context} (${consecutiveSearchErrors}/3). Raffreddamento preventivo di 25s per proteggere l'account...`
    });
    await sleep(getRandomGaussian(25.0, 2.0, 20.0, 30.0) * 1000);
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
      if (details.url.includes("pin-river.data.ea.com/pinEvents") && details.requestBody?.raw) {
        const decoder = new TextDecoder("utf-8");
        const postedString = decoder.decode(details.requestBody.raw[0].bytes);
        const pinData = JSON.parse(postedString);
        console.log("[EA PIN Telemetry Intercettata]", pinData);
      }
    } catch (err) {
      // Ignora errori di parsing su payload parziali
    }
  },
  { urls: ["https://pin-river.data.ea.com/*"] },
  ["requestBody"]
);

// Funzione helper per PIN Event: inoltra l'evento alla scheda attiva della Web App EA
function triggerPinEvent(type, payload = {}) {
  try {
    chrome.tabs.query({ url: "*://www.ea.com/*" }, (tabs) => {
      if (chrome.runtime.lastError) return;
      if (tabs && tabs.length > 0) {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            scope: "PIN_BRIDGE",
            type: type,
            payload: payload
          }, () => {
            if (chrome.runtime.lastError) {
              // Silenzia errori se il content script non è pronto o tab in caricamento
            }
          });
        }
      }
    });
  } catch (err) {
    // Non bloccare mai il bot per la telemetria
  }
}

chrome.runtime.onMessage.addListener(async (message) => {
  if (message.tipo === 'START') {
    start = message.valore;

    if (start == true) {



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
      carteAcquistate = 0;
      carteVinteCiclo = 0;
      consecutive401Errors = 0;
      consecutiveBidErrors = 0;
      consecutiveSnipeErrors = 0;
      consecutiveSearchErrors = 0;

      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Avvio operazione (' + (strategyMode === 'bidding' ? 'Mass Bidding' : 'Sniping') + ')' });
      chrome.runtime.sendMessage({ tipo: 'CARTA_ACQUISTATA', valore: "" });
      crediti = await getCrediti()
      chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });

      // All'avvio puliamo la lista trasferimenti da venduti e rimettiamo in vendita eventuali invendute
      await clearSoldItem();

      // Se in modalità bidding, riconcilia la Watchlist per recuperare carte vinte da sessioni precedenti
      if (strategyMode === "bidding") {
        await reconcileWatchlistOnStartup();
        crediti = await getCrediti();
        chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });
      }

      if (targetMode === "consumables") {
        const styleName = chemStyle === "all" ? "Rotazione (Ombra & Cacciatore)" : (CHEM_STYLES[chemStyle]?.name || `Stile ${chemStyle}`);
        if (strategyMode === "bidding") {
          chrome.runtime.sendMessage({ tipo: 'LOG', valore: `Avvio MASS BIDDING Consumabili (${styleName}, Margine min ${minMargin})` });
          await sendConsumableBiddingRequest();
        } else {
          chrome.runtime.sendMessage({ tipo: 'LOG', valore: `Avvio SNIPING Consumabili (${styleName})` });
          await sendConsumableResearchRequest();
        }
      } else if (targetMode === "fodder" || ricercaFodder === true) {
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

          //aggiorno contatore tentativi rimasti
          chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });

          let randomValue;
          if ((i + 1) % 5 == 0) randomValue = getRandomGaussian(3.5, 0.6, 2.0, 5.0); // pausa ogni 5 tentativi
          else randomValue = getRandomGaussian(1.0, 0.2, 0.5, 1.8); // sleep gaussiano tra le ricerche

          await sleep(randomValue * 1000);

          i++;
        }

        //pulisco la lista trasferimenti dagli elementi venduti a fine ricerche
        await clearSoldItem()
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
    return data?.credits ?? data?.credit ?? 0;
  } catch (error) {
    console.error('[ERROR Updating credits]', error);
    return 'N/D';
  }
}

async function clearSoldItem() {
  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    "x-ut-sid": xUtSid,
  });

  try {
    const response = await fetch(deleteSoldUrl, {
      method: "DELETE",
      headers: headers,
    });

    console.log('[FC Sniper] Lista trasferimenti pulita da venduti');
  } catch (error) {
    console.error('[ERROR clearing sold items]', error);
  }

  // Controlla e rimette in vendita automaticamente eventuali carte scadute/invendute
  await checkAndRelistExpiredItems();
}

// Controlla la lista trasferimenti per rilevare oggetti scaduti/invenduti e rimetterli in vendita
// Esegue la sequenza nativa ufficiale della Web App: PUT /auctionhouse/relist (body: null) seguito da GET /tradepile
async function checkAndRelistExpiredItems() {
  if (!xUtSid) return;

  const tradepileUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/tradepile";
  const relistUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/auctionhouse/relist";

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
      if (res.status === 401) await handle401Error("Tradepile Check");
      return;
    }
    consecutive401Errors = 0;
    const data = await res.json();
    const auctions = data.auctionInfo || [];

    // Cerchiamo le carte scadute e non vendute nella lista trasferimenti
    const expiredUnsold = auctions.filter(a =>
      (a.tradeState === "closed" || a.tradeState === "expired" || a.expires === -1 || a.expires === 0) &&
      (!a.currentBid || a.currentBid === 0) &&
      (a.buyNowPrice > 0 || a.startingBid > 0)
    );

    if (expiredUnsold.length > 0) {
      console.log(`[FC Sniper Tradepile] Rilevate ${expiredUnsold.length} carte scadute/invendute. Eseguo Re-list...`);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[Tradepile] Rilevate ${expiredUnsold.length} carte invendute. Rimetto in vendita al prezzo precedente...`
      });

      let relistSuccess = false;
      try {
        // 1. Chiamata 1 nativa Web App: PUT /auctionhouse/relist con body: null
        const relistHeaders = new Headers({
          "accept": "*/*",
          "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
          "content-type": "application/json",
          "x-ut-sid": xUtSid
        });

        const relistRes = await fetch(relistUrl, {
          method: "PUT",
          headers: relistHeaders,
          body: null
        });

        if (relistRes.ok) {
          relistSuccess = true;
          consecutive401Errors = 0;
          console.log(`[FC Sniper Tradepile] ${expiredUnsold.length} carte scadute rimesse in vendita con successo (PUT relist)!`);
          chrome.runtime.sendMessage({
            tipo: 'LOG',
            valore: `[Tradepile] ${expiredUnsold.length} carte rimesse in vendita sul mercato!`
          });

          // 2. Chiamata 2 nativa Web App: GET /tradepile per sincronizzare la lista trasferimenti
          await sleep(getRandomGaussian(0.5, 0.1, 0.4, 0.7) * 1000);
          const syncRes = await fetch(tradepileUrl, { method: "GET", headers });
          if (syncRes.ok) {
            console.log(`[FC Sniper Tradepile] Lista trasferimenti sincronizzata con successo dopo relist.`);
          }
        } else if (relistRes.status === 401) {
          await handle401Error("Relist Tradepile");
          return;
        } else {
          console.warn(`[FC Sniper Tradepile] PUT relist ha restituito status ${relistRes.status}`);
        }
      } catch (err) {
        console.warn(`[FC Sniper Tradepile] Errore chiamata bulk relist:`, err);
      }

      if (!relistSuccess) {
        // Fallback: se la chiamata bulk non ha avuto successo, rilista singolarmente
        console.warn(`[FC Sniper Tradepile] Relist bulk non eseguito, rilistaggio elemento per elemento...`);
        for (const item of expiredUnsold) {
          const buyNow = item.buyNowPrice;
          const itemId = item.itemData?.id;
          if (itemId && buyNow > 0) {
            await sellSingleItem(itemId, buyNow, item.startingBid);
            await sleep(getRandomGaussian(1.2, 0.15, 1.0, 1.5) * 1000);
          }
        }
      }
    }
  } catch (err) {
    console.error("[FC Sniper Tradepile Error]", err);
  }
}


//Funzioni per chiamate HTTP

// Funzione per inviare una richiesta GET (ricerca)
async function sendResearchRequest() {
  try {
    // Controlla che l'URL e l'header siano definiti
    if (!searchUrl || !searchHeaders) {
      console.error("URL o Header non definiti");
      return;
    }

    // Invia segnale al bridge per simulare i PIN Event nativi di ricerca
    triggerPinEvent("TRIGGER_PIN_SEARCH");

    if (searchUrl.includes('start=0') && !searchUrl.includes('maxb=200')) searchUrl = searchUrl.replace('start=0', 'start=200')
    else if (searchUrl.includes('start=200')) searchUrl = searchUrl.replace('start=200', 'start=0')


    const headers = new Headers({
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
      "X-UT-SID": xUtSid
    });

    // Invia la richiesta GET
    const response = await fetch(searchUrl, {
      method: "GET",
      headers: headers,
    });


    // Controlla la risposta
    if (response.ok) {
      consecutiveSearchErrors = 0;
      consecutive401Errors = 0;
      const data = await response.json();
      if (data.auctionInfo && data.auctionInfo.length > 0) {
        idCarteAcquistate = [];
        console.log('[FC Sniper] Ho trovato ' + data.auctionInfo.length + ' carte');

        for (const auction of data.auctionInfo) {
          let tradeId = auction.tradeId;
          let buyNowPrice = auction.buyNowPrice;
          let itemDataId = auction.itemData.id;

          await sendBuyNowRequest(tradeId, buyNowPrice, itemDataId, idCarteAcquistate);
        };

        if (idCarteAcquistate.length > 0) await sendToTransferList();

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
  let buyNowUrl = 'https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/trade/' + tradeId + '/bid';

  if (!buyNowUrl || !searchHeaders) {
    console.error("URL o Header non definiti");
    return;
  }

  // Invia segnale al bridge per simulare selezione carta e conferma modale nei PIN Event nativi
  triggerPinEvent("TRIGGER_PIN_BUY_NOW", { tradeId, buyNowPrice, itemId });


  const headers = new Headers({
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    "X-UT-SID": xUtSid
  });

  let body = JSON.stringify({ bid: buyNowPrice });


  // Invia la richiesta PUT
  try {
    const response = await fetch(buyNowUrl, {
      method: "PUT",
      headers: headers,
      body: body
    });
    if (response.ok) {
      consecutiveSnipeErrors = 0;
      consecutive401Errors = 0;
      const data = await response.json();
      carteAcquistate += 1;
      idCarteAcquistate.push(itemId);
      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Ho acquistato una carta al prezzo di: ' + buyNowPrice });
      chrome.runtime.sendMessage({ tipo: 'CARTA_ACQUISTATA', valore: carteAcquistate });

    } else {
      let errorDetails = "";
      try {
        const errJson = await response.json();
        errorDetails = errJson.reason || errJson.message || JSON.stringify(errJson);
      } catch {
        try { errorDetails = await response.text(); } catch {}
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
        consecutiveSnipeErrors++;
        console.warn(`[Snipe Fallito ${response.status} - Rate Limit EA] Trade ${tradeId}, prezzo ${buyNowPrice}. Dettagli EA: ${errorDetails}. Errori consecutivi: ${consecutiveSnipeErrors}`);

        if (consecutiveSnipeErrors >= 5) {
          console.warn(`[FC Sniper] Rilevati ${consecutiveSnipeErrors} errori consecutivi di Snipe Soft-Ban (${response.status}). Attivazione pausa di sicurezza...`);
          chrome.runtime.sendMessage({
            tipo: 'LOG',
            valore: `[SOFT-BAN SNIPE RILEVATO] Limite acquisti EA raggiunto (${response.status}). Pausa di sicurezza di 10 min per sbloccare l'account...`
          });
          consecutiveSnipeErrors = 0;
          await sleep(600 * 1000); // 10 minuti di pausa di sicurezza
        } else {
          await sleep(getRandomGaussian(3.5, 0.3, 3.0, 4.2) * 1000);
        }
      } else if (response.status === 478 || response.status === 461) {
        // Carta già acquistata da un altro utente (normale durante lo sniping)
        console.log(`[FC Sniper] Carta già acquistata da un altro utente (${response.status}) su Trade ${tradeId}`);
      } else {
        console.error("Errore nell'acquisto:", response.status, response.statusText, errorDetails);
      }
    }
  } catch (error) {
    console.error("Errore durante l'invio della richiesta di acquisto:", error);
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
  for (id of idCarteAcquistate) {
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

    //Ottiene l'URL finale come stringa
    const searchUrlCompleto = url.href;


    try {
      // Controlla che l'URL e l'header siano definiti
      if (!searchUrlCompleto || !searchHeaders) {
        console.error("URL o Header non definiti");
        return;
      }

      // Invia segnale al bridge per simulare i PIN Event nativi di ricerca
      triggerPinEvent("TRIGGER_PIN_SEARCH");

      if (searchUrlCompleto.includes('start=0') && !searchUrl.includes('maxb=200')) searchUrl = searchUrl.replace('start=0', 'start=200')
      else if (searchUrlCompleto.includes('start=200')) searchUrl = searchUrl.replace('start=200', 'start=0')


      const headers = new Headers({
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Content-Type": "application/json",
        "X-UT-SID": xUtSid
      });

      // Invia la richiesta GET
      const response = await fetch(searchUrlCompleto, {
        method: "GET",
        headers: headers,
      });


      // Controlla la risposta
      if (response.ok) {
        consecutiveSearchErrors = 0;
        consecutive401Errors = 0;
        const data = await response.json();
        if (data.auctionInfo && data.auctionInfo.length > 0) {
          console.log('[FC Sniper] Ho trovato ' + data.auctionInfo.length + ' carte');
          idCarteAcquistate = [];

          for (const auction of data.auctionInfo) {
            let tradeId = auction.tradeId;
            let buyNowPrice = auction.buyNowPrice;
            let itemDataId = auction.itemData.id;

            await sendBuyNowRequest(tradeId, buyNowPrice, itemDataId);

          };

          //invio alla lista trasferimenti
          //if(idCarteAcquistate.length > 0) 
          if (idCarteAcquistate.length > 0) {
            await sendToTransferList();
            await sellFodder(next.price);
          }

        }
      } else {
        if (response.status === 401) {
          await handle401Error("Ricerca Fodder Sniping");
        } else if (response.status === 458) {
          console.warn("[FC Sniper Ricerca Fodder] CAPTCHA 458 rilevato!");
          chrome.runtime.sendMessage({
            tipo: 'LOG',
            valore: '[ATTENZIONE - CAPTCHA RILEVATO] Verifica richiesta nella Web App. Bot arrestato.'
          });
          start = false;
        } else if (response.status === 429 || response.status === 426 || response.status === 521 || response.status === 512) {
          await handleSearchRateLimit(response.status, "Ricerca Fodder Sniping");
        } else {
          console.error("Errore nella ricerca:", response.status, response.statusText);
        }
      }
    } catch (error) {
      console.error("Errore durante l'invio della richiesta:", error);
    }

    //sleep
    //aggiorno contatore tentativi rimasti
    chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });
    let randomValue;
    if ((i + 1) % 50 == 0 && i != numeroTentativi - 1) {
      randomValue = getRandomInRange(300, 420); //sleep random tra 5 minuti e 7 minuti ogni 50 tentativi
      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Cool down di: ' + randomValue + ' sec' });

      //ogni 50 tentativi pulisco la lista trasferimenti dagli elementi venduti
      await clearSoldItem()
    }
    else if ((i + 1) % 5 == 0) randomValue = getRandomGaussian(3.5, 0.6, 2.0, 5.0); // pausa ogni 5 tentativi
    else randomValue = getRandomGaussian(1.0, 0.2, 0.5, 1.8); // sleep gaussiano tra le ricerche

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
    ricercaFodder = message.valore;
    if (message.targetMode) targetMode = message.targetMode;
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
      triggerPinEvent("TRIGGER_PIN_SELL", { itemId: id, price });

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
async function sendBidRequest(tradeId, bidAmount, itemId) {
  const bidUrl = 'https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/trade/' + tradeId + '/bid';
  if (!xUtSid) {
    console.error("X-UT-SID non definito");
    return false;
  }

  // Queue Anti-Collisione Globale:
  // Garantisce che nessun'offerta verso EA possa partire a meno di 1.2s dalla precedente,
  // impedendo a pacchetti simultanei di sovrapporsi e colpire il server nello stesso millisecondo.
  const elapsed = Date.now() - lastBidTimestamp;
  const MIN_BID_INTERVAL_MS = 1200;
  if (elapsed < MIN_BID_INTERVAL_MS) {
    const waitMs = MIN_BID_INTERVAL_MS - elapsed;
    await sleep(waitMs);
  }

  triggerPinEvent("TRIGGER_PIN_BID", { tradeId, bidAmount, itemId });

  const headers = new Headers({
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    "X-UT-SID": xUtSid
  });

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
      console.log(`[FC Sniper] Offerta di ${bidAmount} crediti inviata (Trade: ${tradeId})`);
      return true;
    } else {
      let errorDetails = "";
      try {
        const errJson = await response.json();
        errorDetails = errJson.reason || errJson.message || JSON.stringify(errJson);
      } catch {
        try { errorDetails = await response.text(); } catch {}
      }

      if (response.status === 401) {
        await handle401Error("Bid");
      } else if (response.status === 429 || response.status === 426 || response.status === 512 || response.status === 521) {
        consecutiveBidErrors++;
        console.warn(`[Bid Fallito ${response.status} - Rate Limit EA] Trade ${tradeId}, offerta ${bidAmount}. Dettagli EA: ${errorDetails}. Errori consecutivi: ${consecutiveBidErrors}`);

        if (consecutiveBidErrors >= 3) {
          console.warn(`[FC Sniper] Rilevati ${consecutiveBidErrors} errori consecutivi di Bid Soft-Ban (${response.status}). Attivazione pausa di sicurezza...`);
          chrome.runtime.sendMessage({
            tipo: 'LOG',
            valore: `[SOFT-BAN BID RILEVATO] Limite offerte EA raggiunto (${response.status}). Pausa di sicurezza di 10 min per sbloccare l'account...`
          });
          consecutiveBidErrors = 0;
          await sleep(600 * 1000); // 10 minuti di pausa di sicurezza
        } else {
          // Raffreddamento immediato al primo/secondo errore rate-limit
          await sleep(getRandomGaussian(8.0, 1.0, 6.0, 10.0) * 1000);
        }
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
  const transferListUrl = 'https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/item';
  const headers = new Headers({
    "accept": "*/*",
    "content-type": "application/json",
    "X-UT-SID": xUtSid
  });
  const body = JSON.stringify({ itemData: [{ id: itemId, pile: "trade" }] });
  try {
    const res = await fetch(transferListUrl, { method: "PUT", headers, body });
    return res.ok;
  } catch (e) {
    console.error("Errore spostamento a tradepile:", e);
    return false;
  }
}

// Mette in vendita un singolo oggetto al prezzo Buy Now specificato (e startingBid opzionale)
async function sellSingleItem(itemId, price, startingBid = null) {
  if (!xUtSid) return false;
  const sellUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/auctionhouse";
  const headers = new Headers({
    "accept": "*/*",
    "content-type": "application/json",
    "x-ut-sid": xUtSid
  });
  const step = getEaStep(price);
  const startBid = startingBid && startingBid > 0 ? startingBid : Math.max(price - step, 200);
  const body = JSON.stringify({
    buyNowPrice: price,
    duration: 3600,
    itemData: { id: itemId },
    startingBid: startBid
  });

  try {
    triggerPinEvent("TRIGGER_PIN_SELL", { itemId, price });

    const resp = await fetch(sellUrl, {
      method: "POST",
      headers,
      body,
      referrer: "https://www.ea.com/",
      mode: "cors"
    });
    if (resp.ok) {
      consecutive401Errors = 0;
      console.log(`[FC Sniper] Carta messa in vendita al BIN: ${price} crediti (Start: ${startBid})`);
      return true;
    } else if (resp.status === 401) {
      await handle401Error("Listing");
    }
    return false;
  } catch (e) {
    console.error("Errore listing carta vinta:", e);
    return false;
  }
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
    if (res.status === 401) await handle401Error("DeleteFromWatchlist");
  } catch (e) {
    console.error("Errore cancellazione da watchlist:", e);
  }
}

// Recupera il prezzo di mercato reale di un fodder in base al pid/assetId o al rating
async function getFodderPriceForItem(itemData) {
  if (!itemData) return 0;
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
  triggerPinEvent("TRIGGER_PIN_WATCHLIST");

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

          if (!sellPrice || sellPrice <= 0) {
            const detectedStyleId = tracked?.playStyleId ||
                                   item.itemData?.playStyle ||
                                   item.itemData?.cardsubtypeid ||
                                   item.itemData?.assetId;

            if (detectedStyleId && CHEM_STYLES[String(detectedStyleId)]) {
              console.log(`[FC Sniper Reconciliation] Rilevato consumabile ${CHEM_STYLES[String(detectedStyleId)].name}. Recupero Lowest BIN...`);
              sellPrice = await discoverConsumableLowestBin(detectedStyleId, manualBin);
            } else if (tracked?.isConsumable || item.itemData?.itemType === "training") {
              sellPrice = await discoverConsumableLowestBin("268", manualBin);
            } else {
              sellPrice = await getFodderPriceForItem(item.itemData);
            }
          }

          await moveSingleItemToTrade(itemId);
          if (sellPrice > 0) {
            console.log(`[FC Sniper Reconciliation] Rilevata carta vinta (Trade: ${tradeId}). Sposto a lista trasferimenti a ${sellPrice}...`);
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

  triggerPinEvent("TRIGGER_PIN_WATCHLIST");

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

          if (!sellPrice || sellPrice <= 0) {
            const detectedStyleId = tracked?.playStyleId ||
                                   item.itemData?.playStyle ||
                                   item.itemData?.cardsubtypeid ||
                                   item.itemData?.assetId;

            if (detectedStyleId && CHEM_STYLES[String(detectedStyleId)]) {
              console.log(`[FC Sniper Watchlist] Risoluzione dinamica prezzo per ${CHEM_STYLES[String(detectedStyleId)].name}...`);
              sellPrice = await discoverConsumableLowestBin(detectedStyleId, manualBin);
            } else if (tracked?.isConsumable || item.itemData?.itemType === "training") {
              sellPrice = await discoverConsumableLowestBin("268", manualBin);
            } else {
              sellPrice = await getFodderPriceForItem(item.itemData);
            }
          }

          const buyPrice = item.currentBid || tracked?.bidAmount || 'N/D';

          await moveSingleItemToTrade(itemId);

          if (sellPrice && sellPrice > 0) {
            chrome.runtime.sendMessage({ tipo: 'LOG', valore: `ASTA VINTA a ${buyPrice} crediti! Messa in vendita a ${sellPrice} crediti.` });
            await sellSingleItem(itemId, sellPrice);
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
    // Raccoglie le aste attive su cui siamo stati SUPERATI (outbid) negli ultimi 8 secondi
    const eligibleActions = [];
    for (const item of auctions) {
      if (item.tradeState === "active") {
        const tradeId = item.tradeId;
        const tracked = storedBids[String(tradeId)] || activeBids.get(tradeId) || activeBids.get(Number(tradeId));
        if (tracked && tracked.maxBidAllowed) {
          const nextBid = calculateNextBid(item.startingBid, item.currentBid);
          // Se il prossimo rilancio supera già il tetto massimo, abbandoniamo subito senza aspettare
          if (nextBid > tracked.maxBidAllowed) {
            console.log(`[FC Sniper Watchlist] Asta Trade ${tradeId} (${tracked.name || 'Trade ' + tradeId}) superata a ${item.currentBid}. Il prossimo rilancio (${nextBid}) supererebbe il limite (${tracked.maxBidAllowed}). Abbandono.`);
            await deleteFromWatchlist(tradeId);
            await removeStoredPendingBid(tradeId);
            activeBids.delete(String(tradeId));
            activeBids.delete(Number(tradeId));
            continue;
          }

          if (item.bidState === "outbid") {
            // Carta SUPERATA: finestra sniper di controrilancio (<= 8s)
            if (item.expires !== undefined && item.expires <= 8) {
              eligibleActions.push({ item, tracked });
            }
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

        if (tracked.lastFailedBid && tracked.lastFailedBid >= nextBid) {
          nextBid = calculateNextBid(tracked.lastFailedBid, tracked.lastFailedBid);
          console.log(`[FC Sniper] Offerta precedente a ${tracked.lastFailedBid} fallita/superata. Ricalcolo controrilancio a ${nextBid}...`);
        }

        if (nextBid <= tracked.maxBidAllowed) {
          console.log(`[FC Sniper Queue] CONTRORILANCIO #${nextRebidNumber} (Sniper a ${item.expires}s) su Trade ${tradeId}: superato a ${item.currentBid}, rilancio a ${nextBid} crediti (Max: ${tracked.maxBidAllowed})`);

          const ok = await sendBidRequest(tradeId, nextBid, itemId);
          if (ok) {
            tracked.bidAmount = nextBid;
            tracked.rebidCount = nextRebidNumber;
            delete tracked.lastFailedBid;
            tracked.expiresAt = Date.now() + (item.expires * 1000);
            await storePendingBid(tradeId, tracked);
            activeBids.set(String(tradeId), tracked);
            // Ritardo rapido tra offerte consecutive
            await sleep(getRandomGaussian(1.0, 0.1, 0.85, 1.2) * 1000);
          } else {
            tracked.lastFailedBid = nextBid;
            await storePendingBid(tradeId, tracked);
            activeBids.set(String(tradeId), tracked);
            // Se fallito per rate limit EA, interrompiamo subito la coda per non accumulare errori
            if (lastBidErrorStatus === 429 || lastBidErrorStatus === 426 || lastBidErrorStatus === 512 || lastBidErrorStatus === 521) {
              console.warn(`[FC Sniper Queue] Errore ${lastBidErrorStatus} su Trade ${tradeId}. Arresto coda offerte.`);
              break;
            }
          }
        } else if (nextBid > tracked.maxBidAllowed) {
          console.log(`[FC Sniper] Asta Trade ${tradeId} superata a ${item.currentBid}. Il prossimo rilancio (${nextBid}) supererebbe il limite (${tracked.maxBidAllowed}). Abbandono.`);
          await deleteFromWatchlist(tradeId);
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

    // 2. Risoluzione Watchlist disaccoppiata e mirata:
    // Se abbiamo piazzato offerte o abbiamo aste in chiusura immediata (<= 20s), difendiamo fino alla conclusione
    if (offersCount > 0) {
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

  // Cache valida per 4 minuti per evitare chiamate ripetute ad ogni ciclo
  if (!forceRefresh && consumableBinCache.has(String(playStyleId))) {
    const cached = consumableBinCache.get(String(playStyleId));
    if (Date.now() - cached.timestamp < 4 * 60 * 1000) {
      return cached.price;
    }
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

    // CASO A: Trovate poche carte (1-3) e TUTTE hanno tempo 58-59 minuti rimanenti!
    // Significa che a questo prezzo le carte vengono acquistate quasi all'istante
    if (totalCards > 0 && totalCards <= MAX_INSTANT_CARDS && staleCards.length === 0) {
      verifiedBin = candidateBin;
      console.log(`[FC Sniper Consumabili] Condizione di vendita istantanea confermata a ${verifiedBin} crediti! (${totalCards} carte, tutte a 58-59 min).`);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[Auto-Discovery] Lowest BIN istantaneo per ${styleMeta.name}: ${verifiedBin} crediti (${totalCards} carte a 58-59m)!`
      });
      break;
    }

    // CASO B: 0 carte trovate a questo prezzo
    if (totalCards === 0) {
      if (previousPriceHadStale) {
        // Al gradino superiore c'erano carte che non vendevano all'istante, mentre a questo livello il mercato è completamente vuoto.
        // Listando a candidateBin saremo i più economici e la carta venderà all'istante!
        verifiedBin = candidateBin;
        console.log(`[FC Sniper Consumabili] Mercato vuoto a ${candidateBin} crediti (carte stagnanti al gradino superiore). Prezzo istantaneo: ${verifiedBin}`);
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[Auto-Discovery] Lowest BIN istantaneo per ${styleMeta.name}: ${verifiedBin} crediti (mercato vuoto, vende all'istante)!`
        });
      } else {
        // Se non c'erano carte prima, allineiamo al gradino superiore
        verifiedBin = candidateBin + getEaStep(candidateBin);
        console.log(`[FC Sniper Consumabili] Nessuna carta a ${candidateBin}. Allineo al gradino superiore: ${verifiedBin}`);
      }
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
  const targetStyles = (chemStyle === "all") ? ["268", "266"] : [chemStyle];
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

    // 2. Risoluzione Watchlist disaccoppiata e mirata:
    // Se abbiamo piazzato offerte o abbiamo aste in chiusura immediata (<= 20s), difendiamo fino alla conclusione
    if (offersCount > 0) {
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

// Motore di SNIPING Consumabili (Stili Intesa)
async function sendConsumableResearchRequest() {
  let i = 0;
  const targetStyles = (chemStyle === "all") ? ["268", "266"] : [chemStyle];
  let styleIndex = 0;
  const minBidBumps = [150, 200, 250];

  while (start === true && i < numeroTentativi) {
    const currentStyleId = targetStyles[styleIndex];
    styleIndex = (styleIndex + 1) % targetStyles.length;
    const styleMeta = CHEM_STYLES[currentStyleId] || { id: currentStyleId, name: `Stile ${currentStyleId}`, defaultGuess: 3000 };

    const marketPrice = await discoverConsumableLowestBin(currentStyleId, manualBin, i === 0);
    let snipePrice;
    if (maxSnipePrice && maxSnipePrice > 0) {
      snipePrice = maxSnipePrice;
    } else {
      snipePrice = roundDownToStep(marketPrice * 0.82);
    }

    if (i % 10 === 0) {
      console.log(`[FC Sniper Sniping] Tentativo ${i + 1}/${numeroTentativi}: cerca ${styleMeta.name} a Compra Ora <= ${snipePrice} (Vendita prevista: ${marketPrice})`);
    }

    const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
    const url = new URL(baseUrl);
    url.searchParams.set("num", "21");
    url.searchParams.set("start", "0");
    url.searchParams.set("type", "training");
    url.searchParams.set("cat", "playStyle");
    url.searchParams.set("playStyle", String(currentStyleId));
    url.searchParams.set("maxb", String(snipePrice));
    
    // Cache busting sicuro (max 250 per evitare conflitti con prezzi bassi)
    let currentBump = minBidBumps[i % minBidBumps.length];
    if (currentBump >= snipePrice) currentBump = 150;
    url.searchParams.set("micr", String(currentBump));

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
        consecutiveSearchErrors = 0;
        consecutive401Errors = 0;
        const data = await response.json();
        if (data.auctionInfo && data.auctionInfo.length > 0) {
          console.log(`[FC Sniper Sniping Consumabili] CATTURA! Trovate ${data.auctionInfo.length} carte per ${styleMeta.name} sotto il prezzo di snipe (${snipePrice})`);
          idCarteAcquistate = [];
          for (const auction of data.auctionInfo) {
            if (auction.buyNowPrice <= snipePrice) {
              await sendBuyNowRequest(auction.tradeId, auction.buyNowPrice, auction.itemData?.id);
            }
          }
          if (idCarteAcquistate.length > 0) {
            await sendToTransferList();
            for (const id of idCarteAcquistate) {
              await sellSingleItem(id, marketPrice);
            }
            crediti = await getCrediti();
            chrome.runtime.sendMessage({ tipo: 'CREDITI', valore: crediti });
          }
        }
      } else if (response.status === 401) {
        await handle401Error("Ricerca Sniping Consumabili");
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

    chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });

    // Pulizia periodica venduti per liberare la lista trasferimenti
    if ((i + 1) % 25 === 0) {
      await clearSoldItem();
    }

    let randomValue;
    if ((i + 1) % 60 === 0 && i !== numeroTentativi - 1) {
      randomValue = getRandomInRange(120, 180);
      chrome.runtime.sendMessage({ tipo: 'LOG', valore: `Cool down di sicurezza: ${Math.round(randomValue)}s` });
      await clearSoldItem();
    } else if ((i + 1) % 8 === 0) {
      randomValue = getRandomGaussian(2.5, 0.4, 1.8, 3.5);
    } else {
      randomValue = getRandomGaussian(1.2, 0.2, 0.8, 1.7);
    }
    await sleep(randomValue * 1000);
    i++;
  }
  await clearSoldItem();
}



