// Comunicazione IPC, PIN Telemetria, Offscreen Keep-Alive e Lifecycle Bot
import { botState } from './state.js';

// Invio messaggi broadcast sicuro: invia sia tramite runtime.sendMessage
// sia esplicitamente a tutte le schede della dashboard (index.html) tramite tabs.sendMessage.
export function sendMessageSafe(message, callback) {
  // 1. Invio runtime standard (popup, offscreen, contesti interni)
  try {
    const res = chrome.runtime.sendMessage(message, (...args) => {
      void chrome.runtime.lastError;
      if (typeof callback === "function") callback(...args);
    });
    if (res && typeof res.catch === "function") res.catch(() => { });
  } catch (e) {
    // Nessun ricevitore runtime
  }

  // 2. Invio esplicito a tutte le schede aperte della Dashboard (index.html)
  try {
    if (chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({}, (tabs) => {
        if (chrome.runtime.lastError || !tabs) return;
        for (const tab of tabs) {
          if (tab.id && tab.url && tab.url.includes('index.html')) {
            chrome.tabs.sendMessage(tab.id, message, () => {
              void chrome.runtime.lastError;
            });
          }
        }
      });
    }
  } catch (e) {
    // Gestione silenziosa errori tabs
  }
}

// Funzione helper per PIN Event: inoltra l'evento alla scheda attiva della Web App EA
// Restituisce una Promise protetta da timeout di sicurezza (max 500ms) per evitare blocchi infiniti
export async function triggerPinEvent(type, payload = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    const safetyTimer = setTimeout(finish, 500);

    try {
      chrome.tabs.query({}, (tabs) => {
        const eaTabs = (tabs || []).filter(t => t.url && t.url.includes("ea.com"));
        if (chrome.runtime.lastError || !eaTabs || eaTabs.length === 0) {
          clearTimeout(safetyTimer);
          return finish();
        }
        let pending = eaTabs.length;
        const requestId = 'pin_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        for (const tab of eaTabs) {
          console.log(`[FC Sniper SW] Invio PIN ${type} a scheda ${tab.id}`);
          chrome.tabs.sendMessage(tab.id, {
            scope: "PIN_BRIDGE",
            requestId: requestId,
            type: type,
            payload: payload
          }, () => {
            const _ = chrome.runtime.lastError; // Consuma l'errore per prevenire Unchecked runtime.lastError
            pending--;
            if (pending <= 0) {
              clearTimeout(safetyTimer);
              finish();
            }
          });
        }
      });
    } catch (err) {
      clearTimeout(safetyTimer);
      finish();
    }
  });
}

export async function ensureOffscreenDocument() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Keep service worker alive'
    });
    console.log('[FC Sniper] Offscreen document creato per Keep-Alive MV3.');
  } catch (e) {
    if (!e.message.includes('Only a single offscreen document may be created')) {
      console.warn('[FC Sniper] Errore creazione offscreen:', e);
    }
  }
}

export async function stopOffscreenDocument() {
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
      console.log('[FC Sniper] Offscreen document chiuso (stop bot).');
    }
  } catch (e) {
    console.warn('[FC Sniper] Errore chiusura offscreen:', e);
  }
}

// Arresto centralizzato del bot: aggiorna stato, persiste, notifica la UI e ferma il keep-alive offscreen
export async function stopBot(reason = "") {
  botState.start = false;
  try { await chrome.storage.local.set({ start: false }); } catch (_) { }
  sendMessageSafe({ tipo: 'START', valore: false });
  await stopOffscreenDocument();
  if (reason) console.log(`[FC Sniper] Bot arrestato: ${reason}`);
}
