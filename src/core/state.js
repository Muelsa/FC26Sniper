// Stato centralizzato e persistenza runtime del bot (Fase 1 Refactor)
import { getStoredPendingBids } from './storage.js';

export const botState = {
  xUtSid: "",
  searchUrl: "",
  searchHeaders: {},
  fodderSid: "",
  manualSearchAttempt: 0,
  manualTotalBidsPlaced: 0,
  manualConsecutive461: 0,
  manualBidPriceOffset: 0,
  numeroTentativi: 0,
  start: false,
  crediti: 0,
  carteAcquistate: 0,
  carteVendute: 0,
  carteVinteCiclo: 0,
  listaFodder: [],
  ricercaFodder: false,
  targetMode: "fodder", // "fodder" | "consumables" | "managerLeague" | "managers" | "manual"
  chemStyle: "all",
  managerNation: "18,34",
  autoBin: true,
  manualBin: 0,
  fodderRating: "84",
  indexFodder: 0,
  idCarteAcquistate: [],
  strategyMode: "sniping", // "sniping" | "bidding" | "lazy"
  minMargin: 200,
  maxSnipePrice: 0,
  targetTradepileSize: 50,
  lazyMarkupPercent: 10,
  lazySleepMinutes: 63,
  dynamicQuotaFodder: false,
  dynamicQuotaConsumables: false,
  dynamicQuotaLeague: false,
  dynamicQuotaManagers: false,
  dynamicQuotaChemTax: false,
  chemTaxStyle: "all",
  chemTaxMaxBasePrice: 30000,
  chemTaxMinMargin: 1000,
  consecutiveBidErrors: 0,
  consecutive470Errors: 0,
  consecutiveSnipeErrors: 0,
  consecutive512Errors: 0,
  consecutiveSearchErrors: 0,
  consecutive401Errors: 0,
  consecutive461InBidding: 0,
  lastBidTimestamp: 0,
  lastBidErrorStatus: 0,
  lastBuyNowErrorStatus: 0,
  lastListingTimestamp: 0,
  marketRestricted: false,
  listingRestrictedUntil: 0,
  consecutive426Errors: 0,
  listingTierCounter: 0
};

export const activeBids = new Map(); // tradeId -> { pid, sellPrice, bidAmount, expiresAt }
export const consumableBinCache = new Map(); // playStyleId / targetKey -> { price, timestamp }
export const attemptedTradeIds = new Map(); // tradeId (string) -> timestamp (ms)
export const itemRelistCounts = new Map(); // itemId (string) -> relistCount (number)
export const sellThroughStats = new Map(); // targetKey (string) -> { sold: number, expired: number, updatedAt: number }

const ATTEMPTED_TTL_MS = 5 * 60 * 1000;
const BIN_CACHE_TTL_MS = 15 * 60 * 1000;
const SELL_THROUGH_TTL_MS = 24 * 60 * 60 * 1000;
let attemptedPersistTimer = null;
let relistCountsPersistTimer = null;
let binCachePersistTimer = null;
let sellThroughPersistTimer = null;

export function isDynamicQuotaEnabled(mode = botState.targetMode) {
  if (mode === "fodder") return Boolean(botState.dynamicQuotaFodder);
  if (mode === "consumables") return Boolean(botState.dynamicQuotaConsumables);
  if (mode === "managerLeague") return Boolean(botState.dynamicQuotaLeague);
  if (mode === "managers") return Boolean(botState.dynamicQuotaManagers);
  if (mode === "chemTax") return Boolean(botState.dynamicQuotaChemTax);
  return false;
}

export function persistSellThroughStats() {
  if (sellThroughPersistTimer) return;
  sellThroughPersistTimer = setTimeout(() => {
    sellThroughPersistTimer = null;
    const now = Date.now();
    const entries = [];
    for (const [key, data] of sellThroughStats.entries()) {
      if (data && (now - (data.updatedAt || 0) < SELL_THROUGH_TTL_MS)) {
        entries.push([key, data]);
      }
    }
    chrome.storage.local.set({ sellThroughStats: entries }, () => void chrome.runtime.lastError);
  }, 2000);
}

