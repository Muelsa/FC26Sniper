// Utilità condivise dai motori di strategia (sniping / bidding / lazy)
import { botState, activeBids } from '../core/state.js';
import { sendMessageSafe } from '../core/messenger.js';
import { sleep } from '../core/utils.js';
import { resolveWatchlist } from '../services/watchlist-service.js';

// Restituisce i millisecondi rimanenti alla scadenza dell'asta attiva più vicina che richiede azione immediata
export function getUrgentAuctionTimeRemaining(activeBidsMap) {
  const now = Date.now();
  let minRemainingMs = Infinity;
  for (const [, bid] of activeBidsMap.entries()) {
    if (bid?.expiresAt) {
      const diff = bid.expiresAt - now;
      if (diff > 0 && diff < minRemainingMs) {
        minRemainingMs = diff;
      } else if (diff <= 0 && diff > -120000) {
        // Asta appena scaduta o in attesa di chiusura EA: richiede risoluzione immediata
        minRemainingMs = Math.min(minRemainingMs, 0);
      }
    }
  }
  return minRemainingMs;
}

// Loop di attesa e difesa attiva delle aste aperte nella Watchlist fino a conclusione o timeout
export async function waitForPendingWatchlistAuctions(logPrefix = "[DIFESA ASTE]") {
  if (botState.start !== true) return;
  let activeRemaining = await resolveWatchlist();
  if ((activeRemaining > 0 || activeBids.size > 0) && botState.start === true) {
    const initialCount = Math.max(activeRemaining, activeBids.size);
    sendMessageSafe({
      tipo: 'LOG',
      valore: `${logPrefix} In attesa della chiusura e difesa di ${initialCount} aste in corso...`
    });

    let loopIterations = 0;
    const MAX_SAFETY_TIMEOUT_SEC = 900; // 15 min max safety timeout anti-hang
    let elapsedSec = 0;

    while (botState.start === true && elapsedSec < MAX_SAFETY_TIMEOUT_SEC) {
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
          valore: `${logPrefix} Tutte le aste in corso sono state gestite e concluse con successo!`
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
