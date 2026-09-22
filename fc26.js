
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

// Funzione helper per PIN Event (disattivata: la Web App di EA gestisce nativamente la telemetria)
function triggerPinEvent(type, payload = {}) {
  // no-op: evita di inviare eventi sintetici non validi a EA River
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

// Restituisce i millisecondi rimanenti alla scadenza dell'asta attiva più vicina
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
      // Consideriamo urgente SOLO un'asta che sta ancora attivamente correndo (diff > 0)
      if (diff > 0 && diff < minRemainingMs) {
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
async function checkAndRelistExpiredItems() {
  if (!xUtSid) return;

  const tradepileUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/tradepile";
  const relistUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/auctionhouse/relist";

  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
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
      (a.tradeState === "closed" || a.tradeState === "expired") &&
      (!a.currentBid || a.currentBid === 0)
    );

    if (expiredUnsold.length > 0) {
      console.log(`[FC Sniper Tradepile] Rilevate ${expiredUnsold.length} carte scadute/invendute. Rimetto in vendita...`);
      chrome.runtime.sendMessage({
        tipo: 'LOG',
        valore: `[Tradepile] Rilevate ${expiredUnsold.length} carte invendute. Rimetto in vendita al prezzo precedente...`
      });

      // Chiamata all'endpoint nativo EA di rilistaggio di massa
      const relistRes = await fetch(relistUrl, {
        method: "PUT",
        headers: headers,
        body: JSON.stringify({})
      });

      if (relistRes.ok) {
        console.log(`[FC Sniper Tradepile] ${expiredUnsold.length} carte scadute rimesse in vendita con successo!`);
        chrome.runtime.sendMessage({
          tipo: 'LOG',
          valore: `[Tradepile] ${expiredUnsold.length} carte rimesse in vendita sul mercato!`
        });
      } else if (relistRes.status === 401) {
        await handle401Error("Relist Tradepile");
      } else {
        // Fallback: se la chiamata bulk fallisce, le rimettiamo in vendita singolarmente con il loro prezzo originale
        console.warn(`[FC Sniper Tradepile] Relist bulk ${relistRes.status}, rilistaggio elemento per elemento...`);
        for (const item of expiredUnsold) {
          const buyNow = item.buyNowPrice;
          const itemId = item.itemData?.id;
          if (itemId && buyNow > 0) {
            await sellSingleItem(itemId, buyNow);
            await sleep(getRandomGaussian(1.5, 0.2, 1.2, 2.0) * 1000);
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
      } else if (response.status === 429 || response.status === 521 || response.status === 426) {
        consecutiveSearchErrors++;
        console.warn(`[FC Sniper Ricerca] Rate limit EA (${response.status}). Errori consecutivi: ${consecutiveSearchErrors}`);
        if (consecutiveSearchErrors >= 5) {
          chrome.runtime.sendMessage({
            tipo: 'LOG',
            valore: `[SOFT-BAN RICERCHE RILEVATO] Limite ricerche EA raggiunto (${response.status}). Pausa di sicurezza di 10 min...`
          });
          consecutiveSearchErrors = 0;
          await sleep(600 * 1000);
        } else {
          await sleep(getRandomGaussian(3.5, 0.3, 3.0, 4.2) * 1000);
        }
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
        } else if (response.status === 429 || response.status === 521 || response.status === 426) {
          consecutiveSearchErrors++;
          console.warn(`[FC Sniper Ricerca Fodder] Rate limit EA (${response.status}). Errori consecutivi: ${consecutiveSearchErrors}`);
          if (consecutiveSearchErrors >= 5) {
            chrome.runtime.sendMessage({
              tipo: 'LOG',
              valore: `[SOFT-BAN RICERCHE RILEVATO] Limite ricerche EA raggiunto (${response.status}). Pausa di sicurezza di 10 min...`
            });
            consecutiveSearchErrors = 0;
            await sleep(600 * 1000);
          } else {
            await sleep(getRandomGaussian(3.5, 0.3, 3.0, 4.2) * 1000);
          }
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

// Mette in vendita un singolo oggetto al prezzo Buy Now specificato
async function sellSingleItem(itemId, price) {
  const sellUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/auctionhouse";
  const headers = new Headers({
    "accept": "*/*",
    "content-type": "application/json",
    "x-ut-sid": xUtSid
  });
  const step = getEaStep(price);
  const startBid = Math.max(price - step, 200);
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
      console.log(`[FC Sniper] Carta vinta messa in vendita al BIN: ${price} crediti`);
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

// Aggiunge un'asta alla Watchlist (Lista Osservati) senza effettuare offerte
async function addToWatchlist(tradeId) {
  if (!xUtSid) return false;

  const url = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/watchlist";
  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    "x-ut-sid": xUtSid
  });
  const body = JSON.stringify({ auctionInfo: [{ id: tradeId }] });

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

// Rimuove un'asta persa/scaduta dalla Watchlist per liberare crediti
async function deleteFromWatchlist(tradeId) {
  const url = `https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/watchlist?tradeId=${tradeId}`;
  const headers = new Headers({
    "accept": "*/*",
    "content-type": "application/json",
    "x-ut-sid": xUtSid
  });
  try {
    await fetch(url, { method: "DELETE", headers });
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
      const tracked = storedBids[String(tradeId)] || activeBids.get(tradeId) || activeBids.get(Number(tradeId));

      if (tradeState === "closed") {
        if (bidState === "highest") {
          recoveredWon++;
          let sellPrice = tracked?.sellPrice;

          if (!sellPrice || sellPrice <= 0) {
            if (item.itemData?.playStyle) {
              sellPrice = await discoverConsumableLowestBin(item.itemData.playStyle, manualBin);
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
        } else if (bidState === "outbid") {
          cleanedLost++;
          await deleteFromWatchlist(tradeId);
          await removeStoredPendingBid(tradeId);
          delete storedBids[String(tradeId)];
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
      const tradeState = item.tradeState; // "active", "closed", "expired"
      const bidState = item.bidState;     // "highest", "outbid"
      const tracked = storedBids[String(tradeId)] || activeBids.get(tradeId) || activeBids.get(Number(tradeId));
      const itemId = item.itemData?.id || tracked?.itemId;

      if (tradeState === "active") {
        // Aggiorna la scadenza precisa fornita da EA per calcolare i secondi rimanenti
        if (tracked && item.expires !== undefined) {
          tracked.expiresAt = Date.now() + (item.expires * 1000);
          activeBids.set(String(tradeId), tracked);
        }
      }

      if (tradeState === "closed") {
        if (bidState === "highest") {
          // Incrementa subito il conteggio delle carte vinte prima di spostare
          carteAcquistate += 1;
          carteVinteCiclo += 1;
          chrome.runtime.sendMessage({ tipo: 'CARTA_ACQUISTATA', valore: carteAcquistate });

          let sellPrice = tracked?.sellPrice;

          if (!sellPrice || sellPrice <= 0) {
            if (item.itemData?.playStyle) {
              sellPrice = await discoverConsumableLowestBin(item.itemData.playStyle, manualBin);
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
    // Raccoglie:
    // 1) Aste OSSERVATE (non ancora offerte) che sono entrate nella finestra di partecipazione (<= 20s)
    // 2) Aste già contese su cui siamo stati SUPERATI (outbid <= 8s)
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

          if (tracked.isWatched) {
            // Carta OSSERVATA: controlliamo se è arrivato il momento di partecipare all'asta (<= 20s)
            if (item.expires !== undefined && item.expires <= 20) {
              eligibleActions.push({ item, tracked, isInitialSniper: true });
            }
          } else if (item.bidState === "outbid") {
            // Carta SUPERATA: finestra sniper di controrilancio (<= 8s)
            if (item.expires !== undefined && item.expires <= 8) {
              eligibleActions.push({ item, tracked, isInitialSniper: false });
            }
          }
        }
      }
    }

    if (eligibleActions.length > 0) {
      // Ordina per urgenza: chi scade prima riceve l'offerta per primo
      eligibleActions.sort((a, b) => (a.item.expires || 0) - (b.item.expires || 0));

      for (const { item, tracked, isInitialSniper } of eligibleActions) {
        // Circuit Breaker: se l'offerta precedente ha ricevuto un rate-limit da EA, fermiamo la coda
        if (lastBidErrorStatus === 429 || lastBidErrorStatus === 426 || lastBidErrorStatus === 512 || lastBidErrorStatus === 521) {
          console.warn(`[FC Sniper Queue] Rate limit EA attivo (${lastBidErrorStatus}). Sospendo la coda offerte Watchlist.`);
          break;
        }

        const tradeId = item.tradeId;
        const itemId = item.itemData?.id || tracked?.itemId;
        let nextBid = calculateNextBid(item.startingBid, item.currentBid);

        const nextRebidNumber = isInitialSniper ? 0 : ((tracked.rebidCount || 0) + 1);

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
          if (isInitialSniper) {
            console.log(`[FC Sniper Watchlist] Asta osservata in scadenza (${item.expires}s) per ${tracked.name || 'Trade ' + tradeId}: È IL MOMENTO DI PARTECIPARE! Offro ${nextBid} crediti (Max: ${tracked.maxBidAllowed})`);
          } else {
            console.log(`[FC Sniper Queue] CONTRORILANCIO #${nextRebidNumber} (Sniper a ${item.expires}s) su Trade ${tradeId}: superato a ${item.currentBid}, rilancio a ${nextBid} crediti (Max: ${tracked.maxBidAllowed})`);
          }

          const ok = await sendBidRequest(tradeId, nextBid, itemId);
          if (ok) {
            tracked.isWatched = false; // Ora l'offerta è attiva a tutti gli effetti
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
    // 1. Controllo prioritario aste urgenti:
    // Se un'asta attiva scade entro 25 secondi, attendiamo e monitoriamo la watchlist.
    // In questo modo NON sovrapponiamo la ricerca sul mercato con le fasi critiche delle aste in chiusura.
    while (getUrgentAuctionTimeRemaining() <= 25000 && activeBids.size > 0 && start === true) {
      const secLeft = Math.max(0, Math.round(getUrgentAuctionTimeRemaining() / 1000));
      console.log(`[FC Sniper] Asta urgente in chiusura a breve (~${secLeft}s). Sospendo ricerche e monitoro watchlist per rilancio/vittoria...`);
      await resolveWatchlist();
      // Polling rapido e preciso (1.5-2.5s, media ~2.0s) per colpire la finestra sniper (<=8s)
      await sleep(getRandomGaussian(2.0, 0.25, 1.5, 2.5) * 1000);
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

      // Check rapido prima di ogni tentativo di ricerca: se un'asta attiva è diventata urgente (<= 25s),
      // interrompiamo subito la ricerca per andare a difendere l'asta in chiusura
      if (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 25000) {
        console.log(`[FC Sniper] Rilevata asta urgente (<= 25s) durante la ricerca. Interrompo per difenderla subito.`);
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

          // Separiamo le aste trovate:
          // 1) Aste in chiusura immediata (<= 20s): offerta diretta
          // 2) Aste con margine ma a > 20s (e <= 300s): le aggiungiamo agli osservati per ricontrollarle al momento giusto!
          const SNIPER_WINDOW_SEC = 20;
          let watchedCount = 0;

          for (const auction of auctions) {
            if (start !== true) break;
            const tradeIdStr = String(auction.tradeId);
            if (activeBids.has(tradeIdStr) || auction.bidState === "highest") continue;

            const nextBid = calculateNextBid(auction.startingBid, auction.currentBid);
            if (nextBid > maxBidAllowed) continue;

            // Caso A: Asta in chiusura immediata (<= 20s) -> Offerta diretta
            if (auction.expires > 0 && auction.expires <= SNIPER_WINDOW_SEC) {
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
                  rebidCount: 0,
                  isWatched: false
                };
                activeBids.set(tradeIdStr, bidData);
                await storePendingBid(auction.tradeId, bidData);
              } else if (lastBidErrorStatus === 429 || lastBidErrorStatus === 426 || lastBidErrorStatus === 512 || lastBidErrorStatus === 521) {
                console.warn(`[FC Sniper Queue] Rate limit EA durante offerta su ${next.name || next.pid}. Interrompo ulteriori offerte su questo calciatore.`);
                break;
              }

              // Ritardo rapido e fluido tra offerte
              await sleep(getRandomGaussian(1.1, 0.15, 0.9, 1.35) * 1000);
            }
            // Caso B: Asta a > 20s con margine -> Aggiunta agli osservati per ricontrollarla al momento giusto!
            else if (auction.expires > SNIPER_WINDOW_SEC && auction.expires <= 300 && activeBids.size < 40) {
              const watchOk = await addToWatchlist(auction.tradeId);
              if (watchOk) {
                watchedCount++;
                const watchData = {
                  pid: next.pid,
                  name: next.name,
                  sellPrice: marketPrice,
                  maxBidAllowed: maxBidAllowed,
                  bidAmount: 0,
                  rating: fodderRating,
                  itemId: auction.itemData?.id,
                  expiresAt: Date.now() + (auction.expires * 1000),
                  rebidCount: 0,
                  isWatched: true
                };
                activeBids.set(tradeIdStr, watchData);
                await storePendingBid(auction.tradeId, watchData);
                console.log(`[FC Sniper Watchlist] Asta con margine per ${next.name || 'PID ' + next.pid} a ${auction.expires}s (Trade: ${auction.tradeId}): aggiunta agli osservati per monitoraggio!`);
                await sleep(getRandomGaussian(0.50, 0.05, 0.40, 0.60) * 1000);
              }
            }
          }

          if (offersCount > 0 || watchedCount > 0) {
            console.log(`[FC Sniper] ${offersCount} offerte piazzate, ${watchedCount} aste aggiunte agli osservati per ${next.name || 'PID ' + next.pid}.`);
            break;
          } else {
            if (attempt < minBidBumps.length - 1) {
              await sleep(getRandomGaussian(0.50, 0.08, 0.40, 0.65) * 1000);
            }
          }
        } else if (response.status === 401) {
          await handle401Error("Ricerca Bidding");
          break;
        }
      } catch (err) {
        console.error("Errore ricerca bidding:", err);
        break;
      }
    }

    // 2. Risoluzione Watchlist disaccoppiata e mirata:
    // Se abbiamo piazzato offerte o abbiamo aste attive aperte, passiamo a monitorare la watchlist.
    // Se non ci sono offerte e non abbiamo aste in corso, NON chiamiamo la watchlist (risparmio chiamate e tempo).
    if (offersCount > 0 || activeBids.size > 0) {
      // Pausa naturale (1.2-2.0s) per simulare l'utente che naviga alla scheda "Obiettivi di Mercato"
      await sleep(getRandomGaussian(1.5, 0.25, 1.2, 2.0) * 1000);
      await resolveWatchlist();
    }

    // Check rapido post-ricerca / tra calciatori:
    // Se la risoluzione ha rilevato che un'asta è diventata urgente (<= 25s),
    // entriamo subito nel ciclo di monitoraggio prioritario per difenderla/rilanciare.
    // Se invece le aste attive non sono urgenti (> 25s, es. ~40s), NON restiamo fermi in attesa e riprendiamo la ricerca.
    while (getUrgentAuctionTimeRemaining() <= 25000 && activeBids.size > 0 && start === true) {
      const secLeft = Math.max(0, Math.round(getUrgentAuctionTimeRemaining() / 1000));
      console.log(`[FC Sniper] Asta urgente in chiusura a breve (~${secLeft}s). Sospendo ricerche e monitoro watchlist per rilancio/vittoria...`);
      await resolveWatchlist();
      await sleep(getRandomGaussian(2.0, 0.25, 1.5, 2.5) * 1000);
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
    // Se ci sono aste non urgenti (> 25s, es. ~40s), non attendiamo 40s a vuoto: attendiamo solo la normale pausa fisiologica (es. ~2.4s)
    // e riprendiamo subito a scansionare il mercato.
    // Se durante questa pausa fisiologica un'asta entra nei 25s, interrompiamo subito per difenderla.
    let remainingSleepMs = randomValue * 1000;
    while (remainingSleepMs > 0 && start === true) {
      if (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 25000) {
        break; // Sveglia immediata: l'asta è diventata urgente!
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
async function discoverConsumableLowestBin(playStyleId, manualBinOverride = 0, forceRefresh = false) {
  if (manualBinOverride && manualBinOverride > 0) {
    console.log(`[FC Sniper Consumabili] Usato BIN manuale impostato dall'utente: ${manualBinOverride} crediti`);
    return manualBinOverride;
  }

  const styleMeta = CHEM_STYLES[String(playStyleId)] || { id: playStyleId, name: `Stile ${playStyleId}`, defaultGuess: 3000 };

  if (!forceRefresh && consumableBinCache.has(String(playStyleId))) {
    const cached = consumableBinCache.get(String(playStyleId));
    if (Date.now() - cached.timestamp < 5 * 60 * 1000) {
      return cached.price;
    }
  }

  console.log(`[FC Sniper Consumabili] Rilevamento automatico Lowest BIN per ${styleMeta.name}...`);
  chrome.runtime.sendMessage({
    tipo: 'LOG',
    valore: `[Auto-Discovery] Cerco il Lowest BIN attuale sul mercato per ${styleMeta.name}...`
  });

  const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
  let guess = styleMeta.defaultGuess || 3000;
  let foundBin = 0;

  for (let attempt = 0; attempt < 3; attempt++) {
    const testMaxb = guess + (attempt * 1000);
    const url = new URL(baseUrl);
    url.searchParams.set("num", "21");
    url.searchParams.set("start", "0");
    url.searchParams.set("type", "training");
    url.searchParams.set("cat", "playStyle");
    url.searchParams.set("playStyle", String(playStyleId));
    url.searchParams.set("maxb", String(testMaxb));

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
      const resp = await fetch(url.href, { method: "GET", headers });
      if (resp.status === 401) {
        await handle401Error("AutoDiscovery Consumabili");
        break;
      }
      if (!resp.ok) break;

      const data = await resp.json();
      const auctions = data.auctionInfo || [];

      if (auctions.length > 0) {
        const buyNowPrices = auctions.map(a => a.buyNowPrice).filter(p => p > 0);
        if (buyNowPrices.length > 0) {
          foundBin = Math.min(...buyNowPrices);

          // Verifica se esistono carte a un gradino inferiore
          const lowerStep = getEaStep(foundBin);
          const checkMaxb = Math.max(200, foundBin - lowerStep);

          await sleep(getRandomGaussian(1.0, 0.15, 0.8, 1.3) * 1000);

          const checkUrl = new URL(baseUrl);
          checkUrl.searchParams.set("num", "21");
          checkUrl.searchParams.set("start", "0");
          checkUrl.searchParams.set("type", "training");
          checkUrl.searchParams.set("cat", "playStyle");
          checkUrl.searchParams.set("playStyle", String(playStyleId));
          checkUrl.searchParams.set("maxb", String(checkMaxb));

          const checkResp = await fetch(checkUrl.href, { method: "GET", headers });
          if (checkResp.ok) {
            const checkData = await checkResp.json();
            const checkAuctions = checkData.auctionInfo || [];
            if (checkAuctions.length > 0) {
              const lowerPrices = checkAuctions.map(a => a.buyNowPrice).filter(p => p > 0);
              if (lowerPrices.length > 0) {
                foundBin = Math.min(...lowerPrices);
              }
            }
          }
          break;
        }
      }
    } catch (e) {
      console.error("[AutoDiscovery Error]", e);
      break;
    }
    await sleep(getRandomGaussian(1.0, 0.15, 0.8, 1.3) * 1000);
  }

  if (!foundBin || foundBin <= 0) {
    foundBin = styleMeta.defaultGuess;
    console.warn(`[FC Sniper Consumabili] Auto-Discovery fallita per ${styleMeta.name}. Utilizzo valore stimato di default: ${foundBin} crediti`);
  } else {
    console.log(`[FC Sniper Consumabili] Lowest BIN confermato per ${styleMeta.name}: ${foundBin} crediti`);
    chrome.runtime.sendMessage({
      tipo: 'LOG',
      valore: `[Auto-Discovery] Lowest BIN confermato per ${styleMeta.name}: ${foundBin} crediti`
    });
  }

  consumableBinCache.set(String(playStyleId), { price: foundBin, timestamp: Date.now() });
  return foundBin;
}

// Motore principale di MASS BIDDING Consumabili (Stili Intesa)
async function sendConsumableBiddingRequest() {
  let i = 0;
  const targetStyles = (chemStyle === "all") ? ["268", "266"] : [chemStyle];
  let styleIndex = 0;

  while (start === true && i < numeroTentativi) {
    // 1. Controllo prioritario aste urgenti (<= 25s)
    while (getUrgentAuctionTimeRemaining() <= 25000 && activeBids.size > 0 && start === true) {
      const secLeft = Math.max(0, Math.round(getUrgentAuctionTimeRemaining() / 1000));
      console.log(`[FC Sniper Consumabili] Asta urgente in chiusura a breve (~${secLeft}s). Sospendo ricerche e monitoro watchlist per rilancio/vittoria...`);
      await resolveWatchlist();
      await sleep(getRandomGaussian(2.0, 0.25, 1.5, 2.5) * 1000);
    }

    if (start !== true) break;

    const currentStyleId = targetStyles[styleIndex];
    styleIndex = (styleIndex + 1) % targetStyles.length;
    const styleMeta = CHEM_STYLES[currentStyleId] || { id: currentStyleId, name: `Stile ${currentStyleId}`, defaultGuess: 3000 };

    // Recupera Lowest BIN live (aggiorna la prima volta o ogni 5 minuti)
    const marketPrice = await discoverConsumableLowestBin(currentStyleId, manualBin, i === 0);
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

      if (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 25000) {
        console.log(`[FC Sniper Consumabili] Rilevata asta urgente (<= 25s) durante la ricerca. Interrompo per difenderla subito.`);
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

          // Separiamo le aste trovate:
          // 1) Aste in chiusura immediata (<= 20s): piazziamo l'offerta sniper
          // 2) Aste a > 20s con margine: le aggiungiamo agli osservati per ricontrollarle al momento giusto!
          const SNIPER_WINDOW_SEC = 20;
          let watchedCount = 0;

          for (const auction of auctions) {
            if (start !== true) break;
            const tradeIdStr = String(auction.tradeId);
            if (activeBids.has(tradeIdStr) || auction.bidState === "highest") continue;

            const nextBid = calculateNextBid(auction.startingBid, auction.currentBid);
            if (nextBid > maxBidAllowed) continue; // Nessun margine utile

            // Caso A: Asta in chiusura immediata (<= 20s) -> Offerta diretta
            if (auction.expires > 0 && auction.expires <= SNIPER_WINDOW_SEC) {
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
                  isWatched: false,
                  isConsumable: true
                };
                activeBids.set(tradeIdStr, bidData);
                await storePendingBid(auction.tradeId, bidData);
              } else if (lastBidErrorStatus === 429 || lastBidErrorStatus === 426 || lastBidErrorStatus === 512 || lastBidErrorStatus === 521) {
                console.warn(`[FC Sniper Queue] Rate limit EA durante offerta su ${styleMeta.name}. Interrompo offerte su questo stile.`);
                break;
              }

              // Ritardo rapido e fluido tra offerte
              await sleep(getRandomGaussian(1.1, 0.15, 0.9, 1.35) * 1000);
            }
            // Caso B: Asta a > 20s con margine -> Aggiunta agli osservati per ricontrollarla al momento giusto!
            else if (auction.expires > SNIPER_WINDOW_SEC && auction.expires <= 300 && activeBids.size < 40) {
              const watchOk = await addToWatchlist(auction.tradeId);
              if (watchOk) {
                watchedCount++;
                const watchData = {
                  playStyleId: currentStyleId,
                  name: styleMeta.name,
                  sellPrice: marketPrice,
                  maxBidAllowed: maxBidAllowed,
                  bidAmount: 0,
                  itemId: auction.itemData?.id,
                  expiresAt: Date.now() + (auction.expires * 1000),
                  rebidCount: 0,
                  isWatched: true,
                  isConsumable: true
                };
                activeBids.set(tradeIdStr, watchData);
                await storePendingBid(auction.tradeId, watchData);
                console.log(`[FC Sniper Watchlist] Asta con margine per ${styleMeta.name} a ${auction.expires}s (Trade: ${auction.tradeId}): aggiunta agli osservati per monitoraggio!`);
                await sleep(getRandomGaussian(0.50, 0.05, 0.40, 0.60) * 1000);
              }
            }
          }

          if (offersCount > 0 || watchedCount > 0) {
            console.log(`[FC Sniper Consumabili] ${offersCount} offerte piazzate, ${watchedCount} aste aggiunte agli osservati per ${styleMeta.name}.`);
            break;
          } else {
            if (attempt < minBidBumps.length - 1) {
              await sleep(getRandomGaussian(0.50, 0.08, 0.40, 0.65) * 1000);
            }
          }
        } else if (response.status === 401) {
          await handle401Error("Ricerca Bidding Consumabili");
          break;
        }
      } catch (err) {
        console.error("Errore ricerca bidding consumabili:", err);
        break;
      }
    }

    if (offersCount > 0 || activeBids.size > 0) {
      await sleep(getRandomGaussian(1.5, 0.25, 1.2, 2.0) * 1000);
      await resolveWatchlist();
    }

    while (getUrgentAuctionTimeRemaining() <= 25000 && activeBids.size > 0 && start === true) {
      const secLeft = Math.max(0, Math.round(getUrgentAuctionTimeRemaining() / 1000));
      console.log(`[FC Sniper Consumabili] Asta urgente in chiusura a breve (~${secLeft}s). Sospendo ricerche e monitoro watchlist per rilancio/vittoria...`);
      await resolveWatchlist();
      await sleep(getRandomGaussian(2.0, 0.25, 1.5, 2.5) * 1000);
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
      if (activeBids.size > 0 && getUrgentAuctionTimeRemaining() <= 25000) {
        break;
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

  while (start === true && i < numeroTentativi) {
    const currentStyleId = targetStyles[styleIndex];
    styleIndex = (styleIndex + 1) % targetStyles.length;
    const styleMeta = CHEM_STYLES[currentStyleId] || { id: currentStyleId, name: `Stile ${currentStyleId}`, defaultGuess: 3000 };

    const marketPrice = await discoverConsumableLowestBin(currentStyleId, manualBin, i === 0);
    const snipePrice = Math.floor((marketPrice * 0.85) / 100) * 100;

    const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
    const url = new URL(baseUrl);
    url.searchParams.set("num", "21");
    url.searchParams.set("start", "0");
    url.searchParams.set("type", "training");
    url.searchParams.set("cat", "playStyle");
    url.searchParams.set("playStyle", String(currentStyleId));
    url.searchParams.set("maxb", String(snipePrice));

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
          console.log(`[FC Sniper Consumabili] Trovate ${data.auctionInfo.length} carte da snipare per ${styleMeta.name}`);
          idCarteAcquistate = [];
          for (const auction of data.auctionInfo) {
            await sendBuyNowRequest(auction.tradeId, auction.buyNowPrice, auction.itemData?.id);
          }
          if (idCarteAcquistate.length > 0) {
            await sendToTransferList();
            for (const id of idCarteAcquistate) {
              await sellSingleItem(id, marketPrice);
            }
          }
        }
      } else if (response.status === 401) {
        await handle401Error("Ricerca Sniping Consumabili");
      }
    } catch (error) {
      console.error("Errore ricerca sniping consumabili:", error);
    }

    chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });
    let randomValue;
    if ((i + 1) % 50 == 0 && i != numeroTentativi - 1) {
      randomValue = getRandomInRange(300, 420);
      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Cool down di: ' + randomValue + ' sec' });
      await clearSoldItem();
    } else if ((i + 1) % 5 == 0) {
      randomValue = getRandomGaussian(3.5, 0.6, 2.0, 5.0);
    } else {
      randomValue = getRandomGaussian(1.0, 0.2, 0.5, 1.8);
    }
    await sleep(randomValue * 1000);
    i++;
  }
  await clearSoldItem();
}


