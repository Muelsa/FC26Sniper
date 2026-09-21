
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
let fodderRating = "84";
let indexFodder = 0;
let idCarteAcquistate = [];
let strategyMode = "sniping"; // "sniping" | "bidding"
let minMargin = 250;
let activeBids = new Map(); // tradeId -> { pid, sellPrice, bidAmount, expiresAt }
let consecutiveBidErrors = 0;


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



      // Recupera il numero di tentativi, il rating e la strategia dallo storage
      numeroTentativi = await getNumeroTentativi();
      fodderRating = await getFodderRating();
      strategyMode = message.strategyMode || await getStrategyMode();
      minMargin = message.minMargin || await getMinMargin();
      carteAcquistate = 0;
      carteVinteCiclo = 0;


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

      switch (ricercaFodder) {
        case true:
          if (strategyMode === "bidding") {
            chrome.runtime.sendMessage({ tipo: 'LOG', valore: `Avvio MASS BIDDING Fodder (Rating ${fodderRating}, Margine min ${minMargin})` });
            await sendFodderBiddingRequest();
          } else {
            chrome.runtime.sendMessage({ tipo: 'LOG', valore: `Avvio SNIPING Fodder (Rating ${fodderRating})` });
            await sendFodderResearchRequest();
          }
          break;

        case false:

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

          break;
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
      resolve(result.minMargin ? parseInt(result.minMargin) : 250);
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
      if (diff < minRemainingMs) {
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
      return 'N/D';
    }

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

    console.log('[FC Sniper] Lista trasferimenti pulita');

  } catch (error) {
    console.error('[ERROR clearing sold items]', error);
    return 'N/D';
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

      } else if (!data.auctionInfo) {
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
      const data = await response.json();
      carteAcquistate += 1;
      idCarteAcquistate.push(itemId);
      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Ho acquistato una carta al prezzo di: ' + buyNowPrice });
      chrome.runtime.sendMessage({ tipo: 'CARTA_ACQUISTATA', valore: carteAcquistate });

    } else {
      console.error("Errore nell'acquisto:", response.status, response.statusText);
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
        console.log('[FC Sniper] Carte inviate alla lista trasferimenti');
      }
    } catch (error) {
      console.error("[FC Sniper] Errore durante l'invio alla lista trasferimenti:", error);
    }
  }

}



