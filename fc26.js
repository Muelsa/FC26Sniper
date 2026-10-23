import { sleep, getRandomInRange, getRandomGaussian, getEaStep, calculateNextBid, roundDownToStep, roundUpToStep, calculateTargetMargin, parseFodderPrice } from './src/core/utils.js';
import { reportTelemetry } from './src/core/telemetry.js';
import {
  getNumeroTentativi, getFodderRating, getStrategyMode, getMinMargin, getTargetMode,
  getChemStyle, getAutoBin, getManualBin, getMaxSnipePrice, getTargetTradepileSize,
  getLazyMarkupPercent, getLazySleepMinutes, getManagerNation, getStoredPendingBids, cleanExpiredPendingBids,
  getUserProfile, getTradepileStatus
} from './src/core/storage.js';
import { WATCHLIST_URL, DELETE_SOLD_URL } from './src/ea/endpoints.js';
import { buildEaHeaders } from './src/ea/client.js';
import { isRateLimitStatus } from './src/ea/status-policy.js';
import { CHEM_STYLES, MANAGER_LEAGUES, leagueTargetKey, TOP_MANAGER_NATIONS, managerTargetKey } from './src/ea/constants.js';
import { fetchFodderList } from './src/services/fodder-service.js';
import { sendCycleReport, sendTelegramMessage } from './src/services/telegram-service.js';
import { getUrgentAuctionTimeRemaining } from './src/strategies/strategy-utils.js';
import { installGlobalRateLimiter } from './src/core/rate-limiter.js';

// Budget globale cross-endpoint su tutte le chiamate UTAS (anti soft-ban, Fase 3.4)
installGlobalRateLimiter();

// Invio messaggi broadcast sicuro: ignora "Could not establish connection. Receiving end does not exist"
// quando la dashboard/scheda ricevente è momentaneamente chiusa, senza mascherare altri errori.
function sendMessageSafe(message, callback) {
  try {
    const res = chrome.runtime.sendMessage(message, (...args) => {
      void chrome.runtime.lastError;
      if (typeof callback === "function") callback(...args);
    });
    if (res && typeof res.catch === "function") res.catch(() => { });
    return res;
  } catch (e) {
    // Nessun ricevitore presente
  }
}

let xUtSid = "";
let searchUrl = "";
let searchHeaders = {};
let fodderSid = "";
let manualSearchAttempt = 0;
let manualTotalBidsPlaced = 0;
let manualConsecutive461 = 0;
let manualBidPriceOffset = 0;

// Ripristino del token x-ut-sid e di searchUrl all'avvio del Service Worker
chrome.storage.local.get(['xUtSid', 'searchUrl'], (result) => {
  if (result.xUtSid) {
    xUtSid = result.xUtSid;
    console.log("[FC Sniper] x-ut-sid ripristinato dallo storage all'avvio:", xUtSid.substring(0, 10) + "...");
  }
  if (result.searchUrl && typeof result.searchUrl === 'string') {
    searchUrl = result.searchUrl;
    console.log("[FC Sniper] searchUrl ripristinato dallo storage all'avvio:", searchUrl);
  }
});

//variabili per sniping
let numeroTentativi;
let start = false;
let crediti = 0;
let carteAcquistate = 0;
let carteVendute = 0;
let carteVinteCiclo = 0;
let listaFodder = []
let ricercaFodder = false;
let targetMode = "fodder"; // "fodder" | "consumables" | "managerLeague" | "managers" | "manual"
let chemStyle = "all"; // Modified to "all" to accommodate multi-style portfolio
let managerNation = "18,34";

let autoBin = true;
let manualBin = 0;
let fodderRating = "84";
let indexFodder = 0;
let idCarteAcquistate = [];
let strategyMode = "sniping"; // "sniping" | "bidding" | "lazy"
let minMargin = 200;
let maxSnipePrice = 0;
let targetTradepileSize = 50;
let lazyMarkupPercent = 10;
let lazySleepMinutes = 63;
let activeBids = new Map(); // tradeId -> { pid, sellPrice, bidAmount, expiresAt }
let consecutiveBidErrors = 0;
let consecutive470Errors = 0;
let consecutiveSnipeErrors = 0;
let consecutive512Errors = 0;
let consecutiveSearchErrors = 0;
let consecutive401Errors = 0;
let consecutive461InBidding = 0;
let lastBidTimestamp = 0;
let lastBidErrorStatus = 0;
let lastBuyNowErrorStatus = 0;
let lastListingTimestamp = 0;
let marketRestricted = false;
let listingRestrictedUntil = 0; // Timestamp ms fino a cui il listing (POST /auctionhouse) è in pausa preventiva (426)

// Mappa per tenere traccia delle carte/aste già tentate (evita di ricomprare carte fantasma già perse o fallite)
const attemptedTradeIds = new Map(); // tradeId (string) -> timestamp (ms)
const ATTEMPTED_TTL_MS = 5 * 60 * 1000;
let attemptedPersistTimer = null;

// Ripristino al boot del SW (sopravvive al recycle MV3)
chrome.storage.local.get(['attemptedTradeIds'], (result) => {
  const entries = result.attemptedTradeIds;
  if (!Array.isArray(entries)) return;
  const now = Date.now();
  for (const [id, ts] of entries) {
    if (typeof ts === 'number' && now - ts < ATTEMPTED_TTL_MS) attemptedTradeIds.set(String(id), ts);
  }
});

function persistAttemptedTradeIds() {
  if (attemptedPersistTimer) return; // throttling: max 1 write schedulata alla volta
  attemptedPersistTimer = setTimeout(() => {
    attemptedPersistTimer = null;
    const now = Date.now();
    const entries = [];
    for (const [id, ts] of attemptedTradeIds.entries()) {
      if (now - ts < ATTEMPTED_TTL_MS) entries.push([id, ts]);
    }
    chrome.storage.local.set({ attemptedTradeIds: entries }, () => void chrome.runtime.lastError);
  }, 5000);
}

function isTradeAttempted(tradeId) {
  if (!tradeId) return false;
  const idStr = String(tradeId);
  const now = Date.now();
  if (attemptedTradeIds.has(idStr)) {
    const attemptedAt = attemptedTradeIds.get(idStr);
    // Scade dopo 5 minuti (durata ottimale per il refresh della cache del server EA)
    if (now - attemptedAt < ATTEMPTED_TTL_MS) {
      return true;
    } else {
      attemptedTradeIds.delete(idStr);
    }
  }
  return false;
}

function markTradeAttempted(tradeId) {
  if (!tradeId) return;
  attemptedTradeIds.set(String(tradeId), Date.now());
  // Pulizia automatica della mappa per record più vecchi del TTL
  if (attemptedTradeIds.size > 200) {
    const now = Date.now();
    for (const [id, ts] of attemptedTradeIds.entries()) {
      if (now - ts > ATTEMPTED_TTL_MS) {
        attemptedTradeIds.delete(id);
      }
    }
  }
  persistAttemptedTradeIds();
}

// Metadati Stili Intesa importati da src/ea/constants.js

const consumableBinCache = new Map(); // playStyleId -> { price, timestamp }

const NATION_NAMES = {
  1: "Danimarca", 10: "Brasile", 14: "Inghilterra", 18: "Francia",
  21: "Germania", 27: "Italia", 34: "Paesi Bassi", 36: "Irlanda del Nord",
  38: "Portogallo", 42: "Scozia", 45: "Spagna", 46: "Svezia",
  52: "Argentina", 54: "Belgio", 55: "Croazia", 57: "Polonia",
  59: "Svizzera", 60: "Turchia", 95: "USA", 136: "Uruguay",
  143: "Norvegia", 148: "Colombia"
};

// Formatta il nome visivo leggibile per qualsiasi tipologia di carta (Manager, Calciatore, Consumabile)
function formatItemDisplayName(itemOrAuction, fallbackTradeId = null) {
  if (!itemOrAuction) return fallbackTradeId ? `Trade ${fallbackTradeId}` : "Carta";
  const data = itemOrAuction.itemData || itemOrAuction;

  if (data.itemType === "manager") {
    const natStr = data.nation ? (NATION_NAMES[data.nation] || `Naz ${data.nation}`) : "";
    if (data.lastName) {
      return `Allenatore ${data.lastName}${natStr ? ' (' + natStr + ')' : ''}`;
    }
    if (natStr) {
      return `Allenatore (${natStr})`;
    }
    return data.rating ? `Allenatore (${data.rating})` : "Allenatore";
  }

  if (data.itemType === "player") {
    if (data.lastName) return `${data.lastName}${data.rating ? ' (' + data.rating + ')' : ''}`;
    if (data.name) return `${data.name}${data.rating ? ' (' + data.rating + ')' : ''}`;
    if (data.rating) return `Calciatore (${data.rating})`;
    return "Calciatore";
  }

  if (data.itemType === "training") {
    const lgId = detectManagerLeague(itemOrAuction);
    if (lgId && MANAGER_LEAGUES[lgId]) return `Modificatore ${MANAGER_LEAGUES[lgId].name}`;
    const cs = detectChemistryStyle(itemOrAuction);
    if (cs && CHEM_STYLES[cs]) return CHEM_STYLES[cs].name;
    return "Consumabile";
  }

  return fallbackTradeId ? `Trade ${fallbackTradeId}` : "Carta";
}

// Rileva in modo affidabile lo stile intesa da qualsiasi oggetto carta (item o auction)
function detectChemistryStyle(itemOrAuction, fallbackStyle = null) {
  if (!itemOrAuction) {
    if (fallbackStyle && CHEM_STYLES[String(fallbackStyle)]) return String(fallbackStyle);
    return null;
  }
  const data = itemOrAuction.itemData || itemOrAuction;

  // IMPORTANT: Se l'oggetto ha itemType diverso da "training", NON è uno stile intesa!
  if (data.itemType && data.itemType !== "training") {
    return null;
  }

  // 1. Controlla campi in cui l'API UTAS di EA memorizza lo stile intesa
  const candidateIds = [
    data.playStyle,
    data.playstyle,
    data.playStyleId,
    itemOrAuction.playStyle,
    itemOrAuction.playstyle
  ];

  if (data.cardsubtypeid !== undefined && data.cardsubtypeid !== null && data.cardsubtypeid !== 0) {
    candidateIds.push(data.cardsubtypeid);
  }
  if (data.cardSubtypeId !== undefined && data.cardSubtypeId !== null && data.cardSubtypeId !== 0) {
    candidateIds.push(data.cardSubtypeId);
  }

  for (const c of candidateIds) {
    if (c !== undefined && c !== null) {
      const s = String(c);
      if (CHEM_STYLES[s]) {
        return s;
      }
    }
  }

  // 2. Controlla activeBids usando il tradeId o id oggetto
  const idKey = String(itemOrAuction.tradeId || data.id || "");
  if (idKey && activeBids.has(idKey)) {
    const tracked = activeBids.get(idKey);
    if (tracked?.playStyleId && CHEM_STYLES[String(tracked.playStyleId)]) {
      return String(tracked.playStyleId);
    }
  }

  // 3. Fallback: solo se esplicitamente passato ed è valido
  if (fallbackStyle && CHEM_STYLES[String(fallbackStyle)]) {
    return String(fallbackStyle);
  }
  // Se siamo in modalità chem_styles ed è configurato uno stile specifico (non "all")
  if (targetMode === "chem_styles" && chemStyle && chemStyle !== "all" && CHEM_STYLES[String(chemStyle)]) {
    return String(chemStyle);
  }

  return null;
}

// Rileva se un item/auction è un Modificatore Campionato Allenatore tracciato (top 5 campionati)
function detectManagerLeague(itemOrAuction) {
  if (!itemOrAuction) return null;
  const data = itemOrAuction.itemData || itemOrAuction;
  // Solo carte di tipo training possono essere modificatori campionato
  if (data?.itemType && data.itemType !== "training") return null;
  const tracked = itemOrAuction.tradeId ? activeBids.get(String(itemOrAuction.tradeId)) : null;

  // Nei modificatori campionato EA memorizza l'ID della lega nel campo `amount` (mentre `leagueId` è 0)
  const candidateIds = [
    data?.amount,
    itemOrAuction?.amount,
    tracked?.amount
  ];

  for (const c of candidateIds) {
    if (c !== undefined && c !== null && c > 0) {
      const s = String(c);
      if (MANAGER_LEAGUES[s]) return s;
    }
  }

  return null;
}

// Rileva se un item/auction è un Allenatore (itemType === "manager")
function detectManager(itemOrAuction) {
  if (!itemOrAuction) return null;
  const data = itemOrAuction.itemData || itemOrAuction;
  if (data?.itemType && data.itemType !== "manager") return null;
  const tracked = itemOrAuction.tradeId ? activeBids.get(String(itemOrAuction.tradeId)) : null;

  const candidateNats = [
    data?.nation,
    itemOrAuction?.nation,
    tracked?.nation,
    tracked?.nat
  ];

  for (const n of candidateNats) {
    if (n !== undefined && n !== null && n > 0) {
      const s = String(n);
      if (TOP_MANAGER_NATIONS[s]) return s;
    }
  }
  if (data?.nation) return String(data.nation);
  return null;
}

// Chiave di pricing unificata: "manager_nat_X" per allenatori, "league_X" per modificatori campionato, altrimenti playStyleId
function detectConsumableKey(itemOrAuction, fallbackStyle = null) {
  const mgr = detectManager(itemOrAuction);
  if (mgr) return managerTargetKey(mgr);
  const lg = detectManagerLeague(itemOrAuction);
  if (lg) return leagueTargetKey(lg);
  const cs = detectChemistryStyle(itemOrAuction, fallbackStyle);
  return cs ? String(cs) : null;
}

// Nome leggibile per log: allenatore, campionato o stile intesa
function targetDisplayName(key) {
  if (String(key).startsWith("manager_nat_")) {
    const natId = String(key).slice("manager_nat_".length);
    return `Allenatore ${TOP_MANAGER_NATIONS[natId]?.name || NATION_NAMES[natId] || 'Naz ' + natId}`;
  }
  if (MANAGER_LEAGUES[String(key)]) return MANAGER_LEAGUES[String(key)].name;
  if (String(key).startsWith("league_")) {
    const lg = String(key).slice(7);
    return MANAGER_LEAGUES[lg]?.name || `Lega ${lg}`;
  }
  return CHEM_STYLES[String(key)]?.name || `Stile ${key}`;
}

// Restituisce un nome leggibile per qualsiasi item/auction (allenatore, stile, giocatore, ecc.)
function getItemDisplayName(itemOrAuction, tracked = null) {
  if (tracked?.name) return tracked.name;
  if (!itemOrAuction) return "Oggetto";
  const mgr = detectManager(itemOrAuction);
  if (mgr) {
    const natName = TOP_MANAGER_NATIONS[mgr]?.name || NATION_NAMES[mgr] || `Naz ${mgr}`;
    return `Allenatore ${natName}`;
  }
  const lg = detectManagerLeague(itemOrAuction);
  if (lg) {
    return `Modificatore ${MANAGER_LEAGUES[lg]?.name || lg}`;
  }
  const cs = detectChemistryStyle(itemOrAuction);
  if (cs && CHEM_STYLES[String(cs)]) {
    return CHEM_STYLES[String(cs)].name;
  }
  if (itemOrAuction.itemData?.name) return itemOrAuction.itemData.name;
  return itemOrAuction.tradeId ? `Trade ${itemOrAuction.tradeId}` : "Oggetto";
}

// Floor di mercato (lowest BIN) per qualsiasi item: allenatore (natId), modificatore campionato (leagueId) o stile intesa.
// Ritorna { floor, name, key }. Usa cache di ciclo (cachedPrices), poi cache 15min, poi discovery live.
async function resolveConsumableFloor(itemOrAuction, cachedPrices = {}, fallbackStyle = null) {
  const mgr = detectManager(itemOrAuction);
  if (mgr) {
    const key = managerTargetKey(mgr);
    let floor = cachedPrices?.[key]?.floorBin;
    if (!floor && consumableBinCache.has(key)) floor = consumableBinCache.get(key).price;
    if (!floor) floor = await discoverManagerLowestBin(mgr, manualBin);
    const natName = TOP_MANAGER_NATIONS[mgr]?.name || NATION_NAMES[mgr] || `Naz ${mgr}`;
    return { floor: floor || 0, name: `Allenatore ${natName}`, key };
  }
  const lg = detectManagerLeague(itemOrAuction);
  if (lg) {
    const key = leagueTargetKey(lg);
    let floor = cachedPrices?.[key]?.floorBin;
    if (!floor && consumableBinCache.has(key)) floor = consumableBinCache.get(key).price;
    if (!floor) floor = await discoverLeagueModifierLowestBin(lg, manualBin);
    return { floor: floor || 0, name: `Modificatore ${MANAGER_LEAGUES[lg].name}`, key };
  }
  const sId = detectChemistryStyle(itemOrAuction, fallbackStyle || (targetMode === "chem_styles" ? chemStyle : null));
  if (sId && CHEM_STYLES[String(sId)]) {
    let floor = cachedPrices?.[sId]?.floorBin;
    if (!floor && consumableBinCache.has(sId)) floor = consumableBinCache.get(sId).price;
    if (!floor) floor = await discoverConsumableLowestBin(sId, manualBin);
    return { floor: floor || 0, name: CHEM_STYLES[sId]?.name || `Stile ${sId}`, key: sId };
  }
  return { floor: 0, name: "Consumabile", key: null };
}


// SessionManager: le richieste concorrenti che ricevono 401 si accodano sulla STESSA
// promise di recovery invece di proseguire con token vecchio o avviare recovery parallele
let recovery401Promise = null;

// Gestione centralizzata errore 401 (Sessione scaduta / Unauthorized - con tentativo di recupero token)
async function handle401Error(context = "") {
  if (recovery401Promise) return recovery401Promise;
  recovery401Promise = doRecover401(context).finally(() => { recovery401Promise = null; });
  return recovery401Promise;
}

async function doRecover401(context = "") {
  const currentToken = xUtSid;
  const ctxStr = context ? ` (${context})` : "";
  console.warn(`[FC Sniper 401] Ricevuto errore 401 in ${ctxStr}. Tentativo di recupero token fresco dalla Web App...`);
  sendMessageSafe({
    tipo: 'LOG',
    valore: `[AVVISO 401${ctxStr}] Rilevato token non valido o scaduto. Richiedo sincronizzazione token fresco alla Web App...`
  });

  // 1. Chiede alla Web App aperta di estrarre e inviare il token aggiornato a caldo
  await triggerPinEvent("REQUEST_TOKEN_REFRESH");
  await sleep(2500);

  // Se è arrivato un nuovo token valido diverso da quello che ha fallito:
  if (xUtSid && xUtSid !== currentToken) {
    consecutive401Errors = 0;
    console.log("[FC Sniper 401] Nuovo token EA catturato con successo! Sessione ripristinata.");
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[RECUPERO 401 RIUSCITO] Nuovo token EA sincronizzato (${xUtSid.substring(0, 10)}...). Operazioni ripristinate senza interruzione!`
    });
    return true;
  }

  // 2. Se a caldo non si rinnova (sessione JWT Web App scaduta oltre 2.5-3 ore),
  // tentiamo il reload automatico della scheda Web App: grazie ai cookie di sessione EA (SSO/remid),
  // la Web App si riavvia autenticata e genera immediatamente un nuovo X-UT-SID valido!
  try {
    const tabs = await chrome.tabs.query({});
    // Reload limitato alla sola Web App (non tutte le tab ea.com)
    const eaTabs = (tabs || []).filter(t => t.url && t.url.includes("ea-sports-fc/ultimate-team/web-app"));
    if (eaTabs.length > 0) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[AVVISO 401] Token non rinnovabile a caldo. Ricarico la scheda Web App per rigenerare la sessione via SSO EA...`
      });
      for (const tab of eaTabs) {
        chrome.tabs.reload(tab.id);
      }
      // Attesa fino a 35 secondi per l'avvio della Web App e l'intercettazione del nuovo token (polling con jitter)
      for (let i = 0; i < 35; i++) {
        await sleep(getRandomGaussian(1.0, 0.15, 0.8, 1.3) * 1000);
        if (xUtSid && xUtSid !== currentToken) {
          consecutive401Errors = 0;
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[RECUPERO 401 RIUSCITO] Web App ricaricata e nuova sessione catturata (${xUtSid.substring(0, 10)}...). Bot ripristinato!`
          });
          return true;
        }
      }
    }
  } catch (reloadErr) {
    console.warn("[FC Sniper 401] Errore durante reload Web App:", reloadErr);
  }

  // Se il token è ancora lo stesso o la sessione EA è definitivamente chiusa:
  consecutive401Errors = 0;

  await stopBot(`Errore 401${ctxStr}`);

  console.error(`[FC Sniper ABORT 401] Errore 401 Unauthorized confermato${ctxStr}. Arresto del bot.`);
  reportTelemetry('ABORT_401', `Errore 401 Unauthorized${ctxStr}. Arresto immediato.`, { context });

  sendMessageSafe({
    tipo: 'LOG',
    valore: `[ABORT IMMEDIATO - ERRORE 401] Ricevuto errore 401 Unauthorized${ctxStr}. Sessione Web App scaduta o non valida: bot arrestato. Ricarica la Web App (F5) per rinnovare la sessione.`
  });
  return false;
}

// Gestione centralizzata Rate Limit Ricerche (429 Too Many Requests, 426 Upgrade Required, 521, 512)
async function handleSearchRateLimit(status, context = "Ricerca") {
  consecutiveSearchErrors++;
  console.warn(`[FC Sniper ${context}] Rate limit EA (${status}). Errori consecutivi: ${consecutiveSearchErrors}/3`);

  if (strategyMode === "lazy") {
    // In modalità Lazy, deleghiamo la gestione al ciclo principale per consentire il passaggio fluido a vendita e relist
    return;
  }

  // Implementazione migliorata con circuit breaker e backoff esponenziale
  if (consecutiveSearchErrors >= 3) {
    console.warn(`[FC Sniper] Rilevati ${consecutiveSearchErrors} errori consecutivi di Rate Limit (${status}) in ${context}. Avvio pausa di sicurezza attiva 10 min...`);
    consecutiveSearchErrors = 0;
    await executeSafetyPause(600, `Soft-Ban Ricerche EA (${status}) in ${context}`);
  } else {
    // Implementazione migliore con backoff esponenziale basato su errori consecutivi
    const baseDelay = 25 + (consecutiveSearchErrors * 5); // Delay crescente per ogni errore successivo
    const jitter = getRandomGaussian(0.8, 0.15, 0.6, 1.0);
    
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[RATE LIMIT EA ${status}] Rilevato in ${context} (${consecutiveSearchErrors}/3). Raffreddamento preventivo di ${Math.round(baseDelay * jitter)}s per proteggere l'account...`
    });
    await sleep(Math.max(2000, baseDelay * 1000 * jitter));
  }
}

// Gestione centralizzata CAPTCHA 458: stop immediato strategia + stato persistito + notifica UI
async function handleCaptchaDetected(context = "") {
  const ctxStr = context ? ` (${context})` : "";
  console.warn(`[FC Sniper] CAPTCHA 458 rilevato${ctxStr}!`);
  sendMessageSafe({
    tipo: 'LOG',
    valore: '[ATTENZIONE - CAPTCHA RILEVATO] Verifica richiesta nella Web App. Bot arrestato.'
  });
  await stopBot(`CAPTCHA 458 rilevato${ctxStr}`);
}

