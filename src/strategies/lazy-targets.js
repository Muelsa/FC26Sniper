// Costruzione prezzi e target di ciclo per le 4 modalità Lazy Trading (Fodder, Campionati, Allenatori, Consumabili)
import { botState } from '../core/state.js';
import { sendMessageSafe } from '../core/messenger.js';
import { TRANSFERMARKET_URL } from '../ea/endpoints.js';
import {
  CHEM_STYLES,
  MANAGER_LEAGUES,
  TOP_MANAGER_NATIONS,
  NATION_NAMES,
  leagueTargetKey,
  managerTargetKey
} from '../ea/constants.js';
import { getFodderList } from '../services/fodder-service.js';
import {
  discoverLeagueModifierLowestBin,
  discoverManagerLowestBin,
  discoverConsumableLowestBin
} from '../services/pricing-service.js';
import { detectManagerLeague } from '../services/item-classifier.js';
import { roundDownToStep, roundUpToStep, sleep, getRandomGaussian } from '../core/utils.js';

export async function buildFodderLazyTargets(cycle, markup, minNetProfit) {
  botState.listaFodder = [];
  botState.indexFodder = 0;
  await getFodderList();

  if (botState.listaFodder.length === 0) {
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[LAZY FODDER] Nessun giocatore trovato per Rating ${botState.fodderRating} dal server locale. Attendo 10s prima di riprovare...`
    });
    await sleep(10000);
    return { shouldContinue: true, cyclePrices: null, targets: [], minBidRequired: Infinity, targetStyles: null };
  }

  const validPrices = botState.listaFodder.map(f => f.price).filter(p => typeof p === 'number' && p > 0);
  if (validPrices.length === 0) {
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[LAZY FODDER] Nessun prezzo valido disponibile per Rating ${botState.fodderRating}. Attendo 10s...`
    });
    await sleep(10000);
    return { shouldContinue: true, cyclePrices: null, targets: [], minBidRequired: Infinity, targetStyles: null };
  }

  const playerPriceMap = new Map();
  botState.listaFodder.forEach(f => {
    const pPrice = Number(f.price) || 0;
    const pTierA = roundUpToStep(pPrice * 1.06);
    const pTierB = roundUpToStep(pPrice * (1 + (markup / 100)));
    const pTierC = roundUpToStep(pPrice * 1.15);
    const minNet = Math.floor(pTierA * 0.95);
    const maxBuy = roundDownToStep(minNet - minNetProfit);

    const pInfo = {
      name: f.name || "",
      basePrice: pPrice,
      tierAPrice: pTierA,
      tierBPrice: pTierB,
      tierCPrice: pTierC,
      maxBuyAllowed: maxBuy
    };
    playerPriceMap.set(String(f.pid), pInfo);
    f.priceInfo = pInfo;
  });

  botState.listaFodder.sort((a, b) => (a.price || 999999) - (b.price || 999999));

  const benchmarkFloor = botState.listaFodder[0]?.price || 0;
  const maxPlayerPrice = botState.listaFodder[botState.listaFodder.length - 1]?.price || benchmarkFloor;
  const minMaxBuy = botState.listaFodder[0]?.priceInfo?.maxBuyAllowed || 0;
  const maxMaxBuy = botState.listaFodder[botState.listaFodder.length - 1]?.priceInfo?.maxBuyAllowed || minMaxBuy;

  const cyclePrices = {
    benchmarkFloor: benchmarkFloor,
    floorBin: benchmarkFloor,
    sellPrice: botState.listaFodder[0]?.priceInfo?.tierBPrice || 0,
    tierAPrice: botState.listaFodder[0]?.priceInfo?.tierAPrice || 0,
    tierBPrice: botState.listaFodder[0]?.priceInfo?.tierBPrice || 0,
    tierCPrice: botState.listaFodder[0]?.priceInfo?.tierCPrice || 0,
    maxBidAllowed: maxMaxBuy,
    maxBuyNowAllowed: maxMaxBuy,
    rating: botState.fodderRating,
    playerPriceMap: playerPriceMap
  };

  sendMessageSafe({
    tipo: 'LOG',
    valore: `[PREZZI FODDER CICLO #${cycle}] Rating ${botState.fodderRating} (${botState.listaFodder.length} giocatori) -> Valori Fut.gg: ${benchmarkFloor} - ${maxPlayerPrice} cr | Prezzi Max Safe individuali: da ${minMaxBuy} a ${maxMaxBuy} cr (Margine netto min: +200 cr garantito) | Vendite Scaglionate 1 ORA (Tier A +6%, Tier B +${markup}%, Tier C +15%)`
  });

  const targets = botState.listaFodder.filter(p => p && p.pid && p.priceInfo && p.priceInfo.maxBuyAllowed >= 150).map(p => {
    const pi = p.priceInfo;
    return {
      key: String(p.pid),
      name: p.name || 'PID ' + p.pid,
      maxBid: pi.maxBuyAllowed,
      maxBuyNow: pi.maxBuyAllowed,
      strongBase: pi.maxBuyAllowed,
      tierBase: pi.basePrice,
      sellPrice: pi.tierBPrice,
      tierIsConsumable: false,
      buildUrl: (micr, kind) => {
        const url = new URL(TRANSFERMARKET_URL);
        url.searchParams.set("num", "21");
        url.searchParams.set("start", "0");
        url.searchParams.set("type", "player");
        url.searchParams.set("maskedDefId", String(p.pid));
        url.searchParams.set(kind === "bid" ? "macr" : "maxb", String(pi.maxBuyAllowed));
        url.searchParams.set("micr", String(micr));
        return url;
      },
      bidDataBase: { pid: p.pid, name: p.name, playStyleId: null, basePrice: pi.basePrice, isConsumable: false }
    };
  });

  return {
    shouldContinue: false,
    cyclePrices,
    targets,
    minBidRequired: minMaxBuy,
    targetStyles: null
  };
}

