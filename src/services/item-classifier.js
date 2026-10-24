// Riconoscimento, classificazione e formattazione di carte EA UTAS (Fase 3 Refactor)
import { botState, activeBids } from '../core/state.js';
import {
  CHEM_STYLES,
  MANAGER_LEAGUES,
  TOP_MANAGER_NATIONS,
  NATION_NAMES,
  leagueTargetKey,
  managerTargetKey
} from '../ea/constants.js';

// Formatta il nome visivo leggibile per qualsiasi tipologia di carta (Manager, Calciatore, Consumabile)
export function formatItemDisplayName(itemOrAuction, fallbackTradeId = null) {
  if (!itemOrAuction) return fallbackTradeId ? `Trade ${fallbackTradeId}` : "Carta";
  const data = itemOrAuction.itemData || itemOrAuction;

  if (data.itemType === "manager") {
    const natStr = data.nation ? (NATION_NAMES[data.nation] || `Naz ${data.nation}`) : "";
    if (data.lastName) {
      return `Allenatore ${data.lastName}${natStr ? ' (' + natStr + ')' : ''}`;
    }
    if (natStr) {
      return `Allenatore (${natStr})`;
    }
    return data.rating ? `Allenatore (${data.rating})` : "Allenatore";
  }

  if (data.itemType === "player") {
    if (data.lastName) return `${data.lastName}${data.rating ? ' (' + data.rating + ')' : ''}`;
    if (data.name) return `${data.name}${data.rating ? ' (' + data.rating + ')' : ''}`;
    if (data.rating) return `Calciatore (${data.rating})`;
    return "Calciatore";
  }

  if (data.itemType === "training") {
    const lgId = detectManagerLeague(itemOrAuction);
    if (lgId && MANAGER_LEAGUES[lgId]) return `Modificatore ${MANAGER_LEAGUES[lgId].name}`;
    const cs = detectChemistryStyle(itemOrAuction);
    if (cs && CHEM_STYLES[cs]) return CHEM_STYLES[cs].name;
    return "Consumabile";
  }

  return fallbackTradeId ? `Trade ${fallbackTradeId}` : "Carta";
}

// Rileva in modo affidabile lo stile intesa da qualsiasi oggetto carta (item o auction)
export function detectChemistryStyle(itemOrAuction, fallbackStyle = null) {
  if (!itemOrAuction) {
    if (fallbackStyle && CHEM_STYLES[String(fallbackStyle)]) return String(fallbackStyle);
    return null;
  }
  const data = itemOrAuction.itemData || itemOrAuction;

  // IMPORTANT: Se l'oggetto ha itemType diverso da "training", NON è uno stile intesa!
  if (data.itemType && data.itemType !== "training") {
    return null;
  }

  // 1. Controlla campi in cui l'API UTAS di EA memorizza lo stile intesa
  const candidateIds = [
    data.playStyle,
    data.playstyle,
    data.playStyleId,
    itemOrAuction.playStyle,
    itemOrAuction.playstyle
  ];

  if (data.cardsubtypeid !== undefined && data.cardsubtypeid !== null && data.cardsubtypeid !== 0) {
    candidateIds.push(data.cardsubtypeid);
  }
  if (data.cardSubtypeId !== undefined && data.cardSubtypeId !== null && data.cardSubtypeId !== 0) {
    candidateIds.push(data.cardSubtypeId);
  }

  for (const c of candidateIds) {
    if (c !== undefined && c !== null) {
      const s = String(c);
      if (CHEM_STYLES[s]) {
        return s;
      }
    }
  }

  // 2. Controlla activeBids usando il tradeId o id oggetto
  const idKey = String(itemOrAuction.tradeId || data.id || "");
  if (idKey && activeBids.has(idKey)) {
    const tracked = activeBids.get(idKey);
    if (tracked?.playStyleId && CHEM_STYLES[String(tracked.playStyleId)]) {
      return String(tracked.playStyleId);
    }
  }

  // 3. Fallback: solo se esplicitamente passato ed è valido
  if (fallbackStyle && CHEM_STYLES[String(fallbackStyle)]) {
    return String(fallbackStyle);
  }
  // Se siamo in modalità chem_styles ed è configurato uno stile specifico (non "all")
  if (botState.targetMode === "chem_styles" && botState.chemStyle && botState.chemStyle !== "all" && CHEM_STYLES[String(botState.chemStyle)]) {
    return String(botState.chemStyle);
  }

  return null;
}

