// Logica di calcolo prezzi a tier e Auto-Discovery Lowest BIN (Fase 3 Refactor)
import { botState, consumableBinCache } from '../core/state.js';
import { sendMessageSafe, triggerPinEvent } from '../core/messenger.js';
import { handle401Error, handleSearchRateLimit } from '../ea/error-handlers.js';
import { TRANSFERMARKET_URL } from '../ea/endpoints.js';
import {
  CHEM_STYLES,
  MANAGER_LEAGUES,
  TOP_MANAGER_NATIONS,
  NATION_NAMES,
  leagueTargetKey,
  managerTargetKey
} from '../ea/constants.js';
import { sleep, getRandomGaussian, getEaStep, roundUpToStep } from '../core/utils.js';
import {
  detectManager,
  detectManagerLeague,
  detectChemistryStyle,
  formatItemDisplayName
} from './item-classifier.js';
import { getFodderPriceForItem } from './fodder-service.js';

/**
 * Calcola il prezzo di vendita scaglionato per massimizzare le vendite verso Lazy Buyers
 * Distribuzione:
 * - Tier A: 30% delle carte -> Markup veloce (+6%)
 * - Tier B: 50% delle carte -> Markup standard (+10% o lazyMarkupPercent)
 * - Tier C: 20% delle carte -> Markup alto (+15%)
 */
export function getTieredSellPrice(floorBin, customMarkup = null, isConsumable = true) {
  if (!floorBin || floorBin <= 0) return { price: 0, tier: "B", markup: 10 };

  const baseMarkup = (customMarkup !== null && customMarkup > 0) ? customMarkup : (botState.lazyMarkupPercent || 10);

  // Sequenza interallacciata su 10 carte: 3 A (30%), 5 B (50%), 2 C (20%)
  const tierPattern = [
    { tier: "A", factor: 0.6 }, // 0: Tier A (+6%)
    { tier: "B", factor: 1.0 }, // 1: Tier B (+10%)
    { tier: "B", factor: 1.0 }, // 2: Tier B (+10%)
    { tier: "C", factor: 1.5 }, // 3: Tier C (+15%)
    { tier: "A", factor: 0.6 }, // 4: Tier A (+6%)
    { tier: "B", factor: 1.0 }, // 5: Tier B (+10%)
    { tier: "B", factor: 1.0 }, // 6: Tier B (+10%)
    { tier: "A", factor: 0.6 }, // 7: Tier A (+6%)
    { tier: "B", factor: 1.0 }, // 8: Tier B (+10%)
    { tier: "C", factor: 1.5 }  // 9: Tier C (+15%)
  ];

  const currentSlot = tierPattern[botState.listingTierCounter % tierPattern.length];
  botState.listingTierCounter++;

  const appliedMarkup = Math.max(5, Math.round(baseMarkup * currentSlot.factor));
  let rawPrice = floorBin * (1 + (appliedMarkup / 100));
  let calculatedPrice = roundUpToStep(rawPrice);

  if (isConsumable && calculatedPrice > 5000) {
    calculatedPrice = 5000;
  }

  return {
    price: calculatedPrice,
    tier: currentSlot.tier,
    markup: appliedMarkup
  };
}

