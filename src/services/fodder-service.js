import { parseFodderPrice } from '../core/utils.js';

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
