import { parseFodderPrice } from '../core/utils.js';
import { botState } from '../core/state.js';
import { sendMessageSafe } from '../core/messenger.js';

// Recupera la lista fodder dal server telemetry locale (http://localhost:3000/fut/fodder)
// Ritorna { list, source } oppure lancia in caso di errore di rete/HTTP.
export async function fetchFodderList(rating) {
  const response = await fetch('http://localhost:3000/fut/fodder?rating=' + rating, {
    method: "GET",
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Errore risposta server fodder: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  // Supporta sia il nuovo formato ("players") sia il precedente ("data") o array diretto
  const rawList = Array.isArray(data.players)
    ? data.players
    : Array.isArray(data.data)
      ? data.data
      : Array.isArray(data)
        ? data
        : [];

  const list = [];
  for (const item of rawList) {
    const pid = item.id || item.pid || item.assetId || item.resourceId || item.definitionid;
    const rawPrice = item.price ?? item.prices?.console?.bin ?? item.prices?.ps?.bin ?? item.bin;
    const parsedPrice = parseFodderPrice(rawPrice);

    if (pid && parsedPrice > 0) {
      list.push({
        pid: String(pid),
        name: item.name || "",
        price: parsedPrice,
        rating: item.rating || Number(rating)
      });
    }
  }

  return { list, source: data.source || "server" };
}

export async function getFodderList() {
  try {
    const { list, source } = await fetchFodderList(botState.fodderRating);

    if (list.length > 0) {
      botState.listaFodder.push(...list);
      console.log(`[FC Sniper] Ho recuperato ${botState.listaFodder.length} fodder (rating ${botState.fodderRating}) da ${source}`);
    } else {
      console.warn(`[FC Sniper] Nessun fodder trovato nella risposta per rating ${botState.fodderRating}`);
    }
  } catch (error) {
    sendMessageSafe({ tipo: 'LOG', valore: 'Errore durante recupero lista dei fodder dal server' });
    console.error("Errore durante recupero lista dei fodder dal server:", error);
  }
}

export function getNextFodder() {
  const fodder = botState.listaFodder[botState.indexFodder];
  botState.indexFodder = (botState.indexFodder + 1) % botState.listaFodder.length;
  return fodder;
}

export async function getFodderPriceForItem(itemData) {
  if (!itemData || botState.targetMode !== "fodder") return 0;
  const assetId = itemData.assetId || itemData.resourceId;
  const rating = itemData.rating;

  // 1. Cerca in listaFodder attualmente caricata in memoria
  if (botState.listaFodder && botState.listaFodder.length > 0) {
    if (assetId) {
      const match = botState.listaFodder.find(f => f.pid == assetId);
      if (match && match.price > 0) return match.price;
    }
    if (rating && String(rating) === String(botState.fodderRating)) {
      const prices = botState.listaFodder.map(f => f.price).filter(p => p > 0);
      if (prices.length > 0) return Math.min(...prices);
    }
  }

  // 2. Se non presente in memoria e abbiamo il rating, interroga il server locale
  if (rating) {
    try {
      const { list } = await fetchFodderList(rating);
      if (list && list.length > 0) {
        if (assetId) {
          const match = list.find(d => d.pid == assetId);
          if (match && match.price > 0) return match.price;
        }
        const bins = list.map(d => d.price).filter(p => p > 0);
        if (bins.length > 0) return Math.min(...bins);
      }
    } catch (e) {
      console.error("[getFodderPriceForItem Error]", e);
    }
  }

  return 0;
}