// Handler unico per errori HTTP delle ricerche di mercato: 401, 458, rate-limit (429/426/512/521), altri.
// Ritorna sempre true: il chiamante deve interrompere l'iterazione corrente.
async function handleSearchHttpError(response, context) {
  const status = response.status;
  if (status === 401) {
    await handle401Error(context);
  } else if (status === 458) {
    await handleCaptchaDetected(context);
  } else if (isRateLimitStatus(status)) {
    await handleSearchRateLimit(status, context);
  } else {
    console.warn(`[FC Sniper ${context}] Errore HTTP ${status}: ${response.statusText}`);
  }
  return true;
}


const watchListUrl = WATCHLIST_URL;
const deleteSoldUrl = DELETE_SOLD_URL;

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: "index.html" }); // Apre la GUI in una nuova scheda
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      // 1. FILTRO ANTI-AUTO-INTERCETTAZIONE:
      // Ignora rigorosamente richieste provenienti dal Service Worker di background (tabId === -1)
      // o iniziate dall'estensione stessa (initiator chrome-extension://)
      if (details.tabId === undefined || details.tabId < 0) return;
      if (details.initiator && details.initiator.startsWith("chrome-extension://")) return;
      if (details.initiator && !details.initiator.includes("ea.com")) return;

      // 2. Quando il bot è già in esecuzione, non sovrascrivere il filtro attivo con richieste di background
      if (start === true) return;

      if ((details.method === "GET" || details.method === "POST") && details.url.includes("transfermarket?")) {
        searchUrl = details.url;
        chrome.storage.local.set({ searchUrl: details.url });

        let filterDesc = "";
        try {
          const u = new URL(details.url);
          const type = u.searchParams.get("type");
          const cat = u.searchParams.get("cat");
          const nat = u.searchParams.get("nat");
          const playStyle = u.searchParams.get("playStyle");
          const maskedDefId = u.searchParams.get("maskedDefId");
          const macr = u.searchParams.get("macr");
          const maxb = u.searchParams.get("maxb");

          if (type === "staff" || cat === "manager") {
            const natName = nat ? (NATION_NAMES[nat] || `Naz ${nat}`) : "Tutti";
            filterDesc = `Allenatori (${natName})`;
          } else if (playStyle) {
            filterDesc = CHEM_STYLES[playStyle]?.name || `Stile ${playStyle}`;
          } else if (cat === "managerLeagueModifier") {
            const lg = u.searchParams.get("amount");
            filterDesc = `Modificatore ${MANAGER_LEAGUES[lg]?.name || 'Lega ' + lg}`;
          } else if (type === "player") {
            filterDesc = maskedDefId ? `Calciatore (ID ${maskedDefId})` : "Calciatori";
          } else {
            filterDesc = "Mercato Generico";
          }
          const cap = macr ? `Max Offerta: ${macr} cr` : (maxb ? `Max Compra Ora: ${maxb} cr` : null);
          if (cap) filterDesc += ` [${cap}]`;
        } catch (_) {}

        sendMessageSafe({
          tipo: 'LOG',
          valore: `[FILTRO ACQUISITO] Rilevato dalla Web App: ${filterDesc || 'Filtro impostato correttamente'}`
        });
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
          chrome.storage.local.set({ xUtSid: header.value });
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
  { urls: ["https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/*"] },
  ["requestHeaders"]
);

// Listener diagnostico per osservare la telemetria reale inviata dalla Web App di EA
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      if (details.url.includes("pinEvents") && details.requestBody?.raw) {
        const decoder = new TextDecoder("utf-8");
        const postedString = decoder.decode(details.requestBody.raw[0].bytes);
        const pinData = JSON.parse(postedString);
        console.log("[EA PIN Telemetry Intercettata]", pinData);
        const evCount = pinData.events?.length || 1;
        const types = (pinData.events || []).map(e => e.type || e.pgid || e.core?.en).filter(Boolean).slice(0, 3).join(", ");
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[PIN TELEMETRY] Inviati a EA ${evCount} eventi (${types || 'telemetria'}) | stepCounter: ${pinData.stepCounter || pinData.custom?.step || 'OK'}`
        });
      }
    } catch (err) {
      // Ignora errori di parsing su payload parziali
    }
  },
  { urls: ["*://*.data.ea.com/*", "*://pin-river.data.ea.com/*", "*://pin-river.ea.com/*", "https://pin-river.data.ea.com/*"] },
  ["requestBody"]
);

// Funzione helper per PIN Event: inoltra l'evento alla scheda attiva della Web App EA
// Restituisce una Promise protetta da timeout di sicurezza (max 500ms) per evitare blocchi infiniti
async function triggerPinEvent(type, payload = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    const safetyTimer = setTimeout(finish, 500);

    try {
      chrome.tabs.query({}, (tabs) => {
        const eaTabs = (tabs || []).filter(t => t.url && t.url.includes("ea.com"));
        if (chrome.runtime.lastError || !eaTabs || eaTabs.length === 0) {
          clearTimeout(safetyTimer);
          return finish();
        }
        let pending = eaTabs.length;
        const requestId = 'pin_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        for (const tab of eaTabs) {
          console.log(`[FC Sniper SW] Invio PIN ${type} a scheda ${tab.id}`);
          chrome.tabs.sendMessage(tab.id, {
            scope: "PIN_BRIDGE",
            requestId: requestId,
            type: type,
            payload: payload
          }, () => {
            const _ = chrome.runtime.lastError; // Consuma l'errore per prevenire Unchecked runtime.lastError
            pending--;
            if (pending <= 0) {
              clearTimeout(safetyTimer);
              finish();
            }
          });
        }
      });
    } catch (err) {
      clearTimeout(safetyTimer);
      finish();
    }
  });
}

async function ensureOffscreenDocument() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Keep service worker alive'
    });
    console.log('[FC Sniper] Offscreen document creato per Keep-Alive MV3.');
  } catch (e) {
    if (!e.message.includes('Only a single offscreen document may be created')) {
      console.warn('[FC Sniper] Errore creazione offscreen:', e);
    }
  }
}

async function stopOffscreenDocument() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
      console.log('[FC Sniper] Offscreen document chiuso (stop bot).');
    }
  } catch (e) {
    console.warn('[FC Sniper] Errore chiusura offscreen:', e);
  }
}

// Arresto centralizzato del bot: aggiorna stato, persiste, notifica la UI e ferma il keep-alive offscreen
async function stopBot(reason = "") {
  start = false;
  try { await chrome.storage.local.set({ start: false }); } catch (_) { }
  sendMessageSafe({ tipo: 'START', valore: false });
  await stopOffscreenDocument();
  if (reason) console.log(`[FC Sniper] Bot arrestato: ${reason}`);
}
async function executeSafetyPause(durationSeconds = 600, reason = "Soft-Ban EA") {
  const totalMinutes = Math.round(durationSeconds / 60);
  console.warn(`[FC Sniper] Avvio Pausa di Sicurezza: ${reason}. Durata: ${totalMinutes} minuti (${durationSeconds}s).`);

  sendMessageSafe({
    tipo: 'LOG',
    valore: `[PAUSA DI SICUREZZA] ${reason}. Pausa di ${totalMinutes} min per sbloccare l'account. Silenzio totale verso EA fino allo sblocco.`
  });

  // Silenzio reale: zero richieste UTAS durante il cooldown.
  // Qualsiasi traffico durante il ban resetta i timer di decay EA.
  let remaining = durationSeconds;

  while (remaining > 0 && start === true) {
    await sleep(1000);
    remaining--;

    // Keep-alive Chrome Service Worker ogni 15s per evitare standby
    if (remaining % 15 === 0) {
      try { await chrome.storage.local.get(['keepAliveCheck']); } catch (_) { }
    }

    // Countdown nei log ogni 60 secondi
    if (remaining > 0 && remaining % 60 === 0) {
      const minsLeft = Math.round(remaining / 60);
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[PAUSA DI SICUREZZA] Sblocco soft-ban in corso... Mancano ${minsLeft} min alla ripresa automatica.`
      });
    }
  }

  // Manutenzione differita: vendite/rilist/crediti SOLO dopo la scadenza del cooldown
  if (start === true) {
    try {
      await triggerPinEvent("TRIGGER_PIN_WATCHLIST");
      await clearSoldItem();
      await resolveWatchlist();
      const currentCrediti = await getCrediti();
      if (typeof currentCrediti === 'number') {
        crediti = currentCrediti;
        sendMessageSafe({ tipo: 'CREDITI', valore: crediti });
      }
    } catch (e) {
      console.warn("[Post-Pausa Maintenance Error]", e);
    }
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[PAUSA DI SICUREZZA TERMINATA] Account raffreddato con successo! Manutenzione eseguita, ripresa delle attività.`
    });
  }
}

function handleFodderModeMessage(message) {
  ricercaFodder = !!message.valore;
  if (message.targetMode) targetMode = message.targetMode;
  else targetMode = ricercaFodder ? "fodder" : "consumables";
  ricercaFodder = (targetMode === "fodder");
  if (targetMode !== "fodder") {
    listaFodder = [];
    indexFodder = 0;
  }
  if (message.chemStyle) chemStyle = message.chemStyle;
  if (message.managerNation) managerNation = message.managerNation;
  if (message.autoBin !== undefined) autoBin = message.autoBin;
  if (message.manualBin !== undefined) manualBin = message.manualBin;
  if (message.rating) fodderRating = message.rating;
  if (message.strategyMode) strategyMode = message.strategyMode;
  if (message.minMargin) minMargin = message.minMargin;
}

// Keep-alive MV3: la porta long-lived dal content script tiene sveglio il Service Worker.
// Il listener onConnect è necessario: senza di esso i ping cadono nel vuoto e il SW può essere reciclato.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "KEEP_ALIVE_PORT") return;
  port.onMessage.addListener((msg) => {
    if (msg?.type === "KEEP_ALIVE_PING") {
      // La sola ricezione del messaggio resetta il timer di idle del SW
    }
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError; // silenzia errori di disconnect attesi
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.tipo === 'TOKEN_SYNC' && message.valore) {
    if (xUtSid !== message.valore) {
      console.log("[FC Sniper] x-ut-sid sincronizzato via DOM bridge:", message.valore.substring(0, 10) + "...");
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[TOKEN SYNC] Nuovo token EA catturato dalla Web App: ${message.valore.substring(0, 10)}...`
      });
    }
    xUtSid = message.valore;
    chrome.storage.local.set({ xUtSid: message.valore });
    consecutive401Errors = 0;
    sendResponse?.({ ok: true });
    return false;
  }

  if (message.tipo === 'FODDER_MODE') {
    handleFodderModeMessage(message);
    sendResponse?.({ ok: true });
    return false;
  }

  if (message.tipo === 'START') {
    // Ack immediato per non bloccare la UI; il ciclo prosegue in async
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

  if (message.tipo === 'TELEGRAM_TEST') {
    (async () => {
      let { personaName } = await getUserProfile();

      // Se non ancora presente in storage, chiedi al bridge attivo di inviarlo subito
      if (!personaName) {
        await triggerPinEvent("REQUEST_USER_INFO");
        for (let i = 0; i < 10; i++) {
          await sleep(200);
          const refreshed = await getUserProfile();
          if (refreshed.personaName) {
            personaName = refreshed.personaName;
            break;
          }
        }
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

      testText += "Le notifiche di fine ciclo sono configurate correttamente.";

      return sendTelegramMessage(testText, message.chatId);
    })().then((result) => {
      sendResponse?.(result);
    }).catch((err) => {
      sendResponse?.({ success: false, error: err?.message || String(err) });
    });
    return true; // risposta asincrona
  }

  return false;
});

async function handleStartMessage(message) {
  // Lock anti doppio-start: ignora START se un engine è già attivo
  if (message.valore === true && start === true) {
    sendMessageSafe({ tipo: 'LOG', valore: '[FC Sniper] Bot già avviato: richiesta START ignorata.' });
    return;
  }
  start = message.valore;

  if (start == true) {
    if (!xUtSid) {
      xUtSid = await new Promise((resolve) => {
        chrome.storage.local.get(['xUtSid'], (res) => resolve(res.xUtSid || ""));
      });
    }

    if (!xUtSid) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: '[ATTENZIONE] Sessione Web App non ancora sincronizzata. Clicca su qualsiasi menu nella Web App di EA (es. Trasferimenti o Club) per sincronizzare il token e poi premi Start.'
      });
      await stopBot("Token EA mancante");
      return;
    }

    await ensureOffscreenDocument();

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
      targetTradepileSize = message.targetTradepileSize || await getTargetTradepileSize();
      lazyMarkupPercent = message.lazyMarkupPercent || await getLazyMarkupPercent();
      lazySleepMinutes = message.lazySleepMinutes || await getLazySleepMinutes();
      managerNation = message.managerNation || await getManagerNation();
      carteAcquistate = 0;
      carteVendute = 0;
      sendMessageSafe({ tipo: 'CARTA_ACQUISTATA', valore: 0 });
      sendMessageSafe({ tipo: 'CARTA_VENDUTA', valore: 0 });
      try { chrome.storage.local.set({ carteAcquistate: 0, carteVendute: 0 }); } catch (_) { }
      carteVinteCiclo = 0;
      consecutive401Errors = 0;
      consecutiveBidErrors = 0;
      consecutive470Errors = 0;
      consecutiveSnipeErrors = 0;
      consecutive512Errors = 0;
      consecutiveSearchErrors = 0;
      marketRestricted = false;
      reportTelemetry('START', 'Bot avviato', { strategyMode, targetTradepileSize, chemStyle, managerNation });

      sendMessageSafe({ tipo: 'CARTA_ACQUISTATA', valore: "" });
      crediti = await getCrediti();
      sendMessageSafe({ tipo: 'CREDITI', valore: crediti });
      await getTradepileInfo();

      // Sincronizzazione rigorosa stato modalità
      ricercaFodder = (targetMode === "fodder");
      if (targetMode !== "fodder") {
        listaFodder = [];
        indexFodder = 0;
      }

      // Se in modalità Lazy Trading, deleghiamo la pulizia, auto-discovery prezzi e relist direttamente alla Fase 1 del ciclo
      if (strategyMode === "lazy") {
        if (targetMode === "fodder") {
          ricercaFodder = true;
          sendMessageSafe({ tipo: 'LOG', valore: `Avvio LAZY TRADING Fodder (Rating ${fodderRating}, Target: ${targetTradepileSize}, Ricarico: +${lazyMarkupPercent}%, Pausa: ${lazySleepMinutes}m)` });
          await runLazyTradingEngine();
        } else if (targetMode === "managerLeague") {
          ricercaFodder = false;
          sendMessageSafe({ tipo: 'LOG', valore: `Avvio LAZY TRADING Campionati Allenatore (Premier League, LaLiga, Serie A, Bundesliga, Ligue 1 | Target: ${targetTradepileSize}, Ricarico: +${lazyMarkupPercent}%, Pausa: ${lazySleepMinutes}m)` });
          await runLazyTradingEngine();
        } else if (targetMode === "managers") {
          ricercaFodder = false;
          const natLabel = managerNation === "18,34" ? "Francia + Olanda" : (TOP_MANAGER_NATIONS[managerNation]?.name || NATION_NAMES[managerNation] || `Naz ${managerNation}`);
          sendMessageSafe({ tipo: 'LOG', valore: `Avvio TRADING ALLENATORI (${natLabel} | Acquisto max -15%, Vendita istantanea Lowest BIN | Target Tradepile: ${targetTradepileSize}, Pausa: ${lazySleepMinutes}m)` });
          await runLazyTradingEngine();
        } else {
          targetMode = "consumables";
          ricercaFodder = false;
          const styleName = chemStyle === "all" ? "Rotazione (Ombra, Cacciatore, Ancora, Motore)" : (CHEM_STYLES[chemStyle]?.name || `Stile ${chemStyle}`);
          sendMessageSafe({ tipo: 'LOG', valore: `Avvio LAZY TRADING Consumabili (${styleName}, Target: ${targetTradepileSize}, Ricarico: +${lazyMarkupPercent}%, Pausa: ${lazySleepMinutes}m)` });
          await runLazyTradingEngine();
        }
      } else {
        if (targetMode === "managerLeague" || targetMode === "managers") {
          const modeName = targetMode === "managers" ? "La sezione Allenatori è supportata" : "I Campionati Allenatore sono supportati";
          sendMessageSafe({ tipo: 'LOG', valore: `[ATTENZIONE] ${modeName} solo in modalità Lazy. Seleziona strategia "Lazy" e riavvia.` });
          await stopBot(`${targetMode} richiede strategia Lazy`);
          return;
        }
        // Per le altre modalità: all'avvio puliamo la lista trasferimenti da venduti e rimettiamo in vendita eventuali invendute
        await processUnassignedItems();
        await clearSoldItem();
        await listUnlistedTradepileItems();

        if (strategyMode === "bidding") {
          await reconcileWatchlistOnStartup();
          crediti = await getCrediti();
          sendMessageSafe({ tipo: 'CREDITI', valore: crediti });
        }

        if (targetMode === "consumables") {
          const styleName = chemStyle === "all" ? "Rotazione (Ombra, Cacciatore, Ancora, Motore)" : (CHEM_STYLES[chemStyle]?.name || `Stile ${chemStyle}`);
          if (strategyMode === "bidding") {
            sendMessageSafe({ tipo: 'LOG', valore: `Avvio MASS BIDDING Consumabili (${styleName}, Margine min ${minMargin})` });
            await runMassBiddingEngine();
          } else {
            sendMessageSafe({ tipo: 'LOG', valore: `Avvio SNIPING Consumabili (${styleName})` });
            await sendConsumableResearchRequest();
          }
        } else if (targetMode === "fodder") {
          if (strategyMode === "bidding") {
            sendMessageSafe({ tipo: 'LOG', valore: `Avvio MASS BIDDING Fodder (Rating ${fodderRating}, Margine min ${minMargin})` });
            await runMassBiddingEngine();
          } else {
            sendMessageSafe({ tipo: 'LOG', valore: `Avvio SNIPING Fodder (Rating ${fodderRating})` });
            await sendFodderResearchRequest();
          }
        } else {
          const isManualBidding = strategyMode === "bidding";
          if (isManualBidding) {
            manualTotalBidsPlaced = 0;
            manualConsecutive461 = 0;
            manualBidPriceOffset = 0;
            sendMessageSafe({ tipo: 'LOG', valore: `Avvio BIDDING Manuale (Tetto Max Offerta: ${maxSnipePrice > 0 ? maxSnipePrice + ' cr' : 'NON IMPOSTATO — inserisci Prezzo Max Offerta nella UI'})` });
          } else {
            sendMessageSafe({ tipo: 'LOG', valore: `Avvio SNIPING Manuale (Tetto Max Compra Ora: ${maxSnipePrice > 0 ? maxSnipePrice + ' cr' : 'NON IMPOSTATO — inserisci Prezzo Max Compra Ora nella UI'})` });
          }
          let i = 0;
          while (start == true && i < numeroTentativi) {
            let manualBidResult = null;
            if (isManualBidding) {
              // Se l'account ha subito restrizioni o troppi errori, attendiamo pausa di raffreddamento
              if (marketRestricted) {
                sendMessageSafe({
                  tipo: 'LOG',
                  valore: `[ANTI-BAN] Account momentaneamente limitato. Attendo pausa di raffreddamento di 30s...`
                });
                await sleep(30000);
                marketRestricted = false;
              }

              // Controllo prioritario aste urgenti (<= 45s): difende senza consumare tentativi di ricerca
              while (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 45000 && start === true) {
                await sleep(3000);
                await resolveWatchlist();
              }
              manualBidResult = await sendManualBiddingRequest();
              // Controllo periodico e controrilanci Watchlist ogni 5 ricerche
              if ((i + 1) % 5 === 0 && start === true) {
                await resolveWatchlist();
              }
            } else {
              await sendResearchRequest();
            }
            if (start !== true) break;

            //aggiorno contatore tentativi rimasti
            sendMessageSafe({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });

            let randomValue = 0;
            if (isManualBidding) {
              if (manualBidResult && manualBidResult.found === false) {
                // Se non c'erano aste entro 3 min, abbiamo già atteso ~30s prima della prossima ricerca
                randomValue = 0;
              } else {
                // Pacing identico a Lazy Bidding (3.6s - 4.5s tra ricerche, micro-pausa 5.0s - 7.5s ogni 6)
                if ((i + 1) % 6 === 0) randomValue = getRandomGaussian(6.0, 0.6, 5.0, 7.5);
                else randomValue = getRandomGaussian(3.6, 0.4, 3.0, 4.5);
              }
            } else {
              if ((i + 1) % 25 == 0) randomValue = getRandomGaussian(2.5, 0.3, 2.0, 3.2); // micro-pausa anti-limit ogni 25 tentativi
              else randomValue = getRandomGaussian(1.3, 0.25, 0.9, 1.9); // pacing sniping umanizzato (anti metronomo)
            }

            if (randomValue > 0) {
              await sleep(randomValue * 1000);
            }

            i++;
          }

          // A fine bidding: attendi e difendi tutte le aste ancora aperte nella watchlist prima di chiudere
          if (isManualBidding && start === true) {
            let activeRemaining = await resolveWatchlist();
            if ((activeRemaining > 0 || activeBids.size > 0) && start === true) {
              const initialCount = Math.max(activeRemaining, activeBids.size);
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[BIDDING MANUALE] Ricerche completate. In attesa della chiusura e difesa di ${initialCount} aste in corso...`
              });

              let loopIterations = 0;
              const MAX_SAFETY_TIMEOUT_SEC = 900; // 15 min max safety timeout anti-hang
              let elapsedSec = 0;

              while (start === true && elapsedSec < MAX_SAFETY_TIMEOUT_SEC) {
                const urgentMs = activeBids.size > 0 ? getUrgentAuctionTimeRemaining(activeBids) : 999999;
                // Se un'asta sta per scadere (<= 25s), polling più rapido (3s), altrimenti 5s
                const sleepMs = (urgentMs <= 25000 && urgentMs > 0) ? 3000 : 5000;

                await sleep(sleepMs);
                elapsedSec += Math.round(sleepMs / 1000);
                loopIterations++;

                activeRemaining = await resolveWatchlist();

                // Termina solo quando tutte le aste sono state gestite (vinte o abbandonate)
                if (activeRemaining === 0 && activeBids.size === 0) {
                  sendMessageSafe({
                    tipo: 'LOG',
                    valore: `[BIDDING MANUALE] Tutte le aste in corso sono state gestite e concluse con successo!`
                  });
                  break;
                }

                // Log periodico ogni ~30 secondi
                if (loopIterations % 6 === 0) {
                  const currentPending = Math.max(activeRemaining, activeBids.size);
                  const minSec = (urgentMs < 999999 && urgentMs > 0) ? Math.max(1, Math.round(urgentMs / 1000)) : null;
                  const secMsg = minSec ? ` (prossima scadenza: ~${minSec}s)` : '';
                  sendMessageSafe({
                    tipo: 'LOG',
                    valore: `[DIFESA ASTE] Monitoraggio e difesa di ${currentPending} aste pendenti${secMsg}...`
                  });
                }
              }
            }
          }

          //pulisco la lista trasferimenti dagli elementi venduti a fine ricerche
          await clearSoldItem();
        }
      }

      sendMessageSafe({ tipo: 'LOG', valore: 'Ricerca terminata\n' });
      sendMessageSafe({ tipo: 'TENTATIVI_RIMASTI', valore: "" });

      //pulisco la lista trasferimenti dagli elementi venduti
      await clearSoldItem()

      //recupero crediti residui
      crediti = await getCrediti()
      sendMessageSafe({ tipo: 'CREDITI', valore: crediti });

      // report Telegram di fine ciclo (acquistate / vendute / crediti)
      await sendCycleReport('sniping', {
        acquistate: carteAcquistate,
        vendute: carteVendute,
        crediti
      });

      //ho finito le ricerche, quindi termino ed invio messaggio di stop
      await stopBot("Ciclo ricerche terminato");
    } else {
      // Arresto manuale dal popup: pulizia venduti, relist automatico invenduti e stop keep-alive
      await clearSoldItem();
      await stopOffscreenDocument();
    }
}


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

