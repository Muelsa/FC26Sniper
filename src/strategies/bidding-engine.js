// Motori di Mass Bidding (Manuale, Fodder e Consumabili)
import { botState, activeBids, isTradeAttempted, storePendingBid } from '../core/state.js';
import { sendMessageSafe, triggerPinEvent, stopBot } from '../core/messenger.js';
import { handle401Error, handleSearchRateLimit, handleSearchHttpError } from '../ea/error-handlers.js';
import { isRateLimitStatus } from '../ea/status-policy.js';
import { TRANSFERMARKET_URL } from '../ea/endpoints.js';
import { sendBidRequest, getCrediti } from '../ea/market-api.js';
import { clearSoldItem } from '../services/tradepile-service.js';
import { resolveWatchlist } from '../services/watchlist-service.js';
import { getFodderList, getNextFodder } from '../services/fodder-service.js';
import { discoverConsumableLowestBin } from '../services/pricing-service.js';
import { formatItemDisplayName, detectChemistryStyle } from '../services/item-classifier.js';
import { sendCycleReport } from '../services/telegram-service.js';
import { CHEM_STYLES } from '../ea/constants.js';
import {
  sleep,
  getRandomGaussian,
  getRandomInRange,
  calculateNextBid,
  roundDownToStep,
  calculateTargetMargin
} from '../core/utils.js';
import { getUrgentAuctionTimeRemaining, waitForPendingWatchlistAuctions } from './strategy-utils.js';

