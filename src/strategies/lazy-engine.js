// Motore UNICO di LAZY TRADING (fodder / consumabili / campionati / allenatori)
import { botState, activeBids, attemptedTradeIds, markTradeAttempted, storePendingBid } from '../core/state.js';
import { sendMessageSafe, triggerPinEvent } from '../core/messenger.js';
import { reportTelemetry } from '../core/telemetry.js';
import { handle401Error, handleCaptchaDetected } from '../ea/error-handlers.js';
import { isRateLimitStatus } from '../ea/status-policy.js';
import { getCrediti, sendBidRequest, sendBuyNowRequest, moveSingleItemToTrade, sellSingleItem } from '../ea/market-api.js';
import {
  getTradepileInfo,
  clearSoldItem,
  processUnassignedItems,
  listUnlistedTradepileItems,
  calculateAndPublishProiezioneCrediti
} from '../services/tradepile-service.js';
import {
  reconcileWatchlistOnStartup,
  resolveWatchlist,
  checkAndProcessWatchlistForLazy
} from '../services/watchlist-service.js';
import { getTieredSellPrice } from '../services/pricing-service.js';
import { detectConsumableKey, targetDisplayName } from '../services/item-classifier.js';
import { sendCycleReport } from '../services/telegram-service.js';
import { sleep, getRandomGaussian, calculateNextBid, roundUpToStep } from '../core/utils.js';
import { getUrgentAuctionTimeRemaining } from './strategy-utils.js';
import { buildLazyCycleTargets } from './lazy-targets.js';

