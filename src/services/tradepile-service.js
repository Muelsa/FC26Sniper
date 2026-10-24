// Gestione completa della Lista Trasferimenti e della pila Non Assegnati (Fase 3 Refactor)
import { botState } from '../core/state.js';
import { sendMessageSafe } from '../core/messenger.js';
import { reportTelemetry } from '../core/telemetry.js';
import { handle401Error } from '../ea/error-handlers.js';
import { DELETE_SOLD_URL, TRADEPILE_URL, UNASSIGNED_URL } from '../ea/endpoints.js';
import { getCrediti, sellSingleItem, moveSingleItemToTrade } from '../ea/market-api.js';
import { CHEM_STYLES } from '../ea/constants.js';
import { sleep, getRandomGaussian } from '../core/utils.js';
import { getTieredSellPrice, resolveConsumableFloor } from './pricing-service.js';
import { getFodderPriceForItem } from './fodder-service.js';

// Recupera lo stato attuale della lista trasferimenti (Tradepile)
export async function getTradepileInfo() {
  if (!botState.xUtSid) return { total: 0, active: 0, auctions: [] };

  const tradepileUrl = TRADEPILE_URL;
  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": botState.xUtSid
  });

  try {
    const res = await fetch(tradepileUrl, { method: "GET", headers });
    if (!res.ok) {
      if (res.status === 401) await handle401Error("Get Tradepile Info");
      return { total: 0, active: 0, auctions: [] };
    }
    botState.consecutive401Errors = 0;
    const data = await res.json();
    const auctions = data.auctionInfo || [];
    const active = auctions.filter(a => a.tradeState === "active" || a.expires > 0).length;
    const tradepileDisplay = `${active} attive (${auctions.length} tot)`;
    sendMessageSafe({ tipo: 'TRADEPILE_COUNT', valore: tradepileDisplay, active, total: auctions.length });
    try {
      chrome.storage.local.set({ tradepileCount: tradepileDisplay, tradepileActive: active, tradepileTotal: auctions.length });
    } catch (_) { }

    try {
      if (typeof botState.crediti === 'number' && botState.crediti >= 0) {
        calculateAndPublishProiezioneCrediti(botState.crediti, auctions);
      }
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

// Calcola e pubblica la "Proiezione crediti posseduti":
// somma di tutti i prezzi Compra Ora (buyNowPrice) delle carte attualmente in vendita + crediti attuali
export async function calculateAndPublishProiezioneCrediti(currentCrediti = null, preloadedAuctions = null) {
  try {
    let cred = currentCrediti;
    if (typeof cred !== 'number') {
      cred = await getCrediti();
    }
    let auctions = preloadedAuctions;
    if (!Array.isArray(auctions)) {
      const pileInfo = await getTradepileInfo();
      auctions = pileInfo?.auctions || [];
    }

    // Filtra le carte attualmente in vendita (attive sul mercato)
    const activeAuctions = auctions.filter(a => a.tradeState === "active" || a.expires > 0);
    const sumBuyNow = activeAuctions.reduce((sum, a) => sum + (Number(a.buyNowPrice) || 0), 0);
    const numCrediti = (typeof cred === 'number' && !isNaN(cred)) ? cred : 0;
    const totaleProiezione = numCrediti + sumBuyNow;

    const displayFormatted = totaleProiezione.toLocaleString('it-IT');
    sendMessageSafe({
      tipo: 'PROIEZIONE_CREDITI',
      valore: displayFormatted,
      totale: totaleProiezione,
      sommaVendite: sumBuyNow,
      crediti: numCrediti,
      activeCount: activeAuctions.length
    });

    try {
      chrome.storage.local.set({
        proiezioneCrediti: displayFormatted,
        proiezioneCreditiValore: totaleProiezione,
        proiezioneSommaVendite: sumBuyNow,
        proiezioneActiveCount: activeAuctions.length
      });
    } catch (_) {}

    return {
      totale: totaleProiezione,
      sommaVendite: sumBuyNow,
      crediti: numCrediti,
      display: displayFormatted,
      activeCount: activeAuctions.length
    };
  } catch (err) {
    console.warn("[Proiezione Crediti Error]", err);
    return null;
  }
}

export async function clearSoldItem(cachedPrices = {}, options = {}) {
  if (!botState.xUtSid) return;
  const skipRelist = options?.skipRelist === true;

  try {
    // 1. Recupera lo stato attuale della Tradepile
    const pileInfo = await getTradepileInfo();
    const auctions = pileInfo.auctions || [];

    // 2. Filtra solo le carte effettivamente vendute
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
        "x-ut-sid": botState.xUtSid,
      });

      const response = await fetch(DELETE_SOLD_URL, {
        method: "DELETE",
        headers: headers,
      });

      if (response.ok) {
        console.log(`[FC Sniper] Lista trasferimenti pulita con successo: rimosse ${soldItems.length} carte vendute.`);
        botState.carteVendute += soldItems.length;
        sendMessageSafe({ tipo: 'CARTA_VENDUTA', valore: botState.carteVendute });
        try { chrome.storage.local.set({ carteVendute: botState.carteVendute }); } catch (_) { }
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[TRADEPILE] Incassate e rimosse ${soldItems.length} carte vendute dalla lista trasferimenti! (Totale sessione: ${botState.carteVendute})`
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

    // 4. Controlla e rimette in vendita automaticamente eventuali carte scadute/invendute (se non escluso esplicitamente)
    if (!skipRelist) {
      await checkAndRelistExpiredItems(cachedPrices, auctions);
    }

  } catch (error) {
    console.error('[ERROR clearing sold items]', error);
  }
}

// Controlla la lista trasferimenti per rilevare oggetti scaduti/invenduti e rimetterli in vendita
export async function checkAndRelistExpiredItems(cachedPrices = {}, preloadedAuctions = null) {
  if (!botState.xUtSid) return;

  try {
    let auctions = preloadedAuctions;
    if (!Array.isArray(auctions)) {
      const tradepileUrl = TRADEPILE_URL;
      const headers = new Headers({
        "accept": "*/*",
        "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "x-ut-sid": botState.xUtSid
      });

      const res = await fetch(tradepileUrl, { method: "GET", headers });
      if (!res.ok) {
        if (res.status === 401) await handle401Error("Tradepile Check");
        return;
      }
      botState.consecutive401Errors = 0;
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

    if (Date.now() < botState.listingRestrictedUntil) {
      const remainingMin = Math.ceil((botState.listingRestrictedUntil - Date.now()) / 60000);
      console.log(`[FC Sniper Tradepile] Relist in cooldown (${remainingMin} min rimanenti). Salto.`);
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[RELIST IN COOLDOWN] Rilevate ${expiredUnsold.length} carte scadute, ma il listing EA è in pausa di sicurezza (${remainingMin} min rimanenti). Ripubblicazione posticipata.`
      });
      return;
    }

    console.log(`[FC Sniper Tradepile] Rilevate ${expiredUnsold.length} carte scadute/invendute. Ricalcolo Lowest BIN live e relist...`);
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[Tradepile Relist] Rilevate ${expiredUnsold.length} carte invendute. Ricalcolo prezzi live (Lowest BIN + 10%)...`
    });

    let relistedCount = 0;
    for (const a of expiredUnsold) {
      if (botState.start !== true || Date.now() < botState.listingRestrictedUntil) break;
      const itemId = a.itemData?.id;
      if (!itemId) continue;

      let newSellPrice = 0;
      let cardName = "Carta";
      let tierTag = "";

      if (a.itemData?.itemType === "player") {
        if (botState.targetMode === "fodder") {
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
      } else if (a.itemData?.itemType === "training" || a.itemData?.playStyle || (a.itemData?.cardsubtypeid && CHEM_STYLES[String(a.itemData.cardsubtypeid)])) {
        const { floor, name } = await resolveConsumableFloor(a, cachedPrices);
        cardName = name;

        if (floor && floor > 0) {
          const tiered = getTieredSellPrice(floor, null, true);
          newSellPrice = tiered.price;
          tierTag = ` [Tier ${tiered.tier}: +${tiered.markup}%]`;
        }
      } else if (a.itemData?.itemType === "manager") {
        const { floor, name } = await resolveConsumableFloor(a, cachedPrices);
        cardName = name;
        if (floor && floor > 0) {
          newSellPrice = floor;
          tierTag = ` [Istantaneo: Lowest BIN live]`;
        }
      }

      // Fallback al prezzo precedente se non riusciamo a determinare il nuovo
      if (!newSellPrice || newSellPrice <= 0) {
        newSellPrice = a.buyNowPrice;
      }

      const success = await sellSingleItem(itemId, newSellPrice);
      if (Date.now() < botState.listingRestrictedUntil) break;
      if (success) {
        relistedCount++;
        const prevText = a.buyNowPrice ? ` (prec: ${a.buyNowPrice})` : '';
        if (expiredUnsold.length <= 5) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[RELIST] ${cardName} rimessa in vendita a ${newSellPrice} cr${tierTag}${prevText}`
          });
        } else if (relistedCount % 10 === 0) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[Tradepile Relist] Progresso ripubblicazione: ${relistedCount}/${expiredUnsold.length} carte rimesse in vendita...`
          });
        }

        // Pausa anti-burst ogni 8 carte per non saturare la soglia di 20-25 req/min di EA su auctionhouse
        if (relistedCount % 8 === 0 && relistedCount < expiredUnsold.length) {
          const pauseSec = Math.round(getRandomGaussian(6.5, 0.5, 5.5, 8.0));
          console.log(`[FC Sniper Relist] Pausa anti-burst di ${pauseSec}s dopo ${relistedCount} carte rimesse in vendita.`);
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[PAUSA ANTI-BURST] Sosta defaticante di ${pauseSec}s (dopo ${relistedCount} carte rimesse in vendita) per prevenire rate limit EA (426)...`
          });
          await sleep(pauseSec * 1000);
        } else {
          await sleep(getRandomGaussian(1.8, 0.2, 1.5, 2.2) * 1000);
        }
      } else {
        await sleep(getRandomGaussian(1.8, 0.2, 1.5, 2.2) * 1000);
      }
    }

    if (relistedCount > 0) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[Tradepile Relist] Completato: ${relistedCount}/${expiredUnsold.length} carte rimesse in vendita al prezzo aggiornato!`
      });
    }
  } catch (err) {
    console.error("[FC Sniper Tradepile Relist Error]", err);
  }
}

// Recupera e gestisce tutte le carte presenti nella pila "Non Assegnati" (purchased/items)
export async function processUnassignedItems(cachedPrices = {}) {
  if (!botState.xUtSid) return { found: 0, moved: 0, listed: 0 };

  const unassignedUrl = UNASSIGNED_URL;
  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": botState.xUtSid
  });

  try {
    const res = await fetch(unassignedUrl, { method: "GET", headers });
    if (!res.ok) {
      if (res.status === 401) await handle401Error("Process Unassigned");
      return { found: 0, moved: 0, listed: 0 };
    }
    botState.consecutive401Errors = 0;
    const data = await res.json();
    const items = data.itemData || [];

    if (items.length === 0) {
      return { found: 0, moved: 0, listed: 0 };
    }

    console.log(`[FC Sniper Non Assegnati] Rilevate ${items.length} carte bloccate nei "Non Assegnati". Spostamento in lista trasferimenti e vendita...`);
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[RECUPERO NON ASSEGNATI] Rilevate ${items.length} carte nello slot "Non Assegnati". Le sposto nella lista trasferimenti e le metto in vendita...`
    });

    let movedCount = 0;
    let listedCount = 0;

    for (const item of items) {
      if (botState.start !== true) break;
      const itemId = item.id;
      if (!itemId) continue;

      // 1. Sposta l'oggetto da Non Assegnati alla Tradepile
      const moved = await moveSingleItemToTrade(itemId);
      if (moved) {
        movedCount++;
        await sleep(getRandomGaussian(1.0, 0.2, 0.8, 1.4) * 1000);

        // 2. Determina il prezzo di vendita target
        let sellPrice = 0;
        let cardName = "Carta";
        let tierTag = "";

        if (item.itemType === "player") {
          if (botState.targetMode === "fodder") {
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
        } else if (item.itemType === "training" || item.playStyle || (item.cardsubtypeid && CHEM_STYLES[String(item.cardsubtypeid)])) {
          const { floor, name } = await resolveConsumableFloor(item, cachedPrices);
          cardName = name;

          if (floor && floor > 0) {
            const tiered = getTieredSellPrice(floor, null, true);
            sellPrice = tiered.price;
            tierTag = ` (Tier ${tiered.tier}: +${tiered.markup}%)`;
          }
        } else if (item.itemType === "manager") {
          const { floor, name } = await resolveConsumableFloor(item, cachedPrices);
          cardName = name;
          if (floor && floor > 0) {
            sellPrice = floor;
            tierTag = " [Istantaneo: Lowest BIN live]";
          }
        }

        // 3. Metti in vendita se abbiamo un prezzo valido
        if (sellPrice > 0) {
          const success = await sellSingleItem(itemId, sellPrice);
          if (success) {
            listedCount++;
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[VENDITA NON ASSEGNATI] ${cardName} recuperata e messa in vendita a ${sellPrice} crediti${tierTag}!`
            });
            await sleep(getRandomGaussian(1.6, 0.15, 1.5, 2.0) * 1000);
          } else {
            sendMessageSafe({
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
      sendMessageSafe({
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
export async function listUnlistedTradepileItems(cachedPrices = {}) {
  if (!botState.xUtSid) return { found: 0, listed: 0 };

  const tradepileUrl = TRADEPILE_URL;
  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": botState.xUtSid
  });

  try {
    const res = await fetch(tradepileUrl, { method: "GET", headers });
    if (!res.ok) {
      if (res.status === 401) await handle401Error("List Unlisted Tradepile");
      return { found: 0, listed: 0 };
    }
    botState.consecutive401Errors = 0;
    const data = await res.json();
    const auctions = data.auctionInfo || [];

    const unlisted = auctions.filter(a =>
      a.itemData?.id &&
      a.tradeState !== "active" &&
      (a.expires <= 0 || !a.buyNowPrice || a.buyNowPrice === 0) &&
      a.tradeState !== "closed" && a.tradeState !== "expired"
    );

    if (unlisted.length === 0) {
      return { found: 0, listed: 0 };
    }

    if (Date.now() < botState.listingRestrictedUntil) {
      const remainingMin = Math.ceil((botState.listingRestrictedUntil - Date.now()) / 60000);
      console.log(`[FC Sniper Recupero] Listing in cooldown (${remainingMin} min rimanenti). Salto il listing delle ${unlisted.length} carte non listate.`);
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[RECUPERO IN COOLDOWN] Rilevate ${unlisted.length} carte in lista trasferimenti non ancora messe in vendita, ma il listing EA è in pausa di sicurezza (${remainingMin} min rimanenti). Messa in vendita posticipata a fine cooldown.`
      });
      return { found: unlisted.length, listed: 0 };
    }

    console.log(`[FC Sniper Recupero] Rilevate ${unlisted.length} carte in Tradepile non messe in vendita. Procedo al listaggio immediato...`);
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[RECUPERO LISTA] Rilevate ${unlisted.length} carte in lista trasferimenti non ancora messe in vendita. Le metto sul mercato...`
    });

    let listedCount = 0;
    const waitAfterListing = async (count, total) => {
      if (count % 8 === 0 && count < total) {
        const pauseSec = Math.round(getRandomGaussian(6.5, 0.5, 5.5, 8.0));
        console.log(`[FC Sniper Listing] Pausa anti-burst di ${pauseSec}s dopo ${count} carte messe in vendita.`);
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[PAUSA ANTI-BURST] Sosta defaticante di ${pauseSec}s (dopo ${count} carte messe in vendita) per prevenire rate limit EA (426)...`
        });
        await sleep(pauseSec * 1000);
      } else {
        await sleep(getRandomGaussian(1.8, 0.2, 1.5, 2.2) * 1000);
      }
    };

    for (const a of unlisted) {
      if (botState.start !== true || Date.now() < botState.listingRestrictedUntil) break;
      const item = a.itemData;
      const itemId = item.id;
      let sellPrice = 0;

      if (item.itemType === "player") {
        if (botState.targetMode === "fodder") {
          const assetId = item.assetId || item.resourceId;
          let fodderPrice = cachedPrices?.playerPriceMap?.get(String(assetId))?.basePrice;
          if (!fodderPrice && cachedPrices?.benchmarkFloor) fodderPrice = cachedPrices.benchmarkFloor;
          if (!fodderPrice) fodderPrice = await getFodderPriceForItem(item);
          if (fodderPrice > 0) {
            const tiered = getTieredSellPrice(fodderPrice, null, false);
            sellPrice = tiered.price;
            const success = await sellSingleItem(itemId, sellPrice);
            if (Date.now() < botState.listingRestrictedUntil) break;
            if (success) {
              listedCount++;
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[VENDITA RECUPERATA] Calciatore (Rating ${item.rating || 'N/D'}) messo in vendita a ${sellPrice} crediti (Tier ${tiered.tier}: +${tiered.markup}%)`
              });
              await waitAfterListing(listedCount, unlisted.length);
            } else {
              await sleep(getRandomGaussian(1.8, 0.2, 1.5, 2.2) * 1000);
            }
          }
        }
      } else if (item.itemType === "training" || item.playStyle || (item.cardsubtypeid && CHEM_STYLES[String(item.cardsubtypeid)])) {
        const { floor, name } = await resolveConsumableFloor(item, cachedPrices);

        if (floor && floor > 0) {
          const tiered = getTieredSellPrice(floor, null, true);
          sellPrice = tiered.price;
          const success = await sellSingleItem(itemId, sellPrice);
          if (Date.now() < botState.listingRestrictedUntil) break;
          if (success) {
            listedCount++;
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[VENDITA RECUPERATA] ${name} messa in vendita a ${sellPrice} crediti (Tier ${tiered.tier}: +${tiered.markup}%)`
            });
            await waitAfterListing(listedCount, unlisted.length);
          } else {
            await sleep(getRandomGaussian(1.8, 0.2, 1.5, 2.2) * 1000);
          }
        }
      } else if (item.itemType === "manager") {
        const { floor, name } = await resolveConsumableFloor(item, cachedPrices);
        if (floor && floor > 0) {
          sellPrice = floor;
          const success = await sellSingleItem(itemId, sellPrice);
          if (Date.now() < botState.listingRestrictedUntil) break;
          if (success) {
            listedCount++;
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[VENDITA RECUPERATA] ${name} messa in vendita al Lowest BIN live (${sellPrice} crediti)!`
            });
            await waitAfterListing(listedCount, unlisted.length);
          } else {
            await sleep(getRandomGaussian(1.8, 0.2, 1.5, 2.2) * 1000);
          }
        }
      }
    }

    if (listedCount > 0) {
      sendMessageSafe({
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
