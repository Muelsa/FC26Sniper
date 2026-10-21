// Rate limiter globale per tutte le chiamate UTAS (Fase 3.4 del refactor plan).
// - Budget orario cross-endpoint (ricerche + bid + sell + move + delete condividono lo stesso budget:
//   elimina i burst incrociati che oggi avvengono con throttle separati).
// - Inter-arrival minimo con jitter gaussiano troncato rigenerativamente (niente pile-up ai bound).
// - Installato wrappando self.fetch nel Service Worker: intercetta solo l'host UTAS,
//   lascia passare inalterato tutto il resto (localhost, CDN, ecc.).

const UTAS_HOST = "utas.mob.v1.prd.futc-ext.gcp.ea.com";

// Budget conservativo di default: ~40 richieste/minuto medie, con finestra scorrevole di 1 ora.
const DEFAULT_MAX_PER_HOUR = 2400;
// Inter-arrival minimo globale: base 250ms con jitter gaussiano (media 320ms, sd 90ms, rigenerativo).
const BASE_INTERVAL_MS = 250;
const JITTER_MEAN_MS = 320;
const JITTER_SD_MS = 90;

const requestTimestamps = [];
let lastRequestAt = 0;
let queue = Promise.resolve();

function gaussian(mean, sd) {
  // Box-Muller con rigenerazione: nessun clamp netto ai bordi
  let value;
  do {
    const u = Math.random() || 1e-9;
    const v = Math.random();
    value = mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  } while (value < mean - 2.5 * sd || value > mean + 2.5 * sd);
  return value;
}

function pruneWindow(now) {
  const hourAgo = now - 3600_000;
  while (requestTimestamps.length && requestTimestamps[0] < hourAgo) requestTimestamps.shift();
}

async function throttleOne(maxPerHour) {
  const now = Date.now();

  // Budget orario: se esaurito, attende fino alla scadenza del timestamp più vecchio
  pruneWindow(now);
  if (requestTimestamps.length >= maxPerHour) {
    const waitMs = requestTimestamps[0] + 3600_000 - now;
    if (waitMs > 0) {
      console.warn(`[FC Sniper RateLimiter] Budget orario esaurito (${maxPerHour}/h). Pausa di ${Math.ceil(waitMs / 60000)} min.`);
      await new Promise((r) => setTimeout(r, waitMs));
      pruneWindow(Date.now());
    }
  }

  // Inter-arrival minimo con jitter
  const minInterval = BASE_INTERVAL_MS + Math.max(0, gaussian(JITTER_MEAN_MS, JITTER_SD_MS));
  const sinceLast = Date.now() - lastRequestAt;
  if (sinceLast < minInterval) {
    await new Promise((r) => setTimeout(r, minInterval - sinceLast));
  }

  const ts = Date.now();
  lastRequestAt = ts;
  requestTimestamps.push(ts);
}

/**
 * Restituisce statistiche correnti (richieste nell'ultima ora).
 */
export function getRateLimiterStats() {
  pruneWindow(Date.now());
  return { requestsLastHour: requestTimestamps.length };
}

/**
 * Wrappa self.fetch: le richieste verso l'host UTAS vengono serializzate attraverso
 * il rate limiter; tutte le altre passano inalterate. Idempotente.
 */
export function installGlobalRateLimiter({ maxPerHour = DEFAULT_MAX_PER_HOUR } = {}) {
  if (self.__fcSniperRateLimiterInstalled) return;
  self.__fcSniperRateLimiterInstalled = true;

  const originalFetch = self.fetch.bind(self);
  self.fetch = function (input, init) {
    const url = typeof input === "string" ? input : input?.url;
    if (url && url.includes(UTAS_HOST)) {
      const result = queue.then(() => throttleOne(maxPerHour)).then(() => originalFetch(input, init));
      // La coda non deve bloccarsi su un fetch fallito
      queue = result.catch(() => { });
      return result;
    }
    return originalFetch(input, init);
  };
}