export function computeLazyCycleTarget(pileInfo, isFodder, tag, targetStyles) {
  const currentActiveCount = pileInfo.active || 0;
  const currentTotalCount = pileInfo.total || 0;
  const unlistedCount = Math.max(0, currentTotalCount - currentActiveCount);
  const MAX_TRADEPILE_LIMIT = 100;
  const targetSize = botState.targetTradepileSize && botState.targetTradepileSize > 0
    ? Math.min(botState.targetTradepileSize, MAX_TRADEPILE_LIMIT)
    : 50;

  // Bilanciamento paritario presenze per stile / campionato / nazione (solo non-fodder)
  if (!isFodder && Array.isArray(targetStyles) && targetStyles.length > 0) {
    const currentStyleCounts = {};
    for (const sId of targetStyles) currentStyleCounts[sId] = 0;
    for (const a of (pileInfo.auctions || [])) {
      const detected = detectConsumableKey(a);
      if (currentStyleCounts[detected] !== undefined) currentStyleCounts[detected]++;
    }
    const presenceLog = targetStyles.map(sId => {
      const name = targetDisplayName(sId).replace("Modificatore ", "").replace("Allenatore ", "");
      return `${name}: ${currentStyleCounts[sId]}`;
    }).join(" | ");
    const unitName = botState.targetMode === "managers" ? "nazione" : (botState.targetMode === "managerLeague" ? "campionato" : "stile");
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[BILANCIAMENTO TRADEPILE] Presenze attuali: ${presenceLog} (Quota paritaria: ${Math.round(100 / targetStyles.length)}% per ${unitName})`
    });
  }

  const physicalFreeSlots = Math.max(0, MAX_TRADEPILE_LIMIT - currentTotalCount);
  const neededToTarget = Math.max(0, targetSize - currentTotalCount);
  const rawMissing = Math.min(physicalFreeSlots, neededToTarget);

  const isListingBlocked = Date.now() < botState.listingRestrictedUntil;
  let cycleTarget = 0;
  if (isListingBlocked && (unlistedCount >= 6 || currentTotalCount >= 85)) {
    const remainingMin = Math.ceil((botState.listingRestrictedUntil - Date.now()) / 60000);
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[COOLDOWN LISTING ATTIVO] Ci sono ${unlistedCount} carte in attesa di vendita (${currentTotalCount}/100 in Tradepile) e il listing EA è in pausa (${remainingMin} min). Sospendo acquisti per non bloccare altri crediti.`
    });
    cycleTarget = 0;
  } else {
    let maxBatch;
    if (isFodder) {
      maxBatch = 15;
      if (currentTotalCount < 50) maxBatch = 25;
      else if (currentTotalCount < 80) maxBatch = 20;
    } else {
      maxBatch = 25;
      if (currentTotalCount < 50) maxBatch = 50;
      else if (currentTotalCount < 80) maxBatch = 40;
    }
    cycleTarget = Math.min(rawMissing, maxBatch);
    console.log(`[${tag}] Tradepile: ${currentActiveCount} attive, ${currentTotalCount}/${MAX_TRADEPILE_LIMIT} totali (Mancanti: ${rawMissing}, Target ciclo: ${cycleTarget})`);
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[${tag}] Tradepile: ${currentActiveCount} attive (${currentTotalCount}/${targetSize} tot). Mancanti: ${rawMissing}` + (rawMissing > maxBatch ? ` (Acquisti scaglionati: target ${cycleTarget} carte per questo ciclo)` : '')
    });
  }

  return {
    currentActiveCount,
    currentTotalCount,
    unlistedCount,
    physicalFreeSlots,
    rawMissing,
    targetSize,
    isListingBlocked,
    cycleTarget
  };
}

export async function runLazyBiddingStep(ctx) {
  const {
    isFodder,
    tag,
    bidTag,
    bidActionTag,
    cycleTarget,
    targets,
    targetStyles,
    minBidRequired,
    rawMissing,
    physicalFreeSlots,
    minBidBumps,
    styleSearchCounts
  } = ctx;

  let wonInThisCycle = 0;
  let totalBidsPlaced = 0;
  let searchCount = 0;
  let consecutiveErrorsCount = 0;
  let bidPriceOffset = 0;
  const bidsPerStyle = {};

  const MAX_BIDS_PER_CYCLE = isFodder
    ? Math.min(15, cycleTarget)
    : (rawMissing >= 25 ? 30 : Math.min(30, Math.max(cycleTarget, rawMissing * 2)));

  let bidsTargetPerStyle = null;
  if (!isFodder && Array.isArray(targetStyles)) {
    const bidsBaseQuota = Math.max(1, Math.floor(MAX_BIDS_PER_CYCLE / targetStyles.length));
    const bidsRemainder = MAX_BIDS_PER_CYCLE % targetStyles.length;
    bidsTargetPerStyle = {};
    targetStyles.forEach((sId, idx) => {
      bidsTargetPerStyle[sId] = bidsBaseQuota + (idx < bidsRemainder ? 1 : 0);
    });
  }

  botState.consecutive461InBidding = 0;
  ctx.consecutive512InCycle = 0;
  botState.marketRestricted = false;
  let stopBiddingDueTo461 = false;
  const maxBiddingSearches = isFodder ? Math.max(25, cycleTarget * 3) : Math.max(80, Math.round(MAX_BIDS_PER_CYCLE * 2.5));
  const MAX_ACTIVE_WATCHLIST = isFodder ? 35 : 45;
  let targetCycleIdx = 0;

  if (!isFodder && bidsTargetPerStyle) {
    const bidsQuotaLog = targetStyles.map(sId => {
      const name = targetDisplayName(sId).replace("Modificatore ", "").replace("Allenatore ", "");
      return `${name}: ${bidsTargetPerStyle[sId]}`;
    }).join(" | ");
    const unitName = botState.targetMode === "managers" ? "nazione" : (botState.targetMode === "managerLeague" ? "campionato" : "stile");
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[${bidActionTag}] Step 1: Offerte all'asta paritarie (Quota offerte per ${unitName}: ${bidsQuotaLog} | Totale: ${MAX_BIDS_PER_CYCLE}). Finestra 1-10 min, controrilanci attivi...`
    });
  } else {
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[LAZY FODDER BIDDING] Step 1: Offerte all'asta a sconto (Target: ${cycleTarget} carte, Max offerte: ${MAX_BIDS_PER_CYCLE}, Prezzi Max: ${ctx.minMaxBuy || 0}-${ctx.maxMaxBuy || 0} cr). Rotazione sui giocatori Rating ${botState.fodderRating}...`
    });
  }

  let lastWatchlistCheckTime = Date.now();
  while (wonInThisCycle < cycleTarget && searchCount < maxBiddingSearches && botState.start === true) {
    if (botState.marketRestricted || ctx.earlyExitRateLimit) break;

    // PRIORITÀ ASSOLUTA: Difesa aste in chiusura o scadute (<= 50s)
    while (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 50000 && botState.start === true && !botState.marketRestricted && !ctx.earlyExitRateLimit) {
      const secLeft = Math.max(0, Math.round(getUrgentAuctionTimeRemaining(activeBids) / 1000));
      console.log(`[${bidActionTag}] Priorità difesa asta in chiusura (~${secLeft}s). Controllo Watchlist...`);
      await sleep(getRandomGaussian(2.5, 0.3, 2.0, 3.2) * 1000);
      const prevWon = botState.carteAcquistate;
      await resolveWatchlist();
      lastWatchlistCheckTime = Date.now();
      if (botState.carteAcquistate > prevWon) {
        wonInThisCycle += (botState.carteAcquistate - prevWon);
        botState.consecutive461InBidding = 0;
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[PROGRESSO CICLO] Lotto acquisti: ${wonInThisCycle}/${cycleTarget} carte acquisite.`
        });
        if (wonInThisCycle >= cycleTarget) break;
      }
    }
    if (wonInThisCycle >= cycleTarget || botState.start !== true || botState.marketRestricted || ctx.earlyExitRateLimit) break;

    if (activeBids.size > 0 && Date.now() - lastWatchlistCheckTime >= 15000) {
      const prevWon = botState.carteAcquistate;
      await resolveWatchlist();
      lastWatchlistCheckTime = Date.now();
      if (botState.carteAcquistate > prevWon) {
        wonInThisCycle += (botState.carteAcquistate - prevWon);
        botState.consecutive461InBidding = 0;
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[PROGRESSO CICLO] Lotto acquisti: ${wonInThisCycle}/${cycleTarget} carte acquisite.`
        });
        if (wonInThisCycle >= cycleTarget) break;
      }
    }

    if (!isFodder && bidsTargetPerStyle) {
      const allBidsFilled = targetStyles.every(sId => (bidsPerStyle[sId] || 0) >= (bidsTargetPerStyle[sId] || 1));
      if (allBidsFilled || totalBidsPlaced >= MAX_BIDS_PER_CYCLE) {
        const unitName = botState.targetMode === "managers" ? "nazioni" : (botState.targetMode === "managerLeague" ? "campionati" : "stili");
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[${bidActionTag}] Quota paritaria offerte completata su tutte le ${unitName} (${totalBidsPlaced}/${MAX_BIDS_PER_CYCLE}). Monitoraggio e risoluzione aste in corso...`
        });
        break;
      }
    } else if (totalBidsPlaced >= MAX_BIDS_PER_CYCLE) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[LAZY FODDER BIDDING] Quota offerte ciclo raggiunta (${totalBidsPlaced}/${MAX_BIDS_PER_CYCLE}). Monitoraggio e risoluzione aste in corso...`
      });
      break;
    }

    if (typeof botState.crediti === 'number' && botState.crediti < minBidRequired && activeBids.size === 0) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[${bidTag}] Crediti insufficienti (${botState.crediti} < ${minBidRequired}). Passo al controllo completamento.`
      });
      break;
    }

    const inFlightLimitHit = isFodder
      ? ((wonInThisCycle + activeBids.size) >= (cycleTarget + 2) || activeBids.size >= MAX_ACTIVE_WATCHLIST)
      : (activeBids.size >= MAX_ACTIVE_WATCHLIST || (wonInThisCycle + activeBids.size) >= physicalFreeSlots);
    if (inFlightLimitHit) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[${bidActionTag}] Quota offerte in volo raggiunta (${activeBids.size} attive, ${wonInThisCycle}/${cycleTarget} vinte). Monitoraggio risoluzione aste...`
      });
      while (inFlightLimitHit && activeBids.size > 0 && botState.start === true) {
        await sleep(getRandomGaussian(2.0, 0.3, 1.5, 2.5) * 1000);
        const prevWon = botState.carteAcquistate;
        await resolveWatchlist();
        if (botState.carteAcquistate > prevWon) {
          wonInThisCycle += (botState.carteAcquistate - prevWon);
          botState.consecutive461InBidding = 0;
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[PROGRESSO CICLO] Lotto acquisti: ${wonInThisCycle}/${cycleTarget} carte acquisite.`
          });
          if (wonInThisCycle >= cycleTarget) break;
        }
        if (!(isFodder ? ((wonInThisCycle + activeBids.size) >= (cycleTarget + 2)) : (activeBids.size >= MAX_ACTIVE_WATCHLIST || (wonInThisCycle + activeBids.size) >= physicalFreeSlots))) break;
      }
      if (wonInThisCycle >= cycleTarget) break;
    }

    const target = targets[targetCycleIdx % targets.length];
    targetCycleIdx++;

    if (!target) {
      searchCount++;
      continue;
    }

    if (!isFodder && bidsTargetPerStyle && (bidsPerStyle[target.key] || 0) >= (bidsTargetPerStyle[target.key] || 1)) {
      searchCount++;
      continue;
    }

    const styleSpecificCount = styleSearchCounts[target.key] || 0;
    styleSearchCounts[target.key] = styleSpecificCount + 1;

    const url = target.buildUrl(minBidBumps[(styleSpecificCount + bidPriceOffset) % minBidBumps.length], "bid");
    await triggerPinEvent("TRIGGER_PIN_SEARCH");

    const headers = new Headers({
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      "X-UT-SID": botState.xUtSid
    });

    if (isFodder && searchCount % 4 === 0) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[LAZY FODDER BIDDING] Analisi aste: ${target.name} (Max Bid: ${target.maxBid} cr) [Controllo ${searchCount + 1}/${maxBiddingSearches}]`
      });
    }

    try {
      const res = await fetch(url.href, { method: "GET", headers });
      if (res.ok) {
        consecutiveErrorsCount = 0;
        botState.consecutiveSearchErrors = 0;
        botState.consecutive401Errors = 0;
        const data = await res.json();
        const auctions = data.auctionInfo || [];

        const maxInitialExpiry = botState.targetMode === "managers" ? 180 : 300;
        const maxFallbackExpiry = botState.targetMode === "managers" ? 240 : 600;

        let targetAuctions = auctions.filter(a =>
          a.expires > 0 &&
          a.expires <= maxInitialExpiry &&
          a.bidState !== "highest" &&
          !activeBids.has(String(a.tradeId)) &&
          !attemptedTradeIds.has(String(a.tradeId))
        );
        if (targetAuctions.length === 0) {
          targetAuctions = auctions.filter(a =>
            a.expires > 0 &&
            a.expires <= maxFallbackExpiry &&
            a.bidState !== "highest" &&
            !activeBids.has(String(a.tradeId)) &&
            !attemptedTradeIds.has(String(a.tradeId))
          );
        }

        if (target.itemFilter) {
          targetAuctions = targetAuctions.filter(target.itemFilter);
        }

        targetAuctions.sort((a, b) => (a.expires || 0) - (b.expires || 0));

        let bidsInThisSearch = 0;
        let consecutiveFailedBidsInSearch = 0;
        for (const auction of targetAuctions) {
          if (bidsInThisSearch >= 2) break;
          if (consecutiveFailedBidsInSearch >= 2) break;
          if (!isFodder && bidsTargetPerStyle && ((bidsPerStyle[target.key] || 0) >= (bidsTargetPerStyle[target.key] || 1) || totalBidsPlaced >= MAX_BIDS_PER_CYCLE)) break;
          const capBreak = isFodder
            ? (botState.start !== true || wonInThisCycle >= cycleTarget || (wonInThisCycle + activeBids.size) >= (cycleTarget + 2) || activeBids.size >= MAX_ACTIVE_WATCHLIST)
            : (botState.start !== true || wonInThisCycle >= cycleTarget || (wonInThisCycle + activeBids.size) >= physicalFreeSlots || activeBids.size >= MAX_ACTIVE_WATCHLIST);
          if (capBreak) break;

          const minNextBid = calculateNextBid(auction.startingBid, auction.currentBid);
          if (minNextBid > target.maxBid) continue;

          const isLowValue = !target.strongBase || target.strongBase < 1000;
          const strongBidTarget = roundUpToStep(target.strongBase * 0.70);
          const nextBid = (target.isManagerTarget || isLowValue)
            ? minNextBid
            : Math.min(target.maxBid, Math.max(minNextBid, strongBidTarget));

          if (nextBid <= target.maxBid) {
            if (typeof botState.crediti === 'number' && botState.crediti < nextBid) {
              console.log(`[${bidTag}] Saldo crediti insufficiente per offerta (${botState.crediti} cr < ${nextBid} cr richiesti). Salto asta.`);
              continue;
            }

            if (ctx.requiresSoftBanProbe) {
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[SONDA ANTI-BAN] Verifica preliminare permessi offerte dopo la pausa di riposo (1 sola offerta test)...`
              });
            }

            await sleep(getRandomGaussian(0.8, 0.15, 0.6, 1.1) * 1000);

            const bidSuccess = await sendBidRequest(auction.tradeId, nextBid, auction.itemData?.id, target.maxBid);

            if (ctx.requiresSoftBanProbe) {
              if (!bidSuccess && botState.lastBidErrorStatus === 461) {
                sendMessageSafe({
                  tipo: 'LOG',
                  valore: `[SONDA ANTI-BAN] L'offerta di test ha ricevuto 461 (Soft-ban EA ancora attivo). L'account necessita di ulteriore riposo: rientro in pausa senza insistere.`
                });
                botState.marketRestricted = true;
                ctx.earlyExitRateLimit = true;
                break;
              } else if (bidSuccess) {
                ctx.requiresSoftBanProbe = false;
                sendMessageSafe({
                  tipo: 'LOG',
                  valore: `[SONDA ANTI-BAN] Test superato con successo! Permessi di offerta ripristinati da EA.`
                });
              }
            }

            if (bidSuccess) {
              totalBidsPlaced++;
              bidsInThisSearch++;
              bidsPerStyle[target.key] = (bidsPerStyle[target.key] || 0) + 1;
              consecutiveFailedBidsInSearch = 0;
              botState.consecutive461InBidding = 0;
              if (typeof botState.crediti === 'number') botState.crediti = Math.max(0, botState.crediti - nextBid);
              const bidData = {
                ...target.bidDataBase,
                sellPrice: target.sellPrice,
                maxBidAllowed: target.maxBid,
                bidAmount: nextBid,
                itemId: auction.itemData?.id,
                expiresAt: Date.now() + (auction.expires * 1000),
                rebidCount: 0
              };
              activeBids.set(String(auction.tradeId), bidData);
              await storePendingBid(auction.tradeId, bidData);

              sendMessageSafe({
                tipo: 'LOG',
                valore: `[${bidTag}] Offerta di ${nextBid} crediti su ${target.name} (Scade in ${Math.round(auction.expires)}s | Max: ${target.maxBid}) [Offerte ciclo: ${totalBidsPlaced}]`
              });

              ctx.consecutive512InCycle = 0;
              consecutiveErrorsCount = 0;

              await sleep(getRandomGaussian(5.5, 0.5, 4.8, 7.0) * 1000);

              if (totalBidsPlaced > 0 && totalBidsPlaced % 5 === 0) {
                sendMessageSafe({
                  tipo: 'LOG',
                  valore: `[${bidActionTag}] Pausa distensiva anti-spam (${totalBidsPlaced} offerte piazzate)... Lascio defluire i contatori EA prima delle prossime offerte.`
                });
                await sleep(getRandomGaussian(12.0, 1.0, 10.0, 15.0) * 1000);
              }
            } else {
              consecutiveFailedBidsInSearch++;
              if (botState.lastBidErrorStatus === 461) {
                botState.consecutive461InBidding++;
                bidPriceOffset++;
                if (botState.consecutive461InBidding >= 3) {
                  console.log(`[${bidActionTag}] Rilevate ${botState.consecutive461InBidding} aste contese o rifiutate (461). Concludo Step 1 e verifico con Compra Ora.`);
                  sendMessageSafe({
                    tipo: 'LOG',
                    valore: `[${bidActionTag}] Rilevati 3 errori 461 consecutivi sulle aste. Concludo le offerte all'asta e passo direttamente a Compra Ora per verificare lo stato dell'account...`
                  });
                  await resolveWatchlist();
                  stopBiddingDueTo461 = true;
                  break;
                }
                break;
              }
              if (isRateLimitStatus(botState.lastBidErrorStatus)) {
                ctx.earlyExitRateLimit = true;
                console.warn(`[${bidActionTag}] Avviso rate-limit EA (${botState.lastBidErrorStatus}) su offerta. Attivazione Early-Exit preventiva...`);
                reportTelemetry('EARLY_EXIT_RATE_LIMIT', `Avviso rate-limit EA (${botState.lastBidErrorStatus}) su offerta. Uscita preventiva dagli acquisti.`, { status: botState.lastBidErrorStatus });
                sendMessageSafe({
                  tipo: 'LOG',
                  valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${botState.lastBidErrorStatus}) rilevato. Per prevenire soft-ban, concludo anticipatamente gli acquisti e passo alla pausa di riposo.`
                });
                break;
              }
            }
          }
        }
        if (botState.marketRestricted || ctx.earlyExitRateLimit || stopBiddingDueTo461) break;
      } else if (res.status === 401) {
        await handle401Error(isFodder ? "Lazy Fodder Bidding Search" : "Lazy Bidding Search");
        break;
      } else if (res.status === 458) {
        await handleCaptchaDetected(isFodder ? "Lazy Fodder Bidding" : "Lazy Bidding");
        break;
      } else if (isRateLimitStatus(res.status)) {
        ctx.earlyExitRateLimit = true;
        console.warn(`[${bidActionTag}] Avviso rate-limit EA (${res.status}) su ricerca. Attivazione Early-Exit preventiva...`);
        reportTelemetry('EARLY_EXIT_RATE_LIMIT', `Avviso rate-limit EA (${res.status}) su ricerca. Uscita preventiva dagli acquisti.`, { status: res.status });
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${res.status}) rilevato su ricerca. Concludo anticipatamente gli acquisti e passo alla pausa di riposo.`
        });
        break;
      }
    } catch (e) {
      console.error(`[${bidActionTag} Error]`, e);
      consecutiveErrorsCount++;
      if (consecutiveErrorsCount >= 3) {
        if (isFodder) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[LAZY FODDER BID] Rilevati 3 errori consecutivi di ricerca. Passo allo Step 2.`
          });
        }
        break;
      }
    }

    if (stopBiddingDueTo461) break;
    searchCount++;

    if (activeBids.size > 0 && searchCount % 3 === 0) {
      const prevWon = botState.carteAcquistate;
      await resolveWatchlist();
      if (botState.carteAcquistate > prevWon) {
        wonInThisCycle += (botState.carteAcquistate - prevWon);
        botState.consecutive461InBidding = 0;
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[PROGRESSO CICLO] Lotto acquisti: ${wonInThisCycle}/${cycleTarget} carte acquisite.`
        });
      }
    }

    if (searchCount % 6 === 0) {
      await sleep(getRandomGaussian(6.0, 0.6, 5.0, 7.5) * 1000);
    } else {
      await sleep(getRandomGaussian(3.6, 0.4, 3.0, 4.5) * 1000);
    }
  }

  // Risoluzione e difesa completa di tutte le aste attive prima di procedere allo Step 2
  if (activeBids.size > 0 && botState.start === true && !botState.marketRestricted && !ctx.earlyExitRateLimit && !stopBiddingDueTo461) {
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[${bidTag}] Monitoraggio e risoluzione di tutte le offerte attive (${activeBids.size} in corso)...`
    });

    const maxWaitTimestamp = Date.now() + 4 * 60 * 1000;
    while (activeBids.size > 0 && Date.now() < maxWaitTimestamp && botState.start === true && !botState.marketRestricted && !ctx.earlyExitRateLimit) {
      const remainingMs = getUrgentAuctionTimeRemaining(activeBids);
      const secLeft = Math.max(0, Math.round(remainingMs / 1000));

      let waitDelay;
      if (remainingMs <= 45000) {
        waitDelay = getRandomGaussian(2.8, 0.3, 2.2, 3.6);
        console.log(`[${bidActionTag}] Asta in chiusura entro ${secLeft}s. Monitoraggio ravvicinato Watchlist...`);
      } else {
        waitDelay = getRandomGaussian(8.0, 0.8, 6.0, 10.0);
        console.log(`[${bidActionTag}] Asta più vicina scade in ${secLeft}s. Attesa intermedia (${Math.round(waitDelay)}s)...`);
      }

      await sleep(waitDelay * 1000);
      const prevWon = botState.carteAcquistate;
      await resolveWatchlist();
      if (botState.carteAcquistate > prevWon) {
        wonInThisCycle += (botState.carteAcquistate - prevWon);
        botState.consecutive461InBidding = 0;
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[PROGRESSO CICLO] Lotto acquisti: ${wonInThisCycle}/${cycleTarget} carte acquisite.`
        });
      }
    }

    if (activeBids.size > 0 && botState.start === true) {
      const prevWon = botState.carteAcquistate;
      await resolveWatchlist();
      if (botState.carteAcquistate > prevWon) {
        wonInThisCycle += (botState.carteAcquistate - prevWon);
      }
    }
  }

  return { wonInThisCycle, consecutiveErrorsCount };
}

export async function runLazyTopUpStep(ctx) {
  const {
    isFodder,
    tag,
    topUpTag,
    cycleTarget,
    targets,
    targetSize,
    minBidBumps,
    styleSearchCounts
  } = ctx;

  let { wonInThisCycle } = ctx;

  let topUpTarget;
  if (isFodder) {
    topUpTarget = Math.max(0, cycleTarget - wonInThisCycle);
  } else {
    const midPile = await getTradepileInfo();
    const missingActive = Math.max(0, targetSize - midPile.active);
    const physicalFreeNow = Math.max(0, 100 - midPile.total);
    topUpTarget = Math.min(cycleTarget - wonInThisCycle, Math.min(missingActive, physicalFreeNow));
  }

  if (topUpTarget <= 0) return { wonInThisCycle, topUpBought: 0 };

  const topUpLogText = isFodder
    ? `[LAZY FODDER TOP-UP] Step 2: Compra Ora rapido sotto-prezzo per completare il lotto (${topUpTarget} carte mancanti, Max Buy: <= ${ctx.minMaxBuy || 0}-${ctx.maxMaxBuy || 0} cr)...`
    : (botState.targetMode === "managers"
      ? `[LAZY ALLENATORI TOP-UP] Step 2: Compra Ora rapido di ${topUpTarget} allenatori a -15% dal Lowest BIN...`
      : `[LAZY TOP-UP] Step 2: Rifornimento Compra Ora di ${topUpTarget} carte al Floor BIN per completare gli slot mancanti...`);
  sendMessageSafe({
    tipo: 'LOG',
    valore: topUpLogText
  });

  let topUpBought = 0;
  let topUpSearches = 0;
  let consecutive461InTopUp = 0;
  let minPriceOffset = 0;
  const maxTopUpSearches = isFodder ? Math.max(40, topUpTarget * 5) : Math.max(50, topUpTarget * 6);
  let topUpTargetIdx = 0;
  botState.lastBidErrorStatus = 0;
  botState.lastBuyNowErrorStatus = 0;
  let consecutiveErrorsCount = 0;
  let stopTopUpDueTo461 = false;

  while (topUpBought < topUpTarget && topUpSearches < maxTopUpSearches && botState.start === true) {
    const target = targets[topUpTargetIdx % targets.length];
    topUpTargetIdx++;

    if (!target || !target.maxBuyNow || target.maxBuyNow <= 0) {
      topUpSearches++;
      continue;
    }

    if (typeof botState.crediti === 'number' && botState.crediti < target.maxBuyNow) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[${topUpTag}] Crediti insufficienti (${botState.crediti} < ${target.maxBuyNow}) per ulteriori acquisti Compra Ora.`
      });
      break;
    }

    const styleTopUpCount = styleSearchCounts["topup_" + target.key] || 0;
    styleSearchCounts["topup_" + target.key] = styleTopUpCount + 1;

    if (isFodder && topUpSearches % 4 === 0) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[LAZY FODDER TOP-UP] Analisi Compra Ora: ${target.name} (Max Buy: ${target.maxBuyNow} cr) [Ricerca ${topUpSearches + 1}/${maxTopUpSearches}]`
      });
    }

    const url = target.buildUrl(minBidBumps[(styleTopUpCount + minPriceOffset) % minBidBumps.length], "buy");
    await triggerPinEvent("TRIGGER_PIN_SEARCH");

    const headers = new Headers({
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      "X-UT-SID": botState.xUtSid
    });

    try {
      const res = await fetch(url.href, { method: "GET", headers });
      if (res.ok) {
        consecutiveErrorsCount = 0;
        const data = await res.json();
        const auctions = data.auctionInfo || [];

        const validAuctions = auctions.filter(a =>
          a.buyNowPrice &&
          a.buyNowPrice <= target.maxBuyNow &&
          !attemptedTradeIds.has(String(a.tradeId)) &&
          (!target.itemFilter || target.itemFilter(a))
        );
        validAuctions.sort((a, b) => (b.expires || 0) - (a.expires || 0));

        if (validAuctions.length > 0) {
          const candidate = validAuctions[0];
          if (typeof botState.crediti === 'number' && botState.crediti < candidate.buyNowPrice) {
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[${topUpTag}] Crediti insufficienti (${botState.crediti} cr < ${candidate.buyNowPrice} cr richiesti) per acquistare ${target.name}. Concludo Step 2.`
            });
            break;
          }

          markTradeAttempted(candidate.tradeId);

          if (ctx.requiresSoftBanProbe) {
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[SONDA ANTI-BAN] Verifica preliminare permessi acquisto Compra Ora dopo la pausa di riposo (1 solo acquisto test)...`
            });
          }

          const buySuccess = await sendBuyNowRequest(candidate.tradeId, candidate.buyNowPrice, candidate.itemData?.id);

          if (ctx.requiresSoftBanProbe) {
            if (!buySuccess && (botState.lastBuyNowErrorStatus === 461 || botState.lastBuyNowErrorStatus === 478)) {
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[SONDA ANTI-BAN] L'acquisto di test Compra Ora ha ricevuto 461 (Soft-ban EA ancora attivo). Rientro in pausa senza insistere.`
              });
              botState.marketRestricted = true;
              stopTopUpDueTo461 = true;
              break;
            } else if (buySuccess) {
              ctx.requiresSoftBanProbe = false;
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[SONDA ANTI-BAN] Test superato con successo! Permessi di acquisto ripristinati da EA.`
              });
            }
          }

          if (buySuccess) {
            topUpBought++;
            consecutive461InTopUp = 0;
            botState.consecutive461InBidding = 0;
            wonInThisCycle++;
            botState.carteVinteCiclo++;
            ctx.consecutive512InCycle = 0;
            ctx.requiresSoftBanProbe = false;
            if (typeof botState.crediti === 'number') botState.crediti = Math.max(0, botState.crediti - candidate.buyNowPrice);

            const candItemId = candidate.itemData?.id;
            await moveSingleItemToTrade(candItemId);
            await sleep(getRandomGaussian(1.0, 0.2, 0.8, 1.3) * 1000);

            let targetSellPrice = target.sellPrice;
            let sellLogMsg = "";
            if (target.isManagerTarget || botState.targetMode === "managers") {
              targetSellPrice = target.sellPrice;
              sellLogMsg = `al Lowest BIN live (${targetSellPrice} cr)`;
            } else {
              const tiered = getTieredSellPrice(target.tierBase, null, target.tierIsConsumable);
              targetSellPrice = tiered.price;
              sellLogMsg = `a ${tiered.price} (Tier ${tiered.tier}: +${tiered.markup}%)`;
            }
            const listed = await sellSingleItem(candItemId, targetSellPrice);
            const netEst = Math.floor(targetSellPrice * 0.95) - candidate.buyNowPrice;
            if (listed) {
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[${topUpTag}] Acquistata carta (${target.name}) a ${candidate.buyNowPrice} cr e messa in vendita ${sellLogMsg} (Profitto netto: +${netEst.toLocaleString('it-IT')} cr) [${topUpBought}/${topUpTarget}]`
              });
            } else {
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[${topUpTag}] Acquistata carta (${target.name}) a ${candidate.buyNowPrice} cr. Spostata in lista trasferimenti (Prezzo target: ${targetSellPrice} cr, Profitto netto: +${netEst.toLocaleString('it-IT')} cr) [${topUpBought}/${topUpTarget}].`
              });
            }

            await sleep(getRandomGaussian(3.5, 0.4, 2.8, 4.5) * 1000);
          } else {
            if (isRateLimitStatus(botState.lastBuyNowErrorStatus)) {
              ctx.earlyExitRateLimit = true;
              console.warn(`[${topUpTag}] Avviso rate-limit EA (${botState.lastBuyNowErrorStatus}) su Compra Ora. Attivazione Early-Exit preventiva...`);
              reportTelemetry('EARLY_EXIT_RATE_LIMIT', `Avviso rate-limit EA (${botState.lastBuyNowErrorStatus}) su Compra Ora.`, { status: botState.lastBuyNowErrorStatus });
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${botState.lastBuyNowErrorStatus}) rilevato su Compra Ora. Concludo anticipatamente gli acquisti e passo alla pausa di riposo.`
              });
              break;
            } else {
              if (botState.lastBuyNowErrorStatus === 461 || botState.lastBuyNowErrorStatus === 478) {
                consecutive461InTopUp++;
                minPriceOffset++;
                const nextMinBump = minBidBumps[(styleTopUpCount + minPriceOffset) % minBidBumps.length];

                const isSoftBanTriggered = (botState.consecutive461InBidding >= 3 && consecutive461InTopUp >= 1) || consecutive461InTopUp >= 3;

                if (isSoftBanTriggered) {
                  const errorCountReason = botState.consecutive461InBidding >= 3
                    ? `4 errori 461 consecutivi (3 su aste + 1 su Compra Ora)`
                    : `3 tentativi consecutivi di Compra Ora rifiutati (461)`;
                  console.log(`[${topUpTag}] Rilevato Soft-Ban EA: ${errorCountReason}. Concludo Step 2 e avvio pausa silenziata.`);
                  sendMessageSafe({
                    tipo: 'LOG',
                    valore: `[${topUpTag}] Rilevato Soft-Ban EA (${errorCountReason}). Attivazione pausa rigenerativa silenziata (keep-alive di sessione attivo per evitare disconnessioni)...`
                  });
                  botState.marketRestricted = true;
                  stopTopUpDueTo461 = true;
                  ctx.requiresSoftBanProbe = true;
                  break;
                } else {
                  sendMessageSafe({
                    tipo: 'LOG',
                    valore: `[${topUpTag}] Carta anticipata (461). Eseguo nuova ricerca variando prezzo minimo (${nextMinBump} cr)... (${consecutive461InTopUp}/3)`
                  });
                  await sleep(getRandomGaussian(2.5, 0.3, 2.0, 3.2) * 1000);
                }
              } else {
                await sleep(getRandomGaussian(2.5, 0.3, 2.0, 3.2) * 1000);
              }
            }
          }
        } else {
          await sleep(getRandomGaussian(isFodder ? 3.0 : 3.8, 0.4, isFodder ? 2.4 : 3.0, isFodder ? 4.0 : 4.8) * 1000);
        }

        if (ctx.earlyExitRateLimit || stopTopUpDueTo461) break;
      } else if (res.status === 401) {
        await handle401Error(isFodder ? "Lazy Fodder Top-Up Search" : "Lazy Top-Up Search");
        break;
      } else if (res.status === 458) {
        await handleCaptchaDetected(isFodder ? "Lazy Fodder Top-Up" : "Lazy Top-Up");
        break;
      } else if (isRateLimitStatus(res.status)) {
        ctx.earlyExitRateLimit = true;
        if (!isFodder) {
          console.warn(`[${topUpTag}] Avviso rate-limit EA (${res.status}) su ricerca Compra Ora. Attivazione Early-Exit preventiva...`);
          reportTelemetry('EARLY_EXIT_RATE_LIMIT', `Avviso rate-limit EA (${res.status}) su ricerca Compra Ora.`, { status: res.status });
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${res.status}) rilevato su ricerca Compra Ora. Concludo anticipatamente gli acquisti e passo alla pausa di riposo.`
          });
        }
        break;
      }
    } catch (err) {
      console.error(`[${topUpTag} Error]`, err);
      consecutiveErrorsCount++;
      if (!isFodder || consecutiveErrorsCount >= 3) {
        if (isFodder) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[LAZY FODDER TOP-UP] Troppi errori consecutivi di ricerca Compra Ora. Concludo lo Step 2.`
          });
        }
        break;
      }
    }

    if (stopTopUpDueTo461) break;
    topUpSearches++;

    if (activeBids.size > 0 && (getUrgentAuctionTimeRemaining(activeBids) <= 45000 || topUpSearches % 3 === 0) && botState.start === true) {
      const prevWon = botState.carteAcquistate;
      await resolveWatchlist();
      if (botState.carteAcquistate > prevWon) {
        const newlyWon = (botState.carteAcquistate - prevWon);
        wonInThisCycle += newlyWon;
        topUpBought += newlyWon;
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[${tag} WATCHLIST] Asta vinta durante Compra Ora! Progresso rifornimento: [${topUpBought}/${topUpTarget}]`
        });
        if (topUpBought >= topUpTarget) break;
      }
    }
  }

  return { wonInThisCycle, topUpBought };
}

export async function runLazySleepWithHeartbeat(ctx) {
  const {
    tag,
    cyclePrices,
    finalPile,
    targetSize,
    sessionActiveStartTime
  } = ctx;

  let sleepMins;
  if (botState.marketRestricted || ctx.consecutive512InCycle > 0) {
    botState.marketRestricted = true;
    ctx.consecutiveSoftBansInSession++;
    const baseMins = Math.max(45, botState.lazySleepMinutes && botState.lazySleepMinutes > 0 ? botState.lazySleepMinutes : 60);
    if (ctx.consecutiveSoftBansInSession <= 1) {
      sleepMins = baseMins;
    } else if (ctx.consecutiveSoftBansInSession === 2) {
      sleepMins = Math.round(baseMins * 1.5);
    } else {
      sleepMins = Math.min(180, Math.round(baseMins * 2.0));
    }
    reportTelemetry('COOLDOWN_START', `Pausa rigenerativa soft-ban #${ctx.consecutiveSoftBansInSession} (${sleepMins} min) avviata`, { sleepMins, consecutiveSoftBans: ctx.consecutiveSoftBansInSession, marketRestricted: true });
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[${tag}] Rate limit EA attivo (Soft-ban consecutivo #${ctx.consecutiveSoftBansInSession}). Pausa rigenerativa incrementale di ${sleepMins} min per sblocco completo dell'account (Silenzio totale verso il mercato)...`
    });
  } else if ((Date.now() - sessionActiveStartTime) >= (3 * 60 * 60 * 1000)) {
    ctx.isMacroPause = true;
    ctx.consecutiveSoftBansInSession = 0;
    sleepMins = botState.lazySleepMinutes && botState.lazySleepMinutes > 0 ? botState.lazySleepMinutes : 60;
    const hoursActive = ((Date.now() - sessionActiveStartTime) / (1000 * 60 * 60)).toFixed(1);
    reportTelemetry('MACRO_PAUSE_START', `Superate le 3 ore di attività continuativa (${hoursActive}h). Macro-pausa rigenerativa (${sleepMins} min) avviata`, { sleepMins, hoursActive });
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[MACRO-PAUSA RIGENERATIVA] Concluso intero ciclo dopo ${hoursActive}h di attività continuativa! Avvio macro-pausa di ${sleepMins} min per azzerare i contatori EA e favorire le vendite (Keep-alive attivo)...`
    });
  } else if (ctx.earlyExitRateLimit) {
    ctx.consecutiveSoftBansInSession = 0;
    sleepMins = Math.round(getRandomGaussian(5.5, 0.4, 5.0, 6.5));
    reportTelemetry('PREVENTIVE_COOLING_PAUSE', `Pausa preventiva anti-ban post early-exit (${sleepMins} min)`, { sleepMins });
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[${tag}] Raffreddamento preventivo attivo: pausa di riposo di ${sleepMins} min per azzerare i contatori EA (Ripresa automatica al termine)...`
    });
  } else if (Date.now() < botState.listingRestrictedUntil && (finalPile.total - finalPile.active) >= 6) {
    ctx.consecutiveSoftBansInSession = 0;
    sleepMins = Math.max(10, Math.ceil((botState.listingRestrictedUntil - Date.now()) / 60000));
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[${tag}] Cooldown listing EA attivo (${sleepMins} min) con ${finalPile.total - finalPile.active} carte in attesa di vendita. Pausa distensiva...`
    });
  } else if (finalPile.active < targetSize) {
    ctx.consecutiveSoftBansInSession = 0;
    if (finalPile.active < 40) {
      sleepMins = Math.round(getRandomGaussian(11.5, 0.8, 10.0, 13.0));
    } else if (finalPile.active < 75) {
      sleepMins = Math.round(getRandomGaussian(18.0, 1.2, 16.0, 22.0));
    } else {
      sleepMins = Math.round(getRandomGaussian(28.0, 1.5, 25.0, 32.0));
    }
    reportTelemetry('PAUSE_START', `Pausa dinamica anti-spam (${sleepMins} min)`, { sleepMins, currentPile: finalPile.active, targetSize });
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[${tag}] Tradepile a quota ${finalPile.active}/${targetSize}. Pausa dinamica anti-spam di ${sleepMins} min per favorire le vendite prima del prossimo lotto...`
    });
  } else {
    ctx.consecutiveSoftBansInSession = 0;
    sleepMins = botState.lazySleepMinutes && botState.lazySleepMinutes > 0 ? botState.lazySleepMinutes : 60;
    reportTelemetry('SELLING_PHASE_START', `Fase di vendita Tradepile al completo (${sleepMins} min)`, { sleepMins, currentPile: finalPile.active });
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[${tag}] Tradepile al completo (${finalPile.active}/${targetSize})! Entro in modalità vendita per ${sleepMins} minuti...`
    });
  }

  const totalSleepSeconds = sleepMins * 60;
  let nextHeartbeatAt = Math.round(getRandomGaussian(120, 10, 95, 150));
  let nextPingAt = Math.round(getRandomGaussian(480, 30, 360, 600));

  let elapsed = 0;
  while (elapsed < totalSleepSeconds && botState.start === true) {
    await sleep(1000);
    elapsed++;

    if (elapsed % 15 === 0) {
      try {
        await chrome.storage.local.get(['keepAliveCheck']);
      } catch (_) { }
    }

    if (elapsed >= nextHeartbeatAt && botState.start === true) {
      nextHeartbeatAt = elapsed + Math.round(getRandomGaussian(120, 10, 95, 150));
      try {
        const remainingMinutes = Math.round((totalSleepSeconds - elapsed) / 60);
        if (botState.marketRestricted) {
          if (elapsed >= nextPingAt && remainingMinutes >= 2) {
            nextPingAt = elapsed + Math.round(getRandomGaussian(480, 30, 360, 600));
            await triggerPinEvent("REQUEST_TOKEN_REFRESH");
            await sleep(1600);
            botState.crediti = await getCrediti();
            if (botState.start !== true) break;
            reportTelemetry('COOLDOWN_KEEPALIVE', `Ping leggero anti-401 inviato durante cooldown silenziato`, { crediti: botState.crediti, remainingMinutes });
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[COOLDOWN KEEP-ALIVE] Ping leggero di sessione inviato per mantenere attivo il token Web App (anti-401). Mancano ${remainingMinutes} min alla ripresa.`
            });
          } else {
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[COOLDOWN SILENZIATO] Sblocco soft-ban in corso (silenzio totale verso il mercato)... Mancano ${remainingMinutes} min alla ripresa.`
            });
          }
        } else if (ctx.earlyExitRateLimit) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[COOLDOWN PREVENTIVO] Riposo anti-ban in corso (azzeramento contatori EA)... Mancano ${remainingMinutes} min alla ripresa.`
          });
        } else {
          await triggerPinEvent("TRIGGER_PIN_WATCHLIST");
          // Heartbeat di riposo: incassa vendite e aggiorna crediti senza innescare relist massivi (prevenzione 426)
          await clearSoldItem(cyclePrices, { skipRelist: true });
          await checkAndProcessWatchlistForLazy(cyclePrices);
          await processUnassignedItems(cyclePrices);
          const pileInfo = await getTradepileInfo();
          botState.crediti = await getCrediti();
          if (typeof botState.crediti === 'number') {
            sendMessageSafe({ tipo: 'CREDITI', valore: botState.crediti });
          }

          const hbProj = await calculateAndPublishProiezioneCrediti(botState.crediti, pileInfo?.auctions);
          reportTelemetry('HEARTBEAT', `Heartbeat completato: vendite incassate e crediti sincronizzati`, { crediti: botState.crediti, remainingMinutes, proiezione: hbProj?.totale });
          const projText = hbProj && hbProj.activeCount > 0 ? ` | Proiezione: ${hbProj.display} cr (${hbProj.activeCount} in vendita)` : '';
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[${tag} HEARTBEAT] Tradepile sincronizzata: vendite incassate, carte vinte listate e crediti aggiornati (${botState.crediti} cr${projText}). Prossimo restock tra ${remainingMinutes} min.`
          });
        }
      } catch (hbErr) {
        console.warn("[Heartbeat Error]", hbErr);
      }
    }
  }
}

export async function runLazyTradingEngine() {
  const isFodder = botState.targetMode === "fodder";
  const tag = isFodder ? "LAZY FODDER" : (botState.targetMode === "managerLeague" ? "LAZY CAMPIONATI" : (botState.targetMode === "managers" ? "LAZY ALLENATORI" : "LAZY TRADING"));
  const bidTag = isFodder ? "LAZY FODDER BID" : (botState.targetMode === "managerLeague" ? "LAZY CAMPIONATI BID" : (botState.targetMode === "managers" ? "LAZY ALLENATORI BID" : "LAZY BID"));
  const bidActionTag = isFodder ? "LAZY FODDER BIDDING" : (botState.targetMode === "managerLeague" ? "LAZY CAMPIONATI BIDDING" : (botState.targetMode === "managers" ? "LAZY ALLENATORI BIDDING" : "LAZY BIDDING"));
  const topUpTag = isFodder ? "LAZY FODDER TOP-UP" : (botState.targetMode === "managerLeague" ? "LAZY CAMPIONATI TOP-UP" : (botState.targetMode === "managers" ? "LAZY ALLENATORI TOP-UP" : "LAZY TOP-UP"));
  let cycle = 1;
  let lastReportCycle = 0;
  let consecutiveSoftBansInSession = 0;
  let sessionActiveStartTime = Date.now();
  let requiresSoftBanProbe = false;
  const minBidBumps = [150, 200, 250, 300];

  while (botState.start === true) {
    try {
      let consecutive512InCycle = 0;
      let earlyExitRateLimit = false;
      let isMacroPause = false;
      botState.marketRestricted = false;
      botState.consecutive461InBidding = 0;

      sendMessageSafe({
        tipo: 'LOG',
        valore: `=== [${tag}] Inizio Ciclo #${cycle} ===`
      });

      // FASE 1: Riconciliazione aste Watchlist, rilevamento prezzi, riscossione vendite, relist automatico
      sendMessageSafe({
        tipo: 'LOG',
        valore: isFodder
          ? `[LAZY FODDER] Fase 1: Riconciliazione aste vinte, aggiornamento lista Fut.gg (Rating ${botState.fodderRating}), riscossione vendite e relist 1 Ora...`
          : (botState.targetMode === "managers"
            ? `[LAZY ALLENATORI] Fase 1: Riconciliazione aste vinte, auto-discovery Lowest BIN live, riscossione vendite e relist immediato...`
            : (botState.targetMode === "managerLeague"
              ? `[LAZY CAMPIONATI] Fase 1: Riconciliazione aste vinte, rilevamento prezzi live campionati, riscossione vendite e relist ricalcolato...`
              : `[LAZY TRADING] Fase 1: Riconciliazione aste vinte, rilevamento prezzi live, riscossione vendite e relist ricalcolato...`))
      });

      await reconcileWatchlistOnStartup();
      if (botState.start !== true) break;
      await sleep(1000);

      // 1b. Costruzione prezzi e target di ciclo
      const targetBuild = await buildLazyCycleTargets(cycle);
      if (targetBuild.shouldContinue) {
        continue;
      }
      const { cyclePrices, targets, minBidRequired, targetStyles } = targetBuild;

      // 1c, 1d, 1e: Riscossione vendite, non assegnati, relist e aggiornamento crediti
      await clearSoldItem(cyclePrices);
      if (botState.start !== true) break;
      await sleep(1500);

      await processUnassignedItems(cyclePrices);
      if (botState.start !== true) break;
      await sleep(1000);
      await listUnlistedTradepileItems(cyclePrices);
      if (botState.start !== true) break;
      await sleep(1000);

      botState.crediti = await getCrediti();
      sendMessageSafe({ tipo: 'CREDITI', valore: botState.crediti });
      if (botState.start !== true) break;

      // FASE 2: Analisi capienza Tradepile e target di ciclo
      const pileInfo = await getTradepileInfo();
      const {
        currentActiveCount,
        currentTotalCount,
        physicalFreeSlots,
        rawMissing,
        targetSize,
        isListingBlocked,
        cycleTarget
      } = computeLazyCycleTarget(pileInfo, isFodder, tag, targetStyles);

      // FASE 3: Rifornimento Ibrido Protetto
      const styleSearchCounts = {};
      const ctx = {
        isFodder,
        tag,
        bidTag,
        bidActionTag,
        topUpTag,
        cycleTarget,
        targets,
        targetStyles,
        minBidRequired,
        rawMissing,
        physicalFreeSlots,
        targetSize,
        minBidBumps,
        styleSearchCounts,
        consecutive512InCycle,
        earlyExitRateLimit,
        requiresSoftBanProbe,
        consecutiveSoftBansInSession,
        sessionActiveStartTime,
        isMacroPause,
        cyclePrices
      };

      if (cycleTarget > 0 && botState.start === true) {
        if (targets.length === 0) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[${tag}] Impossibile determinare i prezzi di mercato. Salto il rifornimento per questo ciclo.`
          });
        } else {
          // Step 1: Mass Bidding
          const bidResult = await runLazyBiddingStep(ctx);
          let wonInThisCycle = bidResult.wonInThisCycle;
          ctx.wonInThisCycle = wonInThisCycle;

          // Step 2: Rabbocco Compra Ora
          if (botState.start === true && !botState.marketRestricted && !ctx.earlyExitRateLimit && ctx.consecutive512InCycle < 2 && bidResult.consecutiveErrorsCount < 3) {
            const topUpResult = await runLazyTopUpStep(ctx);
            wonInThisCycle = topUpResult.wonInThisCycle;
          }

          if (!botState.marketRestricted) {
            await processUnassignedItems(cyclePrices);
            await sleep(1000);
            await listUnlistedTradepileItems(cyclePrices);
          }
        }
      } else if (cycleTarget === 0) {
        if (isListingBlocked) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[${tag}] Nessun acquisto per questo ciclo: listing EA in pausa e Tradepile a quota ${currentTotalCount}/100 carte (${currentActiveCount} attive).`
          });
        } else {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[${tag}] Tradepile già al completo (${currentActiveCount}/${targetSize} carte attive sul mercato, ${currentTotalCount} totali).`
          });
        }
      }

      if (botState.start !== true) break;

      // FASE 4: Sincronizzazione finale e Pausa di Riposo
      if (activeBids.size > 0 && botState.start === true && !botState.marketRestricted && !ctx.earlyExitRateLimit) {
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[${tag}] Controllo finale offerte pendenti prima della pausa (${activeBids.size} attive)...`
        });
        const maxWaitTimestamp = Date.now() + 3 * 60 * 1000;
        while (activeBids.size > 0 && Date.now() < maxWaitTimestamp && botState.start === true && !botState.marketRestricted && !ctx.earlyExitRateLimit) {
          await sleep(getRandomGaussian(3.5, 0.4, 2.8, 4.5) * 1000);
          await resolveWatchlist();
        }
      }

      if (!botState.marketRestricted) {
        await sleep(2000);
        await clearSoldItem(cyclePrices);
        await processUnassignedItems(cyclePrices);
        await listUnlistedTradepileItems(cyclePrices);
      }
      const finalPile = await getTradepileInfo();
      botState.crediti = await getCrediti();
      sendMessageSafe({ tipo: 'CREDITI', valore: botState.crediti });

      const proj = await calculateAndPublishProiezioneCrediti(botState.crediti, finalPile.auctions);

      let cycleStatus = "OK";
      if (botState.marketRestricted) {
        cycleStatus = "Soft-ban rilevato (In pausa rigenerativa)";
      } else if (ctx.earlyExitRateLimit) {
        cycleStatus = "Rate limit ricerche (In pausa preventiva)";
      } else if (Date.now() < botState.listingRestrictedUntil && (finalPile.total - finalPile.active) >= 6) {
        const remMin = Math.ceil((botState.listingRestrictedUntil - Date.now()) / 60000);
        cycleStatus = `Listing limitato 426 (In pausa ${remMin} min)`;
      }

      await sendCycleReport('lazy', {
        acquistate: botState.carteAcquistate,
        vendute: botState.carteVendute,
        inVendita: { active: finalPile.active, total: finalPile.total },
        crediti: botState.crediti,
        stato: cycleStatus
      });
      lastReportCycle = cycle;

      const projLogText = proj && proj.activeCount > 0 ? ` | Proiezione crediti posseduti: ${proj.display} cr (valore in vendita: +${proj.sommaVendite.toLocaleString('it-IT')} cr)` : '';
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[STATO TRADEPILE] ${finalPile.active}/${targetSize} carte attive sul mercato (${finalPile.total} totali in lista trasferimenti)${projLogText}.`
      });

      if (botState.start !== true) break;

      botState.consecutive512Errors = 0;
      botState.consecutiveSnipeErrors = 0;

      ctx.finalPile = finalPile;
      await runLazySleepWithHeartbeat(ctx);

      if (botState.start === true) {
        if (ctx.isMacroPause) {
          sessionActiveStartTime = Date.now();
        }
        if (botState.marketRestricted) {
          requiresSoftBanProbe = true;
        }
        botState.marketRestricted = false;
        botState.consecutive461InBidding = 0;
        reportTelemetry('CYCLE_START', `Avvio Ciclo #${cycle + 1}`, { cycle: cycle + 1, crediti: botState.crediti });
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[${tag}] Pausa completata! Avvio Ciclo #${cycle + 1}...`
        });
        await sleep(getRandomGaussian(8.0, 1.0, 6.0, 11.0) * 1000);
      }
    } catch (cycleErr) {
      console.error(`[${tag} ERROR] Ciclo #${cycle}:`, cycleErr);
      await sendCycleReport('lazy', {
        acquistate: botState.carteAcquistate,
        vendute: botState.carteVendute,
        inVendita: ctx?.finalPile ? { active: ctx.finalPile.active, total: ctx.finalPile.total } : null,
        crediti: botState.crediti,
        stato: `Errore ciclo: ${cycleErr?.message || cycleErr}`
      });
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[${tag} ERRORE] Errore imprevisto nel Ciclo #${cycle}: ${cycleErr?.message || cycleErr}. Riavvio nuovo ciclo tra 10s...`
      });
      await sleep(10000);
    }

    cycle++;
  }

  if (lastReportCycle < cycle) {
    try {
      const finalPile = await getTradepileInfo();
      await sendCycleReport('lazy', {
        acquistate: botState.carteAcquistate,
        vendute: botState.carteVendute,
        inVendita: { active: finalPile.active, total: finalPile.total },
        crediti: botState.crediti,
        stato: "Interrotto manualmente dall'utente"
      });
    } catch (_) {}
  }

  sendMessageSafe({
    tipo: 'LOG',
    valore: `[${tag}] Modalità arrestata. Eseguo pulizia finale...`
  });
  await clearSoldItem();
}
