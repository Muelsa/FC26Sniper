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
