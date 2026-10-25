// Entrypoint Background Service Worker — FC Sniper Orchestrator
import { installGlobalRateLimiter } from './src/core/rate-limiter.js';
import { botState, restoreInitialStateFromStorage } from './src/core/state.js';
import {
  sendMessageSafe,
  triggerPinEvent,
  reinjectContentScriptIntoEaTabs,
  ensureOffscreenDocument,
  stopOffscreenDocument,
  stopBot
} from './src/core/messenger.js';
import { registerWebRequestListeners } from './src/ea/web-request-listeners.js';
import { setPostPauseMaintenance } from './src/ea/error-handlers.js';
import { getCrediti } from './src/ea/market-api.js';
import {
  getNumeroTentativi,
  getFodderRating,
  getStrategyMode,
  getMinMargin,
  getTargetMode,
  getChemStyle,
  getAutoBin,
  getManualBin,
  getMaxSnipePrice,
  getTargetTradepileSize,
  getLazyMarkupPercent,
  getLazySleepMinutes,
  getManagerNation,
  cleanExpiredPendingBids,
  getUserProfile,
  getTradepileStatus
} from './src/core/storage.js';
import { reportTelemetry } from './src/core/telemetry.js';
import { sendTelegramMessage, sendCycleReport } from './src/services/telegram-service.js';
import {
  clearSoldItem,
  getTradepileInfo,
  processUnassignedItems,
  listUnlistedTradepileItems
} from './src/services/tradepile-service.js';
import { reconcileWatchlistOnStartup, resolveWatchlist } from './src/services/watchlist-service.js';
import {
  runManualSnipingLoop,
  sendFodderResearchRequest,
  sendConsumableResearchRequest
} from './src/strategies/sniping-engine.js';
import { runManualBiddingLoop, runMassBiddingEngine } from './src/strategies/bidding-engine.js';
import { runLazyTradingEngine } from './src/strategies/lazy-engine.js';
import { CHEM_STYLES, TOP_MANAGER_NATIONS, NATION_NAMES } from './src/ea/constants.js';
import { sleep } from './src/core/utils.js';
import { checkForGithubRelease } from './src/services/updater-service.js';

// 1. Inizializzazione rate-limiter, stato e pulizia storage
installGlobalRateLimiter();
restoreInitialStateFromStorage();
cleanExpiredPendingBids();

// Controllo periodico release GitHub ogni 3 ore (180 minuti)
try {
  chrome.alarms?.create("CHECK_UPDATE_ALARM", { periodInMinutes: 180 });
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm?.name === "CHECK_UPDATE_ALARM") {
      checkForGithubRelease().then((info) => {
        if (info && info.updateAvailable) {
          sendMessageSafe({ tipo: 'UPDATE_AVAILABLE', info });
        }
      }).catch(() => {});
    }
  });
  // Controllo iniziale all'avvio del Service Worker
  checkForGithubRelease().then((info) => {
    if (info && info.updateAvailable) {
      sendMessageSafe({ tipo: 'UPDATE_AVAILABLE', info });
    }
  }).catch(() => {});
} catch (_) {}

// 2. Registrazione listener di rete e manutenzione differita
registerWebRequestListeners();

setPostPauseMaintenance(async () => {
  await triggerPinEvent("TRIGGER_PIN_WATCHLIST");
  await clearSoldItem();
  await resolveWatchlist();
  const currentCrediti = await getCrediti();
  if (typeof currentCrediti === 'number') {
    botState.crediti = currentCrediti;
    sendMessageSafe({ tipo: 'CREDITI', valore: botState.crediti });
  }
});

// 3. Listener per azione estensione (apre la dashboard in una nuova scheda)
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});