// Pulizia automatica offerte pendenti all'avvio del background script
cleanExpiredPendingBids();


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
    const currentCredits = data?.credits ?? data?.credit ?? 0;
    if (typeof currentCredits === 'number') {
      crediti = currentCredits;
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

async function clearSoldItem(cachedPrices = {}) {
  if (!xUtSid) return;

  try {
    // 1. Recupera lo stato attuale della Tradepile
    const pileInfo = await getTradepileInfo();
    const auctions = pileInfo.auctions || [];

    // 2. Filtra solo le carte effettivamente vendute
    // In EA FUT: un oggetto è venduto quando l'asta è chiusa/scaduta e c'è un'offerta vincente (currentBid > 0)
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
        "x-ut-sid": xUtSid,
      });

      const response = await fetch(deleteSoldUrl, {
        method: "DELETE",
        headers: headers,
      });

      if (response.ok) {
        console.log(`[FC Sniper] Lista trasferimenti pulita con successo: rimosse ${soldItems.length} carte vendute.`);
        carteVendute += soldItems.length;
        sendMessageSafe({ tipo: 'CARTA_VENDUTA', valore: carteVendute });
        try { chrome.storage.local.set({ carteVendute }); } catch (_) { }
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[TRADEPILE] Incassate e rimosse ${soldItems.length} carte vendute dalla lista trasferimenti! (Totale sessione: ${carteVendute})`
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

    // 4. Controlla e rimette in vendita automaticamente eventuali carte scadute/invendute
    // riutilizzando l'elenco aste già ottenuto per non inviare una seconda richiesta GET tradepile ad EA
    await checkAndRelistExpiredItems(cachedPrices, auctions);

  } catch (error) {
    console.error('[ERROR clearing sold items]', error);
  }
}

// Recupera lo stato attuale della lista trasferimenti (Tradepile)
async function getTradepileInfo() {
  if (!xUtSid) return { total: 0, active: 0, auctions: [] };

  const tradepileUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/tradepile";
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
      if (res.status === 401) await handle401Error("Get Tradepile Info");
      return { total: 0, active: 0, auctions: [] };
    }
    consecutive401Errors = 0;
    const data = await res.json();
    const auctions = data.auctionInfo || [];
    const active = auctions.filter(a => a.tradeState === "active" || a.expires > 0).length;
    const tradepileDisplay = `${active} attive (${auctions.length} tot)`;
    sendMessageSafe({ tipo: 'TRADEPILE_COUNT', valore: tradepileDisplay, active, total: auctions.length });
    try {
      chrome.storage.local.set({ tradepileCount: tradepileDisplay, tradepileActive: active, tradepileTotal: auctions.length });
    } catch (_) { }

    try {
      if (typeof crediti === 'number' && crediti >= 0) {
        calculateAndPublishProiezioneCrediti(crediti, auctions);
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
async function calculateAndPublishProiezioneCrediti(currentCrediti = null, preloadedAuctions = null) {
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

// Controlla la lista trasferimenti per rilevare oggetti scaduti/invenduti e rimetterli in vendita
// RICALCOLA IL PREZZO per ciascuna carta rilevando lo stile intesa e applicando il Floor BIN live + 10%
async function checkAndRelistExpiredItems(cachedPrices = {}, preloadedAuctions = null) {
  if (!xUtSid) return;

  try {
    let auctions = preloadedAuctions;
    if (!Array.isArray(auctions)) {
      const tradepileUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/tradepile";
      const headers = new Headers({
        "accept": "*/*",
        "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "x-ut-sid": xUtSid
      });

      const res = await fetch(tradepileUrl, { method: "GET", headers });
      if (!res.ok) {
        if (res.status === 401) await handle401Error("Tradepile Check");
        return;
      }
      consecutive401Errors = 0;
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

    console.log(`[FC Sniper Tradepile] Rilevate ${expiredUnsold.length} carte scadute/invendute. Ricalcolo Lowest BIN live e relist...`);
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[Tradepile Relist] Rilevate ${expiredUnsold.length} carte invendute. Ricalcolo prezzi live (Lowest BIN + 10%)...`
    });

    if (Date.now() < listingRestrictedUntil) {
      const remainingMin = Math.ceil((listingRestrictedUntil - Date.now()) / 60000);
      console.log(`[FC Sniper Tradepile] Relist in cooldown (${remainingMin} min rimanenti). Salto.`);
      return;
    }

    let relistedCount = 0;
    for (const a of expiredUnsold) {
      if (start !== true || Date.now() < listingRestrictedUntil) break;
      const itemId = a.itemData?.id;
      if (!itemId) continue;

      let newSellPrice = 0;
      let cardName = "Carta";
      let tierTag = "";

      if (a.itemData?.itemType === "player") {
        // Calciatore / Fodder (calcola nuovo prezzo solo se attivi in modalità Fodder)
        if (targetMode === "fodder") {
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
        // Consumabile / Stile Intesa / Modificatore Campionato
        const { floor, name } = await resolveConsumableFloor(a, cachedPrices);
        cardName = name;

        if (floor && floor > 0) {
          const tiered = getTieredSellPrice(floor, null, true);
          newSellPrice = tiered.price;
          tierTag = ` [Tier ${tiered.tier}: +${tiered.markup}%]`;
        }
      } else if (a.itemData?.itemType === "manager") {
        // Allenatore: vendita istantanea al Lowest BIN live, senza maggiorazione di tier
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
      if (Date.now() < listingRestrictedUntil) break;
      if (success) {
        relistedCount++;
        const prevText = a.buyNowPrice ? ` (prec: ${a.buyNowPrice})` : '';
        // Se le carte da rimettere in vendita sono poche (<= 5), logga singolarmente.
        // Se sono molte (es. 26-66), logga un riassunto di avanzamento ogni 10 per non inondare la console.
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
        await sleep(getRandomGaussian(1.6, 0.15, 1.5, 2.0) * 1000);
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
// Sposta ogni carta nella lista trasferimenti e la mette in vendita con il prezzo Lazy aggiornato
async function processUnassignedItems(cachedPrices = {}) {
  if (!xUtSid) return { found: 0, moved: 0, listed: 0 };

  const unassignedUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/purchased/items";
  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": xUtSid
  });

  try {
    const res = await fetch(unassignedUrl, { method: "GET", headers });
    if (!res.ok) {
      if (res.status === 401) await handle401Error("Process Unassigned");
      return { found: 0, moved: 0, listed: 0 };
    }
    consecutive401Errors = 0;
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
      if (start !== true) break;
      const itemId = item.id;
      if (!itemId) continue;

      // 1. Sposta l'oggetto da Non Assegnati alla Tradepile
      const moved = await moveSingleItemToTrade(itemId);
      if (moved) {
        movedCount++;
        // Pausa di assestamento database EA (800ms - 1200ms)
        await sleep(getRandomGaussian(1.0, 0.2, 0.8, 1.4) * 1000);

        // 2. Determina il prezzo di vendita target
        let sellPrice = 0;
        let cardName = "Carta";
        let tierTag = "";

        if (item.itemType === "player") {
          if (targetMode === "fodder") {
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
// Eseguito sia ad inizio che a fine ciclo per garantire che nessuna carta rimanga invenduta o bloccata nella Tradepile
async function listUnlistedTradepileItems(cachedPrices = {}) {
  if (!xUtSid) return { found: 0, listed: 0 };

  const tradepileUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/tradepile";
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
      if (res.status === 401) await handle401Error("List Unlisted Tradepile");
      return { found: 0, listed: 0 };
    }
    consecutive401Errors = 0;
    const data = await res.json();
    const auctions = data.auctionInfo || [];

    // Filtra gli oggetti nella Tradepile che NON hanno un'asta attiva sul mercato
    // Un oggetto non listato ha: itemData valido, ma tradeState nullo o non "active", ed expires <= 0
    const unlisted = auctions.filter(a =>
      a.itemData?.id &&
      a.tradeState !== "active" &&
      (a.expires <= 0 || !a.buyNowPrice || a.buyNowPrice === 0) &&
      a.tradeState !== "closed" && a.tradeState !== "expired"
    );

    if (unlisted.length === 0) {
      return { found: 0, listed: 0 };
    }

    console.log(`[FC Sniper Recupero] Rilevate ${unlisted.length} carte in Tradepile non messe in vendita. Procedo al listaggio immediato...`);
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[RECUPERO LISTA] Rilevate ${unlisted.length} carte in lista trasferimenti non ancora messe in vendita. Le metto sul mercato...`
    });

    if (Date.now() < listingRestrictedUntil) {
      const remainingMin = Math.ceil((listingRestrictedUntil - Date.now()) / 60000);
      console.log(`[FC Sniper Recupero] Listing in cooldown (${remainingMin} min rimanenti). Salto il listing delle ${unlisted.length} carte non listate.`);
      return { found: unlisted.length, listed: 0 };
    }

    let listedCount = 0;
    for (const a of unlisted) {
      if (start !== true || Date.now() < listingRestrictedUntil) break;
      const item = a.itemData;
      const itemId = item.id;
      let sellPrice = 0;

      if (item.itemType === "player") {
        // 1. Caso Calciatore / Fodder (solo se targetMode === "fodder")
        if (targetMode === "fodder") {
          const assetId = item.assetId || item.resourceId;
          let fodderPrice = cachedPrices?.playerPriceMap?.get(String(assetId))?.basePrice;
          if (!fodderPrice && cachedPrices?.benchmarkFloor) fodderPrice = cachedPrices.benchmarkFloor;
          if (!fodderPrice) fodderPrice = await getFodderPriceForItem(item);
          if (fodderPrice > 0) {
            const tiered = getTieredSellPrice(fodderPrice, null, false);
            sellPrice = tiered.price;
            const success = await sellSingleItem(itemId, sellPrice);
            if (Date.now() < listingRestrictedUntil) break;
            if (success) {
              listedCount++;
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[VENDITA RECUPERATA] Calciatore (Rating ${item.rating || 'N/D'}) messo in vendita a ${sellPrice} crediti (Tier ${tiered.tier}: +${tiered.markup}%)`
              });
              await sleep(getRandomGaussian(1.6, 0.15, 1.5, 2.0) * 1000);
            } else {
              await sleep(getRandomGaussian(1.8, 0.2, 1.5, 2.2) * 1000);
            }
          }
        }
      } else if (item.itemType === "training" || item.playStyle || (item.cardsubtypeid && CHEM_STYLES[String(item.cardsubtypeid)])) {
        // 2. Caso Consumabile / Stile Intesa / Modificatore Campionato
        const { floor, name } = await resolveConsumableFloor(item, cachedPrices);

        if (floor && floor > 0) {
          const tiered = getTieredSellPrice(floor, null, true);
          sellPrice = tiered.price;
          const success = await sellSingleItem(itemId, sellPrice);
          if (Date.now() < listingRestrictedUntil) break;
          if (success) {
            listedCount++;
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[VENDITA RECUPERATA] ${name} messa in vendita a ${sellPrice} crediti (Tier ${tiered.tier}: +${tiered.markup}%)`
            });
            await sleep(getRandomGaussian(1.6, 0.15, 1.5, 2.0) * 1000);
          } else {
            await sleep(getRandomGaussian(1.8, 0.2, 1.5, 2.2) * 1000);
          }
        }
      } else if (item.itemType === "manager") {
        // 3. Caso Allenatore
        const { floor, name } = await resolveConsumableFloor(item, cachedPrices);
        if (floor && floor > 0) {
          sellPrice = floor;
          const success = await sellSingleItem(itemId, sellPrice);
          if (Date.now() < listingRestrictedUntil) break;
          if (success) {
            listedCount++;
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[VENDITA RECUPERATA] ${name} messa in vendita al Lowest BIN live (${sellPrice} crediti)!`
            });
            await sleep(getRandomGaussian(1.6, 0.15, 1.5, 2.0) * 1000);
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

// Controlla la Watchlist prima del rabbocco Lazy:
// 1. Riscatta subito le aste già vinte (tradeState === "closed" / expires <= 0 e bidState === "highest") -> tradepile -> sell al prezzo target
// 2. Rimuove le aste perse (closed con bidState !== "highest" o outbid)
// 3. Identifica e attende brevemente (se <= 35s) le aste in dirittura d'arrivo in cui siamo vincenti
// 4. Restituisce il conteggio delle carte vinte riscattate e delle aste tuttora attive con offerta vincente
async function checkAndProcessWatchlistForLazy(cyclePrices = {}) {
  if (!xUtSid) return { recoveredWon: 0, activeWinning: 0, cleanedLost: 0 };

  await triggerPinEvent("TRIGGER_PIN_WATCHLIST");

  const headers = new Headers({
    "accept": "*/*",
    "accept-language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "cache-control": "no-cache, no-store, must-revalidate",
    "pragma": "no-cache",
    "content-type": "application/json",
    "x-ut-sid": xUtSid,
  });

  try {
    let response = await fetch(watchListUrl, { method: "GET", headers });
    if (!response.ok) {
      if (response.status === 401) await handle401Error("Lazy Watchlist Check");
      return { recoveredWon: 0, activeWinning: 0, cleanedLost: 0 };
    }
    consecutive401Errors = 0;

    let data = await response.json();
    if (data.credits !== undefined) {
      crediti = data.credits;
      sendMessageSafe({ tipo: 'CREDITI', valore: crediti });
    }

    let auctions = data.auctionInfo || [];
    let recoveredWon = 0;
    let cleanedLost = 0;

    // Se ci sono aste attive vincenti che scadono entro i prossimi 35 secondi, attendiamo brevemente che si chiudano
    // per poterle riscattare subito ed evitare acquisti ridondanti a Compra Ora!
    const imminentAuctions = auctions.filter(a => a.tradeState === "active" && a.bidState === "highest" && a.expires > 0 && a.expires <= 35);
    if (imminentAuctions.length > 0) {
      const maxWait = Math.max(...imminentAuctions.map(a => a.expires || 0));
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[LAZY WATCHLIST] ${imminentAuctions.length} aste vincenti in scadenza tra ${maxWait}s. Attendo la chiusura per riscattarle subito...`
      });
      await sleep((maxWait + 2) * 1000);

      // Riesegue una GET della Watchlist aggiornata
      await triggerPinEvent("TRIGGER_PIN_WATCHLIST");
      response = await fetch(watchListUrl, { method: "GET", headers });
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
      const tradeState = item.tradeState; // "active", "closed", "expired"
      const bidState = item.bidState;     // "highest", "outbid"
      const expires = item.expires;
      const itemId = item.itemData?.id;
      const tracked = storedBids[tradeIdStr] || activeBids.get(tradeIdStr) || activeBids.get(Number(tradeId));

      const isFinished = (tradeState === "closed" || tradeState === "expired" || expires === -1 || expires === 0);

      if (isFinished) {
        if (bidState === "highest") {
          // Asta VINTA! Riscatto immediato
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
            carteAcquistate += 1;
            sendMessageSafe({ tipo: 'CARTA_ACQUISTATA', valore: carteAcquistate });
            try { chrome.storage.local.set({ carteAcquistate }); } catch (_) { }
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[ASTA VINTA RISCATTATA] Asta vinta a ${buyPrice} crediti! Spostata in Tradepile e messa in vendita a ${sellPrice}${tierTag}.`
            });
          }

          await removeStoredPendingBid(tradeId);
          activeBids.delete(tradeIdStr);
          activeBids.delete(Number(tradeId));
        } else {
          // Asta chiusa ma NON vinta: pulizia
          await deleteFromWatchlist(tradeId);
          await removeStoredPendingBid(tradeId);
          activeBids.delete(tradeIdStr);
          activeBids.delete(Number(tradeId));
          cleanedLost++;
          await sleep(150);
        }
      } else if (tradeState === "active") {
        if (bidState === "highest") {
          // Asta ancora aperta ma siamo l'offerta PIÙ ALTA (vincente)
          activeWinningCount++;
          console.log(`[FC Sniper Watchlist] Asta Trade ${tradeId} ancora attiva con nostra offerta vincente (${item.currentBid} cr, scade in ${item.expires}s).`);
        } else if (bidState === "outbid") {
          // Siamo stati superati su asta ancora attiva.
          // Se abbiamo ancora margine rispetto al maxBidAllowed, rilanciamo SEMPRE per vincere l'asta.
          const maxBid = Number(tracked?.maxBidAllowed) || 0;
          const currentBid = Number(item.currentBid) || 0;
          const nextBid = calculateNextBid(Number(item.startingBid) || 0, currentBid);

          if (maxBid > 0 && nextBid <= maxBid && start === true) {
            // Rimuovi dal filtro anti-fantasma altrimenti isTradeAttempted bloccherebbe il rilancio per 5 min
            attemptedTradeIds.delete(tradeIdStr);

            // Rilancio deciso (85% del tetto massimo) per non dover inseguire l'avversario a ogni step,
            // ma senza mai superare il maxBidAllowed calcolato sul margine
            const strongBid = Math.max(nextBid, roundUpToStep(maxBid * 0.85));
            const reBidAmount = Math.min(strongBid, maxBid);

            const reBidSuccess = await sendBidRequest(tradeId, reBidAmount, itemId, maxBid);
            if (reBidSuccess) {
              const newBidData = { ...(tracked || {}), bidAmount: reBidAmount, maxBidAllowed: maxBid };
              activeBids.set(tradeIdStr, newBidData);
              await storePendingBid(tradeId, newBidData);
              activeWinningCount++;
              if (typeof crediti === 'number') crediti = Math.max(0, crediti - reBidAmount);
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[RE-BID OUTBID] Superati a ${currentBid} cr su Trade ${tradeId}. Rilancio a ${reBidAmount} cr (Max: ${maxBid}). Asta ancora tracciata.`
              });
            } else {
              // Rilancio fallito (rate limit, asta chiusa, crediti insufficienti): smettiamo di tracciarla
              await removeStoredPendingBid(tradeId);
              activeBids.delete(tradeIdStr);
              activeBids.delete(Number(tradeId));
              cleanedLost++;
            }
          } else {
            // Margine esaurito (nextBid > maxBidAllowed): smettiamo di tracciarla.
            // Non chiamiamo deleteFromWatchlist finché l'asta è attiva perché EA rifiuta con 401.
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


//Funzioni per chiamate HTTP

// Funzione per inviare una richiesta GET (ricerca manuale calciatori)
async function sendResearchRequest() {
  try {
    if (!searchUrl) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: '[ATTENZIONE] Nessun filtro acquisito! Vai nella Web App ed esegui una ricerca nel mercato per impostare il filtro desiderato.'
      });
      await sleep(4000);
      return;
    }
    if (!xUtSid) {
      console.error("Sessione xUtSid non definita");
      return;
    }

    if (!maxSnipePrice || maxSnipePrice <= 0) {
      sendMessageSafe({ tipo: 'LOG', valore: '[SNIPING MANUALE] Imposta il "Prezzo Max Compra Ora" nella UI: senza tetto prezzo lo sniping manuale è disattivato per sicurezza.' });
      await sleep(5000);
      return;
    }

    // 1. Telemetria nativa PIN: inviata rigorosamente PRIMA della ricerca
    await triggerPinEvent("TRIGGER_PIN_SEARCH");

    // Cache buster sicuro: start SEMPRE 0, alterniamo micr solo tra 0 (non impostato) e 150
    let finalUrl = searchUrl;
    try {
      const parsedUrl = new URL(searchUrl);
      parsedUrl.searchParams.set("start", "0");
      parsedUrl.searchParams.set("num", "21");
      if (maxSnipePrice > 0) {
        parsedUrl.searchParams.set("maxb", String(maxSnipePrice));
      }
      if (Math.random() < 0.4) {
        parsedUrl.searchParams.delete("micr");
      } else {
        parsedUrl.searchParams.set("micr", "150");
      }
      manualSearchAttempt++;
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
        "X-UT-SID": xUtSid
      }
    });

    if (response.ok) {
      consecutiveSearchErrors = 0;
      consecutive401Errors = 0;
      const data = await response.json();
      if (data.auctionInfo && data.auctionInfo.length > 0) {
        idCarteAcquistate = [];

        // Ordina per freschezza decrescente escludendo carte già tentate (carte fantasma)
        const auctions = [...data.auctionInfo]
          .filter(a => !isTradeAttempted(a.tradeId))
          .sort((a, b) => (b.expires || 0) - (a.expires || 0));

        // Acquisto immediato sulla carta più recente
        for (const auction of auctions) {
          if (start !== true) break;
          // Guard prezzo: mai comprare oltre il prezzo massimo impostato dall'utente
          if (maxSnipePrice > 0 && auction.buyNowPrice > maxSnipePrice) {
            console.log(`[FC Sniper Manuale] Scartata carta a ${auction.buyNowPrice} cr (oltre il max ${maxSnipePrice} cr)`);
            continue;
          }
          const bought = await sendBuyNowRequest(auction.tradeId, auction.buyNowPrice, auction.itemData?.id);
          if (bought) {
            break; // Stop immediato al primo acquisto per gestire l'oggetto
          }
        }

        if (idCarteAcquistate.length > 0) {
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

// Funzione per il BIDDING manuale: cerca con la searchUrl impostata nella Web App
// e piazza OFFERTE (non Compra Ora) sulle aste sotto il prezzo massimo impostato.
async function sendManualBiddingRequest() {
  try {
    if (!searchUrl) {
      sendMessageSafe({
        tipo: 'LOG',
        valore: '[ATTENZIONE] Nessun filtro acquisito! Vai nella Web App ed esegui una ricerca nel mercato per impostare il filtro desiderato.'
      });
      await sleep(4000);
      return;
    }
    if (!xUtSid) {
      console.error("Sessione xUtSid non definita");
      return;
    }

    if (!maxSnipePrice || maxSnipePrice <= 0) {
      sendMessageSafe({ tipo: 'LOG', valore: '[BIDDING MANUALE] Imposta il "Prezzo Max Offerta" nella UI: senza tetto prezzo il bidding manuale è disattivato per sicurezza.' });
      await sleep(5000);
      return;
    }

    // Cuscinetto di sicurezza watchlist (identico a Lazy Bidding: max 35 attive sui 50 slot EA)
    const MAX_ACTIVE_WATCHLIST = 35;
    if (activeBids.size >= MAX_ACTIVE_WATCHLIST) {
      console.log(`[BIDDING MANUALE] Watchlist satura (${activeBids.size}/${MAX_ACTIVE_WATCHLIST} attive). Attendo risoluzione delle aste correnti prima di nuove offerte.`);
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[BIDDING MANUALE] Limite di sicurezza watchlist raggiunto (${activeBids.size} aste attive). Attendo che si concludano prima di fare altre offerte.`
      });
      await resolveWatchlist();
      return;
    }

    await triggerPinEvent("TRIGGER_PIN_SEARCH");

    let finalUrl = searchUrl;
    try {
      const parsedUrl = new URL(searchUrl);
      parsedUrl.searchParams.set("start", "0");
      parsedUrl.searchParams.set("num", "21");
      if (maxSnipePrice > 0) {
        parsedUrl.searchParams.set("macr", String(maxSnipePrice));
      }
      // Variazione dinamica anti-cache come in Lazy Bidding
      const offsetSteps = [0, 150, 200, 250];
      const chosenOffset = offsetSteps[(manualSearchAttempt + manualBidPriceOffset) % offsetSteps.length];
      if (chosenOffset === 0) {
        parsedUrl.searchParams.delete("micr");
      } else {
        parsedUrl.searchParams.set("micr", String(chosenOffset));
      }
      manualSearchAttempt++;
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
        "X-UT-SID": xUtSid
      }
    });

    if (response.ok) {
      consecutiveSearchErrors = 0;
      consecutive401Errors = 0;
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
        while (start === true && Date.now() < endWait) {
          if (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 45000) {
            await resolveWatchlist();
          }
          await sleep(1000);
        }
        return { found: false, bidsPlaced: 0 };
      }

      targetAuctions.sort((a, b) => (a.expires || 0) - (b.expires || 0));

      let bidsInThisSearch = 0;
      const MAX_BIDS_PER_SEARCH = 3; // Limite prudente per singola ricerca identico a Lazy Bidding
      for (const auction of targetAuctions) {
        if (start !== true || bidsInThisSearch >= MAX_BIDS_PER_SEARCH) break;
        if (activeBids.size >= MAX_ACTIVE_WATCHLIST) break;

        const nextBid = calculateNextBid(auction.startingBid, auction.currentBid);
        // Cap: mai oltre il prezzo massimo utente, né oltre il BIN dell'asta
        const cap = auction.buyNowPrice > 0 ? Math.min(maxSnipePrice, auction.buyNowPrice) : maxSnipePrice;
        if (nextBid > cap) continue;

        // Controllo preventivo crediti per non inviare richieste a vuoto
        if (typeof crediti === 'number' && crediti < nextBid) {
          console.log(`[BIDDING MANUALE] Saldo crediti insufficiente per offerta (${crediti} cr < ${nextBid} cr richiesti). Salto asta.`);
          continue;
        }

        // 1. Ritardo umano di ispezione asta (600ms - 1100ms) identico a Lazy Bidding
        await sleep(getRandomGaussian(0.8, 0.15, 0.6, 1.1) * 1000);

        // 2. Invio offerta
        const ok = await sendBidRequest(auction.tradeId, nextBid, auction.itemData?.id, cap);

        if (ok) {
          manualTotalBidsPlaced++;
          bidsInThisSearch++;
          manualConsecutive461 = 0;
          if (typeof crediti === 'number') crediti = Math.max(0, crediti - nextBid);

          const cardName = formatItemDisplayName(auction, auction.tradeId);
          const isConsumable = (auction.itemData?.itemType === "training" || !!auction.itemData?.playStyle);
          const bidData = {
            tradeId: auction.tradeId,
            name: cardName,
            isManual: true,
            searchUrl: searchUrl,
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
            valore: `[BIDDING MANUALE] Offerta di ${nextBid} cr su ${cardName} (Scade in ${Math.round(auction.expires)}s | Max: ${cap} cr) [Offerta #${manualTotalBidsPlaced}]`
          });

          // 3. Pacing umano naturale tra offerte consecutive (4.8s - 7.0s) identico a Lazy Bidding
          await sleep(getRandomGaussian(5.5, 0.5, 4.8, 7.0) * 1000);

          // 4. Pausa distensiva ogni 5 offerte piazzate (10s - 15s) per far defluire il leaky bucket EA
          if (manualTotalBidsPlaced > 0 && manualTotalBidsPlaced % 5 === 0) {
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[BIDDING MANUALE] Pausa distensiva anti-spam (${manualTotalBidsPlaced} offerte piazzate)... Lascio defluire i contatori EA.`
            });
            await sleep(getRandomGaussian(12.0, 1.0, 10.0, 15.0) * 1000);
          }
        } else {
          // Gestione errori ed early exit identica a Lazy Bidding
          if (lastBidErrorStatus === 461) {
            manualConsecutive461++;
            manualBidPriceOffset++;
            if (manualConsecutive461 >= 3) {
              console.log(`[BIDDING MANUALE] Rilevate 3 aste contese o rifiutate (461). Pausa di sicurezza...`);
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[ANTI-BAN] Rilevate 3 aste contese o rifiutate (461). Pausa di sicurezza di 25s per far raffreddare l'account.`
              });
              await sleep(25000);
              await resolveWatchlist();
              break;
            }
            break; // Interrompe i tentativi su questa pagina e passa alla prossima ricerca
          }

          if (isRateLimitStatus(lastBidErrorStatus)) {
            console.warn(`[BIDDING MANUALE] Rate limit EA (${lastBidErrorStatus}) su offerta. Attivazione pausa protettiva...`);
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${lastBidErrorStatus}) rilevato. Sospendo temporaneamente le offerte per proteggere l'account.`
            });
            marketRestricted = true;
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