export function recordTargetSale(targetKey, count = 1) {
  if (!targetKey || count <= 0) return;
  const key = String(targetKey);
  const existing = sellThroughStats.get(key) || { sold: 0, expired: 0, updatedAt: 0 };
  existing.sold = Math.round(((existing.sold || 0) + count) * 100) / 100;
  existing.updatedAt = Date.now();
  sellThroughStats.set(key, existing);
  persistSellThroughStats();
}

export function recordTargetExpiration(targetKey, count = 1) {
  if (!targetKey || count <= 0) return;
  const key = String(targetKey);
  const existing = sellThroughStats.get(key) || { sold: 0, expired: 0, updatedAt: 0 };
  existing.expired = Math.round(((existing.expired || 0) + count) * 100) / 100;
  existing.updatedAt = Date.now();
  sellThroughStats.set(key, existing);
  persistSellThroughStats();
}

export function decaySellThroughStats(factor = 0.85) {
  if (sellThroughStats.size === 0) return;
  const now = Date.now();
  let changed = false;
  for (const [key, data] of sellThroughStats.entries()) {
    if (!data || (now - (data.updatedAt || 0) >= SELL_THROUGH_TTL_MS)) {
      sellThroughStats.delete(key);
      changed = true;
      continue;
    }
    const newSold = Math.round((data.sold || 0) * factor * 100) / 100;
    const newExpired = Math.round((data.expired || 0) * factor * 100) / 100;
    if (newSold < 0.05 && newExpired < 0.05) {
      sellThroughStats.delete(key);
    } else {
      data.sold = newSold;
      data.expired = newExpired;
    }
    changed = true;
  }
  if (changed) persistSellThroughStats();
}

function distributeIntegerUnits(keys, weightsMap, totalUnits) {
  const N = keys.length;
  const quotas = {};
  if (N === 0 || totalUnits <= 0) {
    for (const k of keys) quotas[k] = 0;
    return quotas;
  }

  let sumW = 0;
  for (const k of keys) sumW += (weightsMap[k] || 0);
  const normW = {};
  for (const k of keys) {
    normW[k] = sumW > 0 ? (weightsMap[k] || 0) / sumW : 1 / N;
  }

  if (totalUnits >= N) {
    // Garantisce almeno 1 unità per ciascun target attivo, ripartendo il resto proporzionalmente
    const remainingPool = totalUnits - N;
    let allocated = N;
    const remainders = [];
    for (let i = 0; i < N; i++) {
      const k = keys[i];
      const exactExtra = remainingPool * normW[k];
      const floorExtra = Math.floor(exactExtra);
      quotas[k] = 1 + floorExtra;
      allocated += floorExtra;
      remainders.push({ k, rem: exactExtra - floorExtra, w: normW[k], idx: i });
    }
    remainders.sort((a, b) => (b.rem - a.rem) || (b.w - a.w) || (a.idx - b.idx));
    let left = totalUnits - allocated;
    for (let i = 0; i < left && i < remainders.length; i++) {
      quotas[remainders[i].k]++;
    }
  } else {
    // Meno unità del numero di target: assegna alle chiavi col peso più alto
    let allocated = 0;
    const remainders = [];
    for (let i = 0; i < N; i++) {
      const k = keys[i];
      const exact = totalUnits * normW[k];
      const floorVal = Math.floor(exact);
      quotas[k] = floorVal;
      allocated += floorVal;
      remainders.push({ k, rem: exact - floorVal, w: normW[k], idx: i });
    }
    remainders.sort((a, b) => (b.rem - a.rem) || (b.w - a.w) || (a.idx - b.idx));
    let left = totalUnits - allocated;
    for (let i = 0; i < left && i < remainders.length; i++) {
      quotas[remainders[i].k]++;
    }
  }

  return quotas;
}

/**
 * Calcola le quote (statiche paritarie oppure dinamiche basate su Sell-Through Rate)
 * per una lista di chiavi target.
 */