export async function buildManagerLeagueLazyTargets(cycle, markup, minNetProfit) {
  let targetStyles = Object.keys(MANAGER_LEAGUES);
  const leagueKeys = targetStyles.map(leagueTargetKey);

  const cyclePrices = {};
  for (const lgId of targetStyles) {
    if (botState.start !== true) break;
    const meta = MANAGER_LEAGUES[lgId];
    const key = leagueTargetKey(lgId);
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[Auto-Discovery Ciclo #${cycle}] Rilevamento Lowest BIN per Modificatore ${meta.name}...`
    });

    const floor = await discoverLeagueModifierLowestBin(lgId, botState.manualBin, false);
    if (botState.start !== true) break;
    if (floor && floor > 0) {
      const pTierA = Math.min(5000, roundUpToStep(floor * 1.06));
      const pTierB = Math.min(5000, roundUpToStep(floor * (1 + (markup / 100))));
      const pTierC = Math.min(5000, roundUpToStep(floor * 1.15));

      const minNetRevenue = Math.floor(pTierA * 0.95);
      let maxBuyAllowed = roundDownToStep(minNetRevenue - minNetProfit);
      if (maxBuyAllowed > 4500) {
        maxBuyAllowed = 4500;
      }

      if (maxBuyAllowed < 150) {
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[GUARD-RAIL NETTO MINIMO] Modificatore ${meta.name} (Floor: ${floor} cr): prezzo max d'acquisto (${maxBuyAllowed} cr) insufficiente per garantire il margine netto minimo di +${minNetProfit} cr. Campionato escluso in questo ciclo!`
        });
        continue;
      }

      cyclePrices[key] = {
        floorBin: floor,
        maxBidAllowed: maxBuyAllowed,
        maxBuyNowAllowed: maxBuyAllowed,
        sellPrice: pTierB,
        meta: meta,
        tierAPrice: pTierA,
        tierBPrice: pTierB,
        tierCPrice: pTierC
      };

      const minProfitText = (minNetRevenue - maxBuyAllowed);
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[PREZZI CICLO #${cycle}] Modificatore ${meta.name} -> Floor: ${floor} | Prezzo Max Acquisto: <= ${maxBuyAllowed} (Profitto netto min garantito: +${minProfitText} cr) | Vendite Scaglionate: A (+6%): ${pTierA}, B (+${markup}%): ${pTierB}, C (+15%): ${pTierC}`
      });
    }
    if (botState.start !== true) break;
    await sleep(getRandomGaussian(1.5, 0.2, 1.2, 1.8) * 1000);
  }
  if (botState.start !== true) {
    return { shouldContinue: true, cyclePrices, targets: [], minBidRequired: Infinity, targetStyles };
  }

  targetStyles = leagueKeys;
  const targets = leagueKeys.filter(key => cyclePrices[key] && cyclePrices[key].maxBidAllowed >= 150).map(key => {
    const pi = cyclePrices[key];
    const lgId = key.slice(7);
    return {
      key: key,
      name: `Modificatore ${pi.meta.name}`,
      maxBid: pi.maxBidAllowed,
      maxBuyNow: pi.maxBuyNowAllowed,
      strongBase: pi.floorBin,
      tierBase: pi.floorBin,
      sellPrice: pi.sellPrice,
      tierIsConsumable: true,
      itemFilter: (a) => detectManagerLeague(a) === lgId,
      buildUrl: (micr, kind) => {
        const url = new URL(TRANSFERMARKET_URL);
        url.searchParams.set("num", "21");
        url.searchParams.set("start", "0");
        url.searchParams.set("type", "training");
        url.searchParams.set("cat", "managerLeagueModifier");
        url.searchParams.set("amount", String(lgId));
        url.searchParams.set(kind === "bid" ? "macr" : "maxb", String(kind === "bid" ? pi.maxBidAllowed : pi.maxBuyNowAllowed));
        url.searchParams.set("micr", String(micr));
        return url;
      },
      bidDataBase: { playStyleId: null, leagueId: lgId, amount: Number(lgId), name: `Modificatore ${pi.meta.name}`, isConsumable: true }
    };
  });

  if (targets.length === 0) {
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[LAZY CAMPIONATI] Nessun campionato rispetta il guard-rail di margine netto minimo (+${minNetProfit} cr). Attendo il prossimo ciclo...`
    });
  }
  const minBidRequired = targets.length > 0 ? Math.min(...targets.map(t => t.maxBid)) : Infinity;

  return {
    shouldContinue: false,
    cyclePrices,
    targets,
    minBidRequired,
    targetStyles
  };
}

export async function buildManagersLazyTargets(cycle) {
  const selectedNats = (botState.managerNation || "18,34").split(",").map(s => s.trim()).filter(Boolean);
  const managerKeys = selectedNats.map(managerTargetKey);

  const cyclePrices = {};
  for (const natId of selectedNats) {
    if (botState.start !== true) break;
    const meta = TOP_MANAGER_NATIONS[natId] || { id: Number(natId), name: NATION_NAMES[natId] || `Naz ${natId}` };
    const key = managerTargetKey(natId);
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[Auto-Discovery Ciclo #${cycle}] Rilevamento Lowest BIN per Allenatore ${meta.name}...`
    });

    const floor = await discoverManagerLowestBin(natId, botState.manualBin, false);
    if (botState.start !== true) break;
    if (floor && floor > 0) {
      const maxBuyAllowed = roundDownToStep(floor * 0.85);

      if (maxBuyAllowed < 150) {
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[GUARD-RAIL] Allenatore ${meta.name} (Floor: ${floor} cr): prezzo max d'acquisto a -15% (${maxBuyAllowed} cr) inferiore al minimo di mercato (150 cr). Nazione esclusa in questo ciclo!`
        });
        continue;
      }

      cyclePrices[key] = {
        floorBin: floor,
        maxBidAllowed: maxBuyAllowed,
        maxBuyNowAllowed: maxBuyAllowed,
        sellPrice: floor,
        meta: meta
      };

      const estProfit = Math.floor(floor * 0.95) - maxBuyAllowed;
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[PREZZI CICLO #${cycle}] Allenatore ${meta.name} -> Lowest BIN: ${floor} cr | Prezzo Max Acquisto (-15%): <= ${maxBuyAllowed} cr (Profitto netto stimato: +${estProfit} cr) | Vendita Istantanea: ${floor} cr`
      });
    }
    if (botState.start !== true) break;
    await sleep(getRandomGaussian(1.5, 0.2, 1.2, 1.8) * 1000);
  }
  if (botState.start !== true) {
    return { shouldContinue: true, cyclePrices, targets: [], minBidRequired: Infinity, targetStyles: managerKeys };
  }

  const targetStyles = managerKeys;
  const targets = managerKeys.filter(key => cyclePrices[key] && cyclePrices[key].maxBidAllowed >= 150).map(key => {
    const pi = cyclePrices[key];
    const natId = key.slice("manager_nat_".length);
    return {
      key: key,
      name: `Allenatore ${pi.meta.name}`,
      maxBid: pi.maxBidAllowed,
      maxBuyNow: pi.maxBuyNowAllowed,
      strongBase: pi.floorBin,
      tierBase: pi.floorBin,
      sellPrice: pi.sellPrice,
      tierIsConsumable: false,
      isManagerTarget: true,
      itemFilter: (a) => {
        const data = a.itemData || a;
        return (data.itemType === "manager" || a.itemType === "manager") &&
               (String(data.nation) === String(natId) || String(a.nation) === String(natId));
      },
      buildUrl: (micr, kind) => {
        const url = new URL(TRANSFERMARKET_URL);
        url.searchParams.set("num", "21");
        url.searchParams.set("start", "0");
        url.searchParams.set("type", "staff");
        url.searchParams.set("cat", "manager");
        url.searchParams.set("nat", String(natId));
        url.searchParams.set(kind === "bid" ? "macr" : "maxb", String(kind === "bid" ? pi.maxBidAllowed : pi.maxBuyNowAllowed));
        url.searchParams.set("micr", String(micr));
        return url;
      },
      bidDataBase: {
        nat: natId,
        nation: Number(natId),
        name: `Allenatore ${pi.meta.name}`,
        isManager: true,
        isConsumable: false,
        basePrice: pi.floorBin,
        sellPrice: pi.floorBin
      }
    };
  });

  if (targets.length === 0) {
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[LAZY ALLENATORI] Nessuna nazione allenatori selezionata ha prezzi validi. Attendo il prossimo ciclo...`
    });
  }
  const minBidRequired = targets.length > 0 ? Math.min(...targets.map(t => t.maxBid)) : Infinity;

  return {
    shouldContinue: false,
    cyclePrices,
    targets,
    minBidRequired,
    targetStyles
  };
}

export async function buildConsumablesLazyTargets(cycle, markup, minNetProfit) {
  const targetStyles = (botState.chemStyle === "all") ? ["268", "266", "265", "260"] : [String(botState.chemStyle)];

  const cyclePrices = {};
  for (const sId of targetStyles) {
    if (botState.start !== true) break;
    const meta = CHEM_STYLES[sId] || { id: sId, name: `Stile ${sId}` };
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[Auto-Discovery Ciclo #${cycle}] Rilevamento Lowest BIN per ${meta.name}...`
    });

    const floor = await discoverConsumableLowestBin(sId, botState.manualBin, false);
    if (botState.start !== true) break;
    if (floor && floor > 0) {
      const pTierA = Math.min(5000, roundUpToStep(floor * 1.06));
      const pTierB = Math.min(5000, roundUpToStep(floor * (1 + (markup / 100))));
      const pTierC = Math.min(5000, roundUpToStep(floor * 1.15));

      const minNetRevenue = Math.floor(pTierA * 0.95);
      let maxBuyAllowed = roundDownToStep(minNetRevenue - minNetProfit);
      if (maxBuyAllowed > 4500) {
        maxBuyAllowed = 4500;
      }

      if (maxBuyAllowed < 150) {
        sendMessageSafe({
          tipo: 'LOG',
          valore: `[GUARD-RAIL NETTO MINIMO] ${meta.name} (Floor: ${floor} cr): prezzo max d'acquisto (${maxBuyAllowed} cr) insufficiente per garantire il margine netto minimo di +${minNetProfit} cr. Stile escluso in questo ciclo!`
        });
        continue;
      }

      cyclePrices[sId] = {
        floorBin: floor,
        maxBidAllowed: maxBuyAllowed,
        maxBuyNowAllowed: maxBuyAllowed,
        sellPrice: pTierB,
        meta: meta,
        tierAPrice: pTierA,
        tierBPrice: pTierB,
        tierCPrice: pTierC
      };

      const minProfitText = (minNetRevenue - maxBuyAllowed);
      sendMessageSafe({
        tipo: 'LOG',
        valore: `[PREZZI CICLO #${cycle}] ${meta.name} -> Floor: ${floor} | Prezzo Max Acquisto: <= ${maxBuyAllowed} (Profitto netto min garantito: +${minProfitText} cr) | Vendite Scaglionate: A (+6%): ${pTierA}, B (+${markup}%): ${pTierB}, C (+15%): ${pTierC}`
      });
    }
    if (botState.start !== true) break;
    await sleep(getRandomGaussian(1.5, 0.2, 1.2, 1.8) * 1000);
  }
  if (botState.start !== true) {
    return { shouldContinue: true, cyclePrices, targets: [], minBidRequired: Infinity, targetStyles };
  }

  const targets = targetStyles.filter(sId => cyclePrices[sId] && cyclePrices[sId].maxBidAllowed >= 150).map(sId => {
    const pi = cyclePrices[sId];
    return {
      key: sId,
      name: pi.meta.name,
      maxBid: pi.maxBidAllowed,
      maxBuyNow: pi.maxBuyNowAllowed,
      strongBase: pi.floorBin,
      tierBase: pi.floorBin,
      sellPrice: pi.sellPrice,
      tierIsConsumable: true,
      buildUrl: (micr, kind) => {
        const url = new URL(TRANSFERMARKET_URL);
        url.searchParams.set("num", "21");
        url.searchParams.set("start", "0");
        url.searchParams.set("type", "training");
        url.searchParams.set("cat", "playStyle");
        url.searchParams.set("playStyle", String(sId));
        url.searchParams.set(kind === "bid" ? "macr" : "maxb", String(kind === "bid" ? pi.maxBidAllowed : pi.maxBuyNowAllowed));
        url.searchParams.set("micr", String(micr));
        return url;
      },
      bidDataBase: { playStyleId: sId, name: pi.meta.name, isConsumable: true }
    };
  });

  if (targets.length === 0) {
    sendMessageSafe({
      tipo: 'LOG',
      valore: `[LAZY CONSUMABILI] Nessuno stile intesa rispetta il guard-rail di margine netto minimo (+${minNetProfit} cr). Attendo il prossimo ciclo...`
    });
  }
  const minBidRequired = targets.length > 0 ? Math.min(...targets.map(t => t.maxBid)) : Infinity;

  return {
    shouldContinue: false,
    cyclePrices,
    targets,
    minBidRequired,
    targetStyles
  };
}

export async function buildLazyCycleTargets(cycle) {
  const isFodder = botState.targetMode === "fodder";
  const markup = botState.lazyMarkupPercent && botState.lazyMarkupPercent > 0 ? botState.lazyMarkupPercent : 10;
  const minNetProfit = Math.max(200, (typeof botState.minMargin === 'number' && botState.minMargin > 0 ? botState.minMargin : 200));

  if (isFodder) {
    return await buildFodderLazyTargets(cycle, markup, minNetProfit);
  } else if (botState.targetMode === "managerLeague") {
    return await buildManagerLeagueLazyTargets(cycle, markup, minNetProfit);
  } else if (botState.targetMode === "managers") {
    return await buildManagersLazyTargets(cycle);
  } else {
    return await buildConsumablesLazyTargets(cycle, markup, minNetProfit);
  }
}