async function sendBuyNowRequest(tradeId, buyNowPrice, itemId) {
  markTradeAttempted(tradeId);
  const buyNowUrl = 'https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/trade/' + tradeId + '/bid';

  if (!buyNowUrl || !xUtSid) {
    console.error("URL o Sessione non definiti");
    return false;
  }

  // Controllo preventivo saldo crediti: impedisce di inviare richieste destinate a fallire
  if (typeof crediti === 'number' && crediti < buyNowPrice) {
    console.warn(`[FC Sniper BuyNow] Crediti insufficienti (${crediti} cr < ${buyNowPrice} cr richiesti). Acquisto annullato su Trade ${tradeId}.`);
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
        "X-UT-SID": xUtSid
      },
      body: JSON.stringify({ bid: buyNowPrice })
    });
    if (response.ok) {
      lastBuyNowErrorStatus = 0;
      consecutiveSnipeErrors = 0;
      consecutive401Errors = 0;
      const data = await response.json();
      carteAcquistate += 1;
      idCarteAcquistate.push(itemId);
      sendMessageSafe({ tipo: 'LOG', valore: `[ACQUISTO RIUSCITO] Carta acquistata al prezzo di ${buyNowPrice} crediti!` });
      sendMessageSafe({ tipo: 'CARTA_ACQUISTATA', valore: carteAcquistate });
      try { chrome.storage.local.set({ carteAcquistate }); } catch (_) { }
      return true;
    } else {
      lastBuyNowErrorStatus = response.status;
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
          consecutive512Errors++;
          console.warn(`[Snipe Fallito 512 - Limite Acquisti EA] Trade ${tradeId}, prezzo ${buyNowPrice}. Errori 512 consecutivi: ${consecutive512Errors}/5`);
        } else {
          consecutive512Errors = 0;
          consecutiveSnipeErrors++;
        }

        console.warn(`[Snipe Fallito ${response.status} - Rate Limit EA] Trade ${tradeId}, prezzo ${buyNowPrice}. Dettagli EA: ${errorDetails}. Errori consecutivi rate limit: ${consecutiveSnipeErrors}`);

        if (strategyMode === "lazy") {
          if (consecutive512Errors >= 5) {
            console.warn(`[FC Sniper Lazy] Rilevati 5 errori 512 consecutivi su Compra Ora. Transizione al sonno vendite...`);
          } else {
            await sleep(getRandomGaussian(1.0, 0.2, 0.7, 1.4) * 1000);
          }
        } else if (consecutiveSnipeErrors >= 5 || consecutive512Errors >= 5) {
          console.warn(`[FC Sniper] Rilevati 5 errori consecutivi di Snipe Soft-Ban (${response.status}). Avvio pausa di sicurezza attiva 10 min...`);
          consecutiveSnipeErrors = 0;
          consecutive512Errors = 0;
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

async function sendToTransferList() {
  let transferListUrl = 'https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/item';

  if (!transferListUrl || !searchHeaders) {
    console.error("URL o Header non definiti per la lista trasferimenti");
    return;
  }

  const headers = buildEaHeaders(xUtSid, {
    "sec-ch-ua": "\"Chromium\";v=\"142\", \"Google Chrome\";v=\"142\", \"Not_A Brand\";v=\"99\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site"
  });

  if (idCarteAcquistate.length === 0) return;

  const body = {
    itemData: idCarteAcquistate.map((id) => ({ "id": id, "pile": "trade" }))
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
      consecutive401Errors = 0;
      console.log('[FC Sniper] Carte inviate alla lista trasferimenti');
    } else if (response.status === 401) {
      await handle401Error("Transfer List");
    }
  } catch (error) {
    console.error("[FC Sniper] Errore durante l'invio alla lista trasferimenti:", error);
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
      await getFodderList();
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

    url.searchParams.delete("macr");
    // Cache busting: micr assente con probabilità ~40%, altrimenti 150 (non deterministico)
    if (Math.random() < 0.4) {
      url.searchParams.delete("micr");
    } else {
      url.searchParams.set("micr", "150");
    }

    //Ottiene l'URL finale come stringa
    const searchUrlCompleto = url.href;

    try {
      if (!searchUrlCompleto || !xUtSid) {
        console.error("URL o Sessione non definiti");
        return;
      }

      // 1. Telemetria nativa PIN: inviata rigorosamente PRIMA della ricerca
      await triggerPinEvent("TRIGGER_PIN_SEARCH");

      // Invia la richiesta GET
      const response = await fetch(searchUrlCompleto, {
        method: "GET",
        headers: {
          "Accept": "*/*",
          "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control": "no-cache",
          "X-UT-SID": xUtSid
        }
      });

      // Controlla la risposta
      if (response.ok) {
        consecutiveSearchErrors = 0;
        consecutive401Errors = 0;
        const data = await response.json();
        if (data.auctionInfo && data.auctionInfo.length > 0) {
          idCarteAcquistate = [];

          // Ordina per freschezza decrescente escludendo carte già tentate (carte fantasma)
          const auctions = [...data.auctionInfo]
            .filter(a => !isTradeAttempted(a.tradeId))
            .sort((a, b) => (b.expires || 0) - (a.expires || 0));

          for (const auction of auctions) {
            if (start !== true) break;
            const bought = await sendBuyNowRequest(auction.tradeId, auction.buyNowPrice, auction.itemData?.id);
            if (bought) {
              break; // Stop al primo acquisto completato
            }
          }

          if (idCarteAcquistate.length > 0) {
            await sendToTransferList();
            await sellFodder(next.price);
            crediti = await getCrediti();
            sendMessageSafe({ tipo: 'CREDITI', valore: crediti });
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

    if (start !== true) break;

    // Pacing competitivo per sniping
    sendMessageSafe({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });
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

  //pulisco la lista trasferimenti dagli elementi venduti a fine tentativi
  await clearSoldItem()

}



// Recupera la lista fodder dal server locale tramite fodder-service
async function getFodderList() {
  try {
    const { list, source } = await fetchFodderList(fodderRating);

    if (list.length > 0) {
      listaFodder.push(...list);
      console.log(`[FC Sniper] Ho recuperato ${listaFodder.length} fodder (rating ${fodderRating}) da ${source}`);
    } else {
      console.warn(`[FC Sniper] Nessun fodder trovato nella risposta per rating ${fodderRating}`);
    }
  } catch (error) {
    sendMessageSafe({ tipo: 'LOG', valore: 'Errore durante recupero lista dei fodder dal server' });
    console.error("Errore durante recupero lista dei fodder dal server:", error);
  }
}




function getNextFodder() {
  const fodder = listaFodder[indexFodder];
  indexFodder = (indexFodder + 1) % listaFodder.length;
  return fodder;
}


async function sellFodder(price) {

  const sellUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/auctionhouse"
  if (!xUtSid) {
    console.error("X-UT-SID non definito");
    return;
  }

  for (const id of idCarteAcquistate) {

    const headers = buildEaHeaders(xUtSid);

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
        consecutive401Errors = 0;
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

// Invia un'offerta (bid) su una specifica asta
async function sendBidRequest(tradeId, bidAmount, itemId, maxBidAllowed = null) {
  const bidUrl = 'https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/trade/' + tradeId + '/bid';
  if (!xUtSid) {
    console.error("X-UT-SID non definito");
    return false;
  }

  // Controllo preventivo saldo crediti: impedisce di inviare richieste destinate a fallire
  if (typeof crediti === 'number' && crediti < bidAmount) {
    console.warn(`[FC Sniper Bid] Crediti insufficienti (${crediti} cr < ${bidAmount} cr richiesti). Offerta annullata su Trade ${tradeId}.`);
    return false;
  }

  // Queue Anti-Collisione Globale (Opzione 3: portato a 1.6s per proteggere dai 512):
  // Garantisce che nessun'offerta verso EA possa partire a meno di 1.6s dalla precedente
  const elapsed = Date.now() - lastBidTimestamp;
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
    "X-UT-SID": xUtSid
  });

  markTradeAttempted(tradeId);
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
      consecutive470Errors = 0;
      consecutive461InBidding = 0;
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
        consecutiveBidErrors++;
        console.warn(`[Bid Fallito ${response.status} - Rate Limit EA] Trade ${tradeId}, offerta ${bidAmount}. Dettagli EA: ${errorDetails}. Errori consecutivi: ${consecutiveBidErrors}`);

        if (strategyMode === "lazy") {
          return false;
        }

        if (consecutiveBidErrors >= 3) {
          console.warn(`[FC Sniper] Rilevati ${consecutiveBidErrors} errori consecutivi di Bid Soft-Ban (${response.status}). Avvio pausa di sicurezza attiva 10 min...`);
          consecutiveBidErrors = 0;
          await executeSafetyPause(600, `Soft-Ban Offerte Asta EA (${response.status})`);
        } else {
          await sleep(getRandomGaussian(8.0, 1.0, 6.0, 10.0) * 1000);
        }
      } else if (response.status === 461) {
        // HTTP 461: Carta non più disponibile (già acquistata via Compra Ora da altri, asta scaduta, o Watchlist satura)
        // NON tentare rilanci: la carta non è più sul mercato.
        console.log(`[FC Sniper Bid 461] Asta non più disponibile o già conclusa su Trade ${tradeId}. Salto carta.`);
        return false;
      } else if (response.status === 470) {
        // HTTP 470: Offerta superata (un altro utente ha offerto un importo superiore su quest'asta ancora aperta)
        consecutive470Errors++;
        console.warn(`[Bid Fallito 470 - Offerta superata] Trade ${tradeId}, offerta ${bidAmount}. Dettagli EA: ${errorDetails}`);
        const step = getEaStep(bidAmount);
        const retryBid = bidAmount + step;
        if (maxBidAllowed && retryBid <= maxBidAllowed && (!crediti || crediti >= retryBid)) {
          console.log(`[FC Sniper 470 Outbid] Offerta a ${bidAmount} cr superata. Controrilancio a ${retryBid} cr (Max: ${maxBidAllowed})...`);
          await sleep(getRandomGaussian(1.0, 0.15, 0.8, 1.2) * 1000);
          return await sendBidRequest(tradeId, retryBid, itemId, maxBidAllowed);
        } else {
          console.log(`[FC Sniper 470 Outbid] Offerta a ${bidAmount} cr superata su Trade ${tradeId}. Prossimo rilancio (${retryBid}) supererebbe il limite (${maxBidAllowed || 'N/D'}). Abbandono.`);
        }
        if (consecutive470Errors >= 4) {
          console.warn(`[FC Sniper] Rilevati ${consecutive470Errors} errori 470 consecutivi. Pausa sincronizzazione aste EA di 4 secondi...`);
          consecutive470Errors = 0;
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
async function moveSingleItemToTrade(itemId) {
  if (!xUtSid || !itemId) return false;
  const transferListUrl = 'https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/item';
  const headers = new Headers({
    "accept": "*/*",
    "content-type": "application/json",
    "X-UT-SID": xUtSid
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

let listingTierCounter = 0;

/**
 * Calcola il prezzo di vendita scaglionato per massimizzare le vendite verso Lazy Buyers
 * Distribuzione richiesta:
 * - Tier A: 30% delle carte -> Markup veloce per rotazione rapida e liquidità (+6%)
 * - Tier B: 50% delle carte -> Markup standard (+10% o lazyMarkupPercent)
 * - Tier C: 20% delle carte -> Markup alto per lazy buyers e micro-picchi (+15%)
 */
function getTieredSellPrice(floorBin, customMarkup = null, isConsumable = true) {
  if (!floorBin || floorBin <= 0) return { price: 0, tier: "B", markup: 10 };

  const baseMarkup = (customMarkup !== null && customMarkup > 0) ? customMarkup : (lazyMarkupPercent || 10);

  // Sequenza interallacciata su 10 carte: 3 A (30%), 5 B (50%), 2 C (20%)
  const tierPattern = [
    { tier: "A", factor: 0.6 }, // 0: Tier A (+6%)
    { tier: "B", factor: 1.0 }, // 1: Tier B (+10%)
    { tier: "B", factor: 1.0 }, // 2: Tier B (+10%)
    { tier: "C", factor: 1.5 }, // 3: Tier C (+15%)
    { tier: "A", factor: 0.6 }, // 4: Tier A (+6%)
    { tier: "B", factor: 1.0 }, // 5: Tier B (+10%)
    { tier: "B", factor: 1.0 }, // 6: Tier B (+10%)
    { tier: "A", factor: 0.6 }, // 7: Tier A (+6%)
    { tier: "B", factor: 1.0 }, // 8: Tier B (+10%)
    { tier: "C", factor: 1.5 }  // 9: Tier C (+15%)
  ];

  const currentSlot = tierPattern[listingTierCounter % tierPattern.length];
  listingTierCounter++;

  const appliedMarkup = Math.max(5, Math.round(baseMarkup * currentSlot.factor));
  let rawPrice = floorBin * (1 + (appliedMarkup / 100));
  let calculatedPrice = roundUpToStep(rawPrice);

  if (isConsumable && calculatedPrice > 5000) {
    calculatedPrice = 5000;
  }

  return {
    price: calculatedPrice,
    tier: currentSlot.tier,
    markup: appliedMarkup
  };
}

// Mette in vendita un singolo oggetto al prezzo Buy Now specificato (e startingBid opzionale)
// Include anti-collisione temporale, capping ai limiti EA, gestione retry su 461 (assestamento/lock) e 426 (rate limit)
async function sellSingleItem(itemId, price, startingBid = null) {
  if (!xUtSid || !itemId) return false;

  // Circuit Breaker: se EA ha attivato il rate limit 426 sulle vendite, non inviare alcuna richiesta
  if (Date.now() < listingRestrictedUntil) {
    const secLeft = Math.ceil((listingRestrictedUntil - Date.now()) / 1000);
    console.warn(`[FC Sniper Listing] Richiesta bloccata dal Circuit Breaker: cooldown attivo per ancora ${secLeft}s.`);
    return false;
  }

  const sellUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/auctionhouse";

  // 1. Normalizzazione prezzo e scalini EA
  let validPrice = Number(price);
  if (isNaN(validPrice) || validPrice <= 0) return false;

  const step = getEaStep(validPrice);
  let startBid = startingBid && startingBid > 0 ? Number(startingBid) : Math.max(validPrice - step, 200);
  startBid = roundDownToStep(startBid);

  const headers = new Headers({
    "accept": "*/*",
    "content-type": "application/json",
    "x-ut-sid": xUtSid
  });

  const body = JSON.stringify({
    buyNowPrice: validPrice,
    duration: 3600,
    itemData: { id: Number(itemId) },
    startingBid: startBid
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    // 2. Queue Anti-Collisione Listing (minimo 1.5s tra richieste di messa in vendita per evitare 426 da spam)
    const elapsed = Date.now() - lastListingTimestamp;
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

      lastListingTimestamp = Date.now();

      if (resp.ok) {
        consecutive401Errors = 0;
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
      // Attiviamo il Circuit Breaker per 15 minuti: stop immediato ad ogni richiesta di listing
      if (resp.status === 426) {
        listingRestrictedUntil = Date.now() + (15 * 60 * 1000);
        console.warn(`[FC Sniper Listing] Rate limit 426 su auctionhouse! Attivato stop temporaneo listing per 15 min.`);
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[RATE LIMIT VENDITA] EA ha temporaneamente limitato il listing delle carte (426). Stop immediato alle richieste di vendita per 15 min per far decadere il blocco. Le carte restano al sicuro in Tradepile.`
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
    if (!res.ok) {
      console.warn(`[FC Sniper Watchlist] Cancellazione trade ${tradeId} non riuscita (Status: ${res.status})`);
    }
  } catch (e) {
    console.error("Errore cancellazione da watchlist:", e);
  }
}

// Recupera il prezzo di mercato reale di un fodder in base al pid/assetId o al rating
async function getFodderPriceForItem(itemData) {
  if (!itemData || targetMode !== "fodder") return 0;
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
  await triggerPinEvent("TRIGGER_PIN_WATCHLIST");

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
async function resolveWatchlist() {
  if (!xUtSid) return;

  await triggerPinEvent("TRIGGER_PIN_WATCHLIST");

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
      sendMessageSafe({ tipo: 'CREDITI', valore: crediti });
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
        // Aggiorna la scadenza precisa fornita da EA per calcolare i secondi rimanenti
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
          // Incrementa subito il conteggio delle carte vinte prima di spostare
          carteAcquistate += 1;
          carteVinteCiclo += 1;
          sendMessageSafe({ tipo: 'CARTA_ACQUISTATA', valore: carteAcquistate });
          try { chrome.storage.local.set({ carteAcquistate }); } catch (_) { }

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

    // Queue Bidding & Controrilanci Watchlist:
    // Raccoglie le aste attive su cui siamo stati SUPERATI (outbid)
    const eligibleActions = [];
    for (const item of auctions) {
      if (item.tradeState === "active") {
        const tradeId = item.tradeId;
        const tracked = storedBids[String(tradeId)] || activeBids.get(tradeId) || activeBids.get(Number(tradeId));
        if (tracked && tracked.maxBidAllowed) {
          const nextBid = calculateNextBid(item.startingBid, item.currentBid);

          // Eseguiamo controlli di abbandono o controrilancio SOLO se siamo stati superati (outbid)!
          // Se siamo "highest", siamo la miglior offerta: l'asta è vincente e NON va toccata né cancellata!
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

            // Se abbiamo già provato ad offrire su questo identico currentBid ed è fallito (es. 470 outbid race),
            // non insistiamo alla cieca: attendiamo che la watchlist di EA si aggiorni con il vero prezzo superato
            if (tracked.failedAtCurrentBid !== undefined && tracked.failedAtCurrentBid === item.currentBid) {
              continue;
            }

            // Altrimenti se il prossimo rilancio rientra nel budget, controrilanciamo!
            eligibleActions.push({ item, tracked });
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

        if (nextBid <= tracked.maxBidAllowed) {
          if (typeof crediti === 'number' && crediti < nextBid) {
            console.log(`[FC Sniper Watchlist] Controrilancio annullato su Trade ${tradeId}: crediti insufficienti (${crediti} cr < ${nextBid} cr).`);
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[CONTRORILANCIO] Annullato su ${tracked.name || 'Trade ' + tradeId}: crediti insufficienti (${crediti} cr < ${nextBid} cr richiesti).`
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

            // Ritardo rapido tra offerte consecutive
            await sleep(getRandomGaussian(2.0, 0.25, 1.6, 2.5) * 1000);
          } else {
            // Se fallito (es. 470 outbid race), memorizziamo che su questo currentBid abbiamo già provato
            tracked.failedAtCurrentBid = item.currentBid;
            await storePendingBid(tradeId, tracked);
            activeBids.set(String(tradeId), tracked);

            // Se fallito per rate limit EA, interrompiamo subito la coda per non accumulare errori e segnaliamo la restrizione
            if (lastBidErrorStatus === 429 || lastBidErrorStatus === 426 || lastBidErrorStatus === 512 || lastBidErrorStatus === 521) {
              console.warn(`[FC Sniper Queue] Errore ${lastBidErrorStatus} su Trade ${tradeId}. Arresto coda offerte e attivo restrizione.`);
              marketRestricted = true;
              break;
            }
            if (lastBidErrorStatus === 470) {
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

// Motore principale di MASS BIDDING Fodder
// Motore UNICO di MASS BIDDING (fodder / consumabili), parametrizzato via targetMode.
// Le differenze tra i due vecchi engine (sorgente target, parametri URL, bidData, soglie margine)
// sono racchiuse nella selezione del target ad inizio giro.
async function runMassBiddingEngine() {
  const isFodder = targetMode === "fodder";
  const logTag = isFodder ? "[FC Sniper]" : "[FC Sniper Consumabili]";
  const errContext = isFodder ? "Ricerca Bidding" : "Ricerca Bidding Consumabili";
  const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
  let i = 0;
  const targetStyles = isFodder ? null : ((chemStyle === "all") ? ["268", "266", "265", "260"] : [chemStyle]);
  let styleIndex = 0;

  while (start === true && i < numeroTentativi) {
    // 1. Controllo prioritario aste urgenti (<= 20s): attende e risolve senza consumare tentativi di ricerca
    while (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 20000 && start === true) {
      const secLeft = Math.max(0, Math.round(getUrgentAuctionTimeRemaining(activeBids) / 1000));
      console.log(`${logTag} Asta urgente in chiusura (~${secLeft}s). Controllo Watchlist per difesa/risoluzione...`);
      await sleep(getRandomGaussian(2.0, 0.2, 1.5, 2.5) * 1000);
      await resolveWatchlist();
    }

    if (start !== true) break;

    // --- Selezione target e calcolo prezzi (unica parte divergente) ---
    let targetName, marketPrice, maxBidAllowed, targetMargin, bidDataBase, buildUrl;

    if (isFodder) {
      // Ad inizio e ad ogni giro completo della lista, ricarica i prezzi dal server
      if (i === 0 || indexFodder === 0 || listaFodder.length === 0) {
        if (i > 0) {
          console.log('[FC Sniper] Giro fodder completato. Ricarico lista e prezzi aggiornati dal server...');
        }
        listaFodder = [];
        indexFodder = 0;
        await getFodderList();
      }

      if (listaFodder.length === 0) {
        console.log('[FC Sniper] Nessun fodder disponibile dal server. Attendo...');
        await sleep(3000);
        i++;
        continue;
      }

      const next = getNextFodder();
      targetName = next.name ? next.name + ' (PID ' + next.pid + ')' : 'PID ' + next.pid;
      marketPrice = next.price; // Lowest BIN live dal server
      const netIncome = Math.floor(marketPrice * 0.95);
      targetMargin = calculateTargetMargin(marketPrice, minMargin);
      maxBidAllowed = roundDownToStep(netIncome - targetMargin);

      // Protezione margine zero (se maxBidAllowed < 700 per un oro raro, non c'è margine)
      if (maxBidAllowed < 700) {
        console.log(`[FC Sniper] Fodder ${targetName} (Rating ${fodderRating}, BIN ${marketPrice}): margine insufficiente (Max Bid ${maxBidAllowed} < 700). Salto.`);
        i++;
        await sleep(600);
        continue;
      }

      bidDataBase = { pid: next.pid, name: next.name, rating: fodderRating };
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

      // Recupera Lowest BIN live (aggiorna la prima volta o ogni 5 minuti)
      marketPrice = await discoverConsumableLowestBin(currentStyleId, manualBin, i === 0);

      // BLOCCO DI SICUREZZA: se il prezzo non è verificato con certezza, salta lo stile ed evita offerte cieche
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
      // Margine calibrato a minMargin - 50 (minimo 100) per allineare l'offerta massima alla soglia vincente reale
      const effectiveMargin = Math.max(100, (minMargin || 200) - 50);
      maxBidAllowed = roundDownToStep(netIncome - effectiveMargin);
      targetMargin = netIncome - maxBidAllowed; // Margine netto reale

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

    // Parametri base della ricerca (sempre start=0 per vedere le aste in chiusura immediata)
    // minBidBumps mescolato ad ogni target: ordine non più deterministico (anti-fingerprint)
    const minBidBumps = [150, 200, 250];
    for (let k = minBidBumps.length - 1; k > 0; k--) {
      const j = Math.floor(Math.random() * (k + 1));
      [minBidBumps[k], minBidBumps[j]] = [minBidBumps[j], minBidBumps[k]];
    }
    let offersCount = 0;

    for (let attempt = 0; attempt < minBidBumps.length; attempt++) {
      if (start !== true) break;

      // Check rapido prima di ogni tentativo di ricerca: se un'asta è diventata urgente (<= 20s),
      // interrompiamo subito la ricerca per andare a partecipare/difendere l'asta in chiusura
      if (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 20000) {
        console.log(`${logTag} Rilevata asta urgente (<= 20s) durante la ricerca. Interrompo per partecipare subito.`);
        break;
      }

      const url = buildUrl(minBidBumps[attempt]);

      triggerPinEvent("TRIGGER_PIN_SEARCH");

      const headers = new Headers({
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
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
              } else if (isRateLimitStatus(lastBidErrorStatus)) {
                console.warn(`[FC Sniper Queue] Rate limit EA durante offerta su ${targetName}. Interrompo ulteriori offerte su questo target.`);
                break;
              }

              // Ritardo rapido e fluido tra offerte
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

    if (start !== true) break;

    // 2. Risoluzione Watchlist disaccoppiata e mirata:
    // Se abbiamo piazzato offerte o abbiamo aste in chiusura immediata (<= 20s), difendiamo fino alla conclusione
    if (offersCount > 0 && start === true) {
      await sleep(getRandomGaussian(1.2, 0.15, 1.0, 1.5) * 1000);
      await resolveWatchlist();
    }
    while (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 20000 && start === true) {
      await sleep(getRandomGaussian(1.8, 0.2, 1.4, 2.3) * 1000);
      await resolveWatchlist();
    }

    // Aggiornamento contatore tentativi rimasti
    sendMessageSafe({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });

    let randomValue;
    if ((i + 1) % 50 == 0 && i != numeroTentativi - 1) {
      randomValue = getRandomInRange(120, 180); // sleep tra 2 e 3 minuti ogni 50 tentativi
      sendMessageSafe({ tipo: 'LOG', valore: 'Cool down di: ' + randomValue + ' sec' });
      await clearSoldItem();
    } else if ((i + 1) % 5 == 0) {
      randomValue = getRandomGaussian(4.0, 0.4, 3.4, 4.8); // breve pausa ogni 5 target
    } else {
      randomValue = getRandomGaussian(2.4, 0.3, 2.0, 2.9); // 2.0-2.9 secondi tra un target e l'altro
    }

    // Pausa naturale tra target (o cool down ogni 50 tentativi).
    let remainingSleepMs = randomValue * 1000;
    while (remainingSleepMs > 0 && start === true) {
      if (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 20000) {
        break; // Sveglia immediata: l'asta è entrata nei 20 secondi!
      }
      const chunk = Math.min(500, remainingSleepMs);
      await sleep(chunk);
      remainingSleepMs -= chunk;
    }
    i++;
  }

  // Chiusura finale: se i tentativi sono terminati, attendiamo che le aste ancora attive scadano e si risolvano
  if (start !== true) return;
  let activeRemaining = await resolveWatchlist();
  if ((activeRemaining > 0 || activeBids.size > 0) && start === true) {
    const initialCount = Math.max(activeRemaining, activeBids.size);
    sendMessageSafe({
      tipo: 'LOG',
      valore: `Tentativi terminati. In attesa della chiusura e difesa di ${initialCount} aste in corso...`
    });

    let loopIterations = 0;
    const MAX_SAFETY_TIMEOUT_SEC = 900; // 15 min max safety timeout
    let elapsedSec = 0;

    while (start === true && elapsedSec < MAX_SAFETY_TIMEOUT_SEC) {
      const urgentMs = activeBids.size > 0 ? getUrgentAuctionTimeRemaining(activeBids) : 999999;
      const sleepMs = (urgentMs <= 25000 && urgentMs > 0) ? 3000 : 5000;
      await sleep(sleepMs);
      elapsedSec += Math.round(sleepMs / 1000);
      loopIterations++;

      activeRemaining = await resolveWatchlist();
      if (activeRemaining === 0 && activeBids.size === 0) break;

      if (loopIterations % 6 === 0) {
        const currentPending = Math.max(activeRemaining, activeBids.size);
        const minSec = (urgentMs < 999999 && urgentMs > 0) ? Math.max(1, Math.round(urgentMs / 1000)) : null;
        const secMsg = minSec ? ` (prossima scadenza: ~${minSec}s)` : '';
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[DIFESA ASTE] Monitoraggio e difesa di ${currentPending} aste pendenti${secMsg}...`
        });
      }
    }
  }

  // Risoluzione finale e pulizia
  await resolveWatchlist();
  sendMessageSafe({
    tipo: 'LOG',
    valore: `[TENTATIVI COMPLETATI] Tutte le aste sono concluse! Carte vinte in questa sessione: ${carteAcquistate}`
  });
  await clearSoldItem();

  // credito aggiornato post-vendite e report Telegram di fine ciclo
  crediti = await getCrediti();
  sendMessageSafe({ tipo: 'CREDITI', valore: crediti });
  await sendCycleReport('bidding', { acquistate: carteAcquistate, vendute: carteVendute, crediti });
}

// Price Discovery universale tramite Downward Skimming (copiata dalla strategia Lazy Buying)
// Valida per qualsiasi tipologia di carta: Stili Intesa, Modificatori Campionato, Allenatori e Calciatori
async function discoverCustomLowestBin(searchFilterParams, displayName, cacheKey, manualBinOverride = 0, forceRefresh = false) {
  if (manualBinOverride && manualBinOverride > 0) {
    console.log(`[FC Sniper Discovery] Usato BIN manuale impostato dall'utente: ${manualBinOverride} crediti`);
    return manualBinOverride;
  }

  const CACHE_TTL_MS = 15 * 60 * 1000;
  if (!forceRefresh && cacheKey && consumableBinCache.has(String(cacheKey))) {
    const cached = consumableBinCache.get(String(cacheKey));
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
      const minsLeft = Math.round((CACHE_TTL_MS - (Date.now() - cached.timestamp)) / 60000);
      console.log(`[FC Sniper Discovery] Usato Floor BIN in cache (${cached.price} cr) per ${displayName} (valido ancora per ${minsLeft} min)`);
      return cached.price;
    }
  }

  // Protezione Soft-Ban: se il mercato è in restrizione (512 / 429), non effettuare ricerche extra
  if (marketRestricted) {
    if (cacheKey && consumableBinCache.has(String(cacheKey))) {
      return consumableBinCache.get(String(cacheKey)).price;
    }
    return 0;
  }

  console.log(`[FC Sniper Discovery] Avvio rilevamento Lowest BIN istantaneo per ${displayName}...`);
  sendMessageSafe({
    tipo: 'LOG',
    valore: `[Auto-Discovery] Analisi di mercato per ${displayName}: cerco il prezzo di vendita istantanea (58-59m)...`
  });

  const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
  const headers = new Headers({
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "X-UT-SID": xUtSid
  });

  // FASE 1: Ricerca iniziale per determinare il tetto massimo da cui iniziare la scrematura
  let candidateBin = 0;
  const initialCache = cacheKey ? consumableBinCache.get(String(cacheKey)) : null;
  let startingPrice = initialCache?.price ? initialCache.price + (getEaStep(initialCache.price) * 2) : 0;

  try {
    const probeUrl = new URL(baseUrl);
    probeUrl.searchParams.set("num", "21");
    probeUrl.searchParams.set("start", "0");
    for (const [k, v] of Object.entries(searchFilterParams)) {
      if (v !== undefined && v !== null && v !== "") {
        probeUrl.searchParams.set(k, String(v));
      }
    }
    if (startingPrice > 0) {
      probeUrl.searchParams.set("maxb", String(startingPrice));
    }
    probeUrl.searchParams.set("micr", "150");

    await triggerPinEvent("TRIGGER_PIN_SEARCH");
    const probeResp = await fetch(probeUrl.href, { method: "GET", headers });
    if (probeResp.status === 401) {
      await handle401Error("AutoDiscovery Probe");
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

  // Se con il filtro maxb non abbiamo trovato carte, facciamo una ricerca libera aperta
  if (!candidateBin || candidateBin <= 0) {
    await sleep(getRandomGaussian(0.8, 0.1, 0.6, 1.0) * 1000);
    try {
      const openUrl = new URL(baseUrl);
      openUrl.searchParams.set("num", "21");
      openUrl.searchParams.set("start", "0");
      for (const [k, v] of Object.entries(searchFilterParams)) {
        if (v !== undefined && v !== null && v !== "") {
          openUrl.searchParams.set(k, String(v));
        }
      }
      openUrl.searchParams.set("micr", "200");

      await triggerPinEvent("TRIGGER_PIN_SEARCH");
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
    console.warn(`[FC Sniper Discovery] Nessuna carta presente sul mercato per ${displayName}.`);
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[BLOCCO SICUREZZA] Nessuna carta presente sul mercato per ${displayName}. Prezzo discovery non disponibile.`
    });
    return 0;
  }

  console.log(`[FC Sniper Discovery] Inizio scrematura verso il basso per ${displayName} a partire da ${candidateBin} crediti.`);

  // FASE 2: Scrematura progressiva del prezzo (Downward Skimming)
  const MAX_SCREMATURA_ITERATIONS = 7;
  let verifiedBin = 0;

  for (let stepIdx = 0; stepIdx < MAX_SCREMATURA_ITERATIONS; stepIdx++) {
    if (start !== true) break;

    await sleep(getRandomGaussian(0.9, 0.12, 0.7, 1.2) * 1000);

    const testUrl = new URL(baseUrl);
    testUrl.searchParams.set("num", "21");
    testUrl.searchParams.set("start", "0");
    for (const [k, v] of Object.entries(searchFilterParams)) {
      if (v !== undefined && v !== null && v !== "") {
        testUrl.searchParams.set(k, String(v));
      }
    }
    testUrl.searchParams.set("maxb", String(candidateBin));
    testUrl.searchParams.set("micr", String(150 + (stepIdx * 50) + (Math.random() < 0.5 ? 0 : 50)));

    await triggerPinEvent("TRIGGER_PIN_SEARCH");

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
    const freshCards = auctions.filter(a => (a.expires >= 3450 && a.expires <= 3600) || (a.expires >= 10650 && a.expires <= 10800));
    const staleCards = auctions.filter(a => a.expires > 0 && a.expires < 3450);

    console.log(`[FC Sniper Scrematura] Test maxb: ${candidateBin} crediti -> ${totalCards} carte trovate (Fresche 58-59m: ${freshCards.length}, Stagnanti: ${staleCards.length})`);

    // CASO A: Trovate carte e TUTTE hanno tempo 58-59 minuti rimanenti
    if (totalCards > 0 && staleCards.length === 0) {
      verifiedBin = candidateBin;
      console.log(`[FC Sniper Discovery] Condizione di vendita istantanea confermata per ${displayName} a ${verifiedBin} crediti! (${totalCards} carte fresche a 58-59 min).`);
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[Auto-Discovery] Lowest BIN live per ${displayName}: ${verifiedBin} crediti (${totalCards} carte fresche a 58-59m)!`
      });
      break;
    }

    // CASO B: 0 carte trovate a questo prezzo
    if (totalCards === 0) {
      const step = getEaStep(candidateBin);
      verifiedBin = candidateBin + step;
      console.log(`[FC Sniper Discovery] 0 carte trovate a ${candidateBin} per ${displayName}. Lowest BIN reale: ${verifiedBin} crediti.`);
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[Auto-Discovery] Lowest BIN reale per ${displayName}: ${verifiedBin} crediti (0 carte a ${candidateBin})!`
      });
      break;
    }

    // CASO C: Ci sono carte stagnanti o troppe carte -> scremiamo verso il basso
    const step = getEaStep(candidateBin);
    const nextLower = candidateBin - step;

    if (nextLower < 200) {
      verifiedBin = 200;
      break;
    }

    console.log(`[FC Sniper Scrematura] A ${candidateBin} ci sono ${totalCards} carte (${staleCards.length} ferme da oltre 2 min). Scremo verso il basso a ${nextLower}...`);
    candidateBin = nextLower;
  }

  if (!verifiedBin && candidateBin > 0) {
    verifiedBin = candidateBin;
  }

  if (verifiedBin > 0) {
    if (cacheKey) {
      consumableBinCache.set(String(cacheKey), { price: verifiedBin, timestamp: Date.now() });
    }
    return verifiedBin;
  }

  return 0;
}

// Auto-Discovery del Lowest BIN reale sul mercato per uno Stile Intesa
async function discoverConsumableLowestBin(playStyleId, manualBinOverride = 0, forceRefresh = false) {
  const styleMeta = CHEM_STYLES[String(playStyleId)] || { id: playStyleId, name: `Stile ${playStyleId}`, defaultGuess: 3000 };
  const params = {
    type: "training",
    cat: "playStyle",
    playStyle: String(playStyleId)
  };
  return discoverCustomLowestBin(params, styleMeta.name, String(playStyleId), manualBinOverride, forceRefresh);
}

// Rileva il Lowest BIN di un Modificatore Campionato Allenatore (cat=managerLeagueModifier&amount=<leagueId>).
async function discoverLeagueModifierLowestBin(leagueId, manualBinOverride = 0, forceRefresh = false) {
  const meta = MANAGER_LEAGUES[String(leagueId)] || { id: leagueId, name: `Lega ${leagueId}`, defaultGuess: 1000 };
  const params = {
    type: "training",
    cat: "managerLeagueModifier",
    amount: String(leagueId)
  };
  return discoverCustomLowestBin(params, `Modificatore ${meta.name}`, leagueTargetKey(leagueId), manualBinOverride, forceRefresh);
}

// Auto-Discovery del Lowest BIN reale per Allenatori di una determinata nazione (type=staff&cat=manager&nat=<natId>)
async function discoverManagerLowestBin(natId, manualBinOverride = 0, forceRefresh = false) {
  const meta = TOP_MANAGER_NATIONS[String(natId)] || { id: Number(natId), name: NATION_NAMES[natId] || `Naz ${natId}`, defaultGuess: 2000 };
  const params = {
    type: "staff",
    cat: "manager",
    nat: String(natId)
  };
  return discoverCustomLowestBin(params, `Allenatore ${meta.name}`, managerTargetKey(natId), manualBinOverride, forceRefresh);
}

// Price Discovery specializzata per carte acquistate/tracciate in Bidding Manuale (Allenatori, Calciatori, Consumabili)
async function discoverManualItemLowestBin(item, tracked = null) {
  const data = item?.itemData || item || {};
  const itemType = data.itemType || tracked?.itemType || tracked?.cardType || "";

  // 1. Modificatore campionato allenatore
  const lgId = detectManagerLeague(item);
  if (lgId && MANAGER_LEAGUES[lgId]) {
    const floor = await discoverLeagueModifierLowestBin(lgId, manualBin);
    return { floor, name: `Modificatore ${MANAGER_LEAGUES[lgId].name}`, isConsumable: true };
  }

  // 2. Stile intesa
  const cStyle = detectChemistryStyle(item, tracked?.playStyleId);
  if (cStyle && CHEM_STYLES[cStyle]) {
    const floor = await discoverConsumableLowestBin(cStyle, manualBin);
    return { floor, name: CHEM_STYLES[cStyle].name, isConsumable: true };
  }

  // 3. Allenatore (Manager)
  if (itemType === "manager") {
    const params = { type: "staff", cat: "manager" };
    const sourceUrl = tracked?.searchUrl || searchUrl;
    if (sourceUrl) {
      try {
        const u = new URL(sourceUrl);
        for (const [k, v] of u.searchParams.entries()) {
          if (!["start", "num", "minb", "maxb", "micr", "macr"].includes(k)) {
            params[k] = v;
          }
        }
      } catch (_) {}
    }
    if (data.nation && !params.nat) params.nat = String(data.nation);
    if (data.leagueId && !params.league && data.leagueId > 0) params.league = String(data.leagueId);

    const name = formatItemDisplayName(item, item.tradeId);
    const cacheKey = `manager_nat_${params.nat || 0}_lg_${params.league || 0}`;
    const floor = await discoverCustomLowestBin(params, name, cacheKey, manualBin);
    return { floor, name, isConsumable: false };
  }

  // 4. Calciatore (Player)
  if (itemType === "player") {
    const params = { type: "player" };
    const sourceUrl = tracked?.searchUrl || searchUrl;
    if (sourceUrl) {
      try {
        const u = new URL(sourceUrl);
        for (const [k, v] of u.searchParams.entries()) {
          if (!["start", "num", "minb", "maxb", "micr", "macr"].includes(k)) {
            params[k] = v;
          }
        }
      } catch (_) {}
    }
    const assetId = data.assetId || data.resourceId || tracked?.assetId;
    if (assetId && !params.maskedDefId) {
      params.maskedDefId = String(assetId);
    }
    const name = formatItemDisplayName(item, item.tradeId);
    const cacheKey = `player_${params.maskedDefId || assetId || data.id}`;
    const floor = await discoverCustomLowestBin(params, name, cacheKey, manualBin);
    return { floor, name, isConsumable: false };
  }

  // 5. Qualsiasi altra ricerca manuale generica dalla Web App
  const sourceUrl = tracked?.searchUrl || searchUrl;
  if (sourceUrl) {
    const params = {};
    try {
      const u = new URL(sourceUrl);
      for (const [k, v] of u.searchParams.entries()) {
        if (!["start", "num", "minb", "maxb", "micr", "macr"].includes(k)) {
          params[k] = v;
        }
      }
    } catch (_) {}
    if (Object.keys(params).length > 0) {
      const name = formatItemDisplayName(item, item.tradeId);
      const cacheKey = `search_${JSON.stringify(params)}`;
      const floor = await discoverCustomLowestBin(params, name, cacheKey, manualBin);
      return { floor, name, isConsumable: false };
    }
  }

  return { floor: 0, name: formatItemDisplayName(item, item.tradeId), isConsumable: false };
}

// Calcola o scopre il prezzo di vendita corretto per qualsiasi carta vinta (Fodder, Consumabile, Manager, Giocatore)
async function resolveItemSellPrice(item, tracked = null) {
  let sellPrice = tracked?.sellPrice || 0;
  let tierTag = "";

  if (tracked?.basePrice && tracked.basePrice > 0) {
    if (targetMode === "managers" || tracked?.isManager) {
      return { sellPrice: tracked.basePrice, tierTag: " [Istantaneo: Lowest BIN live]" };
    }
    if (targetMode === "manual" || tracked?.isManual || strategyMode === "bidding") {
      let sellPrice = tracked.basePrice;
      if (tracked.isConsumable && sellPrice > 5000) sellPrice = 5000;
      return { sellPrice, tierTag: " [Istantaneo: Lowest BIN live]" };
    }
    const tiered = getTieredSellPrice(tracked.basePrice, null, false);
    return { sellPrice: tiered.price, tierTag: ` (Tier ${tiered.tier}: +${tiered.markup}%)` };
  }

  if (sellPrice > 0) {
    return { sellPrice, tierTag: "" };
  }

  const data = item.itemData || item || {};

  // 1. Modalità Fodder
  if (targetMode === "fodder" || tracked?.isFodder) {
    const fFloor = await getFodderPriceForItem(data);
    if (fFloor > 0) {
      const tiered = getTieredSellPrice(fFloor, null, false);
      return { sellPrice: tiered.price, tierTag: ` (Tier ${tiered.tier}: +${tiered.markup}%)` };
    }
  }

  // 2. Modificatore campionato allenatore
  const lgId = detectManagerLeague(item);
  if (lgId && MANAGER_LEAGUES[lgId]) {
    console.log(`[FC Sniper Pricing] Risoluzione dinamica prezzo per Modificatore ${MANAGER_LEAGUES[lgId].name}...`);
    const floor = await discoverLeagueModifierLowestBin(lgId, manualBin);
    if (floor > 0) {
      const tiered = getTieredSellPrice(floor, null, true);
      return { sellPrice: tiered.price, tierTag: ` (Tier ${tiered.tier}: +${tiered.markup}%)` };
    }
  }

  // 2b. Allenatore (Manager) - Vendita istantanea al Lowest BIN live (senza maggiorazioni tier)
  const mgrNat = detectManager(item);
  if (mgrNat || data.itemType === "manager" || targetMode === "managers" || tracked?.isManager) {
    const nat = mgrNat || data.nation || tracked?.nation || (managerNation.includes(",") ? managerNation.split(",")[0] : managerNation);
    console.log(`[FC Sniper Pricing] Risoluzione dinamica prezzo per Allenatore (Naz ${nat})...`);
    const floor = await discoverManagerLowestBin(nat, manualBin);
    if (floor > 0) {
      return { sellPrice: floor, tierTag: " [Istantaneo: Lowest BIN live]" };
    }
  }

  // 3. Stile intesa (Training con stile valido)
  const detectedStyleId = detectChemistryStyle(item, tracked?.playStyleId);
  if (detectedStyleId && CHEM_STYLES[String(detectedStyleId)]) {
    console.log(`[FC Sniper Pricing] Risoluzione dinamica prezzo per ${CHEM_STYLES[String(detectedStyleId)].name}...`);
    const floor = await discoverConsumableLowestBin(detectedStyleId, manualBin);
    if (floor > 0) {
      const tiered = getTieredSellPrice(floor, null, true);
      return { sellPrice: tiered.price, tierTag: ` (Tier ${tiered.tier}: +${tiered.markup}%)` };
    }
  }

  // 4. Modalità Manuale o Carta Bidding Manuale (Allenatore, Calciatore, Consumabile generico)
  if (targetMode === "manual" || tracked?.isManual || strategyMode === "bidding") {
    console.log(`[FC Sniper Pricing] Risoluzione prezzo tramite Auto-Discovery Manual Bidding (vendita istantanea al floor)...`);
    const res = await discoverManualItemLowestBin(item, tracked);
    if (res.floor > 0) {
      // Nel manual bidding vendita istantanea al Lowest BIN live (senza maggiorazioni di tier)
      let sellPrice = res.floor;
      if (res.isConsumable && sellPrice > 5000) sellPrice = 5000;
      return { sellPrice, tierTag: " [Istantaneo: Lowest BIN live]" };
    }
  }

  return { sellPrice: 0, tierTag: "" };
}

// Motore di SNIPING Consumabili (Stili Intesa) - Ottimizzato per massima velocità e zero ritardi
async function sendConsumableResearchRequest() {
  let i = 0;
  const targetStyles = (chemStyle === "all") ? ["268", "266", "265", "260"] : [chemStyle];
  let styleIndex = 0;

  // Pre-calcolo e fissaggio dei prezzi per tutti gli stili target PRIMA di entrare nel loop di snipe
  // Questo elimina ogni delay/blocco dovuto a scansioni secondarie durante lo sniping
  const styleConfig = {};
  for (const sId of targetStyles) {
    const meta = CHEM_STYLES[sId] || { id: sId, name: `Stile ${sId}`, defaultGuess: 3000 };
    const mPrice = await discoverConsumableLowestBin(sId, manualBin, true);
    let sPrice;
    if (maxSnipePrice && maxSnipePrice > 0) {
      sPrice = maxSnipePrice;
    } else {
      sPrice = roundDownToStep(mPrice * 0.82);
    }
    styleConfig[sId] = { meta, marketPrice: mPrice, snipePrice: sPrice };
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[SNIPING TARGET] ${meta.name} -> Mercato: ${mPrice} cr | Compra Ora Snipe: <= ${sPrice} cr`
    });
  }

  while (start === true && i < numeroTentativi) {
    const currentStyleId = targetStyles[styleIndex];
    styleIndex = (styleIndex + 1) % targetStyles.length;
    const target = styleConfig[currentStyleId];

    if (!target) {
      i++;
      continue;
    }

    if (i % 15 === 0) {
      console.log(`[FC Sniper Sniping] Tentativo ${i + 1}/${numeroTentativi}: cerca ${target.meta.name} a Compra Ora <= ${target.snipePrice}`);
    }

    const baseUrl = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket";
    const url = new URL(baseUrl);
    url.searchParams.set("num", "21");
    url.searchParams.set("start", "0");
    url.searchParams.set("type", "training");
    url.searchParams.set("cat", "playStyle");
    url.searchParams.set("playStyle", String(currentStyleId));
    url.searchParams.set("maxb", String(target.snipePrice));
    url.searchParams.delete("macr");
    // Cache busting: micr assente con probabilità ~40%, altrimenti 150 (non deterministico)
    if (Math.random() < 0.4) {
      url.searchParams.delete("micr");
    } else {
      url.searchParams.set("micr", "150");
    }

    // 1. Telemetria nativa PIN: inviata rigorosamente PRIMA della ricerca
    await triggerPinEvent("TRIGGER_PIN_SEARCH");

    try {
      const response = await fetch(url.href, {
        method: "GET",
        headers: {
          "Accept": "*/*",
          "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control": "no-cache",
          "X-UT-SID": xUtSid
        }
      });

      if (response.ok) {
        consecutiveSearchErrors = 0;
        consecutive401Errors = 0;
        const data = await response.json();
        const auctions = data.auctionInfo || [];

        if (auctions.length > 0) {
          // Filtra le carte sotto o uguali al prezzo di snipe escludendo carte già tentate
          const matching = auctions.filter(a => a.buyNowPrice > 0 && a.buyNowPrice <= target.snipePrice && !isTradeAttempted(a.tradeId));

          if (matching.length > 0) {
            // Ordina per freschezza decrescente: expires più alto (es. 3599s = listata 1s fa) in cima!
            matching.sort((a, b) => (b.expires || 0) - (a.expires || 0));
            const targetAuction = matching[0];

            idCarteAcquistate = [];
            // Invio istantaneo della richiesta di acquisto al primo candidato più recente
            const bought = await sendBuyNowRequest(targetAuction.tradeId, targetAuction.buyNowPrice, targetAuction.itemData?.id);
            if (bought) {
              await sendToTransferList();
              await sellSingleItem(targetAuction.itemData?.id, target.marketPrice);
              crediti = await getCrediti();
              sendMessageSafe({ tipo: 'CREDITI', valore: crediti });
              // Breve respiro prima di riprendere le ricerche
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

    if (start !== true) break;

    sendMessageSafe({ tipo: 'TENTATIVI_RIMASTI', valore: numeroTentativi - (i + 1) });

    // Pulizia periodica venduti ogni 25 ricerche per liberare slot
    if ((i + 1) % 25 === 0) {
      await clearSoldItem();
    }

    // Pacing sniping competitivo: 0.7s - 1.25s tra ricerche, con micro-pausa anti-limit ogni 25 ricerche
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

// Motore UNICO di LAZY TRADING (fodder / consumabili) con Bidding + Top-Up Compra Ora ibrido.
// Le differenze tra i due vecchi engine sono racchiuse in Fase 1 (costruzione prezzi/targets)
// e in pochi parametri per-mode; tutto il resto del ciclo è condiviso.
async function runLazyTradingEngine() {
  const isFodder = targetMode === "fodder";
  const tag = isFodder ? "LAZY FODDER" : (targetMode === "managerLeague" ? "LAZY CAMPIONATI" : (targetMode === "managers" ? "LAZY ALLENATORI" : "LAZY TRADING"));
  const bidTag = isFodder ? "LAZY FODDER BID" : (targetMode === "managerLeague" ? "LAZY CAMPIONATI BID" : (targetMode === "managers" ? "LAZY ALLENATORI BID" : "LAZY BID"));
  const bidActionTag = isFodder ? "LAZY FODDER BIDDING" : (targetMode === "managerLeague" ? "LAZY CAMPIONATI BIDDING" : (targetMode === "managers" ? "LAZY ALLENATORI BIDDING" : "LAZY BIDDING"));
  const topUpTag = isFodder ? "LAZY FODDER TOP-UP" : (targetMode === "managerLeague" ? "LAZY CAMPIONATI TOP-UP" : (targetMode === "managers" ? "LAZY ALLENATORI TOP-UP" : "LAZY TOP-UP"));
  let cycle = 1;
  let consecutiveSoftBansInSession = 0;
  let sessionActiveStartTime = Date.now();
  let requiresSoftBanProbe = false;
  const minBidBumps = [150, 200, 250, 300];

  while (start === true) {
    try {
      let consecutive512InCycle = 0;
      let earlyExitRateLimit = false;
      let isMacroPause = false;
      marketRestricted = false;

      sendMessageSafe({
        tipo: 'LOG',
        valore: `=== [${tag}] Inizio Ciclo #${cycle} ===`
      });

      // FASE 1: Riconciliazione aste Watchlist, rilevamento prezzi, riscossione vendite, relist automatico
      sendMessageSafe({
        tipo: 'LOG',
        valore: isFodder
          ? `[LAZY FODDER] Fase 1: Riconciliazione aste vinte, aggiornamento lista Fut.gg (Rating ${fodderRating}), riscossione vendite e relist 1 Ora...`
          : (targetMode === "managers"
            ? `[LAZY ALLENATORI] Fase 1: Riconciliazione aste vinte, auto-discovery Lowest BIN live, riscossione vendite e relist immediato...`
            : (targetMode === "managerLeague"
              ? `[LAZY CAMPIONATI] Fase 1: Riconciliazione aste vinte, rilevamento prezzi live campionati, riscossione vendite e relist ricalcolato...`
              : `[LAZY TRADING] Fase 1: Riconciliazione aste vinte, rilevamento prezzi live, riscossione vendite e relist ricalcolato...`))
      });

      // 1a. Recupera eventuali carte vinte tramite asta (Bidding) dai cicli precedenti
      await reconcileWatchlistOnStartup();
      if (start !== true) break;
      await sleep(1000);

      // 1b. Costruzione prezzi e lista target del ciclo (UNICA parte divergente tra fodder e consumabili)
      const markup = lazyMarkupPercent && lazyMarkupPercent > 0 ? lazyMarkupPercent : 10;
      // Guard-Rail Netto Minimo: garantisce un profitto netto di almeno 200 crediti (o minMargin se configurato superiore)
      const MIN_NET_PROFIT = Math.max(200, (typeof minMargin === 'number' && minMargin > 0 ? minMargin : 200));
      let cyclePrices;      // shape nativa per-mode, passata a clearSold/processUnassigned/listUnlisted
      let targets = [];     // [{ key, name, maxBid, maxBuyNow, strongBase, tierBase, isConsumableTarget, buildUrl(micr, kind), bidDataBase }]
      let minBidRequired = Infinity;
      let targetStyles = null; // solo consumabili (bilanciamento quote)
      let bidsTargetPerStyle = null;
      let minMaxBuy = 0, maxMaxBuy = 0;

      if (isFodder) {
        listaFodder = [];
        indexFodder = 0;
        await getFodderList();

        if (listaFodder.length === 0) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[LAZY FODDER] Nessun giocatore trovato per Rating ${fodderRating} dal server locale. Attendo 10s prima di riprovare...`
          });
          await sleep(10000);
          continue;
        }

        const validPrices = listaFodder.map(f => f.price).filter(p => typeof p === 'number' && p > 0);
        if (validPrices.length === 0) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[LAZY FODDER] Nessun prezzo valido disponibile per Rating ${fodderRating}. Attendo 10s...`
          });
          await sleep(10000);
          continue;
        }

        const playerPriceMap = new Map();
        listaFodder.forEach(f => {
          const pPrice = Number(f.price) || 0;
          const pTierA = roundUpToStep(pPrice * 1.06);
          const pTierB = roundUpToStep(pPrice * (1 + (markup / 100)));
          const pTierC = roundUpToStep(pPrice * 1.15);
          const minNet = Math.floor(pTierA * 0.95);
          const maxBuy = roundDownToStep(minNet - MIN_NET_PROFIT);

          const pInfo = {
            name: f.name || "",
            basePrice: pPrice,
            tierAPrice: pTierA,
            tierBPrice: pTierB,
            tierCPrice: pTierC,
            maxBuyAllowed: maxBuy
          };
          playerPriceMap.set(String(f.pid), pInfo);
          f.priceInfo = pInfo;
        });

        // Ordina i fodder dal più economico al più costoso
        listaFodder.sort((a, b) => (a.price || 999999) - (b.price || 999999));

        const benchmarkFloor = listaFodder[0]?.price || 0;
        const maxPlayerPrice = listaFodder[listaFodder.length - 1]?.price || benchmarkFloor;
        minMaxBuy = listaFodder[0]?.priceInfo?.maxBuyAllowed || 0;
        maxMaxBuy = listaFodder[listaFodder.length - 1]?.priceInfo?.maxBuyAllowed || minMaxBuy;

        cyclePrices = {
          benchmarkFloor: benchmarkFloor,
          floorBin: benchmarkFloor,
          sellPrice: listaFodder[0]?.priceInfo?.tierBPrice || 0,
          tierAPrice: listaFodder[0]?.priceInfo?.tierAPrice || 0,
          tierBPrice: listaFodder[0]?.priceInfo?.tierBPrice || 0,
          tierCPrice: listaFodder[0]?.priceInfo?.tierCPrice || 0,
          maxBidAllowed: maxMaxBuy,
          maxBuyNowAllowed: maxMaxBuy,
          rating: fodderRating,
          playerPriceMap: playerPriceMap
        };

        sendMessageSafe({
          tipo: 'LOG',
          valore: `[PREZZI FODDER CICLO #${cycle}] Rating ${fodderRating} (${listaFodder.length} giocatori) -> Valori Fut.gg: ${benchmarkFloor} - ${maxPlayerPrice} cr | Prezzi Max Safe individuali: da ${minMaxBuy} a ${maxMaxBuy} cr (Margine netto min: +200 cr garantito) | Vendite Scaglionate 1 ORA (Tier A +6%, Tier B +${markup}%, Tier C +15%)`
        });

        targets = listaFodder.filter(p => p && p.pid && p.priceInfo && p.priceInfo.maxBuyAllowed >= 150).map(p => {
          const pi = p.priceInfo;
          return {
            key: String(p.pid),
            name: p.name || 'PID ' + p.pid,
            maxBid: pi.maxBuyAllowed,
            maxBuyNow: pi.maxBuyAllowed,
            strongBase: pi.maxBuyAllowed,
            tierBase: pi.basePrice,
            sellPrice: pi.tierBPrice,
            tierIsConsumable: false,
            buildUrl: (micr, kind) => {
              const url = new URL("https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket");
              url.searchParams.set("num", "21");
              url.searchParams.set("start", "0");
              url.searchParams.set("type", "player");
              url.searchParams.set("maskedDefId", String(p.pid));
              url.searchParams.set(kind === "bid" ? "macr" : "maxb", String(pi.maxBuyAllowed));
              url.searchParams.set("micr", String(micr));
              return url;
            },
            bidDataBase: { pid: p.pid, name: p.name, playStyleId: null, basePrice: pi.basePrice, isConsumable: false }
          };
        });
        minBidRequired = minMaxBuy;
      } else if (targetMode === "managerLeague") {
        // Modificatori Campionato Allenatore: un target per ciascuno dei top 5 campionati
        targetStyles = Object.keys(MANAGER_LEAGUES); // ["13","53","31","19","16"] usati come indice
        const leagueKeys = targetStyles.map(leagueTargetKey);

        cyclePrices = {};
        for (const lgId of targetStyles) {
          if (start !== true) break;
          const meta = MANAGER_LEAGUES[lgId];
          const key = leagueTargetKey(lgId);
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[Auto-Discovery Ciclo #${cycle}] Rilevamento Lowest BIN per Modificatore ${meta.name}...`
          });

          const floor = await discoverLeagueModifierLowestBin(lgId, manualBin, false);
          if (start !== true) break;
          if (floor && floor > 0) {
            const pTierA = Math.min(5000, roundUpToStep(floor * 1.06));
            const pTierB = Math.min(5000, roundUpToStep(floor * (1 + (markup / 100))));
            const pTierC = Math.min(5000, roundUpToStep(floor * 1.15));

            // Cap-Awareness: mai oltre il tetto EA dei consumabili (5000 cr max -> 5000 * 0.95 = 4750 - 200 = 4550 -> max 4500)
            const minNetRevenue = Math.floor(pTierA * 0.95);
            let maxBuyAllowed = roundDownToStep(minNetRevenue - MIN_NET_PROFIT);
            if (maxBuyAllowed > 4500) {
              maxBuyAllowed = 4500;
            }

            // Guard-Rail Netto Minimo: se il prezzo massimo d'acquisto calcolato è inferiore alla prima offerta valida EA (150 cr),
            // non possiamo garantire il profitto netto minimo di sicurezza (+MIN_NET_PROFIT cr) -> escludi dalle offerte
            if (maxBuyAllowed < 150) {
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[GUARD-RAIL NETTO MINIMO] Modificatore ${meta.name} (Floor: ${floor} cr): prezzo max d'acquisto (${maxBuyAllowed} cr) insufficiente per garantire il margine netto minimo di +${MIN_NET_PROFIT} cr. Campionato escluso in questo ciclo!`
              });
              continue;
            }

            cyclePrices[key] = {
              floorBin: floor,
              maxBidAllowed: maxBuyAllowed,
              maxBuyNowAllowed: maxBuyAllowed,
              sellPrice: pTierB,
              meta: meta,
              tierAPrice: pTierA,
              tierBPrice: pTierB,
              tierCPrice: pTierC
            };

            const minProfitText = (minNetRevenue - maxBuyAllowed);
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[PREZZI CICLO #${cycle}] Modificatore ${meta.name} -> Floor: ${floor} | Prezzo Max Acquisto: <= ${maxBuyAllowed} (Profitto netto min garantito: +${minProfitText} cr) | Vendite Scaglionate: A (+6%): ${pTierA}, B (+${markup}%): ${pTierB}, C (+15%): ${pTierC}`
            });
          }
          if (start !== true) break;
          await sleep(getRandomGaussian(1.5, 0.2, 1.2, 1.8) * 1000);
        }
        if (start !== true) break;

        targetStyles = leagueKeys; // da qui in poi le quote paritarie usano le chiavi league_X
        targets = leagueKeys.filter(key => cyclePrices[key] && cyclePrices[key].maxBidAllowed >= 150).map(key => {
          const pi = cyclePrices[key];
          const lgId = key.slice(7);
          return {
            key: key,
            name: `Modificatore ${pi.meta.name}`,
            maxBid: pi.maxBidAllowed,
            maxBuyNow: pi.maxBuyNowAllowed,
            strongBase: pi.floorBin,
            tierBase: pi.floorBin,
            sellPrice: pi.sellPrice,
            tierIsConsumable: true,
            // Filtro server-side via amount=<leagueId> + validazione client-side di sicurezza
            itemFilter: (a) => detectManagerLeague(a) === lgId,
            buildUrl: (micr, kind) => {
              const url = new URL("https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket");
              url.searchParams.set("num", "21");
              url.searchParams.set("start", "0");
              url.searchParams.set("type", "training");
              url.searchParams.set("cat", "managerLeagueModifier");
              url.searchParams.set("amount", String(lgId));
              url.searchParams.set(kind === "bid" ? "macr" : "maxb", String(kind === "bid" ? pi.maxBidAllowed : pi.maxBuyNowAllowed));
              url.searchParams.set("micr", String(micr));
              return url;
            },
            bidDataBase: { playStyleId: null, leagueId: lgId, amount: Number(lgId), name: `Modificatore ${pi.meta.name}`, isConsumable: true }
          };
        });
        if (targets.length === 0) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[LAZY CAMPIONATI] Nessun campionato rispetta il guard-rail di margine netto minimo (+${MIN_NET_PROFIT} cr). Attendo il prossimo ciclo...`
          });
        }
        minBidRequired = targets.length > 0 ? Math.min(...targets.map(t => t.maxBid)) : Infinity;
      } else if (targetMode === "managers") {
        // Modalità Allenatori: una o più nazioni selezionate (es. "18,34" -> Francia + Olanda)
        const selectedNats = (managerNation || "18,34").split(",").map(s => s.trim()).filter(Boolean);
        const managerKeys = selectedNats.map(managerTargetKey);

        cyclePrices = {};
        for (const natId of selectedNats) {
          if (start !== true) break;
          const meta = TOP_MANAGER_NATIONS[natId] || { id: Number(natId), name: NATION_NAMES[natId] || `Naz ${natId}` };
          const key = managerTargetKey(natId);
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[Auto-Discovery Ciclo #${cycle}] Rilevamento Lowest BIN per Allenatore ${meta.name}...`
          });

          const floor = await discoverManagerLowestBin(natId, manualBin, false);
          if (start !== true) break;
          if (floor && floor > 0) {
            // Acquisto con tetto massimo a -15% rispetto al Lowest BIN calcolato (su BIN 3000 -> max buy 2500)
            const maxBuyAllowed = roundDownToStep(floor * 0.85);

            if (maxBuyAllowed < 150) {
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[GUARD-RAIL] Allenatore ${meta.name} (Floor: ${floor} cr): prezzo max d'acquisto a -15% (${maxBuyAllowed} cr) inferiore al minimo di mercato (150 cr). Nazione esclusa in questo ciclo!`
              });
              continue;
            }

            cyclePrices[key] = {
              floorBin: floor,
              maxBidAllowed: maxBuyAllowed,
              maxBuyNowAllowed: maxBuyAllowed,
              sellPrice: floor, // Vendita istantanea al Lowest BIN live, senza maggiorazioni tier!
              meta: meta
            };

            const estProfit = Math.floor(floor * 0.95) - maxBuyAllowed;
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[PREZZI CICLO #${cycle}] Allenatore ${meta.name} -> Lowest BIN: ${floor} cr | Prezzo Max Acquisto (-15%): <= ${maxBuyAllowed} cr (Profitto netto stimato: +${estProfit} cr) | Vendita Istantanea: ${floor} cr`
            });
          }
          if (start !== true) break;
          await sleep(getRandomGaussian(1.5, 0.2, 1.2, 1.8) * 1000);
        }
        if (start !== true) break;

        targetStyles = managerKeys;
        targets = managerKeys.filter(key => cyclePrices[key] && cyclePrices[key].maxBidAllowed >= 150).map(key => {
          const pi = cyclePrices[key];
          const natId = key.slice("manager_nat_".length);
          return {
            key: key,
            name: `Allenatore ${pi.meta.name}`,
            maxBid: pi.maxBidAllowed,
            maxBuyNow: pi.maxBuyNowAllowed,
            strongBase: pi.floorBin,
            tierBase: pi.floorBin,
            sellPrice: pi.sellPrice,
            tierIsConsumable: false,
            isManagerTarget: true,
            itemFilter: (a) => {
              const data = a.itemData || a;
              return (data.itemType === "manager" || a.itemType === "manager") &&
                     (String(data.nation) === String(natId) || String(a.nation) === String(natId));
            },
            buildUrl: (micr, kind) => {
              const url = new URL("https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket");
              url.searchParams.set("num", "21");
              url.searchParams.set("start", "0");
              url.searchParams.set("type", "staff");
              url.searchParams.set("cat", "manager");
              url.searchParams.set("nat", String(natId));
              url.searchParams.set(kind === "bid" ? "macr" : "maxb", String(kind === "bid" ? pi.maxBidAllowed : pi.maxBuyNowAllowed));
              url.searchParams.set("micr", String(micr));
              return url;
            },
            bidDataBase: {
              nat: natId,
              nation: Number(natId),
              name: `Allenatore ${pi.meta.name}`,
              isManager: true,
              isConsumable: false,
              basePrice: pi.floorBin,
              sellPrice: pi.floorBin
            }
          };
        });
        if (targets.length === 0) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[LAZY ALLENATORI] Nessuna nazione allenatori selezionata ha prezzi validi. Attendo il prossimo ciclo...`
          });
        }
        minBidRequired = targets.length > 0 ? Math.min(...targets.map(t => t.maxBid)) : Infinity;
      } else {
        targetStyles = (chemStyle === "all") ? ["268", "266", "265", "260"] : [String(chemStyle)];

        cyclePrices = {};
        for (const sId of targetStyles) {
          if (start !== true) break;
          const meta = CHEM_STYLES[sId] || { id: sId, name: `Stile ${sId}` };
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[Auto-Discovery Ciclo #${cycle}] Rilevamento Lowest BIN per ${meta.name}...`
          });

          const floor = await discoverConsumableLowestBin(sId, manualBin, false);
          if (start !== true) break;
          if (floor && floor > 0) {
            const pTierA = Math.min(5000, roundUpToStep(floor * 1.06));
            const pTierB = Math.min(5000, roundUpToStep(floor * (1 + (markup / 100))));
            const pTierC = Math.min(5000, roundUpToStep(floor * 1.15));

            // Cap-Awareness: mai più di 4.500 cr (5000 * 0.95 = 4750 - 200 = 4550 -> max 4500)
            const minNetRevenue = Math.floor(pTierA * 0.95);
            let maxBuyAllowed = roundDownToStep(minNetRevenue - MIN_NET_PROFIT);
            if (maxBuyAllowed > 4500) {
              maxBuyAllowed = 4500;
            }

            // Guard-Rail Netto Minimo: se il prezzo massimo d'acquisto calcolato è inferiore alla prima offerta valida EA (150 cr),
            // non possiamo garantire il profitto netto minimo di sicurezza (+MIN_NET_PROFIT cr) -> escludi dalle offerte
            if (maxBuyAllowed < 150) {
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[GUARD-RAIL NETTO MINIMO] ${meta.name} (Floor: ${floor} cr): prezzo max d'acquisto (${maxBuyAllowed} cr) insufficiente per garantire il margine netto minimo di +${MIN_NET_PROFIT} cr. Stile escluso in questo ciclo!`
              });
              continue;
            }

            cyclePrices[sId] = {
              floorBin: floor,
              maxBidAllowed: maxBuyAllowed,
              maxBuyNowAllowed: maxBuyAllowed,
              sellPrice: pTierB,
              meta: meta,
              tierAPrice: pTierA,
              tierBPrice: pTierB,
              tierCPrice: pTierC
            };

            const minProfitText = (minNetRevenue - maxBuyAllowed);
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[PREZZI CICLO #${cycle}] ${meta.name} -> Floor: ${floor} | Prezzo Max Acquisto: <= ${maxBuyAllowed} (Profitto netto min garantito: +${minProfitText} cr) | Vendite Scaglionate: A (+6%): ${pTierA}, B (+${markup}%): ${pTierB}, C (+15%): ${pTierC}`
            });
          }
          if (start !== true) break;
          await sleep(getRandomGaussian(1.5, 0.2, 1.2, 1.8) * 1000);
        }
        if (start !== true) break;

        targets = targetStyles.filter(sId => cyclePrices[sId] && cyclePrices[sId].maxBidAllowed >= 150).map(sId => {
          const pi = cyclePrices[sId];
          return {
            key: sId,
            name: pi.meta.name,
            maxBid: pi.maxBidAllowed,
            maxBuyNow: pi.maxBuyNowAllowed,
            strongBase: pi.floorBin,
            tierBase: pi.floorBin,
            sellPrice: pi.sellPrice,
            tierIsConsumable: true,
            buildUrl: (micr, kind) => {
              const url = new URL("https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket");
              url.searchParams.set("num", "21");
              url.searchParams.set("start", "0");
              url.searchParams.set("type", "training");
              url.searchParams.set("cat", "playStyle");
              url.searchParams.set("playStyle", String(sId));
              url.searchParams.set(kind === "bid" ? "macr" : "maxb", String(kind === "bid" ? pi.maxBidAllowed : pi.maxBuyNowAllowed));
              url.searchParams.set("micr", String(micr));
              return url;
            },
            bidDataBase: { playStyleId: sId, name: pi.meta.name, isConsumable: true }
          };
        });
        if (targets.length === 0) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[LAZY CONSUMABILI] Nessuno stile intesa rispetta il guard-rail di margine netto minimo (+${MIN_NET_PROFIT} cr). Attendo il prossimo ciclo...`
          });
        }
        minBidRequired = targets.length > 0 ? Math.min(...targets.map(t => t.maxBid)) : Infinity;
      }

      // 1c. Rimuove le vendute e rimette in vendita quelle invendute con prezzi ricalcolati
      await clearSoldItem(cyclePrices);
      if (start !== true) break;
      await sleep(1500);

      // 1d. Mette in vendita eventuali carte bloccate nei Non Assegnati o in Tradepile
      await processUnassignedItems(cyclePrices);
      if (start !== true) break;
      await sleep(1000);
      await listUnlistedTradepileItems(cyclePrices);
      if (start !== true) break;
      await sleep(1000);

      // 1e. Aggiornamento crediti
      crediti = await getCrediti();
      sendMessageSafe({ tipo: 'CREDITI', valore: crediti });

      if (start !== true) break;

      // FASE 2: Analisi capienza Tradepile e determinazione Target di Ciclo
      const pileInfo = await getTradepileInfo();
      const currentActiveCount = pileInfo.active || 0;
      const currentTotalCount = pileInfo.total || 0;
      const unlistedCount = Math.max(0, currentTotalCount - currentActiveCount);
      const MAX_TRADEPILE_LIMIT = 100;
      const targetSize = targetTradepileSize && targetTradepileSize > 0 ? Math.min(targetTradepileSize, MAX_TRADEPILE_LIMIT) : 50;

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
        const unitName = targetMode === "managers" ? "nazione" : (targetMode === "managerLeague" ? "campionato" : "stile");
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[BILANCIAMENTO TRADEPILE] Presenze attuali: ${presenceLog} (Quota paritaria: ${Math.round(100 / targetStyles.length)}% per ${unitName})`
        });
      }

      // Spazio fisicamente libero nella Tradepile EA (max 100 totali)
      const physicalFreeSlots = Math.max(0, MAX_TRADEPILE_LIMIT - currentTotalCount);
      const neededToTarget = Math.max(0, targetSize - currentTotalCount);
      const rawMissing = Math.min(physicalFreeSlots, neededToTarget);

      const isListingBlocked = Date.now() < listingRestrictedUntil;
      let cycleTarget = 0;
      if (isListingBlocked && (unlistedCount >= 6 || currentTotalCount >= 85)) {
        const remainingMin = Math.ceil((listingRestrictedUntil - Date.now()) / 60000);
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[COOLDOWN LISTING ATTIVO] Ci sono ${unlistedCount} carte in attesa di vendita (${currentTotalCount}/100 in Tradepile) e il listing EA è in pausa (${remainingMin} min). Sospendo acquisti per non bloccare altri crediti.`
        });
        cycleTarget = 0;
      } else {
        // Lotto di riempimento dinamico (fodder più prudente dei consumabili)
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

      // FASE 3: Rifornimento Ibrido Protetto (Mass Bidding mirato + eventuale Rabbocco Compra Ora)
      if (cycleTarget > 0 && start === true) {
        if (targets.length === 0) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[${tag}] Impossibile determinare i prezzi di mercato. Salto il rifornimento per questo ciclo.`
          });
        } else {
          let wonInThisCycle = 0;
          let totalBidsPlaced = 0;
          let searchCount = 0;
          let consecutiveErrorsCount = 0;
          let bidPriceOffset = 0;
          const styleSearchCounts = {};
          const bidsPerStyle = {};
          // Quota offerte a ciclo (cap ridotto per ridurre i soft-ban EA)
          const MAX_BIDS_PER_CYCLE = isFodder
            ? Math.min(15, cycleTarget)
            : (rawMissing >= 25 ? 30 : Math.min(30, Math.max(cycleTarget, rawMissing * 2)));
          // Quota paritaria di offerte per ciascuno stile (solo consumabili)
          if (!isFodder) {
            const bidsBaseQuota = Math.max(1, Math.floor(MAX_BIDS_PER_CYCLE / targetStyles.length));
            const bidsRemainder = MAX_BIDS_PER_CYCLE % targetStyles.length;
            bidsTargetPerStyle = {};
            targetStyles.forEach((sId, idx) => {
              bidsTargetPerStyle[sId] = bidsBaseQuota + (idx < bidsRemainder ? 1 : 0);
            });
          }
          consecutive461InBidding = 0;
          consecutive512InCycle = 0;
          marketRestricted = false;
          let stopBiddingDueTo461 = false;
          const maxBiddingSearches = isFodder ? Math.max(25, cycleTarget * 3) : Math.max(80, Math.round(MAX_BIDS_PER_CYCLE * 2.5));
          const MAX_ACTIVE_WATCHLIST = isFodder ? 35 : 45; // Cuscinetto di sicurezza sui 50 slot EA
          let targetCycleIdx = 0;

          if (!isFodder) {
            const bidsQuotaLog = targetStyles.map(sId => {
              const name = targetDisplayName(sId).replace("Modificatore ", "").replace("Allenatore ", "");
              return `${name}: ${bidsTargetPerStyle[sId]}`;
            }).join(" | ");
            const unitName = targetMode === "managers" ? "nazione" : (targetMode === "managerLeague" ? "campionato" : "stile");
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[${bidActionTag}] Step 1: Offerte all'asta paritarie (Quota offerte per ${unitName}: ${bidsQuotaLog} | Totale: ${MAX_BIDS_PER_CYCLE}). Finestra 1-10 min, controrilanci attivi...`
            });
          } else {
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[LAZY FODDER BIDDING] Step 1: Offerte all'asta a sconto (Target: ${cycleTarget} carte, Max offerte: ${MAX_BIDS_PER_CYCLE}, Prezzi Max: ${minMaxBuy}-${maxMaxBuy} cr). Rotazione sui giocatori Rating ${fodderRating}...`
            });
          }

          // Loop Offerte all'asta (Step 1)
          let lastWatchlistCheckTime = Date.now();
          while (wonInThisCycle < cycleTarget && searchCount < maxBiddingSearches && start === true) {
            if (marketRestricted || earlyExitRateLimit) break;

            // PRIORITÀ ASSOLUTA: Difesa aste in chiusura o scadute (<= 50s)
            // Sospende la ricerca di nuove aste e protegge le offerte in corso con controrilanci immediati
            while (activeBids.size > 0 && getUrgentAuctionTimeRemaining(activeBids) <= 50000 && start === true && !marketRestricted && !earlyExitRateLimit) {
              const secLeft = Math.max(0, Math.round(getUrgentAuctionTimeRemaining(activeBids) / 1000));
              console.log(`[${bidActionTag}] Priorità difesa asta in chiusura (~${secLeft}s). Controllo Watchlist...`);
              await sleep(getRandomGaussian(2.5, 0.3, 2.0, 3.2) * 1000);
              const prevWon = carteAcquistate;
              await resolveWatchlist();
              lastWatchlistCheckTime = Date.now();
              if (carteAcquistate > prevWon) {
                wonInThisCycle += (carteAcquistate - prevWon);
                consecutive461InBidding = 0;
                sendMessageSafe({
                  tipo: 'LOG',
                  valore: `[PROGRESSO CICLO] Lotto acquisti: ${wonInThisCycle}/${cycleTarget} carte acquisite.`
                });
                if (wonInThisCycle >= cycleTarget) break;
              }
            }
            if (wonInThisCycle >= cycleTarget || start !== true || marketRestricted || earlyExitRateLimit) break;

            // Controllo periodico Watchlist (ogni 15s se ci sono offerte attive) per sincronizzare scadenze e rilevare superamenti tempestivamente
            if (activeBids.size > 0 && Date.now() - lastWatchlistCheckTime >= 15000) {
              const prevWon = carteAcquistate;
              await resolveWatchlist();
              lastWatchlistCheckTime = Date.now();
              if (carteAcquistate > prevWon) {
                wonInThisCycle += (carteAcquistate - prevWon);
                consecutive461InBidding = 0;
                sendMessageSafe({
                  tipo: 'LOG',
                  valore: `[PROGRESSO CICLO] Lotto acquisti: ${wonInThisCycle}/${cycleTarget} carte acquisite.`
                });
                if (wonInThisCycle >= cycleTarget) break;
              }
            }

            if (!isFodder) {
              // Se tutti i target hanno già raggiunto la propria quota paritaria di offerte
              const allBidsFilled = targetStyles.every(sId => (bidsPerStyle[sId] || 0) >= (bidsTargetPerStyle[sId] || 1));
              if (allBidsFilled || totalBidsPlaced >= MAX_BIDS_PER_CYCLE) {
                const unitName = targetMode === "managers" ? "nazioni" : (targetMode === "managerLeague" ? "campionati" : "stili");
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

            // Verifica rapida crediti (saldo in memoria, senza chiamata extra)
            if (typeof crediti === 'number' && crediti < minBidRequired && activeBids.size === 0) {
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[${bidTag}] Crediti insufficienti (${crediti} < ${minBidRequired}). Passo al controllo completamento.`
              });
              break;
            }

            // Controllo capienza offerte: Watchlist quasi satura o offerte pendenti pari ai posti liberi
            const inFlightLimitHit = isFodder
              ? ((wonInThisCycle + activeBids.size) >= (cycleTarget + 2) || activeBids.size >= MAX_ACTIVE_WATCHLIST)
              : (activeBids.size >= MAX_ACTIVE_WATCHLIST || (wonInThisCycle + activeBids.size) >= physicalFreeSlots);
            if (inFlightLimitHit) {
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[${bidActionTag}] Quota offerte in volo raggiunta (${activeBids.size} attive, ${wonInThisCycle}/${cycleTarget} vinte). Monitoraggio risoluzione aste...`
              });
              while (inFlightLimitHit && activeBids.size > 0 && start === true) {
                await sleep(getRandomGaussian(2.0, 0.3, 1.5, 2.5) * 1000);
                const prevWon = carteAcquistate;
                await resolveWatchlist();
                if (carteAcquistate > prevWon) {
                  wonInThisCycle += (carteAcquistate - prevWon);
                  consecutive461InBidding = 0;
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

            // Quota paritaria per stile (solo consumabili)
            if (!isFodder && (bidsPerStyle[target.key] || 0) >= (bidsTargetPerStyle[target.key] || 1)) {
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
              "X-UT-SID": xUtSid
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
                consecutiveSearchErrors = 0;
                consecutive401Errors = 0;
                const data = await res.json();
                const auctions = data.auctionInfo || [];

                // Aste mirate: per allenatori finestra ridotta a 3 min (<= 180s, fallback 240s) per non bloccare crediti.
                // Per fodder/consumabili: finestra 5 min (<= 300s, fallback 600s).
                const maxInitialExpiry = targetMode === "managers" ? 180 : 300;
                const maxFallbackExpiry = targetMode === "managers" ? 240 : 600;

                let targetAuctions = auctions.filter(a =>
                  a.expires > 0 &&
                  a.expires <= maxInitialExpiry &&
                  a.bidState !== "highest" &&
                  !activeBids.has(String(a.tradeId)) &&
                  !isTradeAttempted(a.tradeId)
                );
                if (targetAuctions.length === 0) {
                  targetAuctions = auctions.filter(a =>
                    a.expires > 0 &&
                    a.expires <= maxFallbackExpiry &&
                    a.bidState !== "highest" &&
                    !activeBids.has(String(a.tradeId)) &&
                    !isTradeAttempted(a.tradeId)
                  );
                }

                // Filtro client-side opzionale del target (es. modificatori campionato: filtra per leagueId)
                if (target.itemFilter) {
                  targetAuctions = targetAuctions.filter(target.itemFilter);
                }

                targetAuctions.sort((a, b) => (a.expires || 0) - (b.expires || 0));

                let bidsInThisSearch = 0;
                let consecutiveFailedBidsInSearch = 0;
                for (const auction of targetAuctions) {
                  if (bidsInThisSearch >= 2) break; // Max 2 offerte per ricerca: previene burst EA
                  if (consecutiveFailedBidsInSearch >= 2) break;
                  if (!isFodder && ((bidsPerStyle[target.key] || 0) >= (bidsTargetPerStyle[target.key] || 1) || totalBidsPlaced >= MAX_BIDS_PER_CYCLE)) break;
                  const capBreak = isFodder
                    ? (start !== true || wonInThisCycle >= cycleTarget || (wonInThisCycle + activeBids.size) >= (cycleTarget + 2) || activeBids.size >= MAX_ACTIVE_WATCHLIST)
                    : (start !== true || wonInThisCycle >= cycleTarget || (wonInThisCycle + activeBids.size) >= physicalFreeSlots || activeBids.size >= MAX_ACTIVE_WATCHLIST);
                  if (capBreak) break;

                  const minNextBid = calculateNextBid(auction.startingBid, auction.currentBid);
                  // Guard-Rail Netto Minimo: se l'offerta minima necessaria supera il tetto massimo consentito, salta l'asta
                  if (minNextBid > target.maxBid) {
                    continue;
                  }
                  // Strong Bid: offre subito circa il 70% del riferimento per eliminare la concorrenza casuale (per allenatori partiamo da minNextBid per comprare a sconto)
                  const strongBidTarget = roundUpToStep(target.strongBase * 0.70);
                  const nextBid = target.isManagerTarget
                    ? minNextBid
                    : Math.min(target.maxBid, Math.max(minNextBid, strongBidTarget));

                  if (nextBid <= target.maxBid) {
                    // Controllo preventivo crediti per non inviare richieste a vuoto
                    if (typeof crediti === 'number' && crediti < nextBid) {
                      console.log(`[${bidTag}] Saldo crediti insufficiente per offerta (${crediti} cr < ${nextBid} cr richiesti). Salto asta.`);
                      continue;
                    }

                    // Sonda di verifica preliminare post-softban (1 sola offerta di prova)
                    if (requiresSoftBanProbe) {
                      sendMessageSafe({
                        tipo: 'LOG',
                        valore: `[SONDA ANTI-BAN] Verifica preliminare permessi offerte dopo la pausa di riposo (1 sola offerta test)...`
                      });
                    }

                    // Ritardo umano di ispezione asta (600ms - 1100ms) prima di cliccare "Offri"
                    await sleep(getRandomGaussian(0.8, 0.15, 0.6, 1.1) * 1000);

                    const bidSuccess = await sendBidRequest(auction.tradeId, nextBid, auction.itemData?.id, target.maxBid);

                    if (requiresSoftBanProbe) {
                      if (!bidSuccess && lastBidErrorStatus === 461) {
                        sendMessageSafe({
                          tipo: 'LOG',
                          valore: `[SONDA ANTI-BAN] L'offerta di test ha ricevuto 461 (Soft-ban EA ancora attivo). L'account necessita di ulteriore riposo: rientro in pausa senza insistere.`
                        });
                        marketRestricted = true;
                        earlyExitRateLimit = true;
                        break;
                      } else if (bidSuccess) {
                        requiresSoftBanProbe = false;
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
                      consecutive461InBidding = 0;
                      if (typeof crediti === 'number') crediti = Math.max(0, crediti - nextBid);
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

                      consecutive512InCycle = 0;
                      consecutiveErrorsCount = 0;

                      // Pacing umano naturale tra offerte (4.8s - 7.0s) contro i picchi antispam EA
                      await sleep(getRandomGaussian(5.5, 0.5, 4.8, 7.0) * 1000);

                      // Pausa distensiva ogni 5 offerte piazzate per far defluire il leaky bucket EA
                      if (totalBidsPlaced > 0 && totalBidsPlaced % 5 === 0) {
                        sendMessageSafe({
                          tipo: 'LOG',
                          valore: `[${bidActionTag}] Pausa distensiva anti-spam (${totalBidsPlaced} offerte piazzate)... Lascio defluire i contatori EA prima delle prossime offerte.`
                        });
                        await sleep(getRandomGaussian(12.0, 1.0, 10.0, 15.0) * 1000);
                      }
                    } else {
                      consecutiveFailedBidsInSearch++;
                      if (lastBidErrorStatus === 461) {
                        consecutive461InBidding++;
                        bidPriceOffset++; // Varia micr per bypassare la cache EA sulla prossima ricerca
                        if (consecutive461InBidding >= 3) {
                          console.log(`[${bidActionTag}] Rilevate ${consecutive461InBidding} aste contese o rifiutate (461). Concludo Step 1 e passo a Compra Ora.`);
                          sendMessageSafe({
                            tipo: 'LOG',
                            valore: `[${bidActionTag}] Mercato aste molto conteso o blocco temporaneo (3 errori 461 consecutivi). Concludo le offerte all'asta e passo direttamente a Compra Ora.`
                          });
                          await resolveWatchlist();
                          stopBiddingDueTo461 = true;
                          break;
                        }
                        // Interrompe i tentativi su questa pagina e passa alla prossima ricerca
                        break;
                      }
                      if (isRateLimitStatus(lastBidErrorStatus)) {
                        earlyExitRateLimit = true;
                        console.warn(`[${bidActionTag}] Avviso rate-limit EA (${lastBidErrorStatus}) su offerta. Attivazione Early-Exit preventiva...`);
                        reportTelemetry('EARLY_EXIT_RATE_LIMIT', `Avviso rate-limit EA (${lastBidErrorStatus}) su offerta. Uscita preventiva dagli acquisti.`, { status: lastBidErrorStatus });
                        sendMessageSafe({
                          tipo: 'LOG',
                          valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${lastBidErrorStatus}) rilevato. Per prevenire soft-ban, concludo anticipatamente gli acquisti e passo alla pausa di riposo.`
                        });
                        break;
                      }
                    }
                  }
                }
                if (marketRestricted || earlyExitRateLimit || stopBiddingDueTo461) break;
              } else if (res.status === 401) {
                await handle401Error(isFodder ? "Lazy Fodder Bidding Search" : "Lazy Bidding Search");
                break;
              } else if (res.status === 458) {
                await handleCaptchaDetected(isFodder ? "Lazy Fodder Bidding" : "Lazy Bidding");
                break;
              } else if (isRateLimitStatus(res.status)) {
                earlyExitRateLimit = true;
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

            // Risoluzione Watchlist periodica e controrilanci ogni 3 ricerche
            if (activeBids.size > 0 && searchCount % 3 === 0) {
              const prevWon = carteAcquistate;
              await resolveWatchlist();
              if (carteAcquistate > prevWon) {
                wonInThisCycle += (carteAcquistate - prevWon);
                consecutive461InBidding = 0;
                sendMessageSafe({
                  tipo: 'LOG',
                  valore: `[PROGRESSO CICLO] Lotto acquisti: ${wonInThisCycle}/${cycleTarget} carte acquisite.`
                });
              }
            }

            // Pacing umano tra ricerche (micro-pausa ogni 6)
            if (searchCount % 6 === 0) {
              await sleep(getRandomGaussian(6.0, 0.6, 5.0, 7.5) * 1000);
            } else {
              await sleep(getRandomGaussian(3.6, 0.4, 3.0, 4.5) * 1000);
            }
          }

          // Risoluzione e difesa completa di tutte le aste attive prima di procedere allo Step 2 (Compra Ora)
          // Non abbandona le aste pendenti: attende fino alla loro scadenza (max 4 min) difendendo i rilanci
          if (activeBids.size > 0 && start === true && !marketRestricted && !earlyExitRateLimit) {
            sendMessageSafe({
              tipo: 'LOG',
              valore: `[${bidTag}] Monitoraggio e risoluzione di tutte le offerte attive (${activeBids.size} in corso)...`
            });

            const maxWaitTimestamp = Date.now() + 4 * 60 * 1000;
            while (activeBids.size > 0 && Date.now() < maxWaitTimestamp && start === true && !marketRestricted && !earlyExitRateLimit) {
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
              const prevWon = carteAcquistate;
              await resolveWatchlist();
              if (carteAcquistate > prevWon) {
                wonInThisCycle += (carteAcquistate - prevWon);
                consecutive461InBidding = 0;
                sendMessageSafe({
                  tipo: 'LOG',
                  valore: `[PROGRESSO CICLO] Lotto acquisti: ${wonInThisCycle}/${cycleTarget} carte acquisite.`
                });
              }
            }

            // Chiamata finale di riconciliazione se qualche asta è rimasta aperta
            if (activeBids.size > 0 && start === true) {
              const prevWon = carteAcquistate;
              await resolveWatchlist();
              if (carteAcquistate > prevWon) {
                wonInThisCycle += (carteAcquistate - prevWon);
              }
            }
          }

          // STEP 2: RABBOCCO PROTETTO A COMPRA ORA (sniping immediato sul prezzo max consentito)
          // SALTO COMPLETO se troppi errori rate-limit nello Step 1
          if (start === true && !marketRestricted && !earlyExitRateLimit && consecutive512InCycle < 2 && consecutiveErrorsCount < 3) {
            let topUpTarget;
            if (isFodder) {
              topUpTarget = Math.max(0, cycleTarget - wonInThisCycle);
            } else {
              const midPile = await getTradepileInfo();
              const missingActive = Math.max(0, targetSize - midPile.active);
              const physicalFreeNow = Math.max(0, MAX_TRADEPILE_LIMIT - midPile.total);
              topUpTarget = Math.min(cycleTarget - wonInThisCycle, Math.min(missingActive, physicalFreeNow));
            }

            if (topUpTarget > 0) {
              const topUpLogText = isFodder
                ? `[LAZY FODDER TOP-UP] Step 2: Compra Ora rapido sotto-prezzo per completare il lotto (${topUpTarget} carte mancanti, Max Buy: <= ${minMaxBuy}-${maxMaxBuy} cr)...`
                : (targetMode === "managers"
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
              lastBidErrorStatus = 0;
              lastBuyNowErrorStatus = 0;
              consecutiveErrorsCount = 0;
              let stopTopUpDueTo461 = false;

              while (topUpBought < topUpTarget && topUpSearches < maxTopUpSearches && start === true) {
                const target = targets[topUpTargetIdx % targets.length];
                topUpTargetIdx++;

                if (!target || !target.maxBuyNow || target.maxBuyNow <= 0) {
                  topUpSearches++;
                  continue;
                }

                // Verifica crediti per Compra Ora
                if (typeof crediti === 'number' && crediti < target.maxBuyNow) {
                  sendMessageSafe({
                    tipo: 'LOG',
                    valore: `[${topUpTag}] Crediti insufficienti (${crediti} < ${target.maxBuyNow}) per ulteriori acquisti Compra Ora.`
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
                  "X-UT-SID": xUtSid
                });

                try {
                  const res = await fetch(url.href, { method: "GET", headers });
                  if (res.ok) {
                    consecutiveErrorsCount = 0;
                    const data = await res.json();
                    const auctions = data.auctionInfo || [];

                    // Esclude carte già tentate (cache anti-fantasma), solo entro il prezzo massimo consentito
                    const validAuctions = auctions.filter(a =>
                      a.buyNowPrice &&
                      a.buyNowPrice <= target.maxBuyNow &&
                      !attemptedTradeIds.has(String(a.tradeId)) &&
                      (!target.itemFilter || target.itemFilter(a))
                    );
                    validAuctions.sort((a, b) => (b.expires || 0) - (a.expires || 0));

                    if (validAuctions.length > 0) {
                      const candidate = validAuctions[0];
                      // Controllo preventivo crediti
                      if (typeof crediti === 'number' && crediti < candidate.buyNowPrice) {
                        sendMessageSafe({
                          tipo: 'LOG',
                          valore: `[${topUpTag}] Crediti insufficienti (${crediti} cr < ${candidate.buyNowPrice} cr richiesti) per acquistare ${target.name}. Concludo Step 2.`
                        });
                        break;
                      }

                      markTradeAttempted(candidate.tradeId);

                      // Acquisto istantaneo (zero-delay) non appena la carta viene trovata
                      const buySuccess = await sendBuyNowRequest(candidate.tradeId, candidate.buyNowPrice, candidate.itemData?.id);
                      if (buySuccess) {
                        topUpBought++;
                        consecutive461InTopUp = 0;
                        wonInThisCycle++;
                        carteVinteCiclo++;
                        consecutive512InCycle = 0;
                        if (typeof crediti === 'number') crediti = Math.max(0, crediti - candidate.buyNowPrice);

                        const candItemId = candidate.itemData?.id;
                        await moveSingleItemToTrade(candItemId);
                        // Pausa di assestamento database EA (800ms - 1200ms) affinché la transazione sia consolidata in Tradepile
                        await sleep(getRandomGaussian(1.0, 0.2, 0.8, 1.3) * 1000);

                        let targetSellPrice = target.sellPrice;
                        let sellLogMsg = "";
                        if (target.isManagerTarget || targetMode === "managers") {
                          targetSellPrice = target.sellPrice;
                          sellLogMsg = `al Lowest BIN live (${targetSellPrice} cr)`;
                        } else {
                          const tiered = getTieredSellPrice(target.tierBase, null, target.tierIsConsumable);
                          targetSellPrice = tiered.price;
                          sellLogMsg = `a ${tiered.price} (Tier ${tiered.tier}: +${tiered.markup}%)`;
                        }
                        const listed = await sellSingleItem(candItemId, targetSellPrice);
                        if (listed) {
                          const netEst = Math.floor(targetSellPrice * 0.95) - candidate.buyNowPrice;
                          sendMessageSafe({
                            tipo: 'LOG',
                            valore: `[${topUpTag}] Acquistata carta (${target.name}) a ${candidate.buyNowPrice} e listata ${sellLogMsg} (Netto stimato: +${netEst} cr) [${topUpBought}/${topUpTarget}]`
                          });
                        } else {
                          sendMessageSafe({
                            tipo: 'LOG',
                            valore: `[${topUpTag}] Acquistata carta (${target.name}) a ${candidate.buyNowPrice}. Spostata in lista trasferimenti [${topUpBought}/${topUpTarget}].`
                          });
                        }

                        // Respiro naturale dopo acquisto e messa in vendita: 2.8s - 4.5s
                        await sleep(getRandomGaussian(3.5, 0.4, 2.8, 4.5) * 1000);
                      } else {
                        if (isRateLimitStatus(lastBuyNowErrorStatus)) {
                          earlyExitRateLimit = true;
                          console.warn(`[${topUpTag}] Avviso rate-limit EA (${lastBuyNowErrorStatus}) su Compra Ora. Attivazione Early-Exit preventiva...`);
                          reportTelemetry('EARLY_EXIT_RATE_LIMIT', `Avviso rate-limit EA (${lastBuyNowErrorStatus}) su Compra Ora. Uscita preventiva dagli acquisti.`, { status: lastBuyNowErrorStatus });
                          sendMessageSafe({
                            tipo: 'LOG',
                            valore: `[PREVENZIONE ANTI-BAN] Segnale di rate-limit EA (${lastBuyNowErrorStatus}) rilevato su Compra Ora. Concludo anticipatamente gli acquisti e passo alla pausa di riposo.`
                          });
                          break;
                        } else {
                          if (lastBuyNowErrorStatus === 461 || lastBuyNowErrorStatus === 478) {
                            consecutive461InTopUp++;
                            minPriceOffset++;
                            const nextMinBump = minBidBumps[(styleTopUpCount + minPriceOffset) % minBidBumps.length];

                            if (consecutive461InTopUp >= 3) {
                              console.log(`[${topUpTag}] Rilevati ${consecutive461InTopUp} tentativi di Compra Ora rifiutati/anticipati (461). Concludo Step 2.`);
                              sendMessageSafe({
                                tipo: 'LOG',
                                valore: `[${topUpTag}] Rilevati 3 tentativi consecutivi di Compra Ora rifiutati/anticipati (461). Concludo gli acquisti per prevenire soft-ban e passo alla pausa di riposo.`
                              });
                              stopTopUpDueTo461 = true;
                              requiresSoftBanProbe = true;
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
                      // Nessuna carta trovata sotto il prezzo massimo: pausa fisiologica senza alterare i prezzi
                      await sleep(getRandomGaussian(isFodder ? 3.0 : 3.8, 0.4, isFodder ? 2.4 : 3.0, isFodder ? 4.0 : 4.8) * 1000);
                    }

                    if (earlyExitRateLimit || stopTopUpDueTo461) break;
                  } else if (res.status === 401) {
                    await handle401Error(isFodder ? "Lazy Fodder Top-Up Search" : "Lazy Top-Up Search");
                    break;
                  } else if (res.status === 458) {
                    await handleCaptchaDetected(isFodder ? "Lazy Fodder Top-Up" : "Lazy Top-Up");
                    break;
                  } else if (isRateLimitStatus(res.status)) {
                    earlyExitRateLimit = true;
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

                // Monitoraggio attivo e difesa Watchlist durante lo Step 2: priorità su aste vicine (<= 45s) o ogni 3 ricerche
                if (activeBids.size > 0 && (getUrgentAuctionTimeRemaining(activeBids) <= 45000 || topUpSearches % 3 === 0) && start === true) {
                  const prevWon = carteAcquistate;
                  await resolveWatchlist();
                  if (carteAcquistate > prevWon) {
                    const newlyWon = (carteAcquistate - prevWon);
                    wonInThisCycle += newlyWon;
                    topUpBought += newlyWon; // Le aste vinte riducono gli slot da comprare a BIN
                    sendMessageSafe({
                      tipo: 'LOG',
                      valore: `[${tag} WATCHLIST] Asta vinta durante Compra Ora! Progresso rifornimento: [${topUpBought}/${topUpTarget}]`
                    });
                    if (topUpBought >= topUpTarget) break;
                  }
                }
              }
            }
          }

          // Mette in vendita qualsiasi carta vinta/acquistata rimasta non assegnata o non listata
          await processUnassignedItems(cyclePrices);
          await sleep(1000);
          await listUnlistedTradepileItems(cyclePrices);
        }
      } else if (cycleTarget === 0) {
        if (isListingBlocked) {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[${tag}] Nessun acquisto per questo ciclo: listing EA in pausa e Tradepile a quota ${currentTotalCount}/${MAX_TRADEPILE_LIMIT} carte (${currentActiveCount} attive).`
          });
        } else {
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[${tag}] Tradepile già al completo (${currentActiveCount}/${targetSize} carte attive sul mercato, ${currentTotalCount} totali).`
          });
        }
      }

      if (start !== true) break;

      // FASE 4: Sincronizzazione finale, incasso crediti e calcolo pausa del ciclo
      // Controllo di sicurezza: nessuna asta pendente deve rimanere abbandonata prima del riposo
      if (activeBids.size > 0 && start === true && !marketRestricted && !earlyExitRateLimit) {
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[${tag}] Controllo finale offerte pendenti prima della pausa (${activeBids.size} attive)...`
        });
        const maxWaitTimestamp = Date.now() + 3 * 60 * 1000;
        while (activeBids.size > 0 && Date.now() < maxWaitTimestamp && start === true && !marketRestricted && !earlyExitRateLimit) {
          await sleep(getRandomGaussian(3.5, 0.4, 2.8, 4.5) * 1000);
          await resolveWatchlist();
        }
      }

      await sleep(2000);
      await clearSoldItem(cyclePrices);
      await processUnassignedItems(cyclePrices);
      await listUnlistedTradepileItems(cyclePrices);
      const finalPile = await getTradepileInfo();
      crediti = await getCrediti();
      sendMessageSafe({ tipo: 'CREDITI', valore: crediti });

      // Calcolo e pubblicazione proiezione crediti posseduti (crediti attuali + somma Compra Ora carte in vendita)
      const proj = await calculateAndPublishProiezioneCrediti(crediti, finalPile.auctions);

      // report Telegram di fine ciclo (totali carte acquistate / carte vendute / crediti)
      await sendCycleReport('lazy', {
        acquistate: carteAcquistate,
        vendute: carteVendute,
        crediti
      });

      const projLogText = proj && proj.activeCount > 0 ? ` | Proiezione crediti posseduti: ${proj.display} cr (valore in vendita: +${proj.sommaVendite.toLocaleString('it-IT')} cr)` : '';
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[STATO TRADEPILE] ${finalPile.active}/${targetSize} carte attive sul mercato (${finalPile.total} totali in lista trasferimenti)${projLogText}.`
      });

      if (start !== true) break;

      // Reset contatori errori soft-ban per il prossimo ciclo dopo il riposo
      consecutive512Errors = 0;
      consecutiveSnipeErrors = 0;

      // Calcolo pausa: backoff progressivo su soft-ban, macro-pausa ogni 3h, pacing dinamico per riempimento
      let sleepMins;
      if (marketRestricted || consecutive512InCycle > 0) {
        marketRestricted = true;
        consecutiveSoftBansInSession++;
        // Backoff esponenziale progressivo: 1° = 60m, 2° = 90m, 3°+ = 120-180m
        const baseMins = Math.max(45, lazySleepMinutes && lazySleepMinutes > 0 ? lazySleepMinutes : 60);
        if (consecutiveSoftBansInSession <= 1) {
          sleepMins = baseMins;
        } else if (consecutiveSoftBansInSession === 2) {
          sleepMins = Math.round(baseMins * 1.5);
        } else {
          sleepMins = Math.min(180, Math.round(baseMins * 2.0));
        }
        reportTelemetry('COOLDOWN_START', `Pausa rigenerativa soft-ban #${consecutiveSoftBansInSession} (${sleepMins} min) avviata`, { sleepMins, consecutiveSoftBans: consecutiveSoftBansInSession, marketRestricted: true });
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[${tag}] Rate limit EA attivo (Soft-ban consecutivo #${consecutiveSoftBansInSession}). Pausa rigenerativa incrementale di ${sleepMins} min per sblocco completo dell'account (Silenzio totale verso il mercato)...`
        });
      } else if ((Date.now() - sessionActiveStartTime) >= (3 * 60 * 60 * 1000)) {
        isMacroPause = true;
        consecutiveSoftBansInSession = 0;
        sleepMins = lazySleepMinutes && lazySleepMinutes > 0 ? lazySleepMinutes : 60;
        const hoursActive = ((Date.now() - sessionActiveStartTime) / (1000 * 60 * 60)).toFixed(1);
        reportTelemetry('MACRO_PAUSE_START', `Superate le 3 ore di attività continuativa (${hoursActive}h). Macro-pausa rigenerativa (${sleepMins} min) avviata`, { sleepMins, hoursActive });
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[MACRO-PAUSA RIGENERATIVA] Concluso intero ciclo dopo ${hoursActive}h di attività continuativa! Avvio macro-pausa di ${sleepMins} min per azzerare i contatori EA e favorire le vendite (Keep-alive attivo)...`
        });
      } else if (earlyExitRateLimit) {
        consecutiveSoftBansInSession = 0;
        sleepMins = Math.round(getRandomGaussian(5.5, 0.4, 5.0, 6.5));
        reportTelemetry('PREVENTIVE_COOLING_PAUSE', `Pausa preventiva anti-ban post early-exit (${sleepMins} min)`, { sleepMins });
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[${tag}] Raffreddamento preventivo attivo: pausa di riposo di ${sleepMins} min per azzerare i contatori EA (Ripresa automatica al termine)...`
        });
      } else if (Date.now() < listingRestrictedUntil && (finalPile.total - finalPile.active) >= 6) {
        consecutiveSoftBansInSession = 0;
        sleepMins = Math.max(10, Math.ceil((listingRestrictedUntil - Date.now()) / 60000));
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[${tag}] Cooldown listing EA attivo (${sleepMins} min) con ${finalPile.total - finalPile.active} carte in attesa di vendita. Pausa distensiva...`
        });
      } else if (finalPile.active < targetSize) {
        consecutiveSoftBansInSession = 0; // Ciclo andato a buon fine
        // Pacing dinamico tra i cicli in base al riempimento della Tradepile
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
        consecutiveSoftBansInSession = 0;
        sleepMins = lazySleepMinutes && lazySleepMinutes > 0 ? lazySleepMinutes : 60;
        reportTelemetry('SELLING_PHASE_START', `Fase di vendita Tradepile al completo (${sleepMins} min)`, { sleepMins, currentPile: finalPile.active });
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[${tag}] Tradepile al completo (${finalPile.active}/${targetSize})! Entro in modalità vendita per ${sleepMins} minuti...`
        });
      }

      const totalSleepSeconds = sleepMins * 60;
      // Heartbeat con jitter gaussiano (~2 min, range 95-150s): nessun pattern temporale fisso rilevabile
      let nextHeartbeatAt = Math.round(getRandomGaussian(120, 10, 95, 150));
      let nextPingAt = Math.round(getRandomGaussian(480, 30, 360, 600));

      let elapsed = 0;
      while (elapsed < totalSleepSeconds && start === true) {
        await sleep(1000);
        elapsed++;

        // Reset attività Chrome MV3 ogni 15 secondi per impedire lo standby del Service Worker
        if (elapsed % 15 === 0) {
          try {
            await chrome.storage.local.get(['keepAliveCheck']);
          } catch (_) { }
        }

        if (elapsed >= nextHeartbeatAt && start === true) {
          nextHeartbeatAt = elapsed + Math.round(getRandomGaussian(120, 10, 95, 150));
          try {
            const remainingMinutes = Math.round((totalSleepSeconds - elapsed) / 60);
            if (marketRestricted) {
              // Ping leggerissimo + refresh nativo Web App con jitter gaussiano (~8 min) per non far scadere il token X-UT-SID
              if (elapsed >= nextPingAt && remainingMinutes >= 2) {
                nextPingAt = elapsed + Math.round(getRandomGaussian(480, 30, 360, 600));
                await triggerPinEvent("REQUEST_TOKEN_REFRESH");
                await sleep(1600);
                crediti = await getCrediti();
                if (start !== true) break;
                reportTelemetry('COOLDOWN_KEEPALIVE', `Ping leggero anti-401 inviato durante cooldown silenziato`, { crediti, remainingMinutes });
                sendMessageSafe({
                  tipo: 'LOG',
                  valore: `[COOLDOWN KEEP-ALIVE] Ping leggero di sessione inviato per mantenere attivo il token Web App (anti-401). Mancano ${remainingMinutes} min alla ripresa.`
                });
              } else {
                // Silenzio totale verso il mercato durante soft-ban per consentire il reset del ban a EA
                sendMessageSafe({
                  tipo: 'LOG',
                  valore: `[COOLDOWN SILENZIATO] Sblocco soft-ban in corso (silenzio totale verso il mercato)... Mancano ${remainingMinutes} min alla ripresa.`
                });
              }
            } else if (earlyExitRateLimit) {
              // Silenzio verso il mercato per ripristinare il rate limit delle offerte
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[COOLDOWN PREVENTIVO] Riposo anti-ban in corso (azzeramento contatori EA)... Mancano ${remainingMinutes} min alla ripresa.`
              });
            } else {
              await triggerPinEvent("TRIGGER_PIN_WATCHLIST");
              // 1. Incassa le carte vendute e rimette in vendita quelle scadute con ricalcolo prezzi
              await clearSoldItem(cyclePrices);
              // 2. Risolve aste vinte e difende controrilanci anche durante la fase dormiente
              await checkAndProcessWatchlistForLazy(cyclePrices);
              // 3. Recupera carte vinte ma non ancora listate (anti-accumulo)
              await processUnassignedItems(cyclePrices);
              await listUnlistedTradepileItems(cyclePrices);
              const pileInfo = await getTradepileInfo();
              crediti = await getCrediti();
              if (typeof crediti === 'number') {
                sendMessageSafe({ tipo: 'CREDITI', valore: crediti });
              }

              // Calcolo e pubblicazione proiezione crediti posseduti durante heartbeat
              const hbProj = await calculateAndPublishProiezioneCrediti(crediti, pileInfo?.auctions);

              reportTelemetry('HEARTBEAT', `Heartbeat completato: vendite incassate e carte rilistate`, { crediti, remainingMinutes, proiezione: hbProj?.totale });
              const projText = hbProj && hbProj.activeCount > 0 ? ` | Proiezione: ${hbProj.display} cr (${hbProj.activeCount} in vendita)` : '';
              sendMessageSafe({
                tipo: 'LOG',
                valore: `[${tag} HEARTBEAT] Tradepile sincronizzata: vendite incassate, carte vinte listate e crediti aggiornati (${crediti} cr${projText}). Prossimo restock tra ${remainingMinutes} min.`
              });
            }
          } catch (hbErr) {
            console.warn("[Heartbeat Error]", hbErr);
          }
        }
      }

      if (start === true) {
        if (isMacroPause) {
          sessionActiveStartTime = Date.now();
        }
        if (marketRestricted) {
          // Ripresa da soft-ban: la prossima offerta sarà una sonda di verifica (1 sola offerta test)
          requiresSoftBanProbe = true;
        }
        marketRestricted = false;
        reportTelemetry('CYCLE_START', `Avvio Ciclo #${cycle + 1}`, { cycle: cycle + 1, crediti });
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[${tag}] Pausa completata! Avvio Ciclo #${cycle + 1}...`
        });
        // Warm-up naturale al risveglio prima di passare all'azione
        await sleep(getRandomGaussian(8.0, 1.0, 6.0, 11.0) * 1000);
      }
    } catch (cycleErr) {
      console.error(`[${tag} ERROR] Ciclo #${cycle}:`, cycleErr);
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[${tag} ERRORE] Errore imprevisto nel Ciclo #${cycle}: ${cycleErr?.message || cycleErr}. Riavvio nuovo ciclo tra 10s...`
      });
      await sleep(10000);
    }

    cycle++;
  }

  sendMessageSafe({
    tipo: 'LOG',
    valore: `[${tag}] Modalità arrestata. Eseguo pulizia finale...`
  });
  await clearSoldItem();
}

