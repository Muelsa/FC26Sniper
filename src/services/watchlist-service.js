// Gestione completa della Watchlist (riconciliazione, riscatto carte vinte, controrilanci)
import { botState, activeBids, attemptedTradeIds, storePendingBid, removeStoredPendingBid } from '../core/state.js';
import { sendMessageSafe, triggerPinEvent } from '../core/messenger.js';
import { handle401Error } from '../ea/error-handlers.js';
import { WATCHLIST_URL } from '../ea/endpoints.js';
import { sendBidRequest, moveSingleItemToTrade, sellSingleItem, deleteFromWatchlist } from '../ea/market-api.js';
import { getStoredPendingBids, cleanExpiredPendingBids } from '../core/storage.js';
import { sleep, getRandomGaussian, calculateNextBid, roundUpToStep } from '../core/utils.js';
import { resolveConsumableFloor, resolveItemSellPrice, getTieredSellPrice } from './pricing-service.js';
import { getFodderPriceForItem } from './fodder-service.js';
import { getItemDisplayName } from './item-classifier.js';

export async function reconcileWatchlistOnStartup() {
  if (!botState.xUtSid) return;
  await cleanExpiredPendingBids();
  console.log('[FC Sniper] Controllo preliminare Watchlist (Reconciliation)...');
  await triggerPinEvent("TRIGGER_PIN_WATCHLIST");

  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "content-type": "application/json",
    "x-ut-sid": botState.xUtSid,
  });

  try {
    const response = await fetch(WATCHLIST_URL, { method: "GET", headers });
    if (!response.ok) return;

    const data = await response.json();
    const auctions = data.auctionInfo || [];
    const storedBids = await getStoredPendingBids();
    const nowInit = Date.now();
    for (const [tid, bData] of Object.entries(storedBids)) {
      if (bData && bData.expiresAt && bData.expiresAt > nowInit) {
        activeBids.set(String(tid), bData);
      }
    }

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

      if (tradeState === "active") {
        if (tracked) {
          if (item.expires !== undefined) {
            tracked.expiresAt = Date.now() + (item.expires * 1000);
          }
          activeBids.set(tradeIdStr, tracked);
        } else {
          activeBids.set(tradeIdStr, {
            itemId: itemId,
            bidAmount: item.currentBid,
            expiresAt: Date.now() + ((item.expires || 0) * 1000),
            rebidCount: 0
          });
        }
      }

      if (tradeState === "closed" || tradeState === "expired" || item.expires === -1 || item.expires === 0) {
        if (bidState === "highest") {
          recoveredWon++;
          const { sellPrice, tierTag } = await resolveItemSellPrice(item, tracked);

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
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[Reconciliation] Recuperate e messe in vendita ${recoveredWon} carte vinte, rimosse ${cleanedLost} aste perse.`
      });
    }
  } catch (err) {
    console.error("[Reconciliation Error]", err);
  }
}

// Risolve le aste presenti nella Watchlist (gestisce vincite, controrilanci e rimozioni)
export async function resolveWatchlist() {
  if (!botState.xUtSid) return;

  await triggerPinEvent("TRIGGER_PIN_WATCHLIST");

  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache, no-store, must-revalidate",
    "pragma": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": botState.xUtSid,
  });

  try {
    const response = await fetch(WATCHLIST_URL, {
      method: "GET",
      headers: headers,
      cache: "no-store",
    });

    if (response.status === 401) {
      await handle401Error("Watchlist");
      return;
    }
    if (!response.ok) return;
    botState.consecutive401Errors = 0;
    const data = await response.json();
    if (data.credits !== undefined) {
      botState.crediti = data.credits;
      sendMessageSafe({ tipo: 'CREDITI', valore: botState.crediti });
    }
    const auctions = data.auctionInfo || [];
    const storedBids = await getStoredPendingBids();

    const now = Date.now();
    const liveTradeIds = new Set(auctions.map(a => String(a.tradeId)));
    for (const [tradeId, bid] of activeBids.entries()) {
      const tradeIdKey = String(tradeId);
      if (!liveTradeIds.has(tradeIdKey) && bid && bid.expiresAt && (now - bid.expiresAt > 45000)) {
        console.log(`[FC Sniper Watchlist] Rimozione asta non più presente nei server EA (Trade: ${tradeIdKey}).`);
        activeBids.delete(tradeIdKey);
        activeBids.delete(Number(tradeIdKey));
        await removeStoredPendingBid(tradeIdKey);
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
        if (tracked) {
          if (item.expires !== undefined) {
            tracked.expiresAt = Date.now() + (item.expires * 1000);
          }
          activeBids.set(tradeIdStr, tracked);
          activeBids.delete(tradeIdNum);
        } else if (item.bidState === "highest" || item.bidState === "outbid") {
          activeBids.set(tradeIdStr, {
            itemId: itemId,
            bidAmount: item.currentBid,
            expiresAt: Date.now() + ((item.expires || 0) * 1000),
            rebidCount: 0
          });
        }
      }

      if (tradeState === "closed" || tradeState === "expired" || item.expires === -1 || item.expires === 0) {
        if (bidState === "highest") {
          botState.carteAcquistate += 1;
          botState.carteVinteCiclo += 1;
          sendMessageSafe({ tipo: 'CARTA_ACQUISTATA', valore: botState.carteAcquistate });
          try { chrome.storage.local.set({ carteAcquistate: botState.carteAcquistate }); } catch (_) { }

          const { sellPrice, tierTag } = await resolveItemSellPrice(item, tracked);
          const buyPrice = item.currentBid || tracked?.bidAmount || 'N/D';

          await moveSingleItemToTrade(itemId);
          await sleep(getRandomGaussian(1.0, 0.2, 0.8, 1.3) * 1000);

          const itemDisplayName = getItemDisplayName(item, tracked);
          if (sellPrice && sellPrice > 0) {
            const listed = await sellSingleItem(itemId, sellPrice);
            if (listed) {
              sendMessageSafe({ tipo: 'LOG', valore: `[ASTA VINTA] ${itemDisplayName} vinta a ${buyPrice} cr! Messa in vendita a ${sellPrice} cr${tierTag}.` });
            } else {
              sendMessageSafe({ tipo: 'LOG', valore: `[ASTA VINTA] ${itemDisplayName} vinta a ${buyPrice} cr! Spostata in lista trasferimenti.` });
            }
          } else {
            sendMessageSafe({ tipo: 'LOG', valore: `[ASTA VINTA] ${itemDisplayName} vinta a ${buyPrice} cr! Spostata in lista trasferimenti.` });
          }

          await removeStoredPendingBid(tradeId);
          activeBids.delete(String(tradeId));
          activeBids.delete(Number(tradeId));
        } else {
          await deleteFromWatchlist(tradeId);
          await removeStoredPendingBid(tradeId);
          activeBids.delete(String(tradeId));
          activeBids.delete(Number(tradeId));
          const itemDisplayName = getItemDisplayName(item, tracked);
          console.log(`[FC Sniper Watchlist] Asta conclusa non vinta: ${itemDisplayName} (Trade: ${tradeId}). Rimossa dagli osservati.`);
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[ASTA PERSA] Asta su ${itemDisplayName} conclusa non vinta (prezzo finale: ${item.currentBid || 'N/D'} cr). Rimossa dagli osservati.`
          });
        }
      }
    }

    // Queue Bidding & Controrilanci Watchlist
    const eligibleActions = [];
    for (const item of auctions) {
      if (item.tradeState === "active") {
        const tradeId = item.tradeId;
        const tracked = storedBids[String(tradeId)] || activeBids.get(tradeId) || activeBids.get(Number(tradeId));
        if (tracked && tracked.maxBidAllowed) {
          const nextBid = calculateNextBid(item.startingBid, item.currentBid);

          if (item.bidState === "outbid") {
            const itemDisplayName = getItemDisplayName(item, tracked);
            if (nextBid > tracked.maxBidAllowed) {
              console.log(`[FC Sniper Watchlist] Asta ${itemDisplayName} (Trade ${tradeId}) superata da altro utente a ${item.currentBid}. Il prossimo rilancio (${nextBid}) supererebbe il limite (${tracked.maxBidAllowed}). Abbandono.`);
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[ASTA SUPERATA] Asta su ${itemDisplayName} superata a ${item.currentBid} cr. Rilancio (${nextBid} cr) oltre il limite max (${tracked.maxBidAllowed} cr): abbandono.`
              });
              await removeStoredPendingBid(tradeId);
              activeBids.delete(String(tradeId));
              activeBids.delete(Number(tradeId));
              continue;
            }

            if (tracked.failedAtCurrentBid !== undefined && tracked.failedAtCurrentBid === item.currentBid) {
              continue;
            }

            eligibleActions.push({ item, tracked });
          }
        }
      }
    }

    if (eligibleActions.length > 0) {
      eligibleActions.sort((a, b) => (a.item.expires || 0) - (b.item.expires || 0));

      for (const { item, tracked } of eligibleActions) {
        if (botState.lastBidErrorStatus === 429 || botState.lastBidErrorStatus === 426 || botState.lastBidErrorStatus === 512 || botState.lastBidErrorStatus === 521) {
          console.warn(`[FC Sniper Queue] Rate limit EA attivo (${botState.lastBidErrorStatus}). Sospendo la coda offerte Watchlist.`);
          break;
        }

        const tradeId = item.tradeId;
        const itemId = item.itemData?.id || tracked?.itemId;
        let nextBid = calculateNextBid(item.startingBid, item.currentBid);
        const nextRebidNumber = (tracked.rebidCount || 0) + 1;

        if (nextRebidNumber > 5 && nextBid < tracked.maxBidAllowed) {
          console.log(`[FC Sniper All-In Tattico] Asta fortemente contesa (${nextRebidNumber}° rilancio) su Trade ${tradeId}. Salto direttamente al Max Bid (${tracked.maxBidAllowed} crediti) per risolvere subito l'asta!`);
          nextBid = tracked.maxBidAllowed;
        }

        if (nextBid <= tracked.maxBidAllowed) {
          if (typeof botState.crediti === 'number' && botState.crediti < nextBid) {
            console.log(`[FC Sniper Watchlist] Controrilancio annullato su Trade ${tradeId}: crediti insufficienti (${botState.crediti} cr < ${nextBid} cr).`);
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[CONTRORILANCIO] Annullato su ${tracked.name || 'Trade ' + tradeId}: crediti insufficienti (${botState.crediti} cr < ${nextBid} cr richiesti).`
            });
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

            const itemDisplayName = getItemDisplayName(item, tracked);
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[CONTRORILANCIO] Rilancio #${nextRebidNumber} di ${nextBid} cr su ${itemDisplayName} (Superato a ${item.currentBid} cr | Max: ${tracked.maxBidAllowed} cr | Scade in ${Math.round(item.expires)}s)`
            });

            await sleep(getRandomGaussian(2.0, 0.25, 1.6, 2.5) * 1000);
          } else {
            tracked.failedAtCurrentBid = item.currentBid;
            await storePendingBid(tradeId, tracked);
            activeBids.set(String(tradeId), tracked);

            if (botState.lastBidErrorStatus === 429 || botState.lastBidErrorStatus === 426 || botState.lastBidErrorStatus === 512 || botState.lastBidErrorStatus === 521) {
              console.warn(`[FC Sniper Queue] Errore ${botState.lastBidErrorStatus} su Trade ${tradeId}. Arresto coda offerte e attivo restrizione.`);
              botState.marketRestricted = true;
              break;
            }
            if (botState.lastBidErrorStatus === 470) {
              console.warn(`[FC Sniper Queue] Errore 470 su Trade ${tradeId} (asta desincronizzata). Sospendo la coda per permettere sincronizzazione.`);
              break;
            }
          }
        } else if (nextBid > tracked.maxBidAllowed) {
          console.log(`[FC Sniper] Asta Trade ${tradeId} superata a ${item.currentBid}. Il prossimo rilancio (${nextBid}) supererebbe il limite (${tracked.maxBidAllowed}). Abbandono.`);
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[ASTA SUPERATA] Asta su ${tracked.name || 'Trade ' + tradeId} superata a ${item.currentBid} cr. Rilancio (${nextBid} cr) oltre il limite max (${tracked.maxBidAllowed} cr): abbandono.`
          });
          await removeStoredPendingBid(tradeId);
          activeBids.delete(String(tradeId));
          activeBids.delete(Number(tradeId));
        }
      }
    }

    const activeStoredBids = await getStoredPendingBids();
    const ourPendingCount = auctions.filter(a =>
      a.tradeState === "active" && (
        a.bidState === "highest" ||
        activeBids.has(String(a.tradeId)) ||
        activeBids.has(Number(a.tradeId)) ||
        Boolean(activeStoredBids && activeStoredBids[String(a.tradeId)])
      )
    ).length;
    return Math.max(ourPendingCount, activeBids.size);
  } catch (err) {
    console.error("[Error resolving watchlist]", err);
    return activeBids.size;
  }
}

// Controlla la Watchlist prima del rabbocco Lazy:
export async function checkAndProcessWatchlistForLazy(cyclePrices = {}) {
  if (!botState.xUtSid) return { recoveredWon: 0, activeWinning: 0, cleanedLost: 0 };

  await triggerPinEvent("TRIGGER_PIN_WATCHLIST");

  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache, no-store, must-revalidate",
    "pragma": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": botState.xUtSid,
  });

  try {
    let response = await fetch(WATCHLIST_URL, { method: "GET", headers });
    if (!response.ok) {
      if (response.status === 401) await handle401Error("Lazy Watchlist Check");
      return { recoveredWon: 0, activeWinning: 0, cleanedLost: 0 };
    }
    botState.consecutive401Errors = 0;

    let data = await response.json();
    if (data.credits !== undefined) {
      botState.crediti = data.credits;
      sendMessageSafe({ tipo: 'CREDITI', valore: botState.crediti });
    }

    let auctions = data.auctionInfo || [];
    let recoveredWon = 0;
    let cleanedLost = 0;

    const imminentAuctions = auctions.filter(a => a.tradeState === "active" && a.bidState === "highest" && a.expires > 0 && a.expires <= 35);
    if (imminentAuctions.length > 0) {
      const maxWait = Math.max(...imminentAuctions.map(a => a.expires || 0));
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[LAZY WATCHLIST] ${imminentAuctions.length} aste vincenti in scadenza tra ${maxWait}s. Attendo la chiusura per riscattarle subito...`
      });
      await sleep((maxWait + 2) * 1000);

      await triggerPinEvent("TRIGGER_PIN_WATCHLIST");
      response = await fetch(WATCHLIST_URL, { method: "GET", headers });
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
      const tradeState = item.tradeState;
      const bidState = item.bidState;
      const expires = item.expires;
      const itemId = item.itemData?.id;
      const tracked = storedBids[tradeIdStr] || activeBids.get(tradeIdStr) || activeBids.get(Number(tradeId));

      const isFinished = (tradeState === "closed" || tradeState === "expired" || expires === -1 || expires === 0);

      if (isFinished) {
        if (bidState === "highest") {
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
            const { floor } = await resolveConsumableFloor(item, cyclePrices, tracked?.playStyleId);

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
            botState.carteAcquistate += 1;
            sendMessageSafe({ tipo: 'CARTA_ACQUISTATA', valore: botState.carteAcquistate });
            try { chrome.storage.local.set({ carteAcquistate: botState.carteAcquistate }); } catch (_) { }
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[ASTA VINTA RISCATTATA] Asta vinta a ${buyPrice} crediti! Spostata in Tradepile e messa in vendita a ${sellPrice}${tierTag}.`
            });
          }

          await removeStoredPendingBid(tradeId);
          activeBids.delete(tradeIdStr);
          activeBids.delete(Number(tradeId));
        } else {
          await deleteFromWatchlist(tradeId);
          await removeStoredPendingBid(tradeId);
          activeBids.delete(tradeIdStr);
          activeBids.delete(Number(tradeId));
          cleanedLost++;
          await sleep(150);
        }
      } else if (tradeState === "active") {
        if (bidState === "highest") {
          activeWinningCount++;
          console.log(`[FC Sniper Watchlist] Asta Trade ${tradeId} ancora attiva con nostra offerta vincente (${item.currentBid} cr, scade in ${item.expires}s).`);
        } else if (bidState === "outbid") {
          const maxBid = Number(tracked?.maxBidAllowed) || 0;
          const currentBid = Number(item.currentBid) || 0;
          const nextBid = calculateNextBid(Number(item.startingBid) || 0, currentBid);

          if (maxBid > 0 && nextBid <= maxBid && botState.start === true) {
            attemptedTradeIds.delete(tradeIdStr);

            const strongBid = Math.max(nextBid, roundUpToStep(maxBid * 0.85));
            const reBidAmount = Math.min(strongBid, maxBid);

            const reBidSuccess = await sendBidRequest(tradeId, reBidAmount, itemId, maxBid);
            if (reBidSuccess) {
              const newBidData = { ...(tracked || {}), bidAmount: reBidAmount, maxBidAllowed: maxBid };
              activeBids.set(tradeIdStr, newBidData);
              await storePendingBid(tradeId, newBidData);
              activeWinningCount++;
              if (typeof botState.crediti === 'number') botState.crediti = Math.max(0, botState.crediti - reBidAmount);
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[RE-BID OUTBID] Superati a ${currentBid} cr su Trade ${tradeId}. Rilancio a ${reBidAmount} cr (Max: ${maxBid}). Asta ancora tracciata.`
              });
            } else {
              await removeStoredPendingBid(tradeId);
              activeBids.delete(tradeIdStr);
              activeBids.delete(Number(tradeId));
              cleanedLost++;
            }
          } else {
            await removeStoredPendingBid(tradeId);
            activeBids.delete(tradeIdStr);
            activeBids.delete(Number(tradeId));
            cleanedLost++;
          }
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