// 3b. Riapertura automatica e invisibile della Dashboard post-aggiornamento
let isReopeningPostUpdate = false;
function checkPendingPostUpdateReopen() {
  if (isReopeningPostUpdate) return;
  chrome.storage?.local.get(['pendingPostUpdateReopen', 'pendingAutoStartAfterUpdate'], (res) => {
    const shouldReopen = res?.pendingPostUpdateReopen || res?.pendingAutoStartAfterUpdate;
    if (shouldReopen && !isReopeningPostUpdate) {
      isReopeningPostUpdate = true;
      const targetUrl = chrome.runtime.getURL("index.html");
      chrome.tabs.query({}, (tabs) => {
        const extId = chrome.runtime.id;
        const existingTab = tabs?.find(t => t.url && t.url.includes(extId) && t.url.includes('index.html'));
        if (existingTab && existingTab.id) {
          chrome.tabs.update(existingTab.id, { active: true });
          setTimeout(() => { isReopeningPostUpdate = false; }, 2000);
        } else {
          chrome.tabs.create({ url: targetUrl, active: true }, () => {
            setTimeout(() => { isReopeningPostUpdate = false; }, 2000);
          });
        }
      });
    }
  });
}

// Controllo sia all'avvio del Service Worker sia all'evento onInstalled
checkPendingPostUpdateReopen();
reinjectContentScriptIntoEaTabs();
chrome.runtime.onInstalled?.addListener(() => {
  checkPendingPostUpdateReopen();
  reinjectContentScriptIntoEaTabs();
});

// 4. Keep-alive MV3: porta long-lived dal content script
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "KEEP_ALIVE_PORT") return;
  port.onMessage.addListener((msg) => {
    if (msg?.type === "KEEP_ALIVE_PING") {
      // Ricezione del messaggio resetta il timer di idle del SW
    }
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
  });
});

function handleFodderModeMessage(message) {
  botState.ricercaFodder = Boolean(message.valore);
  if (message.targetMode) botState.targetMode = message.targetMode;
  else botState.targetMode = botState.ricercaFodder ? "fodder" : "consumables";
  botState.ricercaFodder = (botState.targetMode === "fodder");
  if (botState.targetMode !== "fodder") {
    botState.listaFodder = [];
    botState.indexFodder = 0;
  }
  if (message.chemStyle) botState.chemStyle = message.chemStyle;
  if (message.managerNation) botState.managerNation = message.managerNation;
  if (message.autoBin !== undefined) botState.autoBin = message.autoBin;
  if (message.manualBin !== undefined) botState.manualBin = message.manualBin;
  if (message.rating) botState.fodderRating = message.rating;
  if (message.strategyMode) botState.strategyMode = message.strategyMode;
  if (message.minMargin) botState.minMargin = message.minMargin;
}