// Floor di mercato (lowest BIN) per qualsiasi item: allenatore (natId), modificatore campionato (leagueId) o stile intesa.
// Ritorna { floor, name, key }. Usa cache di ciclo (cachedPrices), poi cache 10min, poi discovery live.
export async function resolveConsumableFloor(itemOrAuction, cachedPrices = {}, fallbackStyle = null) {
  const mgr = detectManager(itemOrAuction);
  if (mgr) {
    const key = managerTargetKey(mgr);
    let floor = cachedPrices?.[key]?.floorBin;
    if (!floor && consumableBinCache.has(key)) floor = consumableBinCache.get(key).price;
    if (!floor) floor = await discoverManagerLowestBin(mgr, botState.manualBin);
    const natName = TOP_MANAGER_NATIONS[mgr]?.name || NATION_NAMES[mgr] || `Naz ${mgr}`;
    return { floor: floor || 0, name: `Allenatore ${natName}`, key };
  }
  const lg = detectManagerLeague(itemOrAuction);
  if (lg) {
    const key = leagueTargetKey(lg);
    let floor = cachedPrices?.[key]?.floorBin;
    if (!floor && consumableBinCache.has(key)) floor = consumableBinCache.get(key).price;
    if (!floor) floor = await discoverLeagueModifierLowestBin(lg, botState.manualBin);
    return { floor: floor || 0, name: `Modificatore ${MANAGER_LEAGUES[lg].name}`, key };
  }
  const sId = detectChemistryStyle(itemOrAuction, fallbackStyle || (botState.targetMode === "chem_styles" ? botState.chemStyle : null));
  if (sId && CHEM_STYLES[String(sId)]) {
    let floor = cachedPrices?.[sId]?.floorBin;
    if (!floor && consumableBinCache.has(sId)) floor = consumableBinCache.get(sId).price;
    if (!floor) floor = await discoverConsumableLowestBin(sId, botState.manualBin);
    return { floor: floor || 0, name: CHEM_STYLES[sId]?.name || `Stile ${sId}`, key: sId };
  }
  return { floor: 0, name: "Consumabile", key: null };
}

