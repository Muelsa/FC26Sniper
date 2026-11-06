// Servizio per il recupero e filtraggio dei calciatori PGP (Player Games Played)
// da local server (http://127.0.0.1:3000/fut/pgp) per la strategia Shadow/Hunter Chem Tax.
import { parseFodderPrice } from '../core/utils.js';

export async function fetchPgpPlayers(maxPrice = null) {
  const url = new URL('http://localhost:3000/fut/pgp');
  if (maxPrice && Number(maxPrice) > 0) {
    url.searchParams.set('max_price', String(Math.round(Number(maxPrice))));
  }

  const res = await fetch(url.href, {
    method: 'GET',
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) {
    throw new Error(`Errore risposta server PGP: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const rawPlayers = Array.isArray(data.players) ? data.players : [];
  return { players: rawPlayers, source: data.source || 'futbin' };
}

/**
 * Determina lo stile intesa raccomandato (Ombra 268 o Cacciatore 266)
 * in base al ruolo nativo della carta o ai dati PGP.
 */
export function assignPgpChemStyle(player) {
  if (!player) return null;
  const pos = String(player.position || '').toUpperCase().trim();
  if (pos === 'GK') return null; // Esclude categoricamente i portieri

  const psChem = String(player.ps?.chemStyle || '').toUpperCase();
  if (psChem === 'SHADOW') {
    return { styleId: '268', styleName: 'Ombra', reason: 'futbin_chem' };
  }
  if (psChem === 'HUNTER') {
    return { styleId: '266', styleName: 'Cacciatore', reason: 'futbin_chem' };
  }

  // Difensori centrali, terzini e mediani -> OMBRA (268)
  if (['CB', 'LB', 'RB', 'LWB', 'RWB', 'CDM'].includes(pos)) {
    return { styleId: '268', styleName: 'Ombra', reason: 'defensive_role' };
  }

  // Attaccanti, ali, trequartisti ed esterni -> CACCIATORE (266)
  if (['ST', 'CF', 'LW', 'RW', 'LM', 'RM', 'CAM'].includes(pos)) {
    return { styleId: '266', styleName: 'Cacciatore', reason: 'offensive_role' };
  }

  // Centrocampisti centrali (CM): divide in base alla propensione offensiva
  if (pos === 'CM') {
    const gpg = parseFloat(player.ps?.goalsPerGame || '0') || 0;
    if (gpg >= 0.20) {
      return { styleId: '266', styleName: 'Cacciatore', reason: 'cm_offensive' };
    }
    return { styleId: '268', styleName: 'Ombra', reason: 'cm_defensive' };
  }

  return null;
}

/**
 * Filtra e normalizza i candidati validi per il trading PGP Chem Tax
 */
export function filterPgpCandidates(players, options = {}) {
  const {
    styleFilter = 'all', // 'all', '268', '266'
    maxBasePrice = 30000,
    minBasePrice = 1500
  } = options;

  const candidates = [];
  for (const p of (players || [])) {
    if (!p || !p.eaId) continue;
    const assigned = assignPgpChemStyle(p);
    if (!assigned) continue;

    if (styleFilter !== 'all' && assigned.styleId !== String(styleFilter)) {
      continue;
    }

    const priceRaw = p.ps?.price ?? p.price;
    const priceCredits = parseFodderPrice(priceRaw);
    if (!Number.isFinite(priceCredits) || priceCredits < minBasePrice || priceCredits > maxBasePrice) {
      continue;
    }

    candidates.push({
      eaId: String(p.eaId),
      futbinId: String(p.futbinId || ''),
      name: p.name || p.cardName || `Player ${p.eaId}`,
      cardName: p.cardName || p.name || `Player ${p.eaId}`,
      rating: Number(p.rating) || 0,
      position: p.position || '',
      basePrice: priceCredits,
      styleId: assigned.styleId,
      styleName: assigned.styleName,
      key: `pgp_${p.eaId}_${assigned.styleId}`
    });
  }

  return candidates;
}