export async function sendManualBiddingRequest() {
  try {
    if (!botState.searchUrl) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: '[ATTENZIONE] Nessun filtro acquisito! Vai nella Web App ed esegui una ricerca nel mercato per impostare il filtro desiderato.'
      });
      await sleep(4000);
      return { found: false, bidsPlaced: 0 };
    }
    if (!botState.xUtSid) {
      console.error("Sessione xUtSid non definita");
      return { found: false, bidsPlaced: 0 };
    }

    if (!botState.maxSnipePrice || botState.maxSnipePrice <= 0) {
      sendMessageSafe({ tipo: 'LOG', valore: '[BIDDING MANUALE] Imposta il "Prezzo Max Offerta" nella UI: senza tetto prezzo il bidding manuale è disattivato per sicurezza.' });
      await sleep(5000);
      return { found: false, bidsPlaced: 0 };
    }

    // Cuscinetto di sicurezza watchlist (max 35 attive sui 50 slot EA)
    const MAX_ACTIVE_WATCHLIST = 35;
    if (activeBids.size >= MAX_ACTIVE_WATCHLIST) {
      console.log(`[BIDDING MANUALE] Watchlist satura (${activeBids.size}/${MAX_ACTIVE_WATCHLIST} attive). Attendo risoluzione delle aste correnti prima di nuove offerte.`);
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[BIDDING MANUALE] Limite di sicurezza watchlist raggiunto (${activeBids.size} aste attive). Attendo che si concludano prima di fare altre offerte.`
      });
      await resolveWatchlist();
      return { found: true, bidsPlaced: 0 };
    }

    await triggerPinEvent("TRIGGER_PIN_SEARCH");

    let finalUrl = botState.searchUrl;
    try {
      const parsedUrl = new URL(botState.searchUrl);
      parsedUrl.searchParams.set("start", "0");
      parsedUrl.searchParams.set("num", "21");
      if (botState.maxSnipePrice > 0) {
        parsedUrl.searchParams.set("macr", String(botState.maxSnipePrice));
      }
      const offsetSteps = [0, 150, 200, 250];
      const chosenOffset = offsetSteps[(botState.manualSearchAttempt + botState.manualBidPriceOffset) % offsetSteps.length];
      if (chosenOffset === 0) {
        parsedUrl.searchParams.delete("micr");
      } else {
        parsedUrl.searchParams.set("micr", String(chosenOffset));
      }
      botState.manualSearchAttempt++;
      finalUrl = parsedUrl.href;
    } catch {
      // fallback
    }

    const response = await fetch(finalUrl, {
      method: "GET",
      headers: {
        "Accept": "*/*",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "X-UT-SID": botState.xUtSid
      }
    });

    if (response.ok) {
      botState.consecutiveSearchErrors = 0;
      botState.consecutive401Errors = 0;
      const data = await response.json();
      const allAuctions = (data && data.auctionInfo) ? data.auctionInfo : [];

      // Finestra temporale ridotta a 3 minuti (<= 180s) per evitare offerte disperse
      const MANUAL_BID_WINDOW_SEC = 180;
      let targetAuctions = allAuctions.filter(a =>
        a.expires > 0 &&
        a.expires <= MANUAL_BID_WINDOW_SEC &&
        a.bidState !== "highest" &&
        !activeBids.has(String(a.tradeId)) &&
        !isTradeAttempted(a.tradeId)
      );

      // Se la ricerca non restituisce aste idonee entro 3 minuti, attendiamo ~30 secondi
      if (targetAuctions.length === 0) {
        const nextMinSec = allAuctions.length > 0
          ? Math.min(...allAuctions.filter(a => a.expires > 0).map(a => a.expires))
          : null;
        const infoMsg = (nextMinSec && nextMinSec < 999999)
          ? ` (la più vicina scade tra ~${Math.round(nextMinSec)}s)`
          : '';

        sendMessageSafe({
          tipo: 'LOG',
          valore: `[BIDDING MANUALE] Nessuna asta in scadenza entro 3 minuti${infoMsg}. Attendo ~30s per nuove aste in arrivo...`
        });

        const waitMs = getRandomGaussian(30.0, 2.0, 27.0, 33.0) * 1000;
        const endWait = Date.now() + waitMs;
        while (botState.start === true && Date.now() < endWait) {
          if (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 45000) {
            await resolveWatchlist();
          }
          await sleep(1000);
        }
        return { found: false, bidsPlaced: 0 };
      }

      targetAuctions.sort((a, b) => (a.expires || 0) - (b.expires || 0));

      let bidsInThisSearch = 0;
      const MAX_BIDS_PER_SEARCH = 3;
      for (const auction of targetAuctions) {
        if (botState.start !== true || bidsInThisSearch >= MAX_BIDS_PER_SEARCH) break;
        if (activeBids.size >= MAX_ACTIVE_WATCHLIST) break;

        const nextBid = calculateNextBid(auction.startingBid, auction.currentBid);
        const cap = auction.buyNowPrice > 0 ? Math.min(botState.maxSnipePrice, auction.buyNowPrice) : botState.maxSnipePrice;
        if (nextBid > cap) continue;

        if (typeof botState.crediti === 'number' && botState.crediti < nextBid) {
          console.log(`[BIDDING MANUALE] Saldo crediti insufficiente per offerta (${botState.crediti} cr < ${nextBid} cr richiesti). Salto asta.`);
          continue;
        }

        // 1. Ritardo umano di ispezione asta (600ms - 1100ms)
        await sleep(getRandomGaussian(0.8, 0.15, 0.6, 1.1) * 1000);

        // 2. Invio offerta
        const ok = await sendBidRequest(auction.tradeId, nextBid, auction.itemData?.id, cap);

        if (ok) {
          botState.manualTotalBidsPlaced++;
          bidsInThisSearch++;
          botState.manualConsecutive461 = 0;
          if (typeof botState.crediti === 'number') botState.crediti = Math.max(0, botState.crediti - nextBid);

          const cardName = formatItemDisplayName(auction, auction.tradeId);
          const isConsumable = (auction.itemData?.itemType === "training" || Boolean(auction.itemData?.playStyle));
          const bidData = {
            tradeId: auction.tradeId,
            name: cardName,
            isManual: true,
            searchUrl: botState.searchUrl,
            cardType: auction.itemData?.itemType || "item",
            itemType: auction.itemData?.itemType || "item",
            rating: auction.itemData?.rating,
            nation: auction.itemData?.nation,
            leagueId: auction.itemData?.leagueId,
            assetId: auction.itemData?.assetId || auction.itemData?.resourceId,
            playStyleId: detectChemistryStyle(auction),
            bidAmount: nextBid,
            maxBidAllowed: cap,
            itemId: auction.itemData?.id,
            expiresAt: Date.now() + ((auction.expires || 60) * 1000),
            rebidCount: 0,
            isConsumable: isConsumable
          };
          activeBids.set(String(auction.tradeId), bidData);
          await storePendingBid(auction.tradeId, bidData);

          sendMessageSafe({
            tipo: 'LOG',
            valore: `[BIDDING MANUALE] Offerta di ${nextBid} cr su ${cardName} (Scade in ${Math.round(auction.expires)}s | Max: ${cap} cr) [Offerta #${botState.manualTotalBidsPlaced}]`
          });

          // 3. Pacing umano naturale tra offerte consecutive (4.8s - 7.0s)
          await sleep(getRandomGaussian(5.5, 0.5, 4.8, 7.0) * 1000);

          // 4. Pausa distensiva ogni 5 offerte piazzate (10s - 15s) per far defluire il leaky bucket EA
          if (botState.manualTotalBidsPlaced > 0 && botState.manualTotalBidsPlaced % 5 === 0) {
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[BIDDING MANUALE] Pausa distensiva anti-spam (${botState.manualTotalBidsPlaced} offerte piazzate)... Lascio defluire i contatori EA.`
            });
            await sleep(getRandomGaussian(12.0, 1.0, 10.0, 15.0) * 1000);
          }
        } else {
          if (botState.lastBidErrorStatus === 461) {
            botState.manualConsecutive461++;
            botState.manualBidPriceOffset++;
            if (botState.manualConsecutive461 >= 3) {
              console.log(`[BIDDING MANUALE] Rilevate 3 aste contese o rifiutate (461). Pausa di sicurezza...`);
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[ANTI-BAN] Rilevate 3 aste contese o rifiutate (461). Pausa di sicurezza di 25s per far raffreddare l'account.`
              });
              await sleep(25000);
              await resolveWatchlist();
              break;
            }
            break;
          }

          if (isRateLimitStatus(botState.lastBidErrorStatus)) {
            console.warn(`[BIDDING MANUALE] Rate limit EA (${botState.lastBidErrorStatus}) su offerta. Attivazione pausa protettiva...`);
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${botState.lastBidErrorStatus}) rilevato. Sospendo temporaneamente le offerte per proteggere l'account.`
            });
            botState.marketRestricted = true;
            await sleep(30000);
            break;
          }
        }
      }
      return { found: true, bidsPlaced: bidsInThisSearch };
    } else {
      if (response.status === 401) {
        await handle401Error("Ricerca Bidding Manuale");
      } else if (response.status === 458) {
        console.warn("[FC Sniper Bidding Manuale] CAPTCHA 458 rilevato!");
        sendMessageSafe({
          tipo: 'LOG',
          valore: '[ATTENZIONE - CAPTCHA RILEVATO] Verifica richiesta nella Web App. Bot arrestato.'
        });
        await stopBot("CAPTCHA 458 rilevato");
      } else if (isRateLimitStatus(response.status)) {
        await handleSearchRateLimit(response.status, "Ricerca Bidding Manuale");
      } else {
        console.error("Errore nella ricerca bidding manuale:", response.status, response.statusText);
      }
      return { found: false, bidsPlaced: 0 };
    }
  } catch (error) {
    console.error("Errore durante il bidding manuale:", error);
    return { found: false, bidsPlaced: 0 };
  }
}