// 5. Router messaggi runtime IPC
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.tipo === 'TOKEN_SYNC' && message.valore) {
    if (botState.xUtSid !== message.valore) {
      console.log("[FC Sniper] x-ut-sid sincronizzato via DOM bridge:", message.valore.substring(0, 10) + "...");
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[TOKEN SYNC] Nuovo token EA catturato dalla Web App: ${message.valore.substring(0, 10)}...`
      });
    }
    botState.xUtSid = message.valore;
    chrome.storage.local.set({ xUtSid: message.valore });
    botState.consecutive401Errors = 0;
    sendResponse?.({ ok: true });
    return false;
  }

  if (message.tipo === 'FODDER_MODE') {
    handleFodderModeMessage(message);
    sendResponse?.({ ok: true });
    return false;
  }

  if (message.tipo === 'START') {
    sendResponse?.({ ok: true });
    handleStartMessage(message).catch((err) => {
      console.error("[FC Sniper] Errore nel ciclo principale:", err);
    });
    return false;
  }

  if (message.tipo === 'USER_SYNC') {
    const { personaName, clubName } = message;
    if (personaName || clubName) {
      console.log(`[FC Sniper User] Sincronizzato profilo EA via pin-bridge: ${personaName} (${clubName})`);
      chrome.storage.local.set({ personaName: personaName || "", clubName: clubName || "" });
      sendMessageSafe({ tipo: 'USER_SYNC', personaName });
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[PROFILO EA] Sincronizzato account Web App: ${personaName}`
      });
    }
    sendResponse?.({ ok: true });
    return false;
  }

  if (message.tipo === 'PIN_BRIDGE_ACK') {
    const now = Date.now();
    if (message.status === 'ok' && Array.isArray(message.events) && message.events.length > 0) {
      botState.lastPinAckAt = now;
      const evCount = message.events.length;
      const types = message.events.join(", ");
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[PIN TELEMETRY] Inviati a EA ${evCount} eventi (${types}) | stepCounter: ${message.stepCounter || 'OK'}`
      });
    } else if (message.status === 'no_pin_service') {
      if (!botState.lastNoPinServiceWarn || now - botState.lastNoPinServiceWarn > 45000) {
        botState.lastNoPinServiceWarn = now;
        sendMessageSafe({
          tipo: 'LOG',
          valore: '[ATTENZIONE TELEMETRIA] Scheda EA Web App trovata, ma il servizio PIN non è attivo (assicurati di aver effettuato il login completo nella Web App).'
        });
      }
    }
    sendResponse?.({ ok: true });
    return false;
  }

  if (message.tipo === 'TELEGRAM_TEST') {
    (async () => {
      let { personaName } = await getUserProfile();
      if (!personaName) {
        triggerPinEvent("REQUEST_USER_INFO").catch(() => {});
      }

      let testText = "✅ <b>FC Sniper Bot</b>: Test di connessione riuscito!\n";
      if (personaName) {
        testText += `👤 Account: <b>${personaName}</b>\n`;
      }

      try {
        const { tradepileCount, tradepileActive } = await getTradepileStatus();
        const display = (tradepileCount && tradepileCount !== '-') ? tradepileCount : tradepileActive;
        if (display !== null && display !== undefined) {
          testText += `📦 In vendita: <b>${display}</b>\n`;
        }
      } catch (_) {}

      testText += "Le notifiche Telegram sono configurate correttamente.";
      const res = await sendTelegramMessage(testText, message.chatId);
      if (res && res.success) {
        sendMessageSafe({
          tipo: 'LOG',
          valore: '[TELEGRAM] Messaggio di test inviato con successo alla chat!'
        });
      } else {
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[TELEGRAM ERRORE] Test fallito: ${res?.error || 'Verifica il Chat ID o avvia il bot su Telegram'}`
        });
      }
      return res;
    })().then((result) => {
      sendResponse?.(result);
    }).catch((err) => {
      sendResponse?.({ success: false, error: err?.message || String(err) });
    });
    return true;
  }

  return false;
});

