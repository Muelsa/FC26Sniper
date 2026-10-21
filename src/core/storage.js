// Accesso centralizzato a chrome.storage.local (schema delle chiavi del bot)

function getKey(key, fallback) {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] !== undefined ? result[key] : fallback);
    });
  });
}

export const getNumeroTentativi = () => getKey('numeroTentativi', 0);
export const getFodderRating = () => getKey('fodderRating', "84");
export const getStrategyMode = () => getKey('strategyMode', "sniping");
export const getMinMargin = async () => parseInt(await getKey('minMargin', 200)) || 200;
export const getChemStyle = () => getKey('chemStyle', "268");
export const getAutoBin = () => getKey('autoBin', true);
export const getManualBin = async () => parseInt(await getKey('manualBin', 0)) || 0;
export const getMaxSnipePrice = async () => parseInt(await getKey('maxSnipePrice', 0)) || 0;
export const getTargetTradepileSize = async () => parseInt(await getKey('targetTradepileSize', 50)) || 50;
export const getLazyMarkupPercent = async () => parseInt(await getKey('lazyMarkupPercent', 10)) || 10;
export const getLazySleepMinutes = async () => parseInt(await getKey('lazySleepMinutes', 63)) || 63;

// targetMode con retro-compatibilità dalla vecchia chiave booleana fodderMode
export function getTargetMode() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['targetMode', 'fodderMode'], (result) => {
      if (result.targetMode) resolve(result.targetMode);
      else if (result.fodderMode !== undefined) resolve(result.fodderMode ? "fodder" : "manual");
      else resolve("fodder");
    });
  });
}

export const getStoredPendingBids = () => getKey('pendingBids', {});

// Chat ID Telegram dell'utente (fornito dalla UI)
export const getTelegramChatId = () => getKey('telegramChatId', "");

// Info account EA (catturate dal DOM bridge)
export const getUserProfile = async () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['personaName', 'clubName'], (res) => {
      resolve({
        personaName: res.personaName || "",
        clubName: res.clubName || ""
      });
    });
  });
};

// Conteggio elementi in vendita / Tradepile (come visualizzato nella UI)
export const getTradepileStatus = async () => {
  return new Promise((resolve) => {
    chrome.storage.local.get(['tradepileCount', 'tradepileActive', 'tradepileTotal'], (res) => {
      resolve({
        tradepileCount: res.tradepileCount || "",
        tradepileActive: res.tradepileActive !== undefined ? res.tradepileActive : null,
        tradepileTotal: res.tradepileTotal !== undefined ? res.tradepileTotal : null
      });
    });
  });
};

// Proiezione crediti posseduti (crediti attuali + somma Compra Ora carte in vendita)
export const getProiezioneCrediti = () => getKey('proiezioneCrediti', "-");

// Pulisce offerte pendenti obsolete (> 24 ore) per garantire memoria pulita
export async function cleanExpiredPendingBids() {
  try {
    const bids = await getStoredPendingBids();
    const now = Date.now();
    let count = 0;
    for (const tradeId in bids) {
      if (!bids[tradeId]?.expiresAt || bids[tradeId].expiresAt < (now - 24 * 3600 * 1000)) {
        delete bids[tradeId];
        count++;
      }
    }
    if (count > 0) {
      await chrome.storage.local.set({ pendingBids: bids });
      console.log(`[FC Sniper Storage] Pulite ${count} offerte pendenti obsolete.`);
    }
  } catch (e) {
    console.error("[Storage Cleanup Error]", e);
  }
}
