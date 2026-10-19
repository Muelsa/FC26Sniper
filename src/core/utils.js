// Utilità pure condivise (nessuna dipendenza da chrome.* o stato globale)

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function getRandomInRange(min, max) {
  return Math.random() * (max - min + 1) + min;
}

export function getRandomGaussian(mean, stdev, min = null, max = null) {
  let u1 = 0, u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();

  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  let value = mean + z0 * stdev;

  if (min !== null && value < min) value = min;
  if (max !== null && value > max) value = max;

  return value;
}

// Restituisce lo scalino minimo ufficiale di rilancio EA in base al prezzo
export function getEaStep(price) {
  if (price >= 100000) return 1000;
  if (price >= 50000) return 500;
  if (price >= 10000) return 250;
  if (price >= 1000) return 100;
  return 50;
}

// Calcola la prossima offerta valida rispettando lo scalino EA
export function calculateNextBid(startingBid, currentBid) {
  if (!currentBid || currentBid === 0) {
    return startingBid;
  }
  return currentBid + getEaStep(currentBid);
}

// Arrotonda un prezzo per difetto al gradino valido EA più vicino
export function roundDownToStep(price) {
  const step = getEaStep(price);
  return Math.floor(price / step) * step;
}

// Arrotonda un prezzo per eccesso al gradino valido EA più vicino
export function roundUpToStep(price) {
  const step = getEaStep(price);
  return Math.ceil(price / step) * step;
}

// Calcola il margine di profitto netto dinamico in base al valore di mercato della carta
export function calculateTargetMargin(marketPrice, minMarginBase = 200) {
  // Fascia 1: Economiche (<= 5.000 crediti)
  if (marketPrice <= 5000) {
    return minMarginBase > 0 ? minMarginBase : 250;
  }
  // Fascia 2: Medie (5.001 - 15.000 crediti)
  if (marketPrice <= 15000) {
    return Math.max(450, minMarginBase);
  }
  // Fascia 3: Élite (> 15.000 crediti) -> 5% con minimo 1.000 crediti netti
  const percentMargin = Math.floor(marketPrice * 0.05);
  return Math.max(1000, percentMargin, minMarginBase);
}

// Parsing prezzi fodder: accetta numeri o stringhe tipo "2K", "1.2M"
export function parseFodderPrice(price) {
  if (typeof price === 'number') return Math.round(price);
  if (!price || typeof price !== 'string') return 0;

  const raw = price.trim().toUpperCase();
  if (raw.endsWith('M')) {
    const val = parseFloat(raw.slice(0, -1).replace(',', '.'));
    return isNaN(val) ? 0 : Math.round(val * 1000000);
  }
  if (raw.endsWith('K')) {
    const val = parseFloat(raw.slice(0, -1).replace(',', '.'));
    return isNaN(val) ? 0 : Math.round(val * 1000);
  }

  const val = parseFloat(raw.replace(/[^\d.]/g, ''));
  return isNaN(val) ? 0 : Math.round(val);
}