// 6. Orchestratore di Avvio Strategie
async function handleStartMessage(message) {
  if (message.valore === true && botState.start === true) {
    sendMessageSafe({ tipo: 'LOG', valore: '[FC Sniper] Bot già avviato: richiesta START ignorata.' });
    return;
  }
  botState.start = message.valore;

  if (botState.start === true) {
    reinjectContentScriptIntoEaTabs();
    if (!botState.xUtSid) {
      botState.xUtSid = await new Promise((resolve) => {
        chrome.storage.local.get(['xUtSid'], (res) => resolve(res.xUtSid || ""));
      });
    }

    if (!botState.xUtSid) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: '[ATTENZIONE] Sessione Web App non ancora sincronizzata. Clicca su qualsiasi menu nella Web App di EA (es. Trasferimenti o Club) per sincronizzare il token e poi premi Start.'
      });
      await stopBot("Token EA mancante");
      return;
    }

    await ensureOffscreenDocument();

    botState.numeroTentativi = await getNumeroTentativi();
    botState.targetMode = message.targetMode || await getTargetMode();
    botState.chemStyle = message.chemStyle || await getChemStyle();
    botState.autoBin = message.autoBin !== undefined ? message.autoBin : await getAutoBin();
    botState.manualBin = message.manualBin !== undefined ? message.manualBin : await getManualBin();
    botState.fodderRating = message.rating || await getFodderRating();
    botState.strategyMode = message.strategyMode || await getStrategyMode();
    botState.minMargin = message.minMargin || await getMinMargin();
    botState.maxSnipePrice = message.maxSnipePrice !== undefined ? message.maxSnipePrice : await getMaxSnipePrice();
    botState.targetTradepileSize = message.targetTradepileSize || await getTargetTradepileSize();
    botState.lazyMarkupPercent = message.lazyMarkupPercent || await getLazyMarkupPercent();
    botState.lazySleepMinutes = message.lazySleepMinutes || await getLazySleepMinutes();
    botState.managerNation = message.managerNation || await getManagerNation();
    botState.carteAcquistate = 0;
    botState.carteVendute = 0;
    sendMessageSafe({ tipo: 'CARTA_ACQUISTATA', valore: 0 });
    sendMessageSafe({ tipo: 'CARTA_VENDUTA', valore: 0 });
    try { chrome.storage.local.set({ carteAcquistate: 0, carteVendute: 0 }); } catch (_) { }
    botState.carteVinteCiclo = 0;
    botState.consecutive401Errors = 0;
    botState.consecutiveBidErrors = 0;
    botState.consecutive470Errors = 0;
    botState.consecutiveSnipeErrors = 0;
    botState.consecutive512Errors = 0;
    botState.consecutiveSearchErrors = 0;
    botState.consecutive426Errors = 0;
    botState.listingRestrictedUntil = 0;
    botState.marketRestricted = false;
    reportTelemetry('START', 'Bot avviato', {
      strategyMode: botState.strategyMode,
      targetTradepileSize: botState.targetTradepileSize,
      chemStyle: botState.chemStyle,
      managerNation: botState.managerNation
    });

    sendMessageSafe({ tipo: 'CARTA_ACQUISTATA', valore: "" });
    botState.crediti = await getCrediti();
    sendMessageSafe({ tipo: 'CREDITI', valore: botState.crediti });
    await getTradepileInfo();

    botState.ricercaFodder = (botState.targetMode === "fodder");
    if (botState.targetMode !== "fodder") {
      botState.listaFodder = [];
      botState.indexFodder = 0;
    }

    if (botState.strategyMode === "lazy") {
      if (botState.targetMode === "fodder") {
        botState.ricercaFodder = true;
        sendMessageSafe({ tipo: 'LOG', valore: `Avvio LAZY TRADING Fodder (Rating ${botState.fodderRating}, Target: ${botState.targetTradepileSize}, Ricarico: +${botState.lazyMarkupPercent}%, Pausa: ${botState.lazySleepMinutes}m)` });
        await runLazyTradingEngine();
      } else if (botState.targetMode === "managerLeague") {
        botState.ricercaFodder = false;
        sendMessageSafe({ tipo: 'LOG', valore: `Avvio LAZY TRADING Campionati Allenatore (Premier League, LaLiga, Serie A, Bundesliga, Ligue 1 | Target: ${botState.targetTradepileSize}, Ricarico: +${botState.lazyMarkupPercent}%, Pausa: ${botState.lazySleepMinutes}m)` });
        await runLazyTradingEngine();
      } else if (botState.targetMode === "managers") {
        botState.ricercaFodder = false;
        const natLabel = botState.managerNation === "18,34" ? "Francia + Olanda" : (TOP_MANAGER_NATIONS[botState.managerNation]?.name || NATION_NAMES[botState.managerNation] || `Naz ${botState.managerNation}`);
        sendMessageSafe({ tipo: 'LOG', valore: `Avvio TRADING ALLENATORI (${natLabel} | Acquisto max -15%, Vendita istantanea Lowest BIN | Target Tradepile: ${botState.targetTradepileSize}, Pausa: ${botState.lazySleepMinutes}m)` });
        await runLazyTradingEngine();
      } else {
        botState.targetMode = "consumables";
        botState.ricercaFodder = false;
        const styleName = botState.chemStyle === "all" ? "Rotazione (Ombra, Cacciatore, Ancora, Motore)" : (CHEM_STYLES[botState.chemStyle]?.name || `Stile ${botState.chemStyle}`);
        sendMessageSafe({ tipo: 'LOG', valore: `Avvio LAZY TRADING Consumabili (${styleName}, Target: ${botState.targetTradepileSize}, Ricarico: +${botState.lazyMarkupPercent}%, Pausa: ${botState.lazySleepMinutes}m)` });
        await runLazyTradingEngine();
      }
    } else {
      if (botState.targetMode === "managerLeague" || botState.targetMode === "managers") {
        const modeName = botState.targetMode === "managers" ? "La sezione Allenatori è supportata" : "I Campionati Allenatore sono supportati";
        sendMessageSafe({ tipo: 'LOG', valore: `[ATTENZIONE] ${modeName} solo in modalità Lazy. Seleziona strategia "Lazy" e riavvia.` });
        await stopBot(`${botState.targetMode} richiede strategia Lazy`);
        return;
      }

      await processUnassignedItems();
      await clearSoldItem();
      await listUnlistedTradepileItems();

      if (botState.strategyMode === "bidding") {
        await reconcileWatchlistOnStartup();
        botState.crediti = await getCrediti();
        sendMessageSafe({ tipo: 'CREDITI', valore: botState.crediti });
      }

      if (botState.targetMode === "consumables") {
        const styleName = botState.chemStyle === "all" ? "Rotazione (Ombra, Cacciatore, Ancora, Motore)" : (CHEM_STYLES[botState.chemStyle]?.name || `Stile ${botState.chemStyle}`);
        if (botState.strategyMode === "bidding") {
          sendMessageSafe({ tipo: 'LOG', valore: `Avvio MASS BIDDING Consumabili (${styleName}, Margine min ${botState.minMargin})` });
          await runMassBiddingEngine();
        } else {
          sendMessageSafe({ tipo: 'LOG', valore: `Avvio SNIPING Consumabili (${styleName})` });
          await sendConsumableResearchRequest();
        }
      } else if (botState.targetMode === "fodder") {
        if (botState.strategyMode === "bidding") {
          sendMessageSafe({ tipo: 'LOG', valore: `Avvio MASS BIDDING Fodder (Rating ${botState.fodderRating}, Margine min ${botState.minMargin})` });
          await runMassBiddingEngine();
        } else {
          sendMessageSafe({ tipo: 'LOG', valore: `Avvio SNIPING Fodder (Rating ${botState.fodderRating})` });
          await sendFodderResearchRequest();
        }
      } else {
        const isManualBidding = botState.strategyMode === "bidding";
        if (isManualBidding) {
          await runManualBiddingLoop();
        } else {
          await runManualSnipingLoop();
        }
      }

      sendMessageSafe({ tipo: 'LOG', valore: 'Ricerca terminata\n' });
      sendMessageSafe({ tipo: 'TENTATIVI_RIMASTI', valore: "" });

      await clearSoldItem();

      botState.crediti = await getCrediti();
      sendMessageSafe({ tipo: 'CREDITI', valore: botState.crediti });

      await sendCycleReport(botState.strategyMode === "bidding" ? "bidding" : "sniping", {
        acquistate: botState.carteAcquistate,
        vendute: botState.carteVendute,
        crediti: botState.crediti,
        stato: "OK (Ricerche completate)"
      });

      await stopBot("Ciclo ricerche terminato");
    }
  } else {
    if (botState.strategyMode === "sniping" || botState.strategyMode === "bidding") {
      try {
        await sendCycleReport(botState.strategyMode, {
          acquistate: botState.carteAcquistate,
          vendute: botState.carteVendute,
          crediti: botState.crediti,
          stato: "Interrotto manualmente dall'utente"
        });
      } catch (_) {}
    }
    await clearSoldItem();
    await stopOffscreenDocument();
  }
}
