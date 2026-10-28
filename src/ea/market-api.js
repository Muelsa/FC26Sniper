// Chiamate atomiche verso le API di mercato EA UTAS (Fase 2 Refactor)
import { botState, markTradeAttempted } from '../core/state.js';
import { sendMessageSafe, triggerPinEvent, stopBot } from '../core/messenger.js';
import { handle401Error, executeSafetyPause } from './error-handlers.js';
import { WATCHLIST_URL, AUCTIONHOUSE_URL, ITEM_URL, tradeBidUrl, watchlistDeleteUrl } from './endpoints.js';
import { buildEaHeaders } from './client.js';
import { sleep, getRandomGaussian, getEaStep, roundDownToStep } from '../core/utils.js';

export async function getCrediti() {
  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": botState.xUtSid,
  });

  try {
    const response = await fetch(WATCHLIST_URL, {
      method: "GET",
      headers: headers,
    });

    if (!response.ok) {
      if (response.status === 401) {
        await handle401Error("Crediti");
      }
      return 'N/D';
    }
    botState.consecutive401Errors = 0;

    const data = await response.json();
    const currentCredits = data?.credits ?? data?.credit ?? 0;
    if (typeof currentCredits === 'number') {
      botState.crediti = currentCredits;
      try {
        chrome.storage.local.set({ crediti: currentCredits });
      } catch (_) { }
      sendMessageSafe({ tipo: 'CREDITI', valore: currentCredits });
    }
    return currentCredits;
  } catch (error) {
    console.error('[ERROR Updating credits]', error);
    return 'N/D';
  }
}

