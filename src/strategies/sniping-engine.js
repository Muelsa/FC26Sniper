// Motori di Sniping Compra Ora (Manuale, Fodder e Consumabili)
import { botState, isTradeAttempted } from '../core/state.js';
import { sendMessageSafe, triggerPinEvent, stopBot } from '../core/messenger.js';
import { handle401Error, handleSearchRateLimit } from '../ea/error-handlers.js';
import { TRANSFERMARKET_URL } from '../ea/endpoints.js';
import { sendBuyNowRequest, sendToTransferList, sellFodder, sellSingleItem, getCrediti } from '../ea/market-api.js';
import { clearSoldItem } from '../services/tradepile-service.js';
import { getFodderList, getNextFodder } from '../services/fodder-service.js';
import { discoverConsumableLowestBin } from '../services/pricing-service.js';
import { CHEM_STYLES } from '../ea/constants.js';
import { sleep, getRandomGaussian, roundDownToStep } from '../core/utils.js';

// Funzione per inviare una richiesta GET (ricerca manuale calciatori)
export async function sendResearchRequest() {
  try {
    if (!botState.searchUrl) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: '[ATTENZIONE] Nessun filtro acquisito! Vai nella Web App ed esegui una ricerca nel mercato per impostare il filtro desiderato.'
      });
      await sleep(4000);
      return;
    }
    if (!botState.xUtSid) {
      console.error("Sessione xUtSid non definita");
      return;
    }

    if (!botState.maxSnipePrice || botState.maxSnipePrice <= 0) {
      sendMessageSafe({ tipo: 'LOG', valore: '[SNIPING MANUALE] Imposta il "Prezzo Max Compra Ora" nella UI: senza tetto prezzo lo sniping manuale è disattivato per sicurezza.' });
      await sleep(5000);
      return;
    }

    // 1. Telemetria nativa PIN: inviata rigorosamente PRIMA della ricerca
    await triggerPinEvent("TRIGGER_PIN_SEARCH");

    // Cache buster sicuro: start SEMPRE 0, alterniamo micr solo tra 0 (non impostato) e 150
    let finalUrl = botState.searchUrl;
    try {
      const parsedUrl = new URL(botState.searchUrl);
      parsedUrl.searchParams.set("start", "0");
      parsedUrl.searchParams.set("num", "21");
      if (botState.maxSnipePrice > 0) {
        parsedUrl.searchParams.set("maxb", String(botState.maxSnipePrice));
      }
      if (Math.random() < 0.4) {
        parsedUrl.searchParams.delete("micr");
      } else {
        parsedUrl.searchParams.set("micr", "150");
      }
      botState.manualSearchAttempt++;
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
        "X-UT-SID": botState.xUtSid
      }
    });

    if (response.ok) {
      botState.consecutiveSearchErrors = 0;
      botState.consecutive401Errors = 0;
      const data = await response.json();
      if (data.auctionInfo && data.auctionInfo.length > 0) {
        botState.idCarteAcquistate = [];

        // Ordina per freschezza decrescente escludendo carte già tentate (carte fantasma)
        const auctions = [...data.auctionInfo]
          .filter(a => !isTradeAttempted(a.tradeId))
          .sort((a, b) => (b.expires || 0) - (a.expires || 0));

        // Acquisto immediato sulla carta più recente
        for (const auction of auctions) {
          if (botState.start !== true) break;
          // Guard prezzo: mai comprare oltre il prezzo massimo impostato dall'utente
          if (botState.maxSnipePrice > 0 && auction.buyNowPrice > botState.maxSnipePrice) {
            console.log(`[FC Sniper Manuale] Scartata carta a ${auction.buyNowPrice} cr (oltre il max ${botState.maxSnipePrice} cr)`);
            continue;
          }
          const bought = await sendBuyNowRequest(auction.tradeId, auction.buyNowPrice, auction.itemData?.id);
          if (bought) {
            break; // Stop immediato al primo acquisto per gestire l'oggetto
          }
        }

        if (botState.idCarteAcquistate.length > 0) {
          await sendToTransferList();
        }
      }
    } else {
      if (response.status === 401) {
        await handle401Error("Ricerca Sniping");
      } else if (response.status === 458) {
        console.warn("[FC Sniper Ricerca] CAPTCHA 458 rilevato!");
        sendMessageSafe({
          tipo: 'LOG',
          valore: '[ATTENZIONE - CAPTCHA RILEVATO] Verifica richiesta nella Web App. Bot arrestato.'
        });
        await stopBot("CAPTCHA 458 rilevato");
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

export async function runManualSnipingLoop() {
  sendMessageSafe({
    tipo: 'LOG',
    valore: `Avvio SNIPING Manuale (Tetto Max Compra Ora: ${botState.maxSnipePrice > 0 ? botState.maxSnipePrice + ' cr' : 'NON IMPOSTATO — inserisci Prezzo Max Compra Ora nella UI'})`
  });
  let i = 0;
  while (botState.start === true && i < botState.numeroTentativi) {
    await sendResearchRequest();
    if (botState.start !== true) break;

    sendMessageSafe({ tipo: 'TENTATIVI_RIMASTI', valore: botState.numeroTentativi - (i + 1) });

    let randomValue;
    if ((i + 1) % 25 === 0) {
      randomValue = getRandomGaussian(2.5, 0.3, 2.0, 3.2); // micro-pausa anti-limit ogni 25 tentativi
    } else {
      randomValue = getRandomGaussian(1.3, 0.25, 0.9, 1.9); // pacing sniping umanizzato (anti metronomo)
    }

    if (randomValue > 0) {
      await sleep(randomValue * 1000);
    }

    i++;
  }

  await clearSoldItem();
}

export async function sendFodderResearchRequest() {
  let i = 0;
  while (botState.start === true && i < botState.numeroTentativi) {
    // Ad inizio e ad ogni giro completo della lista, ricarica i prezzi dal server
    if (i === 0 || botState.indexFodder === 0 || botState.listaFodder.length === 0) {
      if (i > 0) {
        console.log('[FC Sniper] Giro fodder completato. Ricarico lista e prezzi aggiornati...');
      }
      botState.listaFodder = [];
      botState.indexFodder = 0;
      await getFodderList();
    }

    if (botState.listaFodder.length === 0) {
      console.log('[FC Sniper] Nessun fodder disponibile. Attendo 3s...');
      await sleep(3000);
      i++;
      continue;
    }

    const next = getNextFodder();

    let fodderDefId = next.pid;
    let fodderPrice = Math.floor((next.price * 0.9) / 100) * 100;

    const baseUrl = TRANSFERMARKET_URL;
    const url = new URL(baseUrl);
    url.searchParams.set("num", "21");
    url.searchParams.set("start", "0");
    url.searchParams.set("type", "player");
    url.searchParams.set("maxb", fodderPrice);
    url.searchParams.set("maskedDefId", fodderDefId);
    url.searchParams.delete("macr");

    if (Math.random() < 0.4) {
      url.searchParams.delete("micr");
    } else {
      url.searchParams.set("micr", "150");
    }

    const searchUrlCompleto = url.href;

    try {
      if (!searchUrlCompleto || !botState.xUtSid) {
        console.error("URL o Sessione non definiti");
        return;
      }

      await triggerPinEvent("TRIGGER_PIN_SEARCH");

      const response = await fetch(searchUrlCompleto, {
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
        if (data.auctionInfo && data.auctionInfo.length > 0) {
          botState.idCarteAcquistate = [];

          const auctions = [...data.auctionInfo]
            .filter(a => !isTradeAttempted(a.tradeId))
            .sort((a, b) => (b.expires || 0) - (a.expires || 0));

          let boughtPrice = 0;
          for (const auction of auctions) {
            if (botState.start !== true) break;
            const bought = await sendBuyNowRequest(auction.tradeId, auction.buyNowPrice, auction.itemData?.id);
            if (bought) {
              boughtPrice = auction.buyNowPrice;
              break;
            }
          }

          if (botState.idCarteAcquistate.length > 0) {
            await sendToTransferList();
            await sellFodder(next.price);
            const netProfit = Math.floor(next.price * 0.95) - boughtPrice;
            const profitText = boughtPrice > 0 ? ` (Acquisto: ${boughtPrice} cr | Vendita: ${next.price} cr | Profitto netto: +${netProfit} cr)` : ` (Vendita: ${next.price} cr)`;
            sendMessageSafe({ tipo: 'LOG', valore: `[FODDER SNIPED] Carta trasferita e messa in vendita a ${next.price} cr${profitText}` });
            botState.crediti = await getCrediti();
            sendMessageSafe({ tipo: 'CREDITI', valore: botState.crediti });
            await sleep(getRandomGaussian(1.5, 0.2, 1.2, 2.0) * 1000);
          }
        }
      } else {
        if (response.status === 401) {
          await handle401Error("Ricerca Fodder Sniping");
          break;
        } else if (response.status === 458) {
          console.warn("[FC Sniper Ricerca Fodder] CAPTCHA 458 rilevato!");
          sendMessageSafe({
            tipo: 'LOG',
            valore: '[ATTENZIONE - CAPTCHA RILEVATO] Verifica richiesta nella Web App. Bot arrestato.'
          });
          await stopBot("CAPTCHA 458 rilevato");
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

    if (botState.start !== true) break;

    sendMessageSafe({ tipo: 'TENTATIVI_RIMASTI', valore: botState.numeroTentativi - (i + 1) });
    if ((i + 1) % 25 === 0) {
      await clearSoldItem();
    }

    let randomValue;
    if ((i + 1) % 25 === 0) {
      randomValue = getRandomGaussian(2.5, 0.3, 2.0, 3.2);
    } else {
      randomValue = getRandomGaussian(1.3, 0.25, 0.9, 1.9);
    }

    await sleep(randomValue * 1000);
    i++;
  }

  await clearSoldItem();
}

// Motore di SNIPING Consumabili (Stili Intesa)
export async function sendConsumableResearchRequest() {
  let i = 0;
  const targetStyles = (botState.chemStyle === "all") ? ["268", "266", "265", "260"] : [botState.chemStyle];
  let styleIndex = 0;

  const styleConfig = {};
  for (const sId of targetStyles) {
    const meta = CHEM_STYLES[sId] || { id: sId, name: `Stile ${sId}`, defaultGuess: 3000 };
    const mPrice = await discoverConsumableLowestBin(sId, botState.manualBin, true);
    let sPrice;
    if (botState.maxSnipePrice && botState.maxSnipePrice > 0) {
      sPrice = botState.maxSnipePrice;
    } else {
      sPrice = roundDownToStep(mPrice * 0.82);
    }
    styleConfig[sId] = { meta, marketPrice: mPrice, snipePrice: sPrice };
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[SNIPING TARGET] ${meta.name} -> Mercato: ${mPrice} cr | Compra Ora Snipe: <= ${sPrice} cr`
    });
  }

  while (botState.start === true && i < botState.numeroTentativi) {
    const currentStyleId = targetStyles[styleIndex];
    styleIndex = (styleIndex + 1) % targetStyles.length;
    const target = styleConfig[currentStyleId];

    if (!target) {
      i++;
      continue;
    }

    if (i % 15 === 0) {
      console.log(`[FC Sniper Sniping] Tentativo ${i + 1}/${botState.numeroTentativi}: cerca ${target.meta.name} a Compra Ora <= ${target.snipePrice}`);
    }

    const baseUrl = TRANSFERMARKET_URL;
    const url = new URL(baseUrl);
    url.searchParams.set("num", "21");
    url.searchParams.set("start", "0");
    url.searchParams.set("type", "training");
    url.searchParams.set("cat", "playStyle");
    url.searchParams.set("playStyle", String(currentStyleId));
    url.searchParams.set("maxb", String(target.snipePrice));
    url.searchParams.delete("macr");

    if (Math.random() < 0.4) {
      url.searchParams.delete("micr");
    } else {
      url.searchParams.set("micr", "150");
    }

    await triggerPinEvent("TRIGGER_PIN_SEARCH");

    try {
      const response = await fetch(url.href, {
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
        const auctions = data.auctionInfo || [];

        if (auctions.length > 0) {
          const matching = auctions.filter(a => a.buyNowPrice > 0 && a.buyNowPrice <= target.snipePrice && !isTradeAttempted(a.tradeId));

          if (matching.length > 0) {
            matching.sort((a, b) => (b.expires || 0) - (a.expires || 0));
            const targetAuction = matching[0];

            botState.idCarteAcquistate = [];
            const bought = await sendBuyNowRequest(targetAuction.tradeId, targetAuction.buyNowPrice, targetAuction.itemData?.id);
            if (bought) {
              await sendToTransferList();
              const listed = await sellSingleItem(targetAuction.itemData?.id, target.marketPrice);
              const buyPrice = targetAuction.buyNowPrice;
              const sellPrice = target.marketPrice;
              const netProfit = Math.floor(sellPrice * 0.95) - buyPrice;
              if (listed) {
                sendMessageSafe({
                  tipo: 'LOG',
                  valore: `[CONSUMABILE ACQUISTATO] ${target.name} acquistato a ${buyPrice} cr e messo in vendita a ${sellPrice} cr (Profitto netto stimato: +${netProfit} cr)`
                });
              } else {
                sendMessageSafe({
                  tipo: 'LOG',
                  valore: `[CONSUMABILE ACQUISTATO] ${target.name} acquistato a ${buyPrice} cr. Spostato in lista trasferimenti (Prezzo target: ${sellPrice} cr, Profitto netto: +${netProfit} cr)`
                });
              }
              botState.crediti = await getCrediti();
              sendMessageSafe({ tipo: 'CREDITI', valore: botState.crediti });
              await sleep(getRandomGaussian(1.5, 0.2, 1.2, 2.0) * 1000);
            }
          }
        }
      } else if (response.status === 401) {
        await handle401Error("Ricerca Sniping Consumabili");
        break;
      } else if (response.status === 458) {
        console.warn("[FC Sniper Sniping Consumabili] CAPTCHA 458 rilevato!");
        sendMessageSafe({
          tipo: 'LOG',
          valore: '[ATTENZIONE - CAPTCHA RILEVATO] Verifica richiesta nella Web App. Bot arrestato.'
        });
        await stopBot("CAPTCHA 458 rilevato");
        break;
      } else if (response.status === 429 || response.status === 426 || response.status === 521 || response.status === 512) {
        await handleSearchRateLimit(response.status, "Sniping Consumabili");
      } else {
        console.warn(`[FC Sniper Sniping Consumabili] Errore HTTP ${response.status}: ${response.statusText}`);
      }
    } catch (error) {
      console.error("Errore ricerca sniping consumabili:", error);
    }

    if (botState.start !== true) break;

    sendMessageSafe({ tipo: 'TENTATIVI_RIMASTI', valore: botState.numeroTentativi - (i + 1) });

    if ((i + 1) % 25 === 0) {
      await clearSoldItem();
    }

    let randomValue;
    if ((i + 1) % 25 === 0) {
      randomValue = getRandomGaussian(2.5, 0.3, 2.0, 3.2);
    } else {
      randomValue = getRandomGaussian(1.3, 0.25, 0.9, 1.9);
    }
    await sleep(randomValue * 1000);
    i++;
  }
  await clearSoldItem();
}
