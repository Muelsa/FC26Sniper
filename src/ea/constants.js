// Metadati ufficiali Stili Intesa EA (PlayStyle)
export const CHEM_STYLES = {
  "268": { id: 268, name: "Ombra (Shadow)", defaultGuess: 4200 },
  "266": { id: 266, name: "Cacciatore (Hunter)", defaultGuess: 3800 },
  "265": { id: 265, name: "Ancora (Anchor)", defaultGuess: 1300 },
  "260": { id: 260, name: "Motore (Engine)", defaultGuess: 800 },
  "267": { id: 267, name: "Catalizzatore (Catalyst)", defaultGuess: 800 },
  "255": { id: 255, name: "Falco (Hawk)", defaultGuess: 700 }
};

// Modificatori Campionato Allenatore (cat=managerLeagueModifier) — ID lega EA dei top 5 campionati
export const MANAGER_LEAGUES = {
  "13": { id: 13, name: "Premier League", defaultGuess: 1200 },
  "53": { id: 53, name: "LaLiga", defaultGuess: 1000 },
  "31": { id: 31, name: "Serie A", defaultGuess: 900 },
  "19": { id: 19, name: "Bundesliga", defaultGuess: 800 },
  "16": { id: 16, name: "Ligue 1", defaultGuess: 700 }
};

// Chiave sintetica usata in cyclePrices/cache per un modificatore campionato
export function leagueTargetKey(leagueId) {
  return `league_${leagueId}`;
}

// Top Nazioni Allenatori (cat=manager, nat=<id>)
export const TOP_MANAGER_NATIONS = {
  "18": { id: 18, name: "Francia", defaultGuess: 2500 },
  "34": { id: 34, name: "Olanda", defaultGuess: 2000 },
  "27": { id: 27, name: "Italia", defaultGuess: 1500 },
  "45": { id: 45, name: "Spagna", defaultGuess: 1200 },
  "21": { id: 21, name: "Germania", defaultGuess: 1000 },
  "14": { id: 14, name: "Inghilterra", defaultGuess: 1200 },
  "10": { id: 10, name: "Brasile", defaultGuess: 1200 },
  "38": { id: 38, name: "Portogallo", defaultGuess: 1200 },
  "52": { id: 52, name: "Argentina", defaultGuess: 1000 }
};

// Chiave sintetica usata in cyclePrices/cache per un target allenatore per nazione
export function managerTargetKey(natId) {
  return `manager_nat_${natId}`;
}