export async function sendBuyNowRequest(tradeId, buyNowPrice, itemId) {
  markTradeAttempted(tradeId);
  const buyNowUrl = tradeBidUrl(tradeId);

  if (!buyNowUrl || !botState.xUtSid) {
    console.error("URL o Sessione non definiti");
    return false;
  }

  // Controllo preventivo saldo crediti: impedisce di inviare richieste destinate a fallire
  if (typeof botState.crediti === 'number' && botState.crediti < buyNowPrice) {
    console.warn(`[FC Sniper BuyNow] Crediti insufficienti (${botState.crediti} cr < ${buyNowPrice} cr richiesti). Acquisto annullato su Trade ${tradeId}.`);
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
        "X-UT-SID": botState.xUtSid
      },
      body: JSON.stringify({ bid: buyNowPrice })
    });
    if (response.ok) {
      botState.lastBuyNowErrorStatus = 0;
      botState.consecutiveSnipeErrors = 0;
      botState.consecutive401Errors = 0;
      const data = await response.json();
      botState.carteAcquistate += 1;
      botState.idCarteAcquistate.push(itemId);
      botState.consecutive461InBidding = 0;
      sendMessageSafe({ tipo: 'LOG', valore: `[ACQUISTO RIUSCITO] Carta acquistata al prezzo di ${buyNowPrice} crediti!` });
      sendMessageSafe({ tipo: 'CARTA_ACQUISTATA', valore: botState.carteAcquistate });
      try { chrome.storage.local.set({ carteAcquistate: botState.carteAcquistate }); } catch (_) { }
      return true;
    } else {
      botState.lastBuyNowErrorStatus = response.status;
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
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[ATTENZIONE - CAPTCHA RILEVATO] EA richiede verifica nella Web App. Bot arrestato.`
        });
        await stopBot("CAPTCHA 458 rilevato");
      } else if (response.status === 429 || response.status === 426 || response.status === 512 || response.status === 521) {
        if (response.status === 512) {
          botState.consecutive512Errors++;
          console.warn(`[Snipe Fallito 512 - Limite Acquisti EA] Trade ${tradeId}, prezzo ${buyNowPrice}. Errori 512 consecutivi: ${botState.consecutive512Errors}/5`);
        } else {
          botState.consecutive512Errors = 0;
          botState.consecutiveSnipeErrors++;
        }

        console.warn(`[Snipe Fallito ${response.status} - Rate Limit EA] Trade ${tradeId}, prezzo ${buyNowPrice}. Dettagli EA: ${errorDetails}. Errori consecutivi rate limit: ${botState.consecutiveSnipeErrors}`);

        if (botState.strategyMode === "lazy") {
          if (botState.consecutive512Errors >= 5) {
            console.warn(`[FC Sniper Lazy] Rilevati 5 errori 512 consecutivi su Compra Ora. Transizione al sonno vendite...`);
          } else {
            await sleep(getRandomGaussian(1.0, 0.2, 0.7, 1.4) * 1000);
          }
        } else if (botState.consecutiveSnipeErrors >= 5 || botState.consecutive512Errors >= 5) {
          console.warn(`[FC Sniper] Rilevati 5 errori consecutivi di Snipe Soft-Ban (${response.status}). Avvio pausa di sicurezza attiva 10 min...`);
          botState.consecutiveSnipeErrors = 0;
          botState.consecutive512Errors = 0;
          await executeSafetyPause(600, `Soft-Ban Compra Ora EA (${response.status})`);
        } else {
          await sleep(getRandomGaussian(3.5, 0.3, 3.0, 4.2) * 1000);
        }
      } else if (response.status === 478 || response.status === 461) {
        // Carta già acquistata da un altro utente (normale durante lo sniping se arriviamo con qualche millisecondo di ritardo)
        console.log(`[FC Sniper] Carta già acquistata da un altro utente (${response.status}) su Trade ${tradeId}`);
        sendMessageSafe({
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

export async function sendToTransferList() {
  const transferListUrl = ITEM_URL;

  if (!transferListUrl || !botState.searchHeaders) {
    console.error("URL o Header non definiti per la lista trasferimenti");
    return;
  }

  const headers = buildEaHeaders(botState.xUtSid, {
    "sec-ch-ua": "\"Chromium\";v=\"142\", \"Google Chrome\";v=\"142\", \"Not_A Brand\";v=\"99\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site"
  });

  if (botState.idCarteAcquistate.length === 0) return;

  const body = {
    itemData: botState.idCarteAcquistate.map((id) => ({ "id": id, "pile": "trade" }))
  };
  const bodyJson = JSON.stringify(body);

  // Invio una singola richiesta PUT con tutti gli item da spostare
  try {
    const response = await fetch(transferListUrl, {
      method: "PUT",
      headers: headers,
      body: bodyJson
    });
    if (response.ok) {
      botState.consecutive401Errors = 0;
      console.log('[FC Sniper] Carte inviate alla lista trasferimenti');
    } else if (response.status === 401) {
      await handle401Error("Transfer List");
    }
  } catch (error) {
    console.error("[FC Sniper] Errore durante l'invio alla lista trasferimenti:", error);
  }
}

// Invia un'offerta (bid) su una specifica asta
export async function sendBidRequest(tradeId, bidAmount, itemId, maxBidAllowed = null) {
  const bidUrl = tradeBidUrl(tradeId);
  if (!botState.xUtSid) {
    console.error("X-UT-SID non definito");
    return false;
  }

  // Controllo preventivo saldo crediti: impedisce di inviare richieste destinate a fallire
  if (typeof botState.crediti === 'number' && botState.crediti < bidAmount) {
    console.warn(`[FC Sniper Bid] Crediti insufficienti (${botState.crediti} cr < ${bidAmount} cr richiesti). Offerta annullata su Trade ${tradeId}.`);
    return false;
  }

  // Queue Anti-Collisione Globale:
  // Garantisce che nessun'offerta verso EA possa partire a meno di 1.6s dalla precedente
  const elapsed = Date.now() - botState.lastBidTimestamp;
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
    "X-UT-SID": botState.xUtSid
  });

  markTradeAttempted(tradeId);
  const body = JSON.stringify({ bid: bidAmount });

  try {
    const response = await fetch(bidUrl, {
      method: "PUT",
      headers: headers,
      body: body
    });

    botState.lastBidTimestamp = Date.now();
    botState.lastBidErrorStatus = response.status;

    if (response.ok) {
      botState.consecutiveBidErrors = 0;
      botState.consecutive401Errors = 0;
      botState.consecutive470Errors = 0;
      botState.consecutive461InBidding = 0;
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
        botState.consecutiveBidErrors++;
        console.warn(`[Bid Fallito ${response.status} - Rate Limit EA] Trade ${tradeId}, offerta ${bidAmount}. Dettagli EA: ${errorDetails}. Errori consecutivi: ${botState.consecutiveBidErrors}`);

        if (botState.strategyMode === "lazy") {
          return false;
        }

        if (botState.consecutiveBidErrors >= 3) {
          console.warn(`[FC Sniper] Rilevati ${botState.consecutiveBidErrors} errori consecutivi di Bid Soft-Ban (${response.status}). Avvio pausa di sicurezza attiva 10 min...`);
          botState.consecutiveBidErrors = 0;
          await executeSafetyPause(600, `Soft-Ban Offerte Asta EA (${response.status})`);
        } else {
          await sleep(getRandomGaussian(8.0, 1.0, 6.0, 10.0) * 1000);
        }
      } else if (response.status === 461) {
        // HTTP 461: Carta non più disponibile (già acquistata via Compra Ora da altri, asta scaduta, o Watchlist satura)
        console.log(`[FC Sniper Bid 461] Asta non più disponibile o già conclusa su Trade ${tradeId}. Salto carta.`);
        return false;
      } else if (response.status === 470) {
        // HTTP 470: Offerta superata
        botState.consecutive470Errors++;
        console.warn(`[Bid Fallito 470 - Offerta superata] Trade ${tradeId}, offerta ${bidAmount}. Dettagli EA: ${errorDetails}`);
        const step = getEaStep(bidAmount);
        const retryBid = bidAmount + step;
        if (maxBidAllowed && retryBid <= maxBidAllowed && (!botState.crediti || botState.crediti >= retryBid)) {
          console.log(`[FC Sniper 470 Outbid] Offerta a ${bidAmount} cr superata. Controrilancio a ${retryBid} cr (Max: ${maxBidAllowed})...`);
          await sleep(getRandomGaussian(1.0, 0.15, 0.8, 1.2) * 1000);
          return await sendBidRequest(tradeId, retryBid, itemId, maxBidAllowed);
        } else {
          console.log(`[FC Sniper 470 Outbid] Offerta a ${bidAmount} cr superata su Trade ${tradeId}. Prossimo rilancio (${retryBid}) supererebbe il limite (${maxBidAllowed || 'N/D'}). Abbandono.`);
        }
        if (botState.consecutive470Errors >= 4) {
          console.warn(`[FC Sniper] Rilevati ${botState.consecutive470Errors} errori 470 consecutivi. Pausa sincronizzazione aste EA di 4 secondi...`);
          botState.consecutive470Errors = 0;
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
export async function moveSingleItemToTrade(itemId) {
  if (!botState.xUtSid || !itemId) return false;
  const transferListUrl = ITEM_URL;
  const headers = new Headers({
    "accept": "*/*",
    "content-type": "application/json",
    "X-UT-SID": botState.xUtSid
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

export async function sellSingleItem(itemId, price, startingBid = null) {
  if (!botState.xUtSid || !itemId) return false;

  // Circuit Breaker: se EA ha attivato il rate limit 426 sulle vendite, non inviare alcuna richiesta
  if (Date.now() < botState.listingRestrictedUntil) {
    const secLeft = Math.ceil((botState.listingRestrictedUntil - Date.now()) / 1000);
    console.warn(`[FC Sniper Listing] Richiesta bloccata dal Circuit Breaker: cooldown attivo per ancora ${secLeft}s.`);
    return false;
  }

  const sellUrl = AUCTIONHOUSE_URL;

  // 1. Normalizzazione prezzo e scalini EA
  let validPrice = Number(price);
  if (isNaN(validPrice) || validPrice <= 0) return false;

  const step = getEaStep(validPrice);
  let startBid = startingBid && startingBid > 0 ? Number(startingBid) : Math.max(validPrice - step, 200);
  startBid = roundDownToStep(startBid);

  const headers = new Headers({
    "accept": "*/*",
    "content-type": "application/json",
    "x-ut-sid": botState.xUtSid
  });

  const body = JSON.stringify({
    buyNowPrice: validPrice,
    duration: 3600,
    itemData: { id: Number(itemId) },
    startingBid: startBid
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    // 2. Queue Anti-Collisione Listing (minimo 1.5s tra richieste di messa in vendita per evitare 426 da spam)
    const elapsed = Date.now() - botState.lastListingTimestamp;
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

      botState.lastListingTimestamp = Date.now();

      if (resp.ok) {
        botState.consecutive401Errors = 0;
        botState.consecutive426Errors = 0;
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
      // Circuit Breaker con backoff incrementale (15m -> 25m -> 35m) per far decadere il blocco EA
      if (resp.status === 426) {
        botState.consecutive426Errors = (botState.consecutive426Errors || 0) + 1;
        let cooldownMinutes = 15;
        if (botState.consecutive426Errors === 2) {
          cooldownMinutes = 25;
        } else if (botState.consecutive426Errors >= 3) {
          cooldownMinutes = 35;
        }
        botState.listingRestrictedUntil = Date.now() + (cooldownMinutes * 60 * 1000);
        console.warn(`[FC Sniper Listing] Rate limit 426 su auctionhouse (#${botState.consecutive426Errors})! Cooldown progressivo di ${cooldownMinutes} min.`);
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[RATE LIMIT VENDITA] EA ha limitato il listing (426 - blocco #${botState.consecutive426Errors}). Stop richieste di vendita per ${cooldownMinutes} min con backoff progressivo per far decadere il blocco. Le carte restano al sicuro in Tradepile.`
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

export async function sellFodder(price) {
  const sellUrl = AUCTIONHOUSE_URL;
  if (!botState.xUtSid) {
    console.error("X-UT-SID non definito");
    return;
  }

  for (const id of botState.idCarteAcquistate) {
    const headers = buildEaHeaders(botState.xUtSid);

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
        botState.consecutive401Errors = 0;
        const data = await response.json();
        sendMessageSafe({ tipo: 'LOG', valore: 'Carta messa in vendita a: ' + price + ' crediti' });
      } else {
        if (response.status === 401) {
          await handle401Error("Messa in Vendita Fodder");
        }
        console.error(`[FC Sniper] Errore HTTP: ${response.status} ${response.statusText} nella messa in vendita`);
        sendMessageSafe({ tipo: 'LOG', valore: 'Errore nella messa in vendita a ' + price + ' crediti' });
      }
    } catch (error) {
      console.error("Errore durante la richiesta all'Auction House:", error);
    }
  }
}

// Aggiunge un'asta alla Watchlist (Lista Osservati) conforme alla Web App ufficiale di EA
export async function addToWatchlist(tradeId) {
  if (!botState.xUtSid) return false;

  const url = WATCHLIST_URL;
  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    "x-ut-sid": botState.xUtSid
  });
  const body = JSON.stringify({ auctionInfo: [{ id: Number(tradeId) }] });

  try {
    const res = await fetch(url, { method: "PUT", headers, body });
    if (res.ok) {
      botState.consecutive401Errors = 0;
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
export async function deleteFromWatchlist(tradeId) {
  if (!botState.xUtSid) return;
  const url = watchlistDeleteUrl(tradeId);
  const headers = new Headers({
    "accept": "*/*",
    "content-type": "application/json",
    "x-ut-sid": botState.xUtSid
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