// Rileva se un item/auction è un Modificatore Campionato Allenatore tracciato (top 5 campionati)
export function detectManagerLeague(itemOrAuction) {
  if (!itemOrAuction) return null;
  const data = itemOrAuction.itemData || itemOrAuction;
  // Solo carte di tipo training possono essere modificatori campionato
  if (data?.itemType && data.itemType !== "training") return null;
  const tracked = itemOrAuction.tradeId ? activeBids.get(String(itemOrAuction.tradeId)) : null;

  // Nei modificatori campionato EA memorizza l'ID della lega nel campo `amount` (mentre `leagueId` è 0)
  const candidateIds = [
    data?.amount,
    itemOrAuction?.amount,
    tracked?.amount
  ];

  for (const c of candidateIds) {
    if (c !== undefined && c !== null && c > 0) {
      const s = String(c);
      if (MANAGER_LEAGUES[s]) return s;
    }
  }

  return null;
}

// Rileva se un item/auction è un Allenatore (itemType === "manager")
export function detectManager(itemOrAuction) {
  if (!itemOrAuction) return null;
  const data = itemOrAuction.itemData || itemOrAuction;
  if (data?.itemType && data.itemType !== "manager") return null;
  const tracked = itemOrAuction.tradeId ? activeBids.get(String(itemOrAuction.tradeId)) : null;

  const candidateNats = [
    data?.nation,
    itemOrAuction?.nation,
    tracked?.nation,
    tracked?.nat
  ];

  for (const n of candidateNats) {
    if (n !== undefined && n !== null && n > 0) {
      const s = String(n);
      if (TOP_MANAGER_NATIONS[s]) return s;
    }
  }
  if (data?.nation) return String(data.nation);
  return null;
}

// Chiave di pricing unificata: "manager_nat_X" per allenatori, "league_X" per modificatori campionato, altrimenti playStyleId
export function detectConsumableKey(itemOrAuction, fallbackStyle = null) {
  const mgr = detectManager(itemOrAuction);
  if (mgr) return managerTargetKey(mgr);
  const lg = detectManagerLeague(itemOrAuction);
  if (lg) return leagueTargetKey(lg);
  const cs = detectChemistryStyle(itemOrAuction, fallbackStyle);
  return cs ? String(cs) : null;
}

// Nome leggibile per log: allenatore, campionato o stile intesa
export function targetDisplayName(key) {
  if (String(key).startsWith("manager_nat_")) {
    const natId = String(key).slice("manager_nat_".length);
    return `Allenatore ${TOP_MANAGER_NATIONS[natId]?.name || NATION_NAMES[natId] || 'Naz ' + natId}`;
  }
  if (MANAGER_LEAGUES[String(key)]) return MANAGER_LEAGUES[String(key)].name;
  if (String(key).startsWith("league_")) {
    const lg = String(key).slice(7);
    return MANAGER_LEAGUES[lg]?.name || `Lega ${lg}`;
  }
  return CHEM_STYLES[String(key)]?.name || `Stile ${key}`;
}

// Restituisce un nome leggibile per qualsiasi item/auction (allenatore, stile, giocatore, ecc.)
export function getItemDisplayName(itemOrAuction, tracked = null) {
  if (tracked?.name) return tracked.name;
  if (!itemOrAuction) return "Oggetto";
  const mgr = detectManager(itemOrAuction);
  if (mgr) {
    const natName = TOP_MANAGER_NATIONS[mgr]?.name || NATION_NAMES[mgr] || `Naz ${mgr}`;
    return `Allenatore ${natName}`;
  }
  const lg = detectManagerLeague(itemOrAuction);
  if (lg) {
    return `Modificatore ${MANAGER_LEAGUES[lg]?.name || lg}`;
  }
  const cs = detectChemistryStyle(itemOrAuction);
  if (cs && CHEM_STYLES[String(cs)]) {
    return CHEM_STYLES[String(cs)].name;
  }
  if (itemOrAuction.itemData?.name) return itemOrAuction.itemData.name;
  return itemOrAuction.tradeId ? `Trade ${itemOrAuction.tradeId}` : "Oggetto";
}
