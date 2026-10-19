// Utilità condivise dai motori di strategia (sniping / bidding / lazy)

// Restituisce i millisecondi rimanenti alla scadenza dell'asta attiva più vicina che richiede azione immediata
export function getUrgentAuctionTimeRemaining(activeBids) {
  const now = Date.now();
  let minRemainingMs = Infinity;
  for (const [, bid] of activeBids.entries()) {
    if (bid?.expiresAt) {
      const diff = bid.expiresAt - now;
      if (diff > 0 && diff < minRemainingMs) {
        minRemainingMs = diff;
      } else if (diff <= 0 && diff > -30000) {
        // Asta appena scaduta o in chiusura: richiede risoluzione immediata
        minRemainingMs = Math.min(minRemainingMs, 0);
      }
    }
  }
  return minRemainingMs;
}