export async function runManualBiddingLoop() {
  botState.manualTotalBidsPlaced = 0;
  botState.manualConsecutive461 = 0;
  botState.manualBidPriceOffset = 0;
  sendMessageSafe({
    tipo: 'LOG',
    valore: `Avvio BIDDING Manuale (Tetto Max Offerta: ${botState.maxSnipePrice > 0 ? botState.maxSnipePrice + ' cr' : 'NON IMPOSTATO — inserisci Prezzo Max Offerta nella UI'})`
  });

  let i = 0;
  while (botState.start === true && i < botState.numeroTentativi) {
    if (botState.marketRestricted) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[ANTI-BAN] Account momentaneamente limitato. Attendo pausa di raffreddamento di 30s...`
      });
      await sleep(30000);
      botState.marketRestricted = false;
    }

    // Controllo prioritario aste urgenti (<= 45s): difende senza consumare tentativi di ricerca
    while (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 45000 && botState.start === true) {
      await sleep(3000);
      await resolveWatchlist();
    }

    const manualBidResult = await sendManualBiddingRequest();

    // Controllo periodico e controrilanci Watchlist ogni 5 ricerche
    if ((i + 1) % 5 === 0 && botState.start === true) {
      await resolveWatchlist();
    }

    if (botState.start !== true) break;

    sendMessageSafe({ tipo: 'TENTATIVI_RIMASTI', valore: botState.numeroTentativi - (i + 1) });

    let randomValue = 0;
    if (manualBidResult && manualBidResult.found === false) {
      randomValue = 0;
    } else {
      if ((i + 1) % 6 === 0) randomValue = getRandomGaussian(6.0, 0.6, 5.0, 7.5);
      else randomValue = getRandomGaussian(3.6, 0.4, 3.0, 4.5);
    }

    if (randomValue > 0) {
      await sleep(randomValue * 1000);
    }

    i++;
  }

  // A fine bidding: attendi e difendi tutte le aste ancora aperte nella watchlist prima di chiudere
  if (botState.start === true) {
    await waitForPendingWatchlistAuctions("[BIDDING MANUALE]");
  }

  await clearSoldItem();
}

// Motore UNICO di MASS BIDDING (fodder / consumabili), parametrizzato via targetMode
export async function runMassBiddingEngine() {
  const isFodder = botState.targetMode === "fodder";
  const logTag = isFodder ? "[FC Sniper]" : "[FC Sniper Consumabili]";
  const errContext = isFodder ? "Ricerca Bidding" : "Ricerca Bidding Consumabili";
  const baseUrl = TRANSFERMARKET_URL;
  let i = 0;
  const targetStyles = isFodder ? null : ((botState.chemStyle === "all") ? ["268", "266", "265", "260"] : [botState.chemStyle]);
  let styleIndex = 0;

  while (botState.start === true && i < botState.numeroTentativi) {
    // 1. Controllo prioritario aste urgenti (<= 20s): attende e risolve senza consumare tentativi di ricerca
    while (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 20000 && botState.start === true) {
      const secLeft = Math.max(0, Math.round(getUrgentAuctionTimeRemaining(activeBids) / 1000));
      console.log(`${logTag} Asta urgente in chiusura (~${secLeft}s). Controllo Watchlist per difesa/risoluzione...`);
      await sleep(getRandomGaussian(2.0, 0.2, 1.5, 2.5) * 1000);
      await resolveWatchlist();
    }

    if (botState.start !== true) break;

    // Selezione target e calcolo prezzi
    let targetName, marketPrice, maxBidAllowed, targetMargin, bidDataBase, buildUrl;

    if (isFodder) {
      if (i === 0 || botState.indexFodder === 0 || botState.listaFodder.length === 0) {
        if (i > 0) {
          console.log('[FC Sniper] Giro fodder completato. Ricarico lista e prezzi aggiornati dal server...');
        }
        botState.listaFodder = [];
        botState.indexFodder = 0;
        await getFodderList();
      }

      if (botState.listaFodder.length === 0) {
        console.log('[FC Sniper] Nessun fodder disponibile dal server. Attendo...');
        await sleep(3000);
        i++;
        continue;
      }

      const next = getNextFodder();
      targetName = next.name ? next.name + ' (PID ' + next.pid + ')' : 'PID ' + next.pid;
      marketPrice = next.price;
      const netIncome = Math.floor(marketPrice * 0.95);
      targetMargin = calculateTargetMargin(marketPrice, botState.minMargin);
      maxBidAllowed = roundDownToStep(netIncome - targetMargin);

      if (maxBidAllowed < 700) {
        console.log(`[FC Sniper] Fodder ${targetName} (Rating ${botState.fodderRating}, BIN ${marketPrice}): margine insufficiente (Max Bid ${maxBidAllowed} < 700). Salto.`);
        i++;
        await sleep(600);
        continue;
      }

      bidDataBase = { pid: next.pid, name: next.name, rating: botState.fodderRating };
      buildUrl = (micr) => {
        const url = new URL(baseUrl);
        url.searchParams.set("num", "21");
        url.searchParams.set("start", "0");
        url.searchParams.set("type", "player");
        url.searchParams.set("maskedDefId", next.pid);
        url.searchParams.set("macr", String(maxBidAllowed));
        url.searchParams.set("micr", String(micr));
        return url;
      };
    } else {
      const currentStyleId = targetStyles[styleIndex];
      styleIndex = (styleIndex + 1) % targetStyles.length;
      const styleMeta = CHEM_STYLES[currentStyleId] || { id: currentStyleId, name: `Stile ${currentStyleId}`, defaultGuess: 3000 };
      targetName = styleMeta.name;

      marketPrice = await discoverConsumableLowestBin(currentStyleId, botState.manualBin, i === 0);

      if (!marketPrice || marketPrice <= 0) {
        console.warn(`[FC Sniper Consumabili] Prezzo non identificato per ${styleMeta.name}. Salto per sicurezza.`);
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[SICUREZZA] Prezzo di mercato sconosciuto per ${styleMeta.name}. Offerte sospese su questo stile!`
        });
        i++;
        await sleep(1500);
        continue;
      }

      const netIncome = Math.floor(marketPrice * 0.95);
      const effectiveMargin = Math.max(100, (botState.minMargin || 200) - 50);
      maxBidAllowed = roundDownToStep(netIncome - effectiveMargin);
      targetMargin = netIncome - maxBidAllowed;

      if (maxBidAllowed < 200) {
        console.log(`[FC Sniper Consumabili] Margine insufficiente per ${styleMeta.name} (Max Bid ${maxBidAllowed} < 200). Salto.`);
        i++;
        await sleep(800);
        continue;
      }

      bidDataBase = { playStyleId: currentStyleId, name: styleMeta.name, isConsumable: true };
      buildUrl = (micr) => {
        const url = new URL(baseUrl);
        url.searchParams.set("num", "21");
        url.searchParams.set("start", "0");
        url.searchParams.set("type", "training");
        url.searchParams.set("cat", "playStyle");
        url.searchParams.set("playStyle", String(currentStyleId));
        url.searchParams.set("macr", String(maxBidAllowed));
        url.searchParams.set("micr", String(micr));
        return url;
      };
    }

    const minBidBumps = [150, 200, 250];
    for (let k = minBidBumps.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [minBidBumps[k], minBidBumps[j]] = [minBidBumps[j], minBidBumps[k]];
    }
    let offersCount = 0;

    for (let attempt = 0; attempt < minBidBumps.length; attempt++) {
      if (botState.start !== true) break;

      if (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 20000) {
        console.log(`${logTag} Rilevata asta urgente (<= 20s) durante la ricerca. Interrompo per partecipare subito.`);
        break;
      }

      const url = buildUrl(minBidBumps[attempt]);
      await triggerPinEvent("TRIGGER_PIN_SEARCH");

      const headers = new Headers({
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "X-UT-SID": botState.xUtSid
      });

      try {
        const response = await fetch(url.href, { method: "GET", headers });
        if (response.ok) {
          botState.consecutive401Errors = 0;
          const data = await response.json();
          const auctions = data.auctionInfo || [];

          const SNIPER_WINDOW_SEC = 30;
          const MAX_WATCHLIST_CAPACITY = 48;

          for (const auction of auctions) {
            if (botState.start !== true) break;
            const tradeIdStr = String(auction.tradeId);
            if (activeBids.has(tradeIdStr) || auction.bidState === "highest") continue;

            const nextBid = calculateNextBid(auction.startingBid, auction.currentBid);
            if (nextBid > maxBidAllowed) continue;

            if (auction.expires > 0 && auction.expires <= SNIPER_WINDOW_SEC) {
              if (activeBids.size >= MAX_WATCHLIST_CAPACITY) {
                console.log(`${logTag} Watchlist piena (${activeBids.size}/${MAX_WATCHLIST_CAPACITY}). Attendo risoluzione aste correnti.`);
                break;
              }

              console.log(`${logTag} Asta in chiusura (${auction.expires}s) per ${targetName}: offro ${nextBid} crediti (Max: ${maxBidAllowed}, BIN: ${marketPrice}, Margine: ${targetMargin})`);

              const ok = await sendBidRequest(auction.tradeId, nextBid, auction.itemData?.id);
              if (ok) {
                offersCount++;
                const bidData = {
                  ...bidDataBase,
                  sellPrice: marketPrice,
                  maxBidAllowed: maxBidAllowed,
                  bidAmount: nextBid,
                  itemId: auction.itemData?.id,
                  expiresAt: Date.now() + (auction.expires * 1000),
                  rebidCount: 0
                };
                activeBids.set(tradeIdStr, bidData);
                await storePendingBid(auction.tradeId, bidData);
              } else if (isRateLimitStatus(botState.lastBidErrorStatus)) {
                console.warn(`[FC Sniper Queue] Rate limit EA durante offerta su ${targetName}. Interrompo ulteriori offerte su questo target.`);
                break;
              }

              await sleep(getRandomGaussian(1.1, 0.15, 0.9, 1.35) * 1000);
            }
          }

          if (offersCount > 0) {
            console.log(`${logTag} ${offersCount} offerte piazzate per ${targetName}.`);
            break;
          } else {
            if (attempt < minBidBumps.length - 1) {
              await sleep(getRandomGaussian(0.50, 0.08, 0.40, 0.65) * 1000);
            }
          }
        } else {
          await handleSearchHttpError(response, errContext);
          break;
        }
      } catch (err) {
        console.error(`Errore ricerca bidding (${errContext}):`, err);
        break;
      }
    }

    if (botState.start !== true) break;

    // 2. Risoluzione Watchlist disaccoppiata e mirata:
    if (offersCount > 0 && botState.start === true) {
      await sleep(getRandomGaussian(1.2, 0.15, 1.0, 1.5) * 1000);
      await resolveWatchlist();
    }
    while (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 20000 && botState.start === true) {
      await sleep(getRandomGaussian(1.8, 0.2, 1.4, 2.3) * 1000);
      await resolveWatchlist();
    }

    sendMessageSafe({ tipo: 'TENTATIVI_RIMASTI', valore: botState.numeroTentativi - (i + 1) });

    let randomValue;
    if ((i + 1) % 50 === 0 && i !== botState.numeroTentativi - 1) {
      randomValue = getRandomInRange(120, 180);
      sendMessageSafe({ tipo: 'LOG', valore: 'Cool down di: ' + randomValue + ' sec' });
      await clearSoldItem();
    } else if ((i + 1) % 5 === 0) {
      randomValue = getRandomGaussian(4.0, 0.4, 3.4, 4.8);
    } else {
      randomValue = getRandomGaussian(2.4, 0.3, 2.0, 2.9);
    }

    let remainingSleepMs = randomValue * 1000;
    while (remainingSleepMs > 0 && botState.start === true) {
      if (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 20000) {
        break;
      }
      const chunk = Math.min(500, remainingSleepMs);
      await sleep(chunk);
      remainingSleepMs -= chunk;
    }
    i++;
  }

  if (botState.start !== true) return;
  await waitForPendingWatchlistAuctions("Tentativi terminati.");

  await resolveWatchlist();
  sendMessageSafe({
    tipo: 'LOG',
    valore: `[TENTATIVI COMPLETATI] Tutte le aste sono concluse! Carte vinte in questa sessione: ${botState.carteAcquistate}`
  });
  await clearSoldItem();

  botState.crediti = await getCrediti();
  sendMessageSafe({ tipo: 'CREDITI', valore: botState.crediti });
  await sendCycleReport('bidding', {
    acquistate: botState.carteAcquistate,
    vendute: botState.carteVendute,
    crediti: botState.crediti,
    stato: 'OK (Aste completate)'
  });
}