// Valida per qualsiasi tipologia di carta: Stili Intesa, Modificatori Campionato, Allenatori e Calciatori
export async function discoverCustomLowestBin(searchFilterParams, displayName, cacheKey, manualBinOverride = 0, forceRefresh = false) {
  if (manualBinOverride && manualBinOverride > 0) {
    console.log(`[FC Sniper Discovery] Usato BIN manuale impostato dall'utente: ${manualBinOverride} crediti`);
    return manualBinOverride;
  }

  const CACHE_TTL_MS = 10 * 60 * 1000;
  if (!forceRefresh && cacheKey && consumableBinCache.has(String(cacheKey))) {
    const cached = consumableBinCache.get(String(cacheKey));
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
      const minsLeft = Math.round((CACHE_TTL_MS - (Date.now() - cached.timestamp)) / 60000);
      console.log(`[FC Sniper Discovery] Usato Floor BIN in cache (${cached.price} cr) per ${displayName} (valido ancora per ${minsLeft} min)`);
      return cached.price;
    }
  }

  // Protezione Soft-Ban: se il mercato è in restrizione (512 / 429), non effettuare ricerche extra
  if (botState.marketRestricted) {
    if (cacheKey && consumableBinCache.has(String(cacheKey))) {
      return consumableBinCache.get(String(cacheKey)).price;
    }
    return 0;
  }

  console.log(`[FC Sniper Discovery] Avvio rilevamento Lowest BIN istantaneo per ${displayName}...`);
  sendMessageSafe({
    tipo: 'LOG',
    valore: `[Auto-Discovery] Analisi di mercato per ${displayName}: cerco il prezzo di vendita istantanea (58-59m)...`
  });

  const baseUrl = TRANSFERMARKET_URL;
  const headers = new Headers({
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    "X-UT-SID": botState.xUtSid
  });

  // FASE 1: Ricerca iniziale per determinare il tetto massimo da cui iniziare la scrematura
  let candidateBin = 0;
  const initialCache = cacheKey ? consumableBinCache.get(String(cacheKey)) : null;
  let startingPrice = initialCache?.price ? initialCache.price + (getEaStep(initialCache.price) * 2) : 0;

  try {
    const probeUrl = new URL(baseUrl);
    probeUrl.searchParams.set("num", "21");
    probeUrl.searchParams.set("start", "0");
    for (const [k, v] of Object.entries(searchFilterParams)) {
      if (v !== undefined && v !== null && v !== "") {
        probeUrl.searchParams.set(k, String(v));
      }
    }
    if (startingPrice > 0) {
      probeUrl.searchParams.set("maxb", String(startingPrice));
    }
    probeUrl.searchParams.set("micr", "150");

    await triggerPinEvent("TRIGGER_PIN_SEARCH");
    const probeResp = await fetch(probeUrl.href, { method: "GET", headers });
    if (probeResp.status === 401) {
      await handle401Error("AutoDiscovery Probe");
      return 0;
    } else if (probeResp.status === 429 || probeResp.status === 426 || probeResp.status === 521 || probeResp.status === 512) {
      await handleSearchRateLimit(probeResp.status, "AutoDiscovery Probe");
      return 0;
    }

    if (probeResp.ok) {
      const probeData = await probeResp.json();
      const probeAuctions = probeData.auctionInfo || [];
      const buyNows = probeAuctions.map(a => a.buyNowPrice).filter(p => p > 0);
      if (buyNows.length > 0) {
        candidateBin = Math.min(...buyNows);
      }
    }
  } catch (e) {
    console.error("[AutoDiscovery Probe Error]", e);
  }

  // Se con il filtro maxb non abbiamo trovato carte, facciamo una ricerca libera aperta
  if (!candidateBin || candidateBin <= 0) {
    await sleep(getRandomGaussian(0.8, 0.1, 0.6, 1.0) * 1000);
    try {
      const openUrl = new URL(baseUrl);
      openUrl.searchParams.set("num", "21");
      openUrl.searchParams.set("start", "0");
      for (const [k, v] of Object.entries(searchFilterParams)) {
        if (v !== undefined && v !== null && v !== "") {
          openUrl.searchParams.set(k, String(v));
        }
      }
      openUrl.searchParams.set("micr", "200");

      await triggerPinEvent("TRIGGER_PIN_SEARCH");
      const openResp = await fetch(openUrl.href, { method: "GET", headers });
      if (openResp.status === 401) {
        await handle401Error("AutoDiscovery Open Probe");
        return 0;
      } else if (openResp.status === 429 || openResp.status === 426 || openResp.status === 521 || openResp.status === 512) {
        await handleSearchRateLimit(openResp.status, "AutoDiscovery Open Probe");
        return 0;
      }

      if (openResp.ok) {
        const openData = await openResp.json();
        const openAuctions = openData.auctionInfo || [];
        const openBuyNows = openAuctions.map(a => a.buyNowPrice).filter(p => p > 0);
        if (openBuyNows.length > 0) {
          candidateBin = Math.min(...openBuyNows);
        }
      }
    } catch (e) {
      console.error("[AutoDiscovery Open Probe Error]", e);
    }
  }

  if (!candidateBin || candidateBin <= 0) {
    console.warn(`[FC Sniper Discovery] Nessuna carta presente sul mercato per ${displayName}.`);
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[BLOCCO SICUREZZA] Nessuna carta presente sul mercato per ${displayName}. Prezzo discovery non disponibile.`
    });
    return 0;
  }

  console.log(`[FC Sniper Discovery] Inizio scrematura verso il basso per ${displayName} a partire da ${candidateBin} crediti.`);

  // FASE 2: Scrematura progressiva del prezzo (Downward Skimming)
  const MAX_SCREMATURA_ITERATIONS = 7;
  let verifiedBin = 0;

  for (let stepIdx = 0; stepIdx < MAX_SCREMATURA_ITERATIONS; stepIdx++) {
    if (botState.start !== true) break;

    await sleep(getRandomGaussian(0.9, 0.12, 0.7, 1.2) * 1000);

    const testUrl = new URL(baseUrl);
    testUrl.searchParams.set("num", "21");
    testUrl.searchParams.set("start", "0");
    for (const [k, v] of Object.entries(searchFilterParams)) {
      if (v !== undefined && v !== null && v !== "") {
        testUrl.searchParams.set(k, String(v));
      }
    }
    testUrl.searchParams.set("maxb", String(candidateBin));
    testUrl.searchParams.set("micr", String(150 + (stepIdx * 50) + (Math.random() < 0.5 ? 0 : 50)));

    await triggerPinEvent("TRIGGER_PIN_SEARCH");

    let auctions = [];
    try {
      const resp = await fetch(testUrl.href, { method: "GET", headers });
      if (resp.status === 401) {
        await handle401Error("AutoDiscovery Scrematura");
        return 0;
      } else if (resp.status === 429 || resp.status === 426 || resp.status === 521 || resp.status === 512) {
        await handleSearchRateLimit(resp.status, "AutoDiscovery Scrematura");
        return 0;
      }
      if (!resp.ok) break;

      const data = await resp.json();
      auctions = data.auctionInfo || [];
    } catch (err) {
      console.error("[AutoDiscovery Scrematura Error]", err);
      break;
    }

    const totalCards = auctions.length;
    const freshCards = auctions.filter(a => (a.expires >= 3450 && a.expires <= 3600) || (a.expires >= 10650 && a.expires <= 10800));
    const staleCards = auctions.filter(a => a.expires > 0 && a.expires < 3450);

    console.log(`[FC Sniper Scrematura] Test maxb: ${candidateBin} crediti -> ${totalCards} carte trovate (Fresche 58-59m: ${freshCards.length}, Stagnanti: ${staleCards.length})`);

    // CASO A: Trovate carte e TUTTE hanno tempo 58-59 minuti rimanenti
    if (totalCards > 0 && staleCards.length === 0) {
      verifiedBin = candidateBin;
      console.log(`[FC Sniper Discovery] Condizione di vendita istantanea confermata per ${displayName} a ${verifiedBin} crediti! (${totalCards} carte fresche a 58-59 min).`);
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[Auto-Discovery] Lowest BIN live per ${displayName}: ${verifiedBin} crediti (${totalCards} carte fresche a 58-59m)!`
      });
      break;
    }

    // CASO B: 0 carte trovate a questo prezzo
    if (totalCards === 0) {
      const step = getEaStep(candidateBin);
      verifiedBin = candidateBin + step;
      console.log(`[FC Sniper Discovery] 0 carte trovate a ${candidateBin} per ${displayName}. Lowest BIN reale: ${verifiedBin} crediti.`);
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[Auto-Discovery] Lowest BIN reale per ${displayName}: ${verifiedBin} crediti (0 carte a ${candidateBin})!`
      });
      break;
    }

    // CASO C: Ci sono carte stagnanti o troppe carte -> scremiamo verso il basso
    const step = getEaStep(candidateBin);
    const nextLower = candidateBin - step;

    if (nextLower < 200) {
      verifiedBin = 200;
      break;
    }

    console.log(`[FC Sniper Scrematura] A ${candidateBin} ci sono ${totalCards} carte (${staleCards.length} ferme da oltre 2 min). Scremo verso il basso a ${nextLower}...`);
    candidateBin = nextLower;
  }

  if (!verifiedBin && candidateBin > 0) {
    verifiedBin = candidateBin;
  }

  if (verifiedBin > 0) {
    if (cacheKey) {
      consumableBinCache.set(String(cacheKey), { price: verifiedBin, timestamp: Date.now() });
    }
    return verifiedBin;
  }

  return 0;
}

// Auto-Discovery del Lowest BIN reale sul mercato per uno Stile Intesa
export async function discoverConsumableLowestBin(playStyleId, manualBinOverride = 0, forceRefresh = false) {
  const styleMeta = CHEM_STYLES[String(playStyleId)] || { id: playStyleId, name: `Stile ${playStyleId}`, defaultGuess: 3000 };
  const params = {
    type: "training",
    cat: "playStyle",
    playStyle: String(playStyleId)
  };
  return discoverCustomLowestBin(params, styleMeta.name, String(playStyleId), manualBinOverride, forceRefresh);
}

// Rileva il Lowest BIN di un Modificatore Campionato Allenatore (cat=managerLeagueModifier&amount=<leagueId>).
export async function discoverLeagueModifierLowestBin(leagueId, manualBinOverride = 0, forceRefresh = false) {
  const meta = MANAGER_LEAGUES[String(leagueId)] || { id: leagueId, name: `Lega ${leagueId}`, defaultGuess: 1000 };
  const params = {
    type: "training",
    cat: "managerLeagueModifier",
    amount: String(leagueId)
  };
  return discoverCustomLowestBin(params, `Modificatore ${meta.name}`, leagueTargetKey(leagueId), manualBinOverride, forceRefresh);
}

// Auto-Discovery del Lowest BIN reale per Allenatori di una determinata nazione (type=staff&cat=manager&nat=<natId>)
export async function discoverManagerLowestBin(natId, manualBinOverride = 0, forceRefresh = false) {
  const meta = TOP_MANAGER_NATIONS[String(natId)] || { id: Number(natId), name: NATION_NAMES[natId] || `Naz ${natId}`, defaultGuess: 2000 };
  const params = {
    type: "staff",
    cat: "manager",
    nat: String(natId)
  };
  return discoverCustomLowestBin(params, `Allenatore ${meta.name}`, managerTargetKey(natId), manualBinOverride, forceRefresh);
}

// Price Discovery specializzata per carte acquistate/tracciate in Bidding Manuale (Allenatori, Calciatori, Consumabili)
export async function discoverManualItemLowestBin(item, tracked = null) {
  const data = item?.itemData || item || {};
  const itemType = data.itemType || tracked?.itemType || tracked?.cardType || "";

  // 1. Modificatore campionato allenatore
  const lgId = detectManagerLeague(item);
  if (lgId && MANAGER_LEAGUES[lgId]) {
    const floor = await discoverLeagueModifierLowestBin(lgId, botState.manualBin);
    return { floor, name: `Modificatore ${MANAGER_LEAGUES[lgId].name}`, isConsumable: true };
  }

  // 2. Stile intesa
  const cStyle = detectChemistryStyle(item, tracked?.playStyleId);
  if (cStyle && CHEM_STYLES[cStyle]) {
    const floor = await discoverConsumableLowestBin(cStyle, botState.manualBin);
    return { floor, name: CHEM_STYLES[cStyle].name, isConsumable: true };
  }

  // 3. Allenatore (Manager)
  if (itemType === "manager") {
    const params = { type: "staff", cat: "manager" };
    const sourceUrl = tracked?.searchUrl || botState.searchUrl;
    if (sourceUrl) {
      try {
        const u = new URL(sourceUrl);
        for (const [k, v] of u.searchParams.entries()) {
          if (!["start", "num", "minb", "maxb", "micr", "macr"].includes(k)) {
            params[k] = v;
          }
        }
      } catch (_) {}
    }
    if (data.nation && !params.nat) params.nat = String(data.nation);
    if (data.leagueId && !params.league && data.leagueId > 0) params.league = String(data.leagueId);

    const name = formatItemDisplayName(item, item.tradeId);
    const cacheKey = `manager_nat_${params.nat || 0}_lg_${params.league || 0}`;
    const floor = await discoverCustomLowestBin(params, name, cacheKey, botState.manualBin);
    return { floor, name, isConsumable: false };
  }

  // 4. Calciatore (Player)
  if (itemType === "player") {
    const params = { type: "player" };
    const sourceUrl = tracked?.searchUrl || botState.searchUrl;
    if (sourceUrl) {
      try {
        const u = new URL(sourceUrl);
        for (const [k, v] of u.searchParams.entries()) {
          if (!["start", "num", "minb", "maxb", "micr", "macr"].includes(k)) {
            params[k] = v;
          }
        }
      } catch (_) {}
    }
    const assetId = data.assetId || data.resourceId || tracked?.assetId;
    if (assetId && !params.maskedDefId) {
      params.maskedDefId = String(assetId);
    }
    const name = formatItemDisplayName(item, item.tradeId);
    const cacheKey = `player_${params.maskedDefId || assetId || data.id}`;
    const floor = await discoverCustomLowestBin(params, name, cacheKey, botState.manualBin);
    return { floor, name, isConsumable: false };
  }

  // 5. Qualsiasi altra ricerca manuale generica dalla Web App
  const sourceUrl = tracked?.searchUrl || botState.searchUrl;
  if (sourceUrl) {
    const params = {};
    try {
      const u = new URL(sourceUrl);
      for (const [k, v] of u.searchParams.entries()) {
        if (!["start", "num", "minb", "maxb", "micr", "macr"].includes(k)) {
          params[k] = v;
        }
      }
    } catch (_) {}
    if (Object.keys(params).length > 0) {
      const name = formatItemDisplayName(item, item.tradeId);
      const cacheKey = `search_${JSON.stringify(params)}`;
      const floor = await discoverCustomLowestBin(params, name, cacheKey, botState.manualBin);
      return { floor, name, isConsumable: false };
    }
  }

  return { floor: 0, name: formatItemDisplayName(item, item.tradeId), isConsumable: false };
}

// Calcola o scopre il prezzo di vendita corretto per qualsiasi carta vinta (Fodder, Consumabile, Manager, Giocatore)
export async function resolveItemSellPrice(item, tracked = null) {
  let sellPrice = tracked?.sellPrice || 0;
  let tierTag = "";

  if (tracked?.basePrice && tracked.basePrice > 0) {
    if (botState.targetMode === "managers" || tracked?.isManager) {
      return { sellPrice: tracked.basePrice, tierTag: " [Istantaneo: Lowest BIN live]" };
    }
    if (botState.targetMode === "manual" || tracked?.isManual || botState.strategyMode === "bidding") {
      let sellPrice = tracked.basePrice;
      if (tracked.isConsumable && sellPrice > 5000) sellPrice = 5000;
      return { sellPrice, tierTag: " [Istantaneo: Lowest BIN live]" };
    }
    const tiered = getTieredSellPrice(tracked.basePrice, null, false);
    return { sellPrice: tiered.price, tierTag: ` (Tier ${tiered.tier}: +${tiered.markup}%)` };
  }

  if (sellPrice > 0) {
    return { sellPrice, tierTag: "" };
  }

  const data = item.itemData || item || {};

  // 1. Modalità Fodder
  if (botState.targetMode === "fodder" || tracked?.isFodder) {
    const fFloor = await getFodderPriceForItem(data);
    if (fFloor > 0) {
      const tiered = getTieredSellPrice(fFloor, null, false);
      return { sellPrice: tiered.price, tierTag: ` (Tier ${tiered.tier}: +${tiered.markup}%)` };
    }
  }

  // 2. Modificatore campionato allenatore
  const lgId = detectManagerLeague(item);
  if (lgId && MANAGER_LEAGUES[lgId]) {
    console.log(`[FC Sniper Pricing] Risoluzione dinamica prezzo per Modificatore ${MANAGER_LEAGUES[lgId].name}...`);
    const floor = await discoverLeagueModifierLowestBin(lgId, botState.manualBin);
    if (floor > 0) {
      const tiered = getTieredSellPrice(floor, null, true);
      return { sellPrice: tiered.price, tierTag: ` (Tier ${tiered.tier}: +${tiered.markup}%)` };
    }
  }

  // 2b. Allenatore (Manager) - Vendita istantanea al Lowest BIN live (senza maggiorazioni tier)
  const mgrNat = detectManager(item);
  if (mgrNat || data.itemType === "manager" || botState.targetMode === "managers" || tracked?.isManager) {
    const nat = mgrNat || data.nation || tracked?.nation || (botState.managerNation.includes(",") ? botState.managerNation.split(",")[0] : botState.managerNation);
    console.log(`[FC Sniper Pricing] Risoluzione dinamica prezzo per Allenatore (Naz ${nat})...`);
    const floor = await discoverManagerLowestBin(nat, botState.manualBin);
    if (floor > 0) {
      return { sellPrice: floor, tierTag: " [Istantaneo: Lowest BIN live]" };
    }
  }

  // 3. Stile intesa (Training con stile valido)
  const detectedStyleId = detectChemistryStyle(item, tracked?.playStyleId);
  if (detectedStyleId && CHEM_STYLES[String(detectedStyleId)]) {
    console.log(`[FC Sniper Pricing] Risoluzione dinamica prezzo per ${CHEM_STYLES[String(detectedStyleId)].name}...`);
    const floor = await discoverConsumableLowestBin(detectedStyleId, botState.manualBin);
    if (floor > 0) {
      const tiered = getTieredSellPrice(floor, null, true);
      return { sellPrice: tiered.price, tierTag: ` (Tier ${tiered.tier}: +${tiered.markup}%)` };
    }
  }

  // 4. Modalità Manuale o Carta Bidding Manuale (Allenatore, Calciatore, Consumabile generico)
  if (botState.targetMode === "manual" || tracked?.isManual || botState.strategyMode === "bidding") {
    console.log(`[FC Sniper Pricing] Risoluzione prezzo tramite Auto-Discovery Manual Bidding (vendita istantanea al floor)...`);
    const res = await discoverManualItemLowestBin(item, tracked);
    if (res.floor > 0) {
      // Nel manual bidding vendita istantanea al Lowest BIN live (senza maggiorazioni di tier)
      let sellPrice = res.floor;
      if (res.isConsumable && sellPrice > 5000) sellPrice = 5000;
      return { sellPrice, tierTag: " [Istantaneo: Lowest BIN live]" };
    }
  }

  return { sellPrice: 0, tierTag: "" };
}