export function computeDynamicAllocation(targetKeys, totalUnits, currentCountsMap = null, forceStatic = false, targetTradepileTotal = null) {
  const keys = Array.isArray(targetKeys) ? targetKeys.map(String) : [];
  const N = keys.length;
  const rates = {};
  let totalHistoricalEvents = 0;

  for (const k of keys) {
    const st = sellThroughStats.get(k);
    const sold = st && typeof st.sold === 'number' ? st.sold : 0;
    const expired = st && typeof st.expired === 'number' ? st.expired : 0;
    const events = sold + expired;
    totalHistoricalEvents += events;
    rates[k] = {
      sold: Math.round(sold * 10) / 10,
      expired: Math.round(expired * 10) / 10,
      strPercent: events >= 0.4 ? Math.round((sold / events) * 100) : null
    };
  }

  const shares = {};
  const dynamicEnabled = !forceStatic && isDynamicQuotaEnabled();
  const isDynamicActive = dynamicEnabled && totalHistoricalEvents >= 0.8 && N > 1;

  if (!isDynamicActive) {
    for (const k of keys) shares[k] = N > 0 ? 1 / N : 0;
    const quotas = {};
    if (N > 0 && totalUnits > 0) {
      const base = Math.floor(totalUnits / N);
      const rem = totalUnits % N;
      keys.forEach((k, idx) => {
        quotas[k] = base + (idx < rem ? 1 : 0);
      });
    } else {
      for (const k of keys) quotas[k] = 0;
    }
    return { quotas, shares, rates, isDynamicActive: false, dynamicEnabled };
  }

  // Calcolo score Laplace-smoothed + boost volume vendite
  const rawScores = {};
  let sumRaw = 0;
  for (const k of keys) {
    const { sold, expired } = rates[k];
    const str = (sold + 1) / (sold + expired + 2);
    const volBoost = 1 + 0.15 * Math.min(sold, 10);
    const score = str * volBoost;
    rawScores[k] = score;
    sumRaw += score;
  }

  // Applicazione guard-rail min/max (es. min 10-15%, max 45-50% per evitare monopoli o azzeramenti)
  const minShare = Math.max(0.04, Math.min(0.15, 0.40 / N));
  const maxShare = Math.min(0.65, Math.max(0.45, 2.0 / N));
  let sumClamped = 0;
  const clamped = {};
  for (const k of keys) {
    const rawShare = sumRaw > 0 ? rawScores[k] / sumRaw : 1 / N;
    clamped[k] = Math.min(maxShare, Math.max(minShare, rawShare));
    sumClamped += clamped[k];
  }
  for (const k of keys) {
    shares[k] = sumClamped > 0 ? clamped[k] / sumClamped : 1 / N;
  }

  // Se abbiamo i conteggi attuali in Tradepile, bilanciamo il rifornimento verso i target sotto-quota
  const effectiveWeights = {};
  if (currentCountsMap && typeof currentCountsMap === 'object') {
    const refTotal = (typeof targetTradepileTotal === 'number' && targetTradepileTotal > 0) ? targetTradepileTotal : totalUnits;
    const deficits = {};
    let sumDeficits = 0;
    for (const k of keys) {
      const desired = refTotal * shares[k];
      const curr = Number(currentCountsMap[k]) || 0;
      const def = Math.max(0, desired - curr);
      deficits[k] = def;
      sumDeficits += def;
    }
    for (const k of keys) {
      effectiveWeights[k] = sumDeficits > 0
        ? (0.55 * shares[k] + 0.45 * (deficits[k] / sumDeficits))
        : shares[k];
    }
  } else {
    for (const k of keys) effectiveWeights[k] = shares[k];
  }

  const quotas = distributeIntegerUnits(keys, effectiveWeights, totalUnits);
  return { quotas, shares, rates, isDynamicActive: true, dynamicEnabled };
}

export function persistConsumableBinCache() {
  if (binCachePersistTimer) return;
  binCachePersistTimer = setTimeout(() => {
    binCachePersistTimer = null;
    const now = Date.now();
    const entries = [];
    for (const [key, data] of consumableBinCache.entries()) {
      if (data && typeof data.price === 'number' && (now - (data.timestamp || 0) < BIN_CACHE_TTL_MS)) {
        entries.push([key, data]);
      }
    }
    chrome.storage.local.set({ consumableBinCache: entries }, () => void chrome.runtime.lastError);
  }, 1500);
}

