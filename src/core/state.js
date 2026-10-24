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

const ATTEMPTED_TTL_MS = 5 * 60 * 1000;
let attemptedPersistTimer = null;

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
  chrome.storage.local.get(['xUtSid', 'searchUrl', 'attemptedTradeIds'], (result) => {
    if (result.xUtSid) {
      botState.xUtSid = result.xUtSid;
      console.log("[FC Sniper] x-ut-sid ripristinato dallo storage all'avvio:", botState.xUtSid.substring(0, 10) + "...");
    }
    if (result.searchUrl && typeof result.searchUrl === 'string') {
      botState.searchUrl = result.searchUrl;
      console.log("[FC Sniper] searchUrl ripristinato dallo storage all'avvio:", botState.searchUrl);
    }
    const entries = result.attemptedTradeIds;
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
