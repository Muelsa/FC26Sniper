// Listener chrome.webRequest per intercettare filtri di ricerca, credenziali x-ut-sid e telemetria PIN
import { botState } from '../core/state.js';
import { sendMessageSafe } from '../core/messenger.js';
import { CHEM_STYLES, MANAGER_LEAGUES, NATION_NAMES } from './constants.js';

export function registerWebRequestListeners() {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      try {
        // 1. FILTRO ANTI-AUTO-INTERCETTAZIONE:
        // Ignora rigorosamente richieste provenienti dal Service Worker di background (tabId === -1)
        // o iniziate dall'estensione stessa (initiator chrome-extension://)
        if (details.tabId === undefined || details.tabId < 0) return;
        if (details.initiator && details.initiator.startsWith("chrome-extension://")) return;
        if (details.initiator && !details.initiator.includes("ea.com")) return;

        // 2. Quando il bot è già in esecuzione, non sovrascrivere il filtro attivo con richieste di background
        if (botState.start === true) return;

        if ((details.method === "GET" || details.method === "POST") && details.url.includes("transfermarket?")) {
          botState.searchUrl = details.url;
          chrome.storage.local.set({ searchUrl: details.url });

          let filterDesc = "";
          try {
            const u = new URL(details.url);
            const type = u.searchParams.get("type");
            const cat = u.searchParams.get("cat");
            const nat = u.searchParams.get("nat");
            const playStyle = u.searchParams.get("playStyle");
            const maskedDefId = u.searchParams.get("maskedDefId");
            const macr = u.searchParams.get("macr");
            const maxb = u.searchParams.get("maxb");

            if (type === "staff" || cat === "manager") {
              const natName = nat ? (NATION_NAMES[nat] || `Naz ${nat}`) : "Tutti";
              filterDesc = `Allenatori (${natName})`;
            } else if (playStyle) {
              filterDesc = CHEM_STYLES[playStyle]?.name || `Stile ${playStyle}`;
            } else if (cat === "managerLeagueModifier") {
              const lg = u.searchParams.get("amount");
              filterDesc = `Modificatore ${MANAGER_LEAGUES[lg]?.name || 'Lega ' + lg}`;
            } else if (type === "player") {
              filterDesc = maskedDefId ? `Calciatore (ID ${maskedDefId})` : "Calciatori";
            } else {
              filterDesc = "Mercato Generico";
            }
            const cap = macr ? `Max Offerta: ${macr} cr` : (maxb ? `Max Compra Ora: ${maxb} cr` : null);
            if (cap) filterDesc += ` [${cap}]`;
          } catch (_) {}

          sendMessageSafe({
            tipo: 'LOG',
            valore: `[FILTRO ACQUISITO] Rilevato dalla Web App: ${filterDesc || 'Filtro impostato correttamente'}`
          });
        }
      } catch (err) {
        console.error('[FC26 listener error]', err);
      }
    },
    {
      urls: [
        "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/game/fc27/transfermarket*",
      ]
    },
    ["requestBody"]
  );

  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      if (details.requestHeaders) {
        details.requestHeaders.forEach(header => {
          if (header.name.toLowerCase() === "x-ut-sid" && header.value) {
            if (botState.xUtSid !== header.value) {
              console.log("[FC Sniper] x-ut-sid aggiornato / sincronizzato:", header.value.substring(0, 10) + "...");
            }
            botState.xUtSid = header.value;
            chrome.storage.local.set({ xUtSid: header.value });
          }
        });
      }

      if (details.url.includes("transfermarket?") && botState.start == false) {
        botState.searchHeaders = details.requestHeaders;
      }
      if (details.url.includes("https://www.futwiz.com/fc27/players") && botState.start == false) {
        details.requestHeaders.forEach(header => {
          if (header.name.toLowerCase().includes("next-action")) {
            botState.fodderSid = header.value;
          }
        });
      }
    },
    { urls: ["https://utas.mob.v1.prd.futc-ext.gcp.ea.com/ut/*"] },
    ["requestHeaders"]
  );

  // Listener diagnostico per osservare la telemetria reale inviata dalla Web App di EA
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      try {
        if (details.url.includes("pinEvents") && details.requestBody?.raw) {
          const decoder = new TextDecoder("utf-8");
          const postedString = decoder.decode(details.requestBody.raw[0].bytes);
          const pinData = JSON.parse(postedString);
          console.log("[EA PIN Telemetry Intercettata]", pinData);
          const evCount = pinData.events?.length || 1;
          const types = (pinData.events || []).map(e => e.type || e.pgid || e.core?.en).filter(Boolean).slice(0, 3).join(", ");
          sendMessageSafe({
            tipo: 'LOG',
            valore: `[PIN TELEMETRY] Inviati a EA ${evCount} eventi (${types || 'telemetria'}) | stepCounter: ${pinData.stepCounter || pinData.custom?.step || 'OK'}`
          });
        }
      } catch (err) {
        // Ignora errori di parsing su payload parziali
      }
    },
    { urls: ["*://*.data.ea.com/*", "*://pin-river.data.ea.com/*", "*://pin-river.ea.com/*", "https://pin-river.data.ea.com/*"] },
    ["requestBody"]
  );
}