export function persistItemRelistCounts() {
  if (relistCountsPersistTimer) return;
  relistCountsPersistTimer = setTimeout(() => {
    relistCountsPersistTimer = null;
    const entries = Array.from(itemRelistCounts.entries());
    chrome.storage.local.set({ itemRelistCounts: entries }, () => void chrome.runtime.lastError);
  }, 2000);
}

export function getItemRelistCount(itemId) {
  if (!itemId) return 0;
  return itemRelistCounts.get(String(itemId)) || 0;
}

export function incrementItemRelistCount(itemId) {
  if (!itemId) return 1;
  const key = String(itemId);
  const nextCount = (itemRelistCounts.get(key) || 0) + 1;
  itemRelistCounts.set(key, nextCount);
  persistItemRelistCounts();
  return nextCount;
}

export function removeItemRelistCount(itemId) {
  if (!itemId) return;
  const key = String(itemId);
  if (itemRelistCounts.has(key)) {
    itemRelistCounts.delete(key);
    persistItemRelistCounts();
  }
}

export function pruneItemRelistCounts(activeItemIdsSet) {
  if (!activeItemIdsSet || typeof activeItemIdsSet.has !== 'function') return;
  let changed = false;
  for (const id of itemRelistCounts.keys()) {
    if (!activeItemIdsSet.has(String(id))) {
      itemRelistCounts.delete(id);
      changed = true;
    }
  }
  if (changed) {
    persistItemRelistCounts();
  }
}