async function sendFodderResearchRequest() {


  let i = 0
  while (start == true && i < numeroTentativi) {

    // Ad inizio e ad ogni giro completo della lista, ricarica i prezzi da Futwiz
    if (i == 0 || indexFodder == 0 || listaFodder.length == 0) {
      if (i > 0) {
        console.log('[FC Sniper] Giro fodder completato. Ricarico lista e prezzi aggiornati da Futwiz...');
      }
      listaFodder = [];
      indexFodder = 0;
      await getFdderList();
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

        } else if (!data.auctionInfo) {
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



async function getFdderList() {


  let futWizUrl = 'http://localhost:3000/fut/fodder?rating=' + fodderRating;

  if (!futWizUrl) {
    console.error("URL o Header non definiti per FUTWIZZ");
    return;
  }

  const headers = new Headers({
    "accept": "text/x-component",
    "accept-language": "it-IT,it;q=0.8",
    "content-type": "text/plain;charset=UTF-8",
    "next-action": "7f738887f1d746cf4daefba82830317ddb96a802c6",
    "next-router-state-tree":
      "%5B%22%22%2C%7B%22children%22%3A%5B%5B%22game%22%2C%22fc26%22%2C%22d%22%5D%2C%7B%22children%22%3A%5B%22players%22%2C%7B%22children%22%3A%5B%22__PAGE__%3F%7B%5C%22sort%5C%22%3A%5C%22price%5C%22%2C%5C%22direction%5C%22%3A%5C%22asc%5C%22%2C%5C%22rating_min%5C%22%3A%5C%2284%5C%22%2C%5C%22rating_max%5C%22%3A%5C%2284%5C%22%2C%5C%22priceRange_min%5C%22%3A%5C%22200%5C%22%7D%22%2C%7B%7D%2C%22%2Ffc26%2Fplayers%3Fsort%3Dprice%26direction%3Dasc%26rating_min%3D84%26rating_max%3D84%26priceRange_min%3D200%22%2C%22refresh%22%5D%7D%5D%7D%5D%7D%2Cnull%2Cnull%2Ctrue%5D",
    "priority": "u=1, i",
    "sec-ch-ua": "\"Chromium\";v=\"142\", \"Brave\";v=\"142\", \"Not_A Brand\";v=\"99\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-gpc": "1"
  });

  // Invio la richiesta GET
  try {
    const response = await fetch(futWizUrl, {
      method: "GET",
      headers: headers,
      referrer: futWizUrl,
    });
    if (response.ok) {
      const data = await response.json();

      //se trovo risultati, aggiungo alla lista dei fodder
      if (Array.isArray(data.data) && data?.data?.length) {
        //Estraggo gli id interni delle carte ed i relativi prezzi
        data.data.forEach(item => {
          let fodder = {
            "pid": item.pid,
            "price": item.prices.console.bin
          }
          listaFodder.push(fodder)
        });

        console.log('[FC Sniper] Ho recuperato la lista dei fodder (rating ' + fodderRating + ') da FUTWIZ');
      }
    }
  } catch (error) {
    chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Errore durante recupero lista dei fodder da FUTWIZ' });
    console.error("Errore durante recupero lista dei fodder da FUTWIZ:", error);
  }


}




chrome.runtime.onMessage.addListener(async (message) => {
  if (message.tipo === 'FODDER_MODE') {
    ricercaFodder = message.valore;
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
        const data = await response.json();

        chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Carta messa in vendita a: ' + price + ' crediti' });
      } else {
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

    if (response.ok) {
      consecutiveBidErrors = 0;
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
        console.warn(`[Bid Fallito 401 - Sessione scaduta] In attesa di token aggiornato da Web App...`);
        await sleep(3000);
      } else if (response.status === 429 || response.status === 426 || response.status === 512 || response.status === 521) {
        consecutiveBidErrors++;
        console.warn(`[Bid Fallito ${response.status} - Rate Limit EA] Trade ${tradeId}, offerta ${bidAmount}. Dettagli EA: ${errorDetails}. Errori consecutivi: ${consecutiveBidErrors}`);

        if (consecutiveBidErrors >= 5) {
          console.warn(`[FC Sniper] Rilevati ${consecutiveBidErrors} errori consecutivi di Bid Soft-Ban (${response.status}). Attivazione pausa di sicurezza...`);
          chrome.runtime.sendMessage({
            tipo: 'LOG',
            valore: `[SOFT-BAN BID RILEVATO] Limite offerte EA raggiunto (${response.status}). Pausa di sicurezza di 10 min per sbloccare l'account...`
          });
          consecutiveBidErrors = 0;
          await sleep(600 * 1000); // 10 minuti di pausa di sicurezza
        } else {
          await sleep(getRandomGaussian(3.5, 0.3, 3.0, 4.2) * 1000);
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
      console.log(`[FC Sniper] Carta vinta messa in vendita al BIN: ${price} crediti`);
      return true;
    }
    return false;
  } catch (e) {
    console.error("Errore listing carta vinta:", e);
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

  // 2. Se non presente in memoria e abbiamo il rating, interroga il proxy locale Futwiz
  if (rating) {
    try {
      const res = await fetch('http://localhost:3000/fut/fodder?rating=' + rating);
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json.data) && json.data.length > 0) {
          if (assetId) {
            const match = json.data.find(d => d.pid == assetId || d.definitionid == assetId);
            if (match?.prices?.console?.bin) return match.prices.console.bin;
            if (match?.price) return match.price;
          }
          const bins = json.data.map(d => d.prices?.console?.bin || d.price).filter(p => p > 0);
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
            sellPrice = await getFodderPriceForItem(item.itemData);
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
      console.warn("[FC Sniper] Watchlist 401 (Sessione scaduta). In attesa di refresh token...");
      await sleep(3000);
      return;
    }
    if (!response.ok) return;
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
            sellPrice = await getFodderPriceForItem(item.itemData);
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
        } else if (bidState === "outbid") {
          await deleteFromWatchlist(tradeId);
          await removeStoredPendingBid(tradeId);
          activeBids.delete(String(tradeId));
          activeBids.delete(Number(tradeId));
          console.log(`[FC Sniper] Asta superata e chiusa (Trade: ${tradeId}). Rimossa per recuperare crediti.`);
        }
      } else if (tradeState === "active" && bidState === "outbid") {
        // Siamo stati superati mentre l'asta è ancora attiva: valutiamo se CONTRORILANCIARE
        if (tracked && tracked.maxBidAllowed) {
          let nextBid = calculateNextBid(item.startingBid, item.currentBid);

          // Se l'offerta precedente a questo stesso importo era già fallita (probabile offerta rivale già registrata o cache EA disallineata),
          // proviamo lo scalino successivo per evitare di ripetere un'offerta già rifiutata dai server
          if (tracked.lastFailedBid && tracked.lastFailedBid >= nextBid) {
            nextBid = calculateNextBid(tracked.lastFailedBid, tracked.lastFailedBid);
            console.log(`[FC Sniper] Offerta precedente a ${tracked.lastFailedBid} fallita/superata. Ricalcolo controrilancio a ${nextBid}...`);
          }

          // Se il rilancio rispetta il tetto massimo e l'asta scade nei prossimi 120s
          if (nextBid <= tracked.maxBidAllowed && item.expires <= 120) {
            console.log(`[FC Sniper] CONTRORILANCIO su Trade ${tradeId}: superato a ${item.currentBid}, rilancio a ${nextBid} crediti (Max: ${tracked.maxBidAllowed})`);

            const ok = await sendBidRequest(tradeId, nextBid, itemId);
            if (ok) {
              tracked.bidAmount = nextBid;
              delete tracked.lastFailedBid;
              tracked.expiresAt = Date.now() + (item.expires * 1000);
              await storePendingBid(tradeId, tracked);
              activeBids.set(String(tradeId), tracked);
            } else {
              tracked.lastFailedBid = nextBid;
              await storePendingBid(tradeId, tracked);
              activeBids.set(String(tradeId), tracked);
            }
            // Pausa rapida e gaussiana (500-950ms, media ~700ms) per rapidità ed efficacia nel controrilancio
            await sleep(getRandomGaussian(0.70, 0.12, 0.50, 0.95) * 1000);
          } else if (nextBid > tracked.maxBidAllowed) {
            console.log(`[FC Sniper] Asta Trade ${tradeId} superata a ${item.currentBid}. Il prossimo rilancio (${nextBid}) supererebbe il limite (${tracked.maxBidAllowed}). Abbandono.`);
            await removeStoredPendingBid(tradeId);
            activeBids.delete(String(tradeId));
            activeBids.delete(Number(tradeId));
          }
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
      await sleep(getRandomGaussian(3.5, 0.4, 3.0, 4.2) * 1000);
    }

    if (start !== true) break;

    // Ad inizio e ad ogni giro completo della lista, ricarica i prezzi da Futwiz
    if (i === 0 || indexFodder === 0 || listaFodder.length === 0) {
      if (i > 0) {
        console.log('[FC Sniper] Giro fodder completato. Ricarico lista e prezzi aggiornati da Futwiz...');
      }
      listaFodder = [];
      indexFodder = 0;
      await getFdderList();
    }

    if (listaFodder.length === 0) {
      console.log('[FC Sniper] Nessun fodder disponibile da Futwiz. Attendo...');
      await sleep(3000);
      i++;
      continue;
    }

    const next = getNextFodder();
    const marketPrice = next.price; // Lowest BIN live da Futwiz
    const netIncome = Math.floor(marketPrice * 0.95);
    const maxBidAllowed = roundDownToStep(netIncome - minMargin);

    // Protezione margine zero (se maxBidAllowed < 700 per un oro raro, non c'è margine)
    if (maxBidAllowed < 700) {
      console.log(`[FC Sniper] Fodder PID ${next.pid} (Rating ${fodderRating}, BIN ${marketPrice}): margine insufficiente (Max Bid ${maxBidAllowed} < 700). Salto.`);
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
          const data = await response.json();
          const auctions = data.auctionInfo || [];

          // Filtriamo le aste valide in scadenza (<= 120s) e non già nostre
          const eligibleAuctions = auctions.filter(a => a.bidState !== "highest" && a.expires <= 120);

          if (eligibleAuctions.length > 0) {
            for (const auction of eligibleAuctions) {
              if (start !== true) break;

              const nextBid = calculateNextBid(auction.startingBid, auction.currentBid);

              if (nextBid <= maxBidAllowed) {
                console.log(`[FC Sniper] Asta in scadenza (${auction.expires}s): offro ${nextBid} crediti (Max: ${maxBidAllowed}, BIN: ${marketPrice})`);

                const ok = await sendBidRequest(auction.tradeId, nextBid, auction.itemData?.id);
                if (ok) {
                  offersCount++;
                  const bidData = {
                    pid: next.pid,
                    sellPrice: marketPrice,
                    maxBidAllowed: maxBidAllowed,
                    bidAmount: nextBid,
                    rating: fodderRating,
                    itemId: auction.itemData?.id,
                    expiresAt: Date.now() + (auction.expires * 1000)
                  };
                  activeBids.set(String(auction.tradeId), bidData);
                  await storePendingBid(auction.tradeId, bidData);
                }

                // Ritardo rapido e gaussiano (500-950ms, media ~700ms) per vincere le aste senza cadere nel flood rate-limit
                await sleep(getRandomGaussian(0.70, 0.12, 0.50, 0.95) * 1000);
              }
            }

            if (offersCount > 0) {
              console.log(`[FC Sniper] Piazzate ${offersCount} offerte per PID ${next.pid}.`);
            }
            // Trovate aste utili: usciamo dal ciclo di tentativi e proseguiamo
            break;
          } else {
            // Nessuna asta utile trovata: proviamo ad aggiornare la cache con micr successivo
            if (attempt < minBidBumps.length - 1) {
              console.log(`[FC Sniper] Nessuna asta <= 120s per PID ${next.pid} (su ${auctions.length} trovate). Aggiorno cache EA (tentativo ${attempt + 2}/3 con micr=${minBidBumps[attempt + 1]})...`);
              await sleep(getRandomGaussian(0.70, 0.10, 0.55, 0.85) * 1000);
            }
          }
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

    // Aggiornamento contatore tentativi rimasti
    chrome.runtime.sendMessage({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });

    let randomValue;
    if ((i + 1) % 50 == 0 && i != numeroTentativi - 1) {
      randomValue = getRandomInRange(300, 420); // sleep random tra 5 minuti e 7 minuti ogni 50 tentativi
      chrome.runtime.sendMessage({ tipo: 'LOG', valore: 'Cool down di: ' + randomValue + ' sec' });
      await clearSoldItem();
    } else if ((i + 1) % 5 == 0) {
      randomValue = getRandomGaussian(5.5, 0.8, 4.5, 7.0); // pausa più lunga ogni 5 calciatori
    } else {
      randomValue = getRandomGaussian(3.8, 0.6, 3.0, 5.0); // 3-5 secondi tra un calciatore e l'altro
    }

    await sleep(randomValue * 1000);
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