export function persistAttemptedTradeIds() {
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

export function isTradeAttempted(tradeId) {
  if (!tradeId) return false;
  const idStr = String(tradeId);
  const now = Date.now();
  if (attemptedTradeIds.has(idStr)) {
    const attemptedAt = attemptedTradeIds.get(idStr);
    if (now - attemptedAt < ATTEMPTED_TTL_MS) {
      return true;
    } else {
      attemptedTradeIds.delete(idStr);
    }
  }
  return false;
}

export function markTradeAttempted(tradeId) {
  if (!tradeId) return;
  attemptedTradeIds.set(String(tradeId), Date.now());
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

export function restoreInitialStateFromStorage() {
  chrome.storage.local.get([
    'xUtSid', 'searchUrl', 'attemptedTradeIds', 'itemRelistCounts', 'consumableBinCache', 'sellThroughStats',
    'dynamicQuotaFodder', 'dynamicQuotaConsumables', 'dynamicQuotaLeague', 'dynamicQuotaManagers', 'dynamicQuotaChemTax',
    'chemTaxStyle', 'chemTaxMaxBasePrice', 'chemTaxMinMargin'
  ], (result) => {
    if (result.xUtSid) {
      botState.xUtSid = result.xUtSid;
      console.log("[FC Sniper] x-ut-sid ripristinato dallo storage all'avvio:", botState.xUtSid.substring(0, 10) + "...");
    }
    if (result.searchUrl && typeof result.searchUrl === 'string') {
      botState.searchUrl = result.searchUrl;
      console.log("[FC Sniper] searchUrl ripristinato dallo storage all'avvio:", botState.searchUrl);
    }
    if (result.dynamicQuotaFodder !== undefined) botState.dynamicQuotaFodder = Boolean(result.dynamicQuotaFodder);
    if (result.dynamicQuotaConsumables !== undefined) botState.dynamicQuotaConsumables = Boolean(result.dynamicQuotaConsumables);
    if (result.dynamicQuotaLeague !== undefined) botState.dynamicQuotaLeague = Boolean(result.dynamicQuotaLeague);
    if (result.dynamicQuotaManagers !== undefined) botState.dynamicQuotaManagers = Boolean(result.dynamicQuotaManagers);
    if (result.dynamicQuotaChemTax !== undefined) botState.dynamicQuotaChemTax = Boolean(result.dynamicQuotaChemTax);
    if (result.chemTaxStyle) botState.chemTaxStyle = result.chemTaxStyle;
    if (result.chemTaxMaxBasePrice) botState.chemTaxMaxBasePrice = Number(result.chemTaxMaxBasePrice) || 30000;
    if (result.chemTaxMinMargin) botState.chemTaxMinMargin = Number(result.chemTaxMinMargin) || 1000;
    const sellThroughEntries = result.sellThroughStats;
    if (Array.isArray(sellThroughEntries)) {
      const now = Date.now();
      for (const [key, data] of sellThroughEntries) {
        if (key && data && (now - (data.updatedAt || 0) < SELL_THROUGH_TTL_MS)) {
          sellThroughStats.set(String(key), data);
        }
      }
      if (sellThroughStats.size > 0) {
        console.log(`[FC Sniper] Ripristinate statistiche Sell-Through per ${sellThroughStats.size} target.`);
      }
    }
    const entries = result.attemptedTradeIds;
    const relistEntries = result.itemRelistCounts;
    if (Array.isArray(relistEntries)) {
      for (const [id, count] of relistEntries) {
        if (id && typeof count === 'number') itemRelistCounts.set(String(id), count);
      }
      if (itemRelistCounts.size > 0) {
        console.log(`[FC Sniper] Ripristinati conteggi relist per ${itemRelistCounts.size} carte.`);
      }
    }
    const binCacheEntries = result.consumableBinCache;
    if (Array.isArray(binCacheEntries)) {
      const now = Date.now();
      for (const [key, data] of binCacheEntries) {
        if (key && data && typeof data.price === 'number' && (now - (data.timestamp || 0) < BIN_CACHE_TTL_MS)) {
          consumableBinCache.set(String(key), data);
        }
      }
      if (consumableBinCache.size > 0) {
        console.log(`[FC Sniper] Ripristinati ${consumableBinCache.size} prezzi di mercato da chrome.storage.local.`);
      }
    }
    if (Array.isArray(entries)) {
      const now = Date.now();
      for (const [id, ts] of entries) {
        if (typeof ts === 'number' && now - ts < ATTEMPTED_TTL_MS) attemptedTradeIds.set(String(id), ts);
      }
    }
  });
}

export async function storePendingBid(tradeId, data) {
  activeBids.set(String(tradeId), data);
  const bids = await getStoredPendingBids();
  bids[String(tradeId)] = data;
  await chrome.storage.local.set({ pendingBids: bids });
}

export async function storePendingBidsBatch(itemsMap) {
  const bids = await getStoredPendingBids();
  for (const [tradeId, data] of Object.entries(itemsMap)) {
    activeBids.set(String(tradeId), data);
    bids[String(tradeId)] = data;
  }
  await chrome.storage.local.set({ pendingBids: bids });
}

export async function removeStoredPendingBid(tradeId) {
  activeBids.delete(String(tradeId));
  activeBids.delete(Number(tradeId));
  const bids = await getStoredPendingBids();
  delete bids[String(tradeId)];
  await chrome.storage.local.set({ pendingBids: bids });
}

// Svuota tutte le cache dei prezzi: al successivo avvio il bot ricalcola i prezzi dal mercato live.
// Non tocca attemptedTradeIds (anti-duplicato aste) né il tracciamento delle offerte pendenti.
export async function clearAllPriceCaches() {
  const cachedCount = consumableBinCache.size;
  const fodderCount = botState.listaFodder.length;

  consumableBinCache.clear();
  chrome.storage.local.remove(['consumableBinCache'], () => void chrome.runtime.lastError);
  botState.listaFodder = [];
  botState.indexFodder = 0;

  for (const data of activeBids.values()) {
    if (data && typeof data === 'object') {
      delete data.basePrice;
      delete data.sellPrice;
    }
  }

  let pendingCount = 0;
  try {
    const bids = await getStoredPendingBids();
    for (const tid of Object.keys(bids)) {
      const entry = bids[tid];
      if (entry && typeof entry === 'object' && (entry.basePrice !== undefined || entry.sellPrice !== undefined)) {
        delete entry.basePrice;
        delete entry.sellPrice;
        pendingCount++;
      }
    }
    if (pendingCount > 0) await chrome.storage.local.set({ pendingBids: bids });
  } catch (e) {
    console.warn('[FC Sniper Cache] Errore pulizia prezzi offerte pendenti:', e);
  }

  return { cachedCount, fodderCount, pendingCount };
}
